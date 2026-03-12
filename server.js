/* ============================================================================
   server.js — Proxy server for ChunkUploader Plugin
   -----------------------------------------------------------
   • Token fetched & cached server-side (never exposed to browser)
   • Auto-refreshes token 60s before expiry
   • Proxies all upload API calls with Bearer auth injected
   • NEW: /api/comments endpoint for comment-first flow
   • Serves static files (demo.html, dist/*, etc.) from same origin
   • Streams binary chunk bodies without buffering into memory
============================================================================ */

const express  = require('express');
const axios    = require('axios');
const path     = require('path');
const cors     = require("cors");

const app = express();
app.use(cors());
const PORT = process.env.PORT || 5000;

/* ---------------------------------------------------------------
   Configuration — all secrets stay server-side
--------------------------------------------------------------- */
const API_HOST   = 'https://develop.aerport.nl';
const API_BASE   = `${API_HOST}/api/v1.2`;
const XAPITOKEN  = '7f8f6c05-58b2-4f49-b1fb-02c9bd880e93';

const AUTH_BODY = {
    UserName: 'aerport.api',
    Password: '^?69#oFGB(',
    Scope:    'Tickets:read Tickets:write'
};

/* ---------------------------------------------------------------
   Token cache
--------------------------------------------------------------- */
let cachedToken  = null;
let tokenExpiry  = 0;

async function getToken() {
    if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

    const res = await axios.post(`${API_BASE}/accounts/token`, AUTH_BODY, {
        headers: {
            'Content-Type': 'application/json',
            'x-api-key':    XAPITOKEN
        }
    });

    cachedToken = res.data.token;
    tokenExpiry = Date.now() + (res.data.expiresIn - 60) * 1000;

    console.log('[Token] Refreshed — expires in', res.data.expiresIn, 's');
    return cachedToken;
}

/** Build common auth headers for upstream calls */
async function authHeaders(extra) {
    const token = await getToken();
    return {
        'x-api-key':     XAPITOKEN,
        'Authorization': `Bearer ${token}`,
        ...extra
    };
}

/* ---------------------------------------------------------------
   Middleware
--------------------------------------------------------------- */

// Serve static files (demo.html, dist/*, index.html, etc.)
app.use(express.static(path.join(__dirname)));

// Parse JSON for init / complete / comment requests (limit 1 MB)
app.use('/api', express.json({ limit: '1mb' }));

// Parse raw binary bodies for chunk uploads (up to 200 MB per chunk)
const rawParser = express.raw({ type: '*/*', limit: '200mb' });

/* ---------------------------------------------------------------
   NEW: Comment-first endpoint
--------------------------------------------------------------- */

/**
 * POST /api/comments
 * → Create a comment on a ticket. Returns { ticketId, commentId }.
 *   The plugin calls this FIRST, before uploading any files.
 *
 *   Body: { text: "user's comment", ticketId: 123 }
 *   Adjust the upstream URL/body to match your real API.
 */
app.post('/api/comments', async (req, res) => {
    try {
        const { text, ticketId } = req.body;
        const tid = ticketId || 3059;   // default ticket for demo

        const url = `${API_BASE}/tickets/${tid}/comments`;
        const headers = await authHeaders({ 'Content-Type': 'application/json' });

        const upstream = await axios.post(url, { Text: text || '' }, { headers });

        // Map upstream response to { ticketId, commentId }
        const commentId = upstream.data.Id || upstream.data.id || upstream.data.CommentId;
        res.json({
            ticketId:  tid,
            commentId: commentId
        });

    } catch (err) {
        handleError(res, err, 'create comment');
    }
});

/* ---------------------------------------------------------------
   Upload proxy routes (new query-param style used by the plugin)
--------------------------------------------------------------- */

/**
 * POST /api/tickets/AttachmentUpload
 * → Initialize or finalize a chunked upload.
 *   Query params: TicketId, CommentId, OriginalFileName, FileBytesSize, OriginalSha256, ActionName
 */
app.post('/api/tickets/AttachmentUpload', async (req, res) => {
    try {
        const qs  = req.query;
        const url = `${API_BASE}/tickets/AttachmentUpload`;
        const headers = await authHeaders({ 'Content-Type': 'application/json' });

        const upstream = await axios.post(url, req.body || {}, { headers, params: qs });
        res.status(upstream.status).json(upstream.data);

    } catch (err) {
        handleError(res, err, 'attachment upload (POST)');
    }
});

/**
 * PUT /api/tickets/AttachmentUpload
 * → Upload a single binary chunk.
 *   Query params: TicketId, TempAttachmentId, PartNumber, ActionName
 */
