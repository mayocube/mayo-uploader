/* ============================================================================
   ChunkUploader — Reusable jQuery Plugin
   ========================================
   Usage:
     $('#myDiv').chunkUploader({ ... options ... });

   Options (all overridable):
     apiBase           — Base URL for upload API (default '/api')
     ticketId          — Ticket ID for the upload endpoint
     commentId         — Comment ID attached to upload
     isPublic          — Whether attachment is public (default true)
     placedBy          — Object { EmployeeId, ContactId, Email }
     parallel          — Concurrent chunk workers per file (default 1)
     maxRetries        — Max retry attempts with back-off (default 6)
     retryBaseMs       — Base delay for exponential back-off (default 1000)
     thumbMaxPx        — Max thumbnail dimension in px (default 120)
     maxFileSize       — Max file size in bytes (default 5 GB)
     dbName            — IndexedDB database name (default 'ChunkUploaderDB')
     dbVersion         — IndexedDB version (default 2)
     dbStore           — IndexedDB store name (default 'tasks')
     workerPath        — Path to hashWorker.js (default 'chunk-uploader-worker.js')
     title             — Header title text (default '💬 Attachment Uploader')
     emptyText         — Placeholder text when list is empty
     dropZoneText      — Text inside the drop zone
     commentPlaceholder— Placeholder for the comment textarea
     showComment       — Show comment box (default true)
     showHeader        — Show the header bar (default true)
     enablePaste       — Enable Ctrl+V paste support (default true)
     enableServiceWorker— Register a service worker (default false)
     serviceWorkerPath — Path to sw.js (default 'sw.js')
     autoRecover       — Recover unfinished uploads on init (default true)

   Events (callbacks):
     onFileAdded(task)              — Fired when a file is staged
     onUploadStart(task)            — Fired when upload begins
     onUploadProgress(task, pct)    — Fired on progress update
     onUploadComplete(task)         — Fired when a single file completes
     onUploadFailed(task, error)    — Fired when a file upload fails
     onAllComplete()                — Fired when all uploads finish
     onToast(message, type)         — Fired for toast notifications

   Public API (returned instance):
     instance.addFiles(fileList)    — Programmatically add files
     instance.send(comment?)        — Trigger send / start uploads
     instance.pause(taskId)         — Pause a specific upload
     instance.resume(taskId)        — Resume a specific upload
     instance.cancel(taskId)        — Cancel a specific upload
     instance.pauseAll()            — Pause all active uploads
     instance.resumeAll()           — Resume all paused/failed uploads
     instance.cancelAll()           — Cancel everything
     instance.getTasks()            — Get current tasks Map
     instance.destroy()             — Tear down the plugin entirely
============================================================================ */

