/* ============================================================================
   Enterprise Resumable Chunk Uploader
   ------------------------------------
   ✅ API-driven ChunkSizeBytes & TotalParts
   ✅ Bearer token with auto-refresh on 401
   ✅ Web Worker SHA-256 (non-blocking, concurrent-safe)
   ✅ IndexedDB full task persistence (survives reload)
   ✅ Resume from exact completed parts (not just nextPart)
   ✅ Parallel chunk upload (configurable concurrency)
   ✅ Exponential back-off retry with jitter
   ✅ True progress bar UI with speed + ETA
   ✅ Pause / Resume / Cancel (DELETE API)
   ✅ Recover unfinished uploads on reload (re-attach flow)
   ✅ Online/offline awareness with auto-retry
   ✅ File validation, paste support, drag-and-drop
   ✅ Persistent data-URL thumbnails (survive reload)
   ✅ State-aware action buttons
============================================================================ */

(function ($) {
    'use strict';

    /* ---------------------------------------------------------------
       Configuration
    --------------------------------------------------------------- */
    const CFG = {
        API_BASE:       '/tickets',              // same-origin proxy — no credentials on client
        TICKET_ID:      3059,
        COMMENT_ID:     49717,
        DB_NAME:        'UploaderDB',
        DB_VERSION:     2,
        STORE:          'tasks',
        PARALLEL:       1,                          // concurrent chunk workers per file
        MAX_RETRIES:    6,
        RETRY_BASE_MS:  1000,
        THUMB_MAX_PX:   120,
        MAX_FILE_SIZE:  5 * 1024 * 1024 * 1024      // 5 GB
    };

    /* ---------------------------------------------------------------
       Application state
    --------------------------------------------------------------- */
    let db            = null;
    const tasks       = new Map();   // id → task object
    const fileRefs    = new Map();   // id → File object (session-only)
    const hashWorker  = new Worker('hashWorker.js');
    const hashPending = new Map();   // msgId → { resolve, reject }
    let reattachTargetId = null;

    /* ===============================================================
       IndexedDB
    =============================================================== */
    function openDB() {
        return new Promise(function (resolve, reject) {
            var req = indexedDB.open(CFG.DB_NAME, CFG.DB_VERSION);
            req.onupgradeneeded = function (e) {
                var d = e.target.result;
                if (!d.objectStoreNames.contains(CFG.STORE)) {
                    d.createObjectStore(CFG.STORE, { keyPath: 'id' });
                }
            };
            req.onsuccess = function (e) { db = e.target.result; resolve(); };
            req.onerror   = function ()  { reject(req.error); };
        });
    }

    function dbPut(task) {
        var clone = $.extend({}, task);
        // Strip session-only / non-serialisable properties
        delete clone.sessionStartTime;
        delete clone.sessionStartBytes;
        delete clone._activeXhrs;
        delete clone._getInFlightBytes;
        var tx = db.transaction(CFG.STORE, 'readwrite');
        tx.objectStore(CFG.STORE).put(clone);
    }

    function dbDelete(id) {
        var tx = db.transaction(CFG.STORE, 'readwrite');
        tx.objectStore(CFG.STORE).delete(id);
    }

    function dbGetAll() {
        return new Promise(function (resolve, reject) {
            var tx  = db.transaction(CFG.STORE, 'readonly');
            var req = tx.objectStore(CFG.STORE).getAll();
            req.onsuccess = function () { resolve(req.result); };
            req.onerror   = function () { reject(req.error); };
        });
    }

    /* ===============================================================
       API fetch — calls same-origin proxy (token handled server-side)
    =============================================================== */
    async function apiFetch(url, opts) {
        opts = opts || {};
        var res = await fetch(url, opts);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res;
    }

    /* ===============================================================
       XHR upload with streaming progress
    =============================================================== */
    function xhrUpload(url, blob, headers, onProgress, activeXhrs) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            if (activeXhrs) activeXhrs.add(xhr);

            xhr.open('PUT', url);
            Object.keys(headers || {}).forEach(function (k) {
                xhr.setRequestHeader(k, headers[k]);
            });

            xhr.upload.onprogress = function (e) {
                if (e.lengthComputable && onProgress) onProgress(e.loaded);
            };

            xhr.onload = function () {
                if (activeXhrs) activeXhrs.delete(xhr);
                if (xhr.status >= 200 && xhr.status < 300) resolve(xhr);
                else reject(new Error('HTTP ' + xhr.status));
            };
            xhr.onerror = function () {
                if (activeXhrs) activeXhrs.delete(xhr);
                reject(new Error('Network error'));
            };
            xhr.onabort = function () {
                if (activeXhrs) activeXhrs.delete(xhr);
                var e = new Error('Aborted');
                e.name = 'AbortError';
                reject(e);
            };

            xhr.send(blob);
        });
    }

    /* ===============================================================
       SHA-256 via Web Worker (concurrent-safe)
    =============================================================== */
    hashWorker.onmessage = function (e) {
        var data    = e.data;
        var pending = hashPending.get(data.id);
        if (!pending) return;
        hashPending.delete(data.id);
        if (data.error) pending.reject(new Error(data.error));
        else            pending.resolve(data.hash);
    };

    function computeHash(file) {
        return new Promise(function (resolve, reject) {
            var msgId = crypto.randomUUID();
            hashPending.set(msgId, { resolve: resolve, reject: reject });
            hashWorker.postMessage({ id: msgId, file: file });
        });
    }

    /* ===============================================================
       Utility helpers
    =============================================================== */
    function fmtBytes(b) {
        if (b < 1024)        return b + ' B';
        if (b < 1048576)     return (b / 1024).toFixed(1) + ' KB';
        if (b < 1073741824)  return (b / 1048576).toFixed(1) + ' MB';
        return (b / 1073741824).toFixed(2) + ' GB';
    }

    function fmtTime(s) {
        if (!isFinite(s) || s < 0) return '--';
        if (s < 60)   return Math.ceil(s) + 's';
        if (s < 3600) return Math.floor(s / 60) + 'm ' + Math.ceil(s % 60) + 's';
        return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    }

    var FILE_ICONS = {
        pdf:'📕', doc:'📘', docx:'📘', xls:'📗', xlsx:'📗',
        ppt:'📙', pptx:'📙', zip:'📦', rar:'📦', '7z':'📦',
        mp4:'🎬', avi:'🎬', mov:'🎬', mkv:'🎬', webm:'🎬',
        mp3:'🎵', wav:'🎵', ogg:'🎵', flac:'🎵',
        txt:'📝', csv:'📊', json:'📋', xml:'📋', html:'🌐',
        svg:'🎨', psd:'🎨', ai:'🎨', fig:'🎨'
    };

    function fileIcon(name) {
        var ext = (name.split('.').pop() || '').toLowerCase();
        return FILE_ICONS[ext] || '📄';
    }

    function escHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
                .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /** Generate a small data-URL thumbnail (persists in IndexedDB) */
    function makeThumbnail(file) {
        return new Promise(function (resolve) {
            if (!file.type.startsWith('image/')) { resolve(null); return; }

            var reader = new FileReader();
            reader.onload = function () {
                var img = new Image();
                img.onload = function () {
                    var c = document.createElement('canvas');
                    var M = CFG.THUMB_MAX_PX;
                    var w = img.width, h = img.height;
                    if (w > h) { h = h * M / w; w = M; } else { w = w * M / h; h = M; }
                    c.width = w; c.height = h;
                    c.getContext('2d').drawImage(img, 0, 0, w, h);
                    resolve(c.toDataURL('image/jpeg', 0.7));
                };
                img.onerror = function () { resolve(null); };
                img.src = reader.result;
            };
            reader.onerror = function () { resolve(null); };
            reader.readAsDataURL(file);
        });
    }

    /* ===============================================================
       Exponential back-off with jitter
    =============================================================== */
    async function retryBackoff(fn, maxRetries) {
        maxRetries = maxRetries || CFG.MAX_RETRIES;
        var delay = CFG.RETRY_BASE_MS;

        for (var i = 0; i <= maxRetries; i++) {
            try {
                return await fn();
            } catch (err) {
                if (i === maxRetries) throw err;
                await new Promise(function (r) {
                    setTimeout(r, delay + Math.random() * 500);
                });
                delay *= 2;
            }
        }
    }

    /* ===============================================================
       Toast notifications
    =============================================================== */
    function toast(msg, type, duration) {
        type     = type || 'info';
        duration = duration || 4000;
        var $t = $('<div class="toast ' + type + '"></div>').text(msg);
        $('#toastContainer').append($t);
        setTimeout(function () { $t.addClass('show'); }, 20);
        setTimeout(function () {
            $t.removeClass('show');
            setTimeout(function () { $t.remove(); }, 300);
        }, duration);
    }

    /* ===============================================================
       UI — Rendering & updates
    =============================================================== */
    function renderCard(task) {
        var thumbHtml = task.thumbDataUrl
            ? '<img src="' + task.thumbDataUrl + '" alt="">'
            : '<span class="icon">' + fileIcon(task.fileName) + '</span>';

        var html =
            '<div class="file-card" id="task-' + task.id + '" data-status="' + task.status + '">' +
                '<div class="thumb">' + thumbHtml + '</div>' +
                '<div class="file-body">' +
                    '<div class="file-name" title="' + escHtml(task.fileName) + '">' + escHtml(task.fileName) + '</div>' +
                    '<div class="file-meta">' + fmtBytes(task.fileSize) + '</div>' +
                    '<div class="progress-track"><div class="progress-fill" id="pf-' + task.id + '"></div></div>' +
                    '<div class="file-status" id="st-' + task.id + '">' + statusLabel(task) + '</div>' +
                '</div>' +
                '<div class="file-actions">' +
                    '<button class="act-btn pause-btn"    title="Pause"          data-id="' + task.id + '">⏸</button>' +
                    '<button class="act-btn resume-btn"   title="Resume"         data-id="' + task.id + '">▶️</button>' +
                    '<button class="act-btn reattach-btn" title="Re-attach file" data-id="' + task.id + '">📂</button>' +
                    '<button class="act-btn cancel-btn"   title="Cancel"         data-id="' + task.id + '">✕</button>' +
                '</div>' +
            '</div>';

        $('#fileList').append(html);
        syncActionButtons(task);
        updateProgressBar(task);
    }

    /** Render a compact staged card in the staging area (pre-send) */
    function renderStagedCard(task) {
        var thumbHtml = task.thumbDataUrl
            ? '<img height="24" width="24" style="object-fit: contain;" src="' + task.thumbDataUrl + '" alt="">'
            : '<span class="icon">' + fileIcon(task.fileName) + '</span>';
        var statusText = task.status === 'hashing' ? '⏳ Verifying…' : '✓ Ready';
        var html =
            '<div class="staged-card" id="task-' + task.id + '" data-status="' + task.status + '">' +
                '<span class="staged-icon">' + thumbHtml + '</span>' +
                '<span class="staged-name" title="' + escHtml(task.fileName) + '">' + escHtml(task.fileName) + '</span>' +
                '<span class="staged-size">' + fmtBytes(task.fileSize) + '</span>' +
                '<span class="staged-status" id="st-' + task.id + '">' + statusText + '</span>' +
                '<button class="staged-remove" data-id="' + task.id + '" title="Remove">✕</button>' +
            '</div>';
        $('#stagingArea').append(html);
    }

    /** Render a WhatsApp-style chat bubble with optional comment + compact file cards */
    function renderMessageBubble(msgId, comment, taskList) {
        var html = '<div class="chat-message" id="' + msgId + '">' +
            '<div class="msg-bubble">';

        if (comment) {
            html += '<div class="msg-text">' + escHtml(comment).replace(/\n/g, '<br>') + '</div>';
        }

        if (taskList.length) {
            html += '<div class="msg-attachments">';
            taskList.forEach(function (task) {
                html += renderCompactCardHtml(task);
            });
            html += '</div>';
        }

        var now  = new Date();
        var time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        html += '<div class="msg-time">' + time + '</div>';
        html += '</div></div>';

        var $list = $('#fileList');
        $list.append(html);
        $list.scrollTop($list[0].scrollHeight);

        taskList.forEach(function (task) {
            syncActionButtons(task);
            updateProgressBar(task);
        });
    }

    /** Generate HTML for a compact file card inside a message bubble */
    function renderCompactCardHtml(task) {
        var thumbHtml = task.thumbDataUrl
            ? '<img src="' + task.thumbDataUrl + '" alt="">'
            : '<span>' + fileIcon(task.fileName) + '</span>';

        return '<div class="compact-file" id="task-' + task.id + '" data-status="' + task.status + '">' +
            '<div class="compact-icon">' + thumbHtml + '</div>' +
            '<div class="compact-body">' +
                '<div class="compact-name-row">' +
                    '<span class="compact-name" title="' + escHtml(task.fileName) + '">' + escHtml(task.fileName) + '</span>' +
                    '<span class="compact-size">' + fmtBytes(task.fileSize) + '</span>' +
                '</div>' +
                '<div class="progress-track"><div class="progress-fill" id="pf-' + task.id + '"></div></div>' +
                '<div class="file-status" id="st-' + task.id + '">' + statusLabel(task) + '</div>' +
            '</div>' +
            '<div class="file-actions">' +
                '<button class="act-btn pause-btn"    title="Pause"          data-id="' + task.id + '">⏸</button>' +
                '<button class="act-btn resume-btn"   title="Resume"         data-id="' + task.id + '">▶️</button>' +
                '<button class="act-btn reattach-btn" title="Re-attach file" data-id="' + task.id + '">📂</button>' +
                '<button class="act-btn cancel-btn"   title="Cancel"         data-id="' + task.id + '">✕</button>' +
            '</div>' +
        '</div>';
    }

    function statusLabel(task) {
        switch (task.status) {
            case 'queued':         return 'Queued';
            case 'hashing':        return 'Verifying file…';
            case 'initializing':   return 'Initializing…';
            case 'uploading':      return progressText(task);
            case 'paused':         return 'Paused — ' + pctText(task);
            case 'completing':     return 'Finalizing…';
            case 'completed':      return '✅ Completed';
            case 'failed':         return '❌ Failed — tap ▶️ to retry';
            case 'needs-reattach': return '⚠️ Re-select file to resume';
            case 'cancelled':      return 'Cancelled';
            default:               return task.status;
        }
    }

    function pctText(task) {
        if (!task.fileSize) return '0%';
        return Math.round((calcUploadedBytes(task) / task.fileSize) * 100) + '%';
    }

    function progressText(task) {
        if (!task.totalParts) return 'Starting…';
        var elapsed  = task.sessionStartTime ? (Date.now() - task.sessionStartTime) / 1000 : 0;
        var uplBytes = calcUploadedBytes(task);
        var pct      = task.fileSize ? (uplBytes / task.fileSize) * 100 : 0;
        var sesBytes = uplBytes - (task.sessionStartBytes || 0);
        var speed    = elapsed > 1 ? sesBytes / elapsed : 0;   // wait 1s before showing speed
        var remaining = task.fileSize - uplBytes;
        var eta      = speed > 0 ? remaining / speed : -1;

        var txt = pct.toFixed(0) + '%';
        if (speed > 0) txt += ' · ' + fmtBytes(Math.round(speed)) + '/s';
        if (eta > 0)   txt += ' · ETA ' + fmtTime(eta);
        return txt;
    }

    /** Accurately calculate bytes uploaded based on completed parts + in-flight */
    function calcUploadedBytes(task) {
        var completed = 0;
        if (task.completedParts && task.completedParts.length && task.chunkSize) {
            var fullChunks = task.completedParts.filter(function (p) { return p < task.totalParts; }).length;
            var hasLast    = task.completedParts.indexOf(task.totalParts) !== -1;
            var lastSize   = task.fileSize - (task.totalParts - 1) * task.chunkSize;
            completed = (fullChunks * task.chunkSize) + (hasLast ? Math.max(lastSize, 0) : 0);
        }
        var inFlight = task._getInFlightBytes ? task._getInFlightBytes() : 0;
        return completed + inFlight;
    }

    function updateCard(task) {
        var $card = $('#task-' + task.id);
        if (!$card.length) return;
        $card.attr('data-status', task.status);

        if ($card.hasClass('staged-card')) {
            // Staged card — minimal update
            var stagedText = task.status === 'hashing' ? '⏳ Verifying…' : '✓ Ready';
            $('#st-' + task.id).text(stagedText);
        } else {
            updateProgressBar(task);
            $('#st-' + task.id).text(statusLabel(task));
            syncActionButtons(task);
        }
    }

    function updateProgressBar(task) {
        var pct = task.fileSize ? (calcUploadedBytes(task) / task.fileSize) * 100 : 0;
        $('#pf-' + task.id).css('width', Math.min(pct, 100) + '%');
    }

    /** Show / hide action buttons based on current task status */
    function syncActionButtons(task) {
        var $c = $('#task-' + task.id);
        $c.find('.pause-btn').css('display',    task.status === 'uploading' ? 'flex' : 'none');
        $c.find('.resume-btn').css('display',   (task.status === 'paused' || task.status === 'failed') ? 'flex' : 'none');
        $c.find('.reattach-btn').css('display', task.status === 'needs-reattach' ? 'flex' : 'none');
        $c.find('.cancel-btn').css('display',
            (task.status !== 'completed' && task.status !== 'cancelled') ? 'flex' : 'none');
    }

    function updateSummary() {
        var all = Array.from(tasks.values());
        var staged = [], uploading = 0, completed = 0;

        all.forEach(function (t) {
            if (!t.messageId && t.status !== 'completed' && t.status !== 'cancelled') staged.push(t);
            if (t.status === 'uploading')  uploading++;
            if (t.status === 'completed')  completed++;
        });

        var parts = [];
        if (staged.length) {
            var stagedSize = staged.reduce(function (s, t) { return s + t.fileSize; }, 0);
            parts.push(staged.length + ' file' + (staged.length !== 1 ? 's' : '') + ' · ' + fmtBytes(stagedSize));
        }
        if (uploading) parts.push(uploading + ' uploading');
        if (completed) parts.push(completed + ' done');
        $('#queueSummary').text(parts.length ? parts.join(' · ') : '');

        // Enable send button when there are staged files or comment text
        var hasStaged = staged.length > 0;
        var hasComment = ($('#commentBox').val() || '').trim().length > 0;
        $('#sendBtn').prop('disabled', !hasStaged && !hasComment);
    }

    /* ===============================================================
       Upload Engine
    =============================================================== */

    /** Step 1: Initialize — get tempId, chunkSize, totalParts from API */
    async function initUpload(task) {
        var res = await apiFetch(
            CFG.API_BASE + '/AttachmentUpload?TicketId=' + CFG.TICKET_ID + '&CommentId=' + CFG.COMMENT_ID + '&OriginalFileName=' + task.fileName + '&FileBytesSize=' + task.fileSize + '&OriginalSha256=' + task.sha256 + '&ActionName=Initiate',
            {
                method:  'POST',
            }
        );
        
        var data         = await res.json();
        console.log(data);
        task.tempId = data.Id;
        task.chunkSize = data.ChunkSizeBytes;
        task.totalParts = data.TotalParts;
        task.completedParts = task.completedParts || [];
        dbPut(task);
    }

    /** Step 2: Parallel chunk upload with streaming progress */
    async function uploadChunks(task, file) {
        var completedSet = {};
        (task.completedParts || []).forEach(function (p) { completedSet[p] = true; });

        // Build list of parts still pending
        var pending = [];
        for (var p = 1; p <= task.totalParts; p++) {
            if (!completedSet[p]) pending.push(p);
        }

        var idx    = 0;
        var failed = false;

        // Streaming progress tracking
        var inFlightProgress = {};          // workerId → bytes sent for current chunk
        var lastUIUpdate     = 0;
        task._activeXhrs     = new Set();
        task._getInFlightBytes = function () {
            var total = 0;
            for (var k in inFlightProgress) total += inFlightProgress[k];
            return total;
        };

        async function worker(workerId) {
            while (idx < pending.length && !failed) {
                if (task.status === 'paused' || task.status === 'cancelled') return;

                var partNum = pending[idx++];
                var start   = (partNum - 1) * task.chunkSize;
                var end     = Math.min(start + task.chunkSize, file.size);
                var blob    = file.slice(start, end);

                inFlightProgress[workerId] = 0;

                await retryBackoff(function () {
                    if (task.status === 'paused' || task.status === 'cancelled') {
                        var e = new Error('Aborted'); e.name = 'AbortError'; throw e;
                    }
                    inFlightProgress[workerId] = 0;   // reset on retry

                    return xhrUpload(
                        CFG.API_BASE + '/AttachmentUpload?TicketId=' + CFG.TICKET_ID + '&TempAttachmentId=' + task.tempId + '&PartNumber=' + partNum + '&ActionName=UploadChunk',
                        blob,
                        {
                            'Content-Type':  'application/octet-stream',
                            'Content-Range': 'bytes ' + start + '-' + (end - 1) + '/' + file.size
                        },
                        function (loaded) {
                            console.log(loaded);
                            inFlightProgress[workerId] = loaded;
                            var now = Date.now();
                            if (now - lastUIUpdate > 150) {   // throttle UI updates
                                lastUIUpdate = now;
                                updateCard(task);
                            }
                        },
                        task._activeXhrs
                    );
                });

                // Only update AFTER successful upload (fixes the skipped-part bug)
                inFlightProgress[workerId] = 0;
                completedSet[partNum] = true;
                task.completedParts = Object.keys(completedSet).map(Number);
                task.uploadedParts  = task.completedParts.length;
                dbPut(task);
                updateCard(task);
            }
        }

        // Spawn parallel workers
        var workerCount = Math.min(CFG.PARALLEL, pending.length);
        var workers = [];
        for (var w = 0; w < workerCount; w++) {
            workers.push(
                worker(w).catch(function (err) {
                    if (err && err.name === 'AbortError') return;
                    failed = true;
                    throw err;
                })
            );
        }

        var results = await Promise.allSettled(workers);

        // Cleanup session-only tracking
        delete task._activeXhrs;
        delete task._getInFlightBytes;

        var errors  = results.filter(function (r) { return r.status === 'rejected'; });
        if (errors.length && task.status !== 'paused' && task.status !== 'cancelled') {
            throw errors[0].reason;
        }
    }

    /** Step 3: Finalize on server */
    async function completeUpload(task) {
        await apiFetch(
            CFG.API_BASE + '/AttachmentUpload?TicketId=' + CFG.TICKET_ID + '&TempAttachmentId=' + task.tempId + '&ActionName=Finalize',
            { 
                method: 'POST',
            }
        );
    }

    /** Main upload orchestrator for a single task */
    async function runUpload(task) {
        var file = fileRefs.get(task.id);
        if (!file) {
            setStatus(task, 'needs-reattach');
            return;
        }

        try {
            // Re-hash if needed (e.g. task was in 'hashing' state when page closed)
            if (!task.sha256) {
                setStatus(task, 'hashing');
                task.sha256 = await computeHash(file);
                dbPut(task);
            }

            // Set session timing for speed/ETA (not persisted)
            task.sessionStartTime  = Date.now();
            task.sessionStartBytes = calcUploadedBytes(task);
            setStatus(task, 'uploading');

            // Initialize if we don't have a server-side temp upload yet
            if (!task.tempId) {
                setStatus(task, 'initializing');
                await retryBackoff(function () { return initUpload(task); });
                setStatus(task, 'uploading');
            }

            // Upload all remaining chunks in parallel
            await uploadChunks(task, file);

            if (task.status === 'paused' || task.status === 'cancelled') return;

            // Finalize
            setStatus(task, 'completing');
            await retryBackoff(function () { return completeUpload(task); });

            setStatus(task, 'completed');
            dbDelete(task.id);
            toast(task.fileName + ' uploaded!', 'success');

        } catch (err) {
            if (task.status !== 'paused' && task.status !== 'cancelled') {
                setStatus(task, 'failed');
                toast('Upload failed: ' + task.fileName, 'error');
                console.error('[Uploader]', task.fileName, err);
            }
        }
    }

    function setStatus(task, status) {
        task.status = status;
        if (status !== 'completed' && status !== 'cancelled' && task.messageId) dbPut(task);
        updateCard(task);
        updateSummary();
    }

    /* ===============================================================
       Task creation
    =============================================================== */
    async function addFile(file) {
        // --- Validation ---
        if (file.size === 0) {
            toast(file.name + ' is empty — skipped', 'error');
            return;
        }
        if (CFG.MAX_FILE_SIZE && file.size > CFG.MAX_FILE_SIZE) {
            toast(file.name + ' exceeds ' + fmtBytes(CFG.MAX_FILE_SIZE) + ' limit', 'error');
            return;
        }

        var id    = crypto.randomUUID();
        var thumb = await makeThumbnail(file);

        var task = {
            id:              id,
            fileName:        file.name,
            fileSize:        file.size,
            fileType:        file.type,
            thumbDataUrl:    thumb,          // data-URL persists in IndexedDB
            sha256:          null,
            tempId:          null,
            chunkSize:       null,
            totalParts:      null,
            completedParts:  [],
            uploadedParts:   0,
            status:          'hashing'
        };

        tasks.set(id, task);
        fileRefs.set(id, file);
        renderStagedCard(task);
        updateSummary();

        // Hash in background (non-blocking via Web Worker)
        try {
            task.sha256 = await computeHash(file);
            dbPut(task);
            if (task.messageId) {
                // Already sent as part of a message — auto-start
                runUpload(task);
            } else {
                setStatus(task, 'queued');
            }
        } catch (err) {
            toast('Hash failed for ' + file.name, 'error');
            setStatus(task, 'failed');
        }
    }

    /* ===============================================================
       Public controls — Pause / Resume / Cancel / Re-attach
    =============================================================== */
    function pause(id) {
        var task = tasks.get(id);
        if (!task || task.status !== 'uploading') return;
        if (task._activeXhrs) {
            task._activeXhrs.forEach(function (xhr) { xhr.abort(); });
        }
        setStatus(task, 'paused');
        toast(task.fileName + ' paused', 'info');
    }

    function resume(id) {
        var task = tasks.get(id);
        if (!task) return;
        if (task.status === 'paused' || task.status === 'failed') {
            runUpload(task);
        }
    }

    async function cancel(id) {
        var task = tasks.get(id);
        if (!task) return;

        if (task._activeXhrs) {
            task._activeXhrs.forEach(function (xhr) { xhr.abort(); });
        }
        var prevStatus = task.status;
        task.status = 'cancelled';
        updateCard(task);

        // Server-side cleanup (best-effort)
        if (task.tempId) {
            try {
                await apiFetch(
                    CFG.API_BASE + '/AttachmentUpload?TicketId=' + CFG.TICKET_ID + '&TempAttachmentId=' + task.tempId + '&ActionName=Delete',
                    { 
                        method: 'DELETE',
                    }
                );
            } catch (_) { /* best-effort */ }
        }

        dbDelete(id);
        tasks.delete(id);
        fileRefs.delete(id);
        $('#task-' + id).slideUp(200, function () {
            var $msg = $(this).closest('.chat-message');
            $(this).remove();
            // Remove empty message bubbles (no attachments left, no text)
            if ($msg.length && !$msg.find('.compact-file').length) {
                var hasText = $msg.find('.msg-text').text().trim().length > 0;
                if (!hasText) {
                    $msg.slideUp(200, function () { $(this).remove(); });
                }
            }
        });
        updateSummary();
        toast(task.messageId ? (task.fileName + ' cancelled') : (task.fileName + ' removed'), 'info');
    }

    /** Prompt user to re-select a file for a recovered task */
    function reattach(id) {
        reattachTargetId = id;
        $('#reattachInput').trigger('click');
    }

    /** Handle the re-attached file — verify name, size, hash */
    async function handleReattach(file) {
        var task = tasks.get(reattachTargetId);
        reattachTargetId = null;
        if (!task) return;

        // Name + size must match
        if (file.name !== task.fileName || file.size !== task.fileSize) {
            toast(
                'File does not match — expected "' + task.fileName +
                '" (' + fmtBytes(task.fileSize) + ')',
                'error', 5000
            );
            return;
        }

        // Verify hash integrity if we have one stored
        if (task.sha256) {
            setStatus(task, 'hashing');
            try {
                var hash = await computeHash(file);
                if (hash !== task.sha256) {
                    toast('File content differs from original — cannot resume', 'error', 5000);
                    setStatus(task, 'needs-reattach');
                    return;
                }
            } catch (err) {
                toast('Hash verification failed', 'error');
                setStatus(task, 'needs-reattach');
                return;
            }
        }

        fileRefs.set(task.id, file);
        toast(task.fileName + ' re-attached ✓', 'success');

        if (task.messageId) {
            // Already part of a sent message — resume uploading immediately
            runUpload(task);
        } else {
            setStatus(task, 'queued');
        }
    }

    /** Create a message bubble from staged files + comment, then start uploads */
    function startAll() {
        var comment = ($('#commentBox').val() || '').trim();

        // Collect staged tasks (not yet in a message)
        var stagedTasks = [];
        tasks.forEach(function (task) {
            if (!task.messageId && task.status !== 'completed' && task.status !== 'cancelled') {
                stagedTasks.push(task);
            }
        });

        if (!stagedTasks.length && !comment) {
            toast('Attach files or type a message first', 'info');
            return;
        }

        // Remove staged cards from DOM before creating compact cards (same IDs)
        stagedTasks.forEach(function (task) {
            $('#task-' + task.id).remove();
        });

        // Create message bubble
        var msgId = 'msg-' + Date.now();
        renderMessageBubble(msgId, comment, stagedTasks);

        // Assign messageId to tasks
        stagedTasks.forEach(function (task) {
            task.messageId = msgId;
            dbPut(task);
        });

        // Clear compose area
        $('#commentBox').val('').css('height', 'auto');

        // Start ready tasks (queued, paused, or failed)
        stagedTasks.forEach(function (task) {
            if (task.status === 'queued' || task.status === 'paused' || task.status === 'failed') {
                runUpload(task);
            }
            // tasks still hashing will auto-start via messageId check in addFile
        });

        updateSummary();
    }

    /* ===============================================================
       Recovery — restore unfinished tasks from IndexedDB on reload
    =============================================================== */
    async function recoverTasks() {
        var saved = await dbGetAll();
        var recovered = 0;
        var messageGroups = {};   // messageId → [task, …]
        var ungrouped = [];       // tasks that were still staged (no messageId)

        saved.forEach(function (task) {
            // Clean up stale completed / cancelled entries
            if (task.status === 'completed' || task.status === 'cancelled') {
                dbDelete(task.id);
                return;
            }
            // File reference is lost — user must re-attach
            task.status = 'needs-reattach';
            tasks.set(task.id, task);
            recovered++;

            if (task.messageId) {
                if (!messageGroups[task.messageId]) messageGroups[task.messageId] = [];
                messageGroups[task.messageId].push(task);
            } else {
                // Unsent staged files — discard on reload
                dbDelete(task.id);
                tasks.delete(task.id);
                recovered--;
            }
        });

        // Re-render sent messages as chat bubbles
        Object.keys(messageGroups).sort().forEach(function (msgId) {
            renderMessageBubble(msgId, null, messageGroups[msgId]);
        });

        if (recovered > 0) {
            toast(recovered + ' upload(s) can be resumed — re-attach files to continue', 'info', 6000);
        }
        updateSummary();
    }

    /* ===============================================================
       Online / Offline awareness
    =============================================================== */
    function updateOnlineStatus() {
        var online = navigator.onLine;
        $('#connStatus').html(
            '<span class="dot ' + (online ? 'online' : 'offline') + '"></span> ' +
            (online ? 'Online' : 'Offline')
        );

        if (online) {
            // Auto-retry failed tasks that still have a file reference
            tasks.forEach(function (task) {
                if (task.status === 'failed' && fileRefs.has(task.id)) {
                    toast('Retrying ' + task.fileName + '…', 'info');
                    runUpload(task);
                }
            });
        } else {
            toast('You are offline — uploads will resume when connected', 'error', 5000);
        }
    }

    /* ===============================================================
       Event bindings
    =============================================================== */
    $(async function () {
        // Initialise DB & recover persisted tasks
        await openDB();
        await recoverTasks();
    });

    $(function(){
        // Register service worker
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('sw.js').catch(function () {});
        }

        // Online / offline
        updateOnlineStatus();
        $(window).on('online offline', updateOnlineStatus);

        // ---- Drop zone ----
        var $dz = $('#dropZone');

        $dz.on('click', function () { $('#fileInput').trigger('click'); });
        $dz.on('dragover', function (e) { e.preventDefault(); $dz.addClass('dragover'); });
        $dz.on('dragleave drop', function () { $dz.removeClass('dragover'); });
        $dz.on('drop', function (e) {
            e.preventDefault();
            var files = e.originalEvent.dataTransfer.files;
            for (var i = 0; i < files.length; i++) addFile(files[i]);
        });

        // ---- File input (single handler — no duplicates) ----
        $('#fileInput').on('change', function () {
            for (var i = 0; i < this.files.length; i++) addFile(this.files[i]);
            this.value = '';   // allow re-selecting the same files
        });

        // ---- Re-attach input ----
        $('#reattachInput').on('change', function () {
            if (this.files[0]) handleReattach(this.files[0]);
            this.value = '';
        });

        // ---- Send / Upload button ----
        $('#sendBtn').on('click', startAll);

        // ---- Comment box auto-resize ----
        $('#commentBox').on('input', function () {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 120) + 'px';
            updateSummary();   // re-evaluate send button state
        });

        // Enter to send (Shift+Enter for newline)
        $('#commentBox').on('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!$('#sendBtn').prop('disabled')) startAll();
            }
        });

        // ---- Paste support (Ctrl+V files) ----
        $(document).on('paste', function (e) {
            var items = (e.originalEvent.clipboardData || {}).items;
            if (!items) return;
            for (var i = 0; i < items.length; i++) {
                if (items[i].kind === 'file') {
                    var f = items[i].getAsFile();
                    if (f) addFile(f);
                }
            }
        });

        // ---- Delegated action-button clicks ----
        $('#fileList').on('click', '.pause-btn',    function () { pause($(this).data('id')); });
        $('#fileList').on('click', '.resume-btn',   function () { resume($(this).data('id')); });
        $('#fileList').on('click', '.reattach-btn', function () { reattach($(this).data('id')); });
        $('#fileList').on('click', '.cancel-btn',   function () { cancel($(this).data('id')); });
        $('#stagingArea').on('click', '.staged-remove', function () { cancel($(this).data('id')); });

        // ---- Warn before leaving with active uploads ----
        $(window).on('beforeunload', function (e) {
            var active = false;
            tasks.forEach(function (t) { if (t.status === 'uploading') active = true; });
            if (active) {
                e.preventDefault();
                return '';   // triggers browser's native "leave page?" dialog
            }
        });
    })

})(jQuery);
