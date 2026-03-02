/* ============================================================================
   server.js — Proxy server for Enterprise Resumable Uploader
   -----------------------------------------------------------
   • Token fetched & cached server-side (never exposed to browser)
   • Auto-refreshes token 60s before expiry
   • Proxies all upload API calls with Bearer auth injected
   • Serves static files (index.html, app.js, etc.) from same origin
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

// Serve static files (index.html, app.js, hashWorker.js, sw.js)
app.use(express.static(path.join(__dirname)));

// Parse JSON for init / complete requests (limit 1 MB)
app.use('/api', express.json({ limit: '1mb' }));

// Parse raw binary bodies for chunk uploads (up to 200 MB per chunk)
const rawParser = express.raw({ type: '*/*', limit: '200mb' });

/* ---------------------------------------------------------------
   Proxy routes
--------------------------------------------------------------- */

/**
 * POST /api/tickets/:ticketId/upload_attachments
 * → Initialize a chunked upload.  Body is JSON.
 */
app.post('/api/tickets/:ticketId/upload_attachments', async (req, res) => {
    try {
        const url = `${API_BASE}/tickets/${req.params.ticketId}/upload_attachments`;
        const headers = await authHeaders({ 'Content-Type': 'application/json' });

        const upstream = await axios.post(url, req.body, { headers });
        res.status(upstream.status).json(upstream.data);

    } catch (err) {
        handleError(res, err, 'init upload');
    }
});

/**
 * PUT /api/tickets/:ticketId/upload_attachments/:tempId/parts/:partNum
 * → Upload a single binary chunk.
 *   The body is raw binary (application/octet-stream), streamed directly.
 */
app.put('/api/tickets/:ticketId/upload_attachments/:tempId/parts/:partNum', async (req, res) => {
    try {
        const { ticketId, tempId, partNum } = req.params;
        const url = `${API_BASE}/tickets/${ticketId}/upload_attachments/${tempId}/parts/${partNum}`;
        const headers = await authHeaders({
            'Content-Type': req.headers['content-type'] || 'application/octet-stream',
            // Forward content-length so upstream knows the chunk size
            ...(req.headers['content-length'] && { 'Content-Length': req.headers['content-length'] }),
            // Forward content-range so upstream knows the start byte of each chunk
            ...(req.headers['content-range'] && { 'Content-Range': req.headers['content-range'] })
        });
        let config = {
            method: 'put',
            maxBodyLength: Infinity,
            url: url,
            headers: headers,
            data: req                     // stream request body directly — no buffering
        };
        const upstream = await axios.request(config);
        res.status(upstream.status).json(upstream.data);

    } catch (err) {
        handleError(res, err, 'upload chunk');
    }
});

/**
 * POST /api/tickets/:ticketId/upload_attachments/:tempId/complete
 * → Finalize the upload.
 */
app.post('/api/tickets/:ticketId/upload_attachments/:tempId/complete', async (req, res) => {
    try {
        const { ticketId, tempId } = req.params;
        const url = `${API_BASE}/tickets/${ticketId}/upload_attachments/${tempId}/complete`;
        const headers = await authHeaders({ 'Content-Type': 'application/json' });

        const upstream = await axios.post(url, req.body || {}, { headers });
        res.status(upstream.status).json(upstream.data);

    } catch (err) {
        handleError(res, err, 'complete upload');
    }
});

/**
 * DELETE /api/tickets/:ticketId/upload_attachments/:tempId
 * → Cancel / delete an in-progress upload.
 */
app.delete('/api/tickets/:ticketId/upload_attachments/:tempId', async (req, res) => {
    try {
        const { ticketId, tempId } = req.params;
        const url = `${API_BASE}/tickets/${ticketId}/upload_attachments/${tempId}`;
        const headers = await authHeaders();

        const upstream = await axios.delete(url, { headers });
        res.status(upstream.status).json(upstream.data);

    } catch (err) {
        handleError(res, err, 'cancel upload');
    }
});

/* ---------------------------------------------------------------
   Error handler
--------------------------------------------------------------- */
function handleError(res, err, context) {
    const status  = err.response?.status || 500;
    const message = err.response?.data || err.message;

    console.error(`[Proxy] ${context} failed (${status}):`, message);

    // If upstream returned 401, clear cached token so next request refreshes
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
    console.log(`   Upstream API:             ${API_BASE}\n`);
});