;(function ($, window, document, undefined) {
    'use strict';

    var pluginName = 'chunkUploader';

    /* ---------------------------------------------------------------
       Default options
    --------------------------------------------------------------- */
    var DEFAULTS = {
        // API
        apiBase:            '/api',
        ticketId:           null,
        commentId:          null,
        isPublic:           true,
        placedBy:           null,   // { EmployeeId, ContactId, Email }

        // Engine
        parallel:           1,
        maxRetries:         6,
        retryBaseMs:        1000,
        thumbMaxPx:         120,
        maxFileSize:        5 * 1024 * 1024 * 1024,  // 5 GB

        // Persistence
        dbName:             'ChunkUploaderDB',
        dbVersion:          2,
        dbStore:            'tasks',

        // Worker
        workerPath:         'chunk-uploader-worker.js',

        // UI text
        title:              '💬 Attachment Uploader',
        emptyText:          'Your messages will appear here',
        dropZoneText:       'Drop files here or click to attach',
        commentPlaceholder: 'Type a message…',

        // Feature toggles
        showComment:        true,
        showHeader:         true,
        enablePaste:        true,
        enableServiceWorker: false,
        serviceWorkerPath:  'sw.js',
        autoRecover:        true,

        // Event callbacks
        onFileAdded:        null,
        onUploadStart:      null,
        onUploadProgress:   null,
        onUploadComplete:   null,
        onUploadFailed:     null,
        onAllComplete:      null,
        onToast:            null
    };

    /* ---------------------------------------------------------------
       Plugin constructor
    --------------------------------------------------------------- */
    function ChunkUploader(element, options) {
        this.el  = element;
        this.$el = $(element);
        this.cfg = $.extend({}, DEFAULTS, options);

        // Instance state
        this.db             = null;
        this.tasks          = new Map();
        this.fileRefs       = new Map();
        this.hashWorker     = null;
        this.hashPending    = new Map();
        this.reattachTargetId = null;
        this._uid           = 'nct' + Math.random().toString(36).substr(2, 8);
        this._destroyed     = false;

        // Ensure unique toast container per instance
        this.$toast = null;

        this._init();
    }

    /* ===============================================================
       Initialisation
    =============================================================== */
    ChunkUploader.prototype._init = function () {
        var self = this;

        // Build DOM
        this._buildDOM();

        // Start hash worker
        this.hashWorker = new Worker(this.cfg.workerPath);
        this.hashWorker.onmessage = function (e) { self._onHashMessage(e); };

        // Open DB & recover
        this._openDB().then(function () {
            if (self.cfg.autoRecover) self._recoverTasks();
        });

        // Bind events
        this._bindEvents();

        // Service worker
        if (this.cfg.enableServiceWorker && 'serviceWorker' in navigator) {
            navigator.serviceWorker.register(this.cfg.serviceWorkerPath).catch(function () {});
        }
    };

    /* ===============================================================
       DOM Construction
    =============================================================== */
    ChunkUploader.prototype._buildDOM = function () {
        var c = this.cfg;
        var uid = this._uid;

        var html = '';

        // Header
        if (c.showHeader) {
            html +=
                '<div class="nct-header">' +
                    '<h2>' + this._escHtml(c.title) + '</h2>' +
                    '<div class="nct-conn-status" id="' + uid + '-conn">' +
                        '<span class="nct-dot online"></span> Online' +
                    '</div>' +
                '</div>';
        }

        // File list
        html += '<div class="nct-file-list" id="' + uid + '-list" data-empty-text="' + this._escHtml(c.emptyText) + '"></div>';

        // Compose area
        html += '<div class="nct-compose-area">';

        // Drop zone
        html +=
            '<div class="nct-drop-zone" id="' + uid + '-drop">' +
                '<span class="nct-drop-icon">📎</span>' +
                '<span>' + this._escHtml(c.dropZoneText) + '</span>' +
            '</div>';

        // Staging area
        html += '<div class="nct-staging-area" id="' + uid + '-staging"></div>';

        // Hidden inputs
        html += '<input type="file" id="' + uid + '-fileInput" multiple hidden>';
        html += '<input type="file" id="' + uid + '-reattachInput" hidden>';

        // Compose bar
        if (c.showComment) {
            html +=
                '<div class="nct-compose-bar">' +
                    '<textarea id="' + uid + '-comment" placeholder="' + this._escHtml(c.commentPlaceholder) + '" rows="1"></textarea>' +
                    '<button class="nct-send-btn" id="' + uid + '-send" disabled title="Send / Start Upload">' +
                        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                            '<path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/>' +
                        '</svg>' +
                    '</button>' +
                '</div>';
        } else {
            html +=
                '<div class="nct-compose-bar">' +
                    '<button class="nct-send-btn" id="' + uid + '-send" disabled title="Start Upload" style="width:100%;border-radius:12px;">' +
                        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                            '<path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/>' +
                        '</svg>' +
                        '&nbsp; Upload' +
                    '</button>' +
                '</div>';
        }

        // Queue summary
        html += '<div class="nct-queue-summary" id="' + uid + '-summary"></div>';
        html += '</div>'; // end compose-area

        this.$el.addClass('nct-uploader').html(html);

        // Toast container (global singleton per page, shared between instances)
        if (!$('#nctToastContainer').length) {
            $('body').append('<div class="nct-toast-container" id="nctToastContainer"></div>');
        }
        this.$toast = $('#nctToastContainer');
    };

    /* ===============================================================
       IndexedDB
    =============================================================== */
    ChunkUploader.prototype._openDB = function () {
        var self = this;
        var c    = this.cfg;
        return new Promise(function (resolve, reject) {
            var req = indexedDB.open(c.dbName, c.dbVersion);
            req.onupgradeneeded = function (e) {
                var d = e.target.result;
                if (!d.objectStoreNames.contains(c.dbStore)) {
                    d.createObjectStore(c.dbStore, { keyPath: 'id' });
                }
            };
            req.onsuccess = function (e) { self.db = e.target.result; resolve(); };
            req.onerror   = function ()  { reject(req.error); };
        });
    };

    ChunkUploader.prototype._dbPut = function (task) {
        var clone = $.extend({}, task);
        delete clone.sessionStartTime;
        delete clone.sessionStartBytes;
        delete clone._activeXhrs;
        delete clone._getInFlightBytes;
        var tx = this.db.transaction(this.cfg.dbStore, 'readwrite');
        tx.objectStore(this.cfg.dbStore).put(clone);
    };

    ChunkUploader.prototype._dbDelete = function (id) {
        var tx = this.db.transaction(this.cfg.dbStore, 'readwrite');
        tx.objectStore(this.cfg.dbStore).delete(id);
    };

    ChunkUploader.prototype._dbGetAll = function () {
        var store = this.cfg.dbStore;
        var db    = this.db;
        return new Promise(function (resolve, reject) {
            var tx  = db.transaction(store, 'readonly');
            var req = tx.objectStore(store).getAll();
            req.onsuccess = function () { resolve(req.result); };
            req.onerror   = function () { reject(req.error); };
        });
    };

    /* ===============================================================
       API fetch
    =============================================================== */
    ChunkUploader.prototype._apiFetch = function (url, opts) {
        opts = opts || {};
        return fetch(url, opts).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res;
        });
    };

    /* ===============================================================
       XHR upload with streaming progress
    =============================================================== */
    ChunkUploader.prototype._xhrUpload = function (url, blob, headers, onProgress, activeXhrs) {
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
    };

    /* ===============================================================
       SHA-256 via Web Worker
    =============================================================== */
    ChunkUploader.prototype._onHashMessage = function (e) {
        var data    = e.data;
        var pending = this.hashPending.get(data.id);
        if (!pending) return;
        this.hashPending.delete(data.id);
        if (data.error) pending.reject(new Error(data.error));
        else            pending.resolve(data.hash);
    };

    ChunkUploader.prototype._computeHash = function (file) {
        var self = this;
        return new Promise(function (resolve, reject) {
            var msgId = crypto.randomUUID();
            self.hashPending.set(msgId, { resolve: resolve, reject: reject });
            self.hashWorker.postMessage({ id: msgId, file: file });
        });
    };

    /* ===============================================================
       Utility helpers
    =============================================================== */
    ChunkUploader.prototype._fmtBytes = function (b) {
        if (b < 1024)        return b + ' B';
        if (b < 1048576)     return (b / 1024).toFixed(1) + ' KB';
        if (b < 1073741824)  return (b / 1048576).toFixed(1) + ' MB';
        return (b / 1073741824).toFixed(2) + ' GB';
    };

    ChunkUploader.prototype._fmtTime = function (s) {
        if (!isFinite(s) || s < 0) return '--';
        if (s < 60)   return Math.ceil(s) + 's';
        if (s < 3600) return Math.floor(s / 60) + 'm ' + Math.ceil(s % 60) + 's';
        return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    };

    var FILE_ICONS = {
        pdf:'📕', doc:'📘', docx:'📘', xls:'📗', xlsx:'📗',
        ppt:'📙', pptx:'📙', zip:'📦', rar:'📦', '7z':'📦',
        mp4:'🎬', avi:'🎬', mov:'🎬', mkv:'🎬', webm:'🎬',
        mp3:'🎵', wav:'🎵', ogg:'🎵', flac:'🎵',
        txt:'📝', csv:'📊', json:'📋', xml:'📋', html:'🌐',
        svg:'🎨', psd:'🎨', ai:'🎨', fig:'🎨'
    };

    ChunkUploader.prototype._fileIcon = function (name) {
        var ext = (name.split('.').pop() || '').toLowerCase();
        return FILE_ICONS[ext] || '📄';
    };

    ChunkUploader.prototype._escHtml = function (s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };

    ChunkUploader.prototype._makeThumbnail = function (file) {
        var maxPx = this.cfg.thumbMaxPx;
        return new Promise(function (resolve) {
            if (!file.type.startsWith('image/')) { resolve(null); return; }
            var reader = new FileReader();
            reader.onload = function () {
                var img = new Image();
                img.onload = function () {
                    var c = document.createElement('canvas');
                    var M = maxPx;
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
    };

    /* ===============================================================
       Exponential back-off with jitter
    =============================================================== */
    ChunkUploader.prototype._retryBackoff = function (fn, maxRetries) {
        maxRetries = maxRetries || this.cfg.maxRetries;
        var delay = this.cfg.retryBaseMs;

        return (async function () {
            for (var i = 0; i <= maxRetries; i++) {
                try { return await fn(); }
                catch (err) {
                    if (i === maxRetries) throw err;
                    await new Promise(function (r) { setTimeout(r, delay + Math.random() * 500); });
                    delay *= 2;
                }
            }
        })();
    };

    /* ===============================================================
       Toast notifications
    =============================================================== */
    ChunkUploader.prototype._toast = function (msg, type, duration) {
        type     = type || 'info';
        duration = duration || 4000;

        // Fire callback
        if (typeof this.cfg.onToast === 'function') {
            this.cfg.onToast(msg, type);
        }

        var $t = $('<div class="nct-toast ' + type + '"></div>').text(msg);
        this.$toast.append($t);
        setTimeout(function () { $t.addClass('show'); }, 20);
        setTimeout(function () {
            $t.removeClass('show');
            setTimeout(function () { $t.remove(); }, 300);
        }, duration);
    };

    /* ===============================================================
       UI — Rendering & updates
    =============================================================== */
    ChunkUploader.prototype._renderStagedCard = function (task) {
        var thumbHtml = task.thumbDataUrl
            ? '<img height="24" width="24" style="object-fit: contain;" src="' + task.thumbDataUrl + '" alt="">'
            : '<span class="nct-icon">' + this._fileIcon(task.fileName) + '</span>';
        var statusText = task.status === 'hashing' ? '⏳ Verifying…' : '✓ Ready';
        var html =
            '<div class="nct-staged-card" id="task-' + task.id + '" data-status="' + task.status + '">' +
                '<span class="nct-staged-icon">' + thumbHtml + '</span>' +
                '<span class="nct-staged-name" title="' + this._escHtml(task.fileName) + '">' + this._escHtml(task.fileName) + '</span>' +
                '<span class="nct-staged-size">' + this._fmtBytes(task.fileSize) + '</span>' +
                '<span class="nct-staged-status" id="st-' + task.id + '">' + statusText + '</span>' +
                '<button class="nct-staged-remove" data-id="' + task.id + '" title="Remove">✕</button>' +
            '</div>';
        $('#' + this._uid + '-staging').append(html);
    };

    ChunkUploader.prototype._renderMessageBubble = function (msgId, comment, taskList) {
        var self = this;
        var html = '<div class="nct-chat-message" id="' + msgId + '">' +
            '<div class="nct-msg-bubble">';

        if (comment) {
            html += '<div class="nct-msg-text">' + this._escHtml(comment).replace(/\n/g, '<br>') + '</div>';
        }

        if (taskList.length) {
            html += '<div class="nct-msg-attachments">';
            taskList.forEach(function (task) {
                html += self._renderCompactCardHtml(task);
            });
            html += '</div>';
        }

        var now  = new Date();
        var time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        html += '<div class="nct-msg-time">' + time + '</div>';
        html += '</div></div>';

        var $list = $('#' + this._uid + '-list');
        $list.append(html);
        $list.scrollTop($list[0].scrollHeight);

        taskList.forEach(function (task) {
            self._syncActionButtons(task);
            self._updateProgressBar(task);
        });
    };

    ChunkUploader.prototype._renderCompactCardHtml = function (task) {
        var thumbHtml = task.thumbDataUrl
            ? '<img src="' + task.thumbDataUrl + '" alt="">'
            : '<span>' + this._fileIcon(task.fileName) + '</span>';

        return '<div class="nct-compact-file" id="task-' + task.id + '" data-status="' + task.status + '">' +
            '<div class="nct-compact-icon">' + thumbHtml + '</div>' +
            '<div class="nct-compact-body">' +
                '<div class="nct-compact-name-row">' +
                    '<span class="nct-compact-name" title="' + this._escHtml(task.fileName) + '">' + this._escHtml(task.fileName) + '</span>' +
                    '<span class="nct-compact-size">' + this._fmtBytes(task.fileSize) + '</span>' +
                '</div>' +
                '<div class="nct-progress-track"><div class="nct-progress-fill" id="pf-' + task.id + '"></div></div>' +
                '<div class="nct-file-status" id="st-' + task.id + '">' + this._statusLabel(task) + '</div>' +
            '</div>' +
            '<div class="nct-file-actions">' +
                '<button class="nct-act-btn nct-pause-btn"    title="Pause"          data-id="' + task.id + '">⏸</button>' +
                '<button class="nct-act-btn nct-resume-btn"   title="Resume"         data-id="' + task.id + '">▶️</button>' +
                '<button class="nct-act-btn nct-reattach-btn" title="Re-attach file" data-id="' + task.id + '">📂</button>' +
                '<button class="nct-act-btn nct-cancel-btn"   title="Cancel"         data-id="' + task.id + '">✕</button>' +
            '</div>' +
        '</div>';
    };

    ChunkUploader.prototype._statusLabel = function (task) {
        switch (task.status) {
            case 'queued':         return 'Queued';
            case 'hashing':        return 'Verifying file…';
            case 'initializing':   return 'Initializing…';
            case 'uploading':      return this._progressText(task);
            case 'paused':         return 'Paused — ' + this._pctText(task);
            case 'completing':     return 'Finalizing…';
            case 'completed':      return '✅ Completed';
            case 'failed':         return '❌ Failed — tap ▶️ to retry';
            case 'needs-reattach': return '⚠️ Re-select file to resume';
            case 'cancelled':      return 'Cancelled';
            default:               return task.status;
        }
    };

    ChunkUploader.prototype._pctText = function (task) {
        if (!task.fileSize) return '0%';
        return Math.round((this._calcUploadedBytes(task) / task.fileSize) * 100) + '%';
    };

    ChunkUploader.prototype._progressText = function (task) {
        if (!task.totalParts) return 'Starting…';
        var elapsed  = task.sessionStartTime ? (Date.now() - task.sessionStartTime) / 1000 : 0;
        var uplBytes = this._calcUploadedBytes(task);
        var pct      = task.fileSize ? (uplBytes / task.fileSize) * 100 : 0;
        var sesBytes = uplBytes - (task.sessionStartBytes || 0);
        var speed    = elapsed > 1 ? sesBytes / elapsed : 0;
        var remaining = task.fileSize - uplBytes;
        var eta      = speed > 0 ? remaining / speed : -1;

        var txt = pct.toFixed(0) + '%';
        if (speed > 0) txt += ' · ' + this._fmtBytes(Math.round(speed)) + '/s';
        if (eta > 0)   txt += ' · ETA ' + this._fmtTime(eta);
        return txt;
    };

    ChunkUploader.prototype._calcUploadedBytes = function (task) {
        var completed = 0;
        if (task.completedParts && task.completedParts.length && task.chunkSize) {
            var fullChunks = task.completedParts.filter(function (p) { return p < task.totalParts; }).length;
            var hasLast    = task.completedParts.indexOf(task.totalParts) !== -1;
            var lastSize   = task.fileSize - (task.totalParts - 1) * task.chunkSize;
            completed = (fullChunks * task.chunkSize) + (hasLast ? Math.max(lastSize, 0) : 0);
        }
        var inFlight = task._getInFlightBytes ? task._getInFlightBytes() : 0;
        return completed + inFlight;
    };

    ChunkUploader.prototype._updateCard = function (task) {
        var $card = $('#task-' + task.id);
        if (!$card.length) return;
        $card.attr('data-status', task.status);

        if ($card.hasClass('nct-staged-card')) {
            var stagedText = task.status === 'hashing' ? '⏳ Verifying…' : '✓ Ready';
            $('#st-' + task.id).text(stagedText);
        } else {
            this._updateProgressBar(task);
            $('#st-' + task.id).text(this._statusLabel(task));
            this._syncActionButtons(task);
        }
    };

    ChunkUploader.prototype._updateProgressBar = function (task) {
        var pct = task.fileSize ? (this._calcUploadedBytes(task) / task.fileSize) * 100 : 0;
        $('#pf-' + task.id).css('width', Math.min(pct, 100) + '%');
    };

    ChunkUploader.prototype._syncActionButtons = function (task) {
        var $c = $('#task-' + task.id);
        $c.find('.nct-pause-btn').css('display',    task.status === 'uploading' ? 'flex' : 'none');
        $c.find('.nct-resume-btn').css('display',   (task.status === 'paused' || task.status === 'failed') ? 'flex' : 'none');
        $c.find('.nct-reattach-btn').css('display', task.status === 'needs-reattach' ? 'flex' : 'none');
        $c.find('.nct-cancel-btn').css('display',
            (task.status !== 'completed' && task.status !== 'cancelled') ? 'flex' : 'none');
    };

    ChunkUploader.prototype._updateSummary = function () {
        var self = this;
        var uid  = this._uid;
        var all  = Array.from(this.tasks.values());
        var staged = [], uploading = 0, completed = 0;

        all.forEach(function (t) {
            if (!t.messageId && t.status !== 'completed' && t.status !== 'cancelled') staged.push(t);
            if (t.status === 'uploading')  uploading++;
            if (t.status === 'completed')  completed++;
        });

        var parts = [];
        if (staged.length) {
            var stagedSize = staged.reduce(function (s, t) { return s + t.fileSize; }, 0);
            parts.push(staged.length + ' file' + (staged.length !== 1 ? 's' : '') + ' · ' + self._fmtBytes(stagedSize));
        }
        if (uploading) parts.push(uploading + ' uploading');
        if (completed) parts.push(completed + ' done');
        $('#' + uid + '-summary').text(parts.length ? parts.join(' · ') : '');

        var hasStaged  = staged.length > 0;
        var hasComment = ($('#' + uid + '-comment').val() || '').trim().length > 0;
        $('#' + uid + '-send').prop('disabled', !hasStaged && !hasComment);

        // Check if all tasks are completed
        if (all.length > 0 && all.every(function (t) { return t.status === 'completed' || t.status === 'cancelled'; })) {
            if (typeof self.cfg.onAllComplete === 'function') self.cfg.onAllComplete();
        }
    };

    /* ===============================================================
       Upload Engine
    =============================================================== */
    ChunkUploader.prototype._initUpload = async function (task) {
        var c = this.cfg;

        var body = {
            CommentId:        c.commentId,
            IsPublic:         c.isPublic,
            OriginalFileName: task.fileName,
            FileSizeBytes:    task.fileSize,
            OriginalSha256:   task.sha256
        };

        if (c.placedBy) body.PlacedBy = c.placedBy;

        var res = await this._apiFetch(
            c.apiBase + '/tickets/' + c.ticketId + '/upload_attachments',
            {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(body)
            }
        );

        var data         = await res.json();
        task.tempId      = data.id;
        task.chunkSize   = data.chunkSizeBytes;
        task.totalParts  = data.totalParts;
        task.completedParts = task.completedParts || [];
        this._dbPut(task);
    };

    ChunkUploader.prototype._uploadChunks = async function (task, file) {
        var self = this;
        var c    = this.cfg;
        var completedSet = {};
        (task.completedParts || []).forEach(function (p) { completedSet[p] = true; });

        var pending = [];
        for (var p = 1; p <= task.totalParts; p++) {
            if (!completedSet[p]) pending.push(p);
        }

        var idx    = 0;
        var failed = false;
        var inFlightProgress = {};
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

                await self._retryBackoff(function () {
                    if (task.status === 'paused' || task.status === 'cancelled') {
                        var e = new Error('Aborted'); e.name = 'AbortError'; throw e;
                    }
                    inFlightProgress[workerId] = 0;

                    return self._xhrUpload(
                        c.apiBase + '/tickets/' + c.ticketId +
                        '/upload_attachments/' + task.tempId + '/parts/' + partNum,
                        blob,
                        {
                            'Content-Type':  'application/octet-stream',
                            'Content-Range': 'bytes ' + start + '-' + (end - 1) + '/' + file.size
                        },
                        function (loaded) {
                            inFlightProgress[workerId] = loaded;
                            var now = Date.now();
                            if (now - lastUIUpdate > 150) {
                                lastUIUpdate = now;
                                self._updateCard(task);

                                // Fire progress callback
                                if (typeof self.cfg.onUploadProgress === 'function') {
                                    var pct = task.fileSize ? (self._calcUploadedBytes(task) / task.fileSize) * 100 : 0;
                                    self.cfg.onUploadProgress(task, pct);
                                }
                            }
                        },
                        task._activeXhrs
                    );
                });

                inFlightProgress[workerId] = 0;
                completedSet[partNum] = true;
                task.completedParts = Object.keys(completedSet).map(Number);
                task.uploadedParts  = task.completedParts.length;
                self._dbPut(task);
                self._updateCard(task);
            }
        }

        var workerCount = Math.min(c.parallel, pending.length);
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
        delete task._activeXhrs;
        delete task._getInFlightBytes;

        var errors = results.filter(function (r) { return r.status === 'rejected'; });
        if (errors.length && task.status !== 'paused' && task.status !== 'cancelled') {
            throw errors[0].reason;
        }
    };

    ChunkUploader.prototype._completeUpload = async function (task) {
        var c = this.cfg;
        await this._apiFetch(
            c.apiBase + '/tickets/' + c.ticketId +
            '/upload_attachments/' + task.tempId + '/complete',
            { method: 'POST' }
        );
    };

    ChunkUploader.prototype._runUpload = async function (task) {
        var self = this;
        var file = this.fileRefs.get(task.id);
        if (!file) {
            this._setStatus(task, 'needs-reattach');
            return;
        }

        try {
            if (typeof this.cfg.onUploadStart === 'function') this.cfg.onUploadStart(task);

            if (!task.sha256) {
                this._setStatus(task, 'hashing');
                task.sha256 = await this._computeHash(file);
                this._dbPut(task);
            }

            task.sessionStartTime  = Date.now();
            task.sessionStartBytes = this._calcUploadedBytes(task);
            this._setStatus(task, 'uploading');

            if (!task.tempId) {
                this._setStatus(task, 'initializing');
                await this._retryBackoff(function () { return self._initUpload(task); });
                this._setStatus(task, 'uploading');
            }

            await this._uploadChunks(task, file);

            if (task.status === 'paused' || task.status === 'cancelled') return;

            this._setStatus(task, 'completing');
            await this._retryBackoff(function () { return self._completeUpload(task); });

            this._setStatus(task, 'completed');
            this._dbDelete(task.id);
            this._toast(task.fileName + ' uploaded!', 'success');

            if (typeof this.cfg.onUploadComplete === 'function') this.cfg.onUploadComplete(task);

        } catch (err) {
            if (task.status !== 'paused' && task.status !== 'cancelled') {
                this._setStatus(task, 'failed');
                this._toast('Upload failed: ' + task.fileName, 'error');

                if (typeof this.cfg.onUploadFailed === 'function') this.cfg.onUploadFailed(task, err);
            }
        }
    };

    ChunkUploader.prototype._setStatus = function (task, status) {
        task.status = status;
        if (status !== 'completed' && status !== 'cancelled' && task.messageId) this._dbPut(task);
        this._updateCard(task);
        this._updateSummary();
    };

    /* ===============================================================
       Task creation
    =============================================================== */
    ChunkUploader.prototype._addFile = async function (file) {
        var self = this;
        var c    = this.cfg;

        if (file.size === 0) {
            this._toast(file.name + ' is empty — skipped', 'error');
            return;
        }
        if (c.maxFileSize && file.size > c.maxFileSize) {
            this._toast(file.name + ' exceeds ' + this._fmtBytes(c.maxFileSize) + ' limit', 'error');
            return;
        }

        var id    = crypto.randomUUID();
        var thumb = await this._makeThumbnail(file);

        var task = {
            id:              id,
            fileName:        file.name,
            fileSize:        file.size,
            fileType:        file.type,
            thumbDataUrl:    thumb,
            sha256:          null,
            tempId:          null,
            chunkSize:       null,
            totalParts:      null,
            completedParts:  [],
            uploadedParts:   0,
            status:          'hashing'
        };

        this.tasks.set(id, task);
        this.fileRefs.set(id, file);
        this._renderStagedCard(task);
        this._updateSummary();

        if (typeof this.cfg.onFileAdded === 'function') this.cfg.onFileAdded(task);

        try {
            task.sha256 = await this._computeHash(file);
            this._dbPut(task);
            if (task.messageId) {
                this._runUpload(task);
            } else {
                this._setStatus(task, 'queued');
            }
        } catch (err) {
            this._toast('Hash failed for ' + file.name, 'error');
            this._setStatus(task, 'failed');
        }
    };

    /* ===============================================================
       Controls — Pause / Resume / Cancel / Re-attach
    =============================================================== */
    ChunkUploader.prototype.pause = function (id) {
        var task = this.tasks.get(id);
        if (!task || task.status !== 'uploading') return;
        if (task._activeXhrs) {
            task._activeXhrs.forEach(function (xhr) { xhr.abort(); });
        }
        this._setStatus(task, 'paused');
        this._toast(task.fileName + ' paused', 'info');
    };

    ChunkUploader.prototype.resume = function (id) {
        var task = this.tasks.get(id);
        if (!task) return;
        if (task.status === 'paused' || task.status === 'failed') {
            this._runUpload(task);
        }
    };

    ChunkUploader.prototype.cancel = async function (id) {
        var self = this;
        var task = this.tasks.get(id);
        if (!task) return;

        if (task._activeXhrs) {
            task._activeXhrs.forEach(function (xhr) { xhr.abort(); });
        }
        task.status = 'cancelled';
        this._updateCard(task);

        if (task.tempId) {
            try {
                await this._apiFetch(
                    this.cfg.apiBase + '/tickets/' + this.cfg.ticketId +
                    '/upload_attachments/' + task.tempId,
                    { method: 'DELETE' }
                );
            } catch (_) { /* best-effort */ }
        }

        this._dbDelete(id);
        this.tasks.delete(id);
        this.fileRefs.delete(id);
        $('#task-' + id).slideUp(200, function () {
            var $msg = $(this).closest('.nct-chat-message');
            $(this).remove();
            if ($msg.length && !$msg.find('.nct-compact-file').length) {
                var hasText = $msg.find('.nct-msg-text').text().trim().length > 0;
                if (!hasText) {
                    $msg.slideUp(200, function () { $(this).remove(); });
                }
            }
        });
        this._updateSummary();
        this._toast(task.messageId ? (task.fileName + ' cancelled') : (task.fileName + ' removed'), 'info');
    };

    ChunkUploader.prototype._reattach = function (id) {
        this.reattachTargetId = id;
        $('#' + this._uid + '-reattachInput').trigger('click');
    };

    ChunkUploader.prototype._handleReattach = async function (file) {
        var task = this.tasks.get(this.reattachTargetId);
        this.reattachTargetId = null;
        if (!task) return;

        if (file.name !== task.fileName || file.size !== task.fileSize) {
            this._toast(
                'File does not match — expected "' + task.fileName +
                '" (' + this._fmtBytes(task.fileSize) + ')',
                'error', 5000
            );
            return;
        }

        if (task.sha256) {
            this._setStatus(task, 'hashing');
            try {
                var hash = await this._computeHash(file);
                if (hash !== task.sha256) {
                    this._toast('File content differs from original — cannot resume', 'error', 5000);
                    this._setStatus(task, 'needs-reattach');
                    return;
                }
            } catch (err) {
                this._toast('Hash verification failed', 'error');
                this._setStatus(task, 'needs-reattach');
                return;
            }
        }

        this.fileRefs.set(task.id, file);
        this._toast(task.fileName + ' re-attached ✓', 'success');

        if (task.messageId) {
            this._runUpload(task);
        } else {
            this._setStatus(task, 'queued');
        }
    };

    /* ===============================================================
       Send / Start all
    =============================================================== */
    ChunkUploader.prototype.send = function (comment) {
        var self = this;
        var uid  = this._uid;

        if (comment === undefined) {
            comment = ($('#' + uid + '-comment').val() || '').trim();
        }

        var stagedTasks = [];
        this.tasks.forEach(function (task) {
            if (!task.messageId && task.status !== 'completed' && task.status !== 'cancelled') {
                stagedTasks.push(task);
            }
        });

        if (!stagedTasks.length && !comment) {
            this._toast('Attach files or type a message first', 'info');
            return;
        }

        stagedTasks.forEach(function (task) {
            $('#task-' + task.id).remove();
        });

        var msgId = 'msg-' + Date.now();
        this._renderMessageBubble(msgId, comment, stagedTasks);

        stagedTasks.forEach(function (task) {
            task.messageId = msgId;
            self._dbPut(task);
        });

        $('#' + uid + '-comment').val('').css('height', 'auto');

        stagedTasks.forEach(function (task) {
            if (task.status === 'queued' || task.status === 'paused' || task.status === 'failed') {
                self._runUpload(task);
            }
        });

        this._updateSummary();
    };

    /* ===============================================================
       Bulk controls
    =============================================================== */
    ChunkUploader.prototype.pauseAll = function () {
        var self = this;
        this.tasks.forEach(function (task) {
            if (task.status === 'uploading') self.pause(task.id);
        });
    };

    ChunkUploader.prototype.resumeAll = function () {
        var self = this;
        this.tasks.forEach(function (task) {
            if (task.status === 'paused' || task.status === 'failed') self.resume(task.id);
        });
    };

    ChunkUploader.prototype.cancelAll = function () {
        var self = this;
        this.tasks.forEach(function (task) {
            if (task.status !== 'completed' && task.status !== 'cancelled') self.cancel(task.id);
        });
    };

    /* ===============================================================
       Public helpers
    =============================================================== */
    ChunkUploader.prototype.addFiles = function (fileList) {
        for (var i = 0; i < fileList.length; i++) this._addFile(fileList[i]);
    };

    ChunkUploader.prototype.getTasks = function () {
        return this.tasks;
    };

    /* ===============================================================
       Recovery
    =============================================================== */
    ChunkUploader.prototype._recoverTasks = async function () {
        var self = this;
        var saved = await this._dbGetAll();
        var recovered = 0;
        var messageGroups = {};

        saved.forEach(function (task) {
            if (task.status === 'completed' || task.status === 'cancelled') {
                self._dbDelete(task.id);
                return;
            }
            task.status = 'needs-reattach';
            self.tasks.set(task.id, task);
            recovered++;

            if (task.messageId) {
                if (!messageGroups[task.messageId]) messageGroups[task.messageId] = [];
                messageGroups[task.messageId].push(task);
            } else {
                self._dbDelete(task.id);
                self.tasks.delete(task.id);
                recovered--;
            }
        });

        Object.keys(messageGroups).sort().forEach(function (msgId) {
            self._renderMessageBubble(msgId, null, messageGroups[msgId]);
        });

        if (recovered > 0) {
            this._toast(recovered + ' upload(s) can be resumed — re-attach files to continue', 'info', 6000);
        }
        this._updateSummary();
    };

    /* ===============================================================
       Online / Offline awareness
    =============================================================== */
    ChunkUploader.prototype._updateOnlineStatus = function () {
        var self   = this;
        var online = navigator.onLine;
        var uid    = this._uid;

        $('#' + uid + '-conn').html(
            '<span class="nct-dot ' + (online ? 'online' : 'offline') + '"></span> ' +
            (online ? 'Online' : 'Offline')
        );

        if (online) {
            this.tasks.forEach(function (task) {
                if (task.status === 'failed' && self.fileRefs.has(task.id)) {
                    self._toast('Retrying ' + task.fileName + '…', 'info');
                    self._runUpload(task);
                }
            });
        } else {
            this._toast('You are offline — uploads will resume when connected', 'error', 5000);
        }
    };

    /* ===============================================================
       Event bindings
    =============================================================== */
    ChunkUploader.prototype._bindEvents = function () {
        var self = this;
        var uid  = this._uid;

        // Online / offline
        this._updateOnlineStatus();
        this._onOnline = function () { self._updateOnlineStatus(); };
        $(window).on('online offline', this._onOnline);

        // Drop zone
        var $dz = $('#' + uid + '-drop');
        $dz.on('click', function () { $('#' + uid + '-fileInput').trigger('click'); });
        $dz.on('dragover', function (e) { e.preventDefault(); $dz.addClass('dragover'); });
        $dz.on('dragleave drop', function () { $dz.removeClass('dragover'); });
        $dz.on('drop', function (e) {
            e.preventDefault();
            var files = e.originalEvent.dataTransfer.files;
            for (var i = 0; i < files.length; i++) self._addFile(files[i]);
        });

        // File input
        $('#' + uid + '-fileInput').on('change', function () {
            for (var i = 0; i < this.files.length; i++) self._addFile(this.files[i]);
            this.value = '';
        });

        // Re-attach input
        $('#' + uid + '-reattachInput').on('change', function () {
            if (this.files[0]) self._handleReattach(this.files[0]);
            this.value = '';
        });

        // Send button
        $('#' + uid + '-send').on('click', function () { self.send(); });

        // Comment box auto-resize
        $('#' + uid + '-comment').on('input', function () {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 120) + 'px';
            self._updateSummary();
        });

        // Enter to send
        $('#' + uid + '-comment').on('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!$('#' + uid + '-send').prop('disabled')) self.send();
            }
        });

        // Paste support
        if (this.cfg.enablePaste) {
            this._onPaste = function (e) {
                var items = (e.originalEvent.clipboardData || {}).items;
                if (!items) return;
                for (var i = 0; i < items.length; i++) {
                    if (items[i].kind === 'file') {
                        var f = items[i].getAsFile();
                        if (f) self._addFile(f);
                    }
                }
            };
            $(document).on('paste', this._onPaste);
        }

        // Delegated action-button clicks
        this.$el.on('click', '.nct-pause-btn',    function () { self.pause($(this).data('id')); });
        this.$el.on('click', '.nct-resume-btn',   function () { self.resume($(this).data('id')); });
        this.$el.on('click', '.nct-reattach-btn', function () { self._reattach($(this).data('id')); });
        this.$el.on('click', '.nct-cancel-btn',   function () { self.cancel($(this).data('id')); });
        this.$el.on('click', '.nct-staged-remove', function () { self.cancel($(this).data('id')); });

        // Warn before leaving with active uploads
        this._onBeforeUnload = function (e) {
            var active = false;
            self.tasks.forEach(function (t) { if (t.status === 'uploading') active = true; });
            if (active) { e.preventDefault(); return ''; }
        };
        $(window).on('beforeunload', this._onBeforeUnload);
    };

    /* ===============================================================
       Destroy
    =============================================================== */
    ChunkUploader.prototype.destroy = function () {
        this._destroyed = true;

        // Abort active uploads
        this.tasks.forEach(function (task) {
            if (task._activeXhrs) task._activeXhrs.forEach(function (xhr) { xhr.abort(); });
        });

        // Terminate worker
        if (this.hashWorker) this.hashWorker.terminate();

        // Remove event listeners
        $(window).off('online offline', this._onOnline);
        $(window).off('beforeunload', this._onBeforeUnload);
        if (this._onPaste) $(document).off('paste', this._onPaste);

        // Close DB
        if (this.db) this.db.close();

        // Clean DOM
        this.$el.removeClass('nct-uploader').empty();

        // Remove data
        this.$el.removeData('plugin_' + pluginName);
    };

    /* ===============================================================
       jQuery plugin registration
    =============================================================== */
    $.fn[pluginName] = function (options) {
        // If called on a single element, return the instance for chaining API calls
        if (this.length === 1) {
            var instance = this.data('plugin_' + pluginName);
            if (!instance) {
                instance = new ChunkUploader(this[0], options);
                this.data('plugin_' + pluginName, instance);
            }
            return instance;
        }

        // Multiple elements
        return this.each(function () {
            if (!$.data(this, 'plugin_' + pluginName)) {
                $.data(this, 'plugin_' + pluginName, new ChunkUploader(this, options));
            }
        });
    };

})(jQuery, window, document);