app.put('/api/tickets/AttachmentUpload', rawParser, async (req, res) => {
    try {
        const qs  = req.query;
        const url = `${API_BASE}/tickets/AttachmentUpload`;

        const headers = await authHeaders({
            'Content-Type': req.headers['content-type'] || 'application/octet-stream',
            ...(req.headers['content-length'] && { 'Content-Length': req.headers['content-length'] }),
            ...(req.headers['content-range']  && { 'Content-Range':  req.headers['content-range'] })
        });

        const upstream = await axios.put(url, req.body, { headers, params: qs, maxBodyLength: Infinity });
        res.status(upstream.status).json(upstream.data);

    } catch (err) {
        handleError(res, err, 'attachment upload (PUT chunk)');
    }
});

/**
 * DELETE /api/tickets/AttachmentUpload
 * → Cancel / delete an in-progress upload.
 *   Query params: TicketId, TempAttachmentId, ActionName
 */
app.delete('/api/tickets/AttachmentUpload', async (req, res) => {
    try {
        const qs  = req.query;
        const url = `${API_BASE}/tickets/AttachmentUpload`;
        const headers = await authHeaders();

        const upstream = await axios.delete(url, { headers, params: qs });
        res.status(upstream.status).json(upstream.data);

    } catch (err) {
        handleError(res, err, 'cancel upload');
    }
});

/* ---------------------------------------------------------------
   Legacy proxy routes (backward compat with old app.js)
--------------------------------------------------------------- */

app.post('/api/tickets/:ticketId/upload_attachments', async (req, res) => {
    try {
        const url = `${API_BASE}/tickets/${req.params.ticketId}/upload_attachments`;
        const headers = await authHeaders({ 'Content-Type': 'application/json' });
        const upstream = await axios.post(url, req.body, { headers });
        res.status(upstream.status).json(upstream.data);
    } catch (err) { handleError(res, err, 'init upload (legacy)'); }
});

app.put('/api/tickets/:ticketId/upload_attachments/:tempId/parts/:partNum', rawParser, async (req, res) => {
    try {
        const { ticketId, tempId, partNum } = req.params;
        const url = `${API_BASE}/tickets/${ticketId}/upload_attachments/${tempId}/parts/${partNum}`;
        const headers = await authHeaders({
            'Content-Type': req.headers['content-type'] || 'application/octet-stream',
            ...(req.headers['content-length'] && { 'Content-Length': req.headers['content-length'] }),
            ...(req.headers['content-range']  && { 'Content-Range':  req.headers['content-range'] })
        });
        const upstream = await axios.put(url, req.body, { headers, maxBodyLength: Infinity });
        res.status(upstream.status).json(upstream.data);
    } catch (err) { handleError(res, err, 'upload chunk (legacy)'); }
});

app.post('/api/tickets/:ticketId/upload_attachments/:tempId/complete', async (req, res) => {
    try {
        const { ticketId, tempId } = req.params;
        const url = `${API_BASE}/tickets/${ticketId}/upload_attachments/${tempId}/complete`;
        const headers = await authHeaders({ 'Content-Type': 'application/json' });
        const upstream = await axios.post(url, req.body || {}, { headers });
        res.status(upstream.status).json(upstream.data);
    } catch (err) { handleError(res, err, 'complete upload (legacy)'); }
});

app.delete('/api/tickets/:ticketId/upload_attachments/:tempId', async (req, res) => {
    try {
        const { ticketId, tempId } = req.params;
        const url = `${API_BASE}/tickets/${ticketId}/upload_attachments/${tempId}`;
        const headers = await authHeaders();
        const upstream = await axios.delete(url, { headers });
        res.status(upstream.status).json(upstream.data);
    } catch (err) { handleError(res, err, 'cancel upload (legacy)'); }
});

/* ---------------------------------------------------------------
   Error handler
--------------------------------------------------------------- */
function handleError(res, err, context) {
    const status  = err.response?.status || 500;
    const message = err.response?.data || err.message;

    console.error(`[Proxy] ${context} failed (${status}):`, message);

    if (status === 401) {
        cachedToken = null;
        tokenExpiry = 0;
    }

    res.status(status).json({
        error:   true,
        context: context,
        message: typeof message === 'string' ? message : JSON.stringify(message)
    });
}

/* ---------------------------------------------------------------
   Start
--------------------------------------------------------------- */
app.listen(PORT, () => {
    console.log(`\n🚀 Upload proxy running → http://localhost:${PORT}\n`);
    console.log(`   Static files served from: ${__dirname}`);
    console.log(`   Upstream API:             ${API_BASE}`);
    console.log(`   Demo page:                http://localhost:${PORT}/demo.html\n`);
});
