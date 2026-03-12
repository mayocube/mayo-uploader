/* ============================================================================
   ChunkUploader — jQuery Attachment Panel Plugin
   ============================================================================
   A reusable, resumable chunk-upload attachment manager.

   This is NOT a chat widget. It is a **file-attachment panel** designed to
   integrate with YOUR existing chat / messaging UI.  You already have:
     • a message container
     • a textarea (comment box)
     • a send button
     • an attachment icon (📎)

   This plugin provides:
     ✔ A togglable attachment panel (opens when the user clicks your 📎 icon)
     ✔ Drag-and-drop / click-to-attach / paste support
     ✔ SHA-256 hashing via Web Worker (non-blocking)
     ✔ Chunked resumable upload with parallel workers
     ✔ Per-file progress, pause / resume / cancel
     ✔ IndexedDB persistence (survives page reload)
     ✔ Online / offline awareness with auto-retry
     ✔ Toast notifications

   TYPICAL FLOW
   ─────────────
   1. User clicks your 📎 icon  →  you call  $panel.chunkUploader('open')
   2. User drops / picks files   →  they appear in the staging list
   3. User types comment in YOUR textarea and hits YOUR send button
   4. In your send handler you call:
        var comment = $('#myTextarea').val();
        postComment(comment).then(function (ids) {
            $panel.chunkUploader('upload', ids.ticketId, ids.commentId);
        });
   5. The plugin uploads all staged files against that ticket/comment.
   6. You can listen to lifecycle callbacks (onUploadComplete, onAllComplete, …)

   MINIMAL EXAMPLE
   ────────────────
   <div id="attachPanel"></div>

   $('#attachPanel').chunkUploader({
       apiBase:       '/api',
       hashWorkerUrl: 'dist/chunk-uploader-worker.js'
   });

   // Your attachment icon
   $('#attachIcon').on('click', function () {
       $('#attachPanel').chunkUploader('toggle');
   });

   // Your send button
   $('#sendBtn').on('click', async function () {
       var text = $('#myTextarea').val();
       var res  = await postComment(text);          // your API call
       $('#attachPanel').chunkUploader('upload', res.ticketId, res.commentId);
   });

   PUBLIC METHODS
   ───────────────
   'open'                              — show the panel
   'close'                             — hide the panel
   'toggle'                            — toggle open / close
   'isOpen'                            — returns true/false
   'upload',  ticketId, commentId      — start uploading all staged files
   'addFiles', fileList                — add files programmatically
   'getFiles'                          — returns array of staged task objects
   'hasFiles'                          — returns true if staged files exist
   'clear'                             — remove all staged (un-uploaded) files
   'pause',   taskId                   — pause a single upload
   'resume',  taskId                   — resume / retry a single upload
   'cancel',  taskId                   — cancel a single upload
   'destroy'                           — tear everything down
============================================================================ */

;(function ($) {
    'use strict';

    /* ---------------------------------------------------------------
       Plugin defaults
    --------------------------------------------------------------- */
    var DEFAULTS = {
        // API & assets
        apiBase:           '/api',
        hashWorkerUrl:     'chunk-uploader-worker.js',
        swUrl:             null,

        // IndexedDB
        dbName:            'ChunkUploaderDB',
        dbVersion:         2,
        dbStore:           'tasks',

        // Upload
        parallel:          3,
        maxRetries:        6,
        retryBaseMs:       1000,
        thumbMaxPx:        120,
        maxFileSize:       5 * 1024 * 1024 * 1024,   // 5 GB

        // UI text
        title:             'Attachments',
        dropText:          'Drop files here or click to browse',
        emptyText:         'No files attached yet',

        // Panel behaviour
        openOnInit:        false,   // start open or closed
        closeOnUpload:     false,   // auto-close panel when upload() is called
        backdrop:          false,   // render a semi-transparent backdrop behind panel

        // Lifecycle callbacks
        onOpen:            $.noop,
        onClose:           $.noop,
        onFileAdded:       $.noop,
        onFileRemoved:     $.noop,
        onUploadStart:     $.noop,  // fires once when upload() is called
        onUploadComplete:  $.noop,  // fires per file
        onAllComplete:     $.noop,
        onError:           $.noop
    };

    /* ---------------------------------------------------------------
       File icon lookup
    --------------------------------------------------------------- */
    var FILE_ICONS = {
        pdf:'📕', doc:'📘', docx:'📘', xls:'📗', xlsx:'📗',
        ppt:'📙', pptx:'📙', zip:'📦', rar:'📦', '7z':'📦',
        mp4:'🎬', avi:'🎬', mov:'🎬', mkv:'🎬', webm:'🎬',
        mp3:'🎵', wav:'🎵', ogg:'🎵', flac:'🎵',
        txt:'📝', csv:'📊', json:'📋', xml:'📋', html:'🌐',
        svg:'🎨', psd:'🎨', ai:'🎨', fig:'🎨'
    };

    /* ---------------------------------------------------------------
       Utility helpers
    --------------------------------------------------------------- */
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

    function fileIcon(name) {
        var ext = (name.split('.').pop() || '').toLowerCase();
        return FILE_ICONS[ext] || '📄';
    }

    function escHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
                .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function uuid() {
        if (crypto.randomUUID) return crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    /* ===============================================================
       ChunkUploader class
    =============================================================== */
    function ChunkUploader(element, options) {
        this.$el      = $(element);
        this.opts      = $.extend({}, DEFAULTS, options);
        this.id        = uuid();
        this.db        = null;
        this.tasks     = new Map();
        this.fileRefs  = new Map();
        this.hashWorker      = null;
        this.hashPending     = new Map();
        this.reattachTargetId = null;
        this._isOpen   = false;

        this._init();
    }

    ChunkUploader.prototype = {

        /* ===========================================================
           Initialisation
        =========================================================== */
        _init: function () {
            this._buildUI();
            this._initWorker();
            this._bindEvents();
            this._openDB().then(this._recoverTasks.bind(this));
            if (this.opts.swUrl) this._registerSW();
            if (this.opts.openOnInit) this.open();
        },

        /* ===========================================================
           UI — Build the attachment panel
        =========================================================== */
        _buildUI: function () {
            var o   = this.opts;
            var uid = this.id;

            var html =
                '<div class="cu-panel" id="cu-panel-' + uid + '">' +
                    // ── Header ──
                    '<div class="cu-panel-header">' +
                        '<h3 class="cu-panel-title">' + escHtml(o.title) + '</h3>' +
                        '<div class="cu-panel-actions">' +
                            '<span class="cu-file-count" id="cu-count-' + uid + '"></span>' +
                            '<span class="cu-conn-dot" id="cu-conn-' + uid + '" title="Online">' +
                                '<span class="cu-dot cu-online"></span>' +
                            '</span>' +
                            '<button class="cu-panel-close" id="cu-close-' + uid + '" title="Close panel">✕</button>' +
                        '</div>' +
                    '</div>' +

                    // ── Drop zone ──
                    '<div class="cu-drop-zone" id="cu-drop-' + uid + '">' +
                        '<span class="cu-drop-icon">📎</span>' +
                        '<span>' + escHtml(o.dropText) + '</span>' +
                    '</div>' +

                    // ── File list (staged + uploading) ──
                    '<div class="cu-file-list" id="cu-list-' + uid + '" data-empty-text="' + escHtml(o.emptyText) + '"></div>' +

                    // ── Hidden file inputs ──
                    '<input type="file" id="cu-fileinput-' + uid + '" multiple hidden>' +
                    '<input type="file" id="cu-reattach-' + uid + '" hidden>' +
                '</div>';

            // Optional backdrop
            if (o.backdrop) {
                html = '<div class="cu-backdrop" id="cu-backdrop-' + uid + '"></div>' + html;
            }

            this.$el.html(html);

            // Ensure a global toast container
            if (!$('#cu-toast-container').length) {
                $('body').append('<div class="cu-toast-container" id="cu-toast-container"></div>');
            }

            // Cache references
            this.$panel     = this.$el.find('#cu-panel-' + uid);
            this.$list      = this.$el.find('#cu-list-' + uid);
            this.$drop      = this.$el.find('#cu-drop-' + uid);
            this.$fileInput = this.$el.find('#cu-fileinput-' + uid);
            this.$reattach  = this.$el.find('#cu-reattach-' + uid);
            this.$closeBtn  = this.$el.find('#cu-close-' + uid);
            this.$count     = this.$el.find('#cu-count-' + uid);
            this.$conn      = this.$el.find('#cu-conn-' + uid);
            this.$backdrop  = this.$el.find('#cu-backdrop-' + uid);
        },

        _initWorker: function () {
            var self = this;
            this.hashWorker = new Worker(this.opts.hashWorkerUrl);
            this.hashWorker.onmessage = function (e) {
                var data    = e.data;
                var pending = self.hashPending.get(data.id);
                if (!pending) return;
                self.hashPending.delete(data.id);
                if (data.error) pending.reject(new Error(data.error));
                else            pending.resolve(data.hash);
            };
        },

        _registerSW: function () {
            if ('serviceWorker' in navigator && this.opts.swUrl) {
                navigator.serviceWorker.register(this.opts.swUrl).catch(function () {});
            }
        },

        /* ===========================================================
           Panel open / close / toggle
        =========================================================== */
        open: function () {
            if (this._isOpen) return;
            this._isOpen = true;
            this.$panel.addClass('cu-panel--open');
            if (this.$backdrop.length) this.$backdrop.addClass('cu-backdrop--visible');
            this.opts.onOpen.call(this.$el[0]);
        },

        close: function () {
            if (!this._isOpen) return;
            this._isOpen = false;
            this.$panel.removeClass('cu-panel--open');
            if (this.$backdrop.length) this.$backdrop.removeClass('cu-backdrop--visible');
            this.opts.onClose.call(this.$el[0]);
        },

        toggle: function () {
            this._isOpen ? this.close() : this.open();
        },

        isOpen: function () {
            return this._isOpen;
        },

        /* ===========================================================
           IndexedDB
        =========================================================== */
        _openDB: function () {
            var self = this;
            var o    = this.opts;
            return new Promise(function (resolve, reject) {
                var req = indexedDB.open(o.dbName, o.dbVersion);
                req.onupgradeneeded = function (e) {
                    var d = e.target.result;
                    if (!d.objectStoreNames.contains(o.dbStore)) {
                        d.createObjectStore(o.dbStore, { keyPath: 'id' });
                    }
                };
                req.onsuccess = function (e) { self.db = e.target.result; resolve(); };
                req.onerror   = function ()  { reject(req.error); };
            });
        },

        _dbPut: function (task) {
            var clone = $.extend({}, task);
            delete clone.sessionStartTime;
            delete clone.sessionStartBytes;
            delete clone._activeXhrs;
            delete clone._getInFlightBytes;
            var tx = this.db.transaction(this.opts.dbStore, 'readwrite');
            tx.objectStore(this.opts.dbStore).put(clone);
        },

        _dbDelete: function (id) {
            var tx = this.db.transaction(this.opts.dbStore, 'readwrite');
            tx.objectStore(this.opts.dbStore).delete(id);
        },

        _dbGetAll: function () {
            var self = this;
            return new Promise(function (resolve, reject) {
                var tx  = self.db.transaction(self.opts.dbStore, 'readonly');
                var req = tx.objectStore(self.opts.dbStore).getAll();
                req.onsuccess = function () { resolve(req.result); };
                req.onerror   = function () { reject(req.error); };
            });
        },

        /* ===========================================================
           Network helpers
        =========================================================== */
        _apiFetch: function (url, opts) {
            opts = opts || {};
            return fetch(url, opts).then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res;
            });
        },

        _xhrUpload: function (url, blob, headers, onProgress, activeXhrs) {
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
        },

        /* ===========================================================
           SHA-256
        =========================================================== */
        _computeHash: function (file) {
            var self = this;
            return new Promise(function (resolve, reject) {
                var msgId = uuid();
                self.hashPending.set(msgId, { resolve: resolve, reject: reject });
                self.hashWorker.postMessage({ id: msgId, file: file });
            });
        },

        /* ===========================================================
           Thumbnail
        =========================================================== */
        _makeThumbnail: function (file) {
            var maxPx = this.opts.thumbMaxPx;
            return new Promise(function (resolve) {
                if (!file.type.startsWith('image/')) { resolve(null); return; }
                var reader = new FileReader();
                reader.onload = function () {
                    var img = new Image();
                    img.onload = function () {
                        var c = document.createElement('canvas');
                        var w = img.width, h = img.height;
                        if (w > h) { h = h * maxPx / w; w = maxPx; }
                        else       { w = w * maxPx / h; h = maxPx; }
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
        },

        /* ===========================================================
           Retry
        =========================================================== */
        _retryBackoff: function (fn, maxRetries) {
            var o     = this.opts;
            maxRetries = maxRetries || o.maxRetries;
            var delay = o.retryBaseMs;

            return (async function attempt(i) {
                try { return await fn(); }
                catch (err) {
                    if (i >= maxRetries) throw err;
                    await new Promise(function (r) {
                        setTimeout(r, delay + Math.random() * 500);
                    });
                    delay *= 2;
                    return attempt(i + 1);
                }
            })(0);
        },

        /* ===========================================================
           Toast
        =========================================================== */
        _toast: function (msg, type, duration) {
            type     = type || 'info';
            duration = duration || 4000;
            var $t = $('<div class="cu-toast cu-' + type + '"></div>').text(msg);
            $('#cu-toast-container').append($t);
            setTimeout(function () { $t.addClass('cu-show'); }, 20);
            setTimeout(function () {
                $t.removeClass('cu-show');
                setTimeout(function () { $t.remove(); }, 300);
            }, duration);
        },

        /* ===========================================================
           UI rendering — file cards inside the panel
        =========================================================== */

        /** Render a file card in the panel list */
        _renderFileCard: function (task) {
            var thumbHtml = task.thumbDataUrl
                ? '<img src="' + task.thumbDataUrl + '" alt="">'
                : '<span>' + fileIcon(task.fileName) + '</span>';

            var html =
                '<div class="cu-file-card" id="cu-task-' + task.id + '" data-status="' + task.status + '">' +
                    '<div class="cu-file-thumb">' + thumbHtml + '</div>' +
                    '<div class="cu-file-body">' +
                        '<div class="cu-file-name-row">' +
                            '<span class="cu-file-name" title="' + escHtml(task.fileName) + '">' + escHtml(task.fileName) + '</span>' +
                            '<span class="cu-file-size">' + fmtBytes(task.fileSize) + '</span>' +
                        '</div>' +
                        '<div class="cu-progress-track"><div class="cu-progress-fill" id="cu-pf-' + task.id + '"></div></div>' +
                        '<div class="cu-file-status" id="cu-st-' + task.id + '">' + this._statusLabel(task) + '</div>' +
                    '</div>' +
                    '<div class="cu-file-actions">' +
                        '<button class="cu-act-btn cu-pause-btn"    title="Pause"          data-id="' + task.id + '">⏸</button>' +
                        '<button class="cu-act-btn cu-resume-btn"   title="Resume"         data-id="' + task.id + '">▶️</button>' +
                        '<button class="cu-act-btn cu-reattach-btn" title="Re-attach file" data-id="' + task.id + '">📂</button>' +
                        '<button class="cu-act-btn cu-cancel-btn"   title="Remove"         data-id="' + task.id + '">✕</button>' +
                    '</div>' +
                '</div>';

            this.$list.append(html);
            this._syncActionButtons(task);
            this._updateProgressBar(task);
        },

        _statusLabel: function (task) {
            switch (task.status) {
                case 'staged':         return '✓ Ready to send';
                case 'hashing':        return '⏳ Verifying…';
                case 'queued':         return '⏳ Queued';
                case 'initializing':   return 'Initializing…';
                case 'uploading':      return this._progressText(task);
                case 'paused':         return 'Paused — ' + this._pctText(task);
                case 'completing':     return 'Finalizing…';
                case 'completed':      return '✅ Uploaded';
                case 'failed':         return '❌ Failed — tap ▶️ to retry';
                case 'needs-reattach': return '⚠️ Re-select file to resume';
                case 'cancelled':      return 'Cancelled';
                default:               return task.status;
            }
        },

        _pctText: function (task) {
            if (!task.fileSize) return '0%';
            return Math.round((this._calcUploadedBytes(task) / task.fileSize) * 100) + '%';
        },

        _progressText: function (task) {
            if (!task.totalParts) return 'Starting…';
            var elapsed  = task.sessionStartTime ? (Date.now() - task.sessionStartTime) / 1000 : 0;
            var uplBytes = this._calcUploadedBytes(task);
            var pct      = task.fileSize ? (uplBytes / task.fileSize) * 100 : 0;
            var sesBytes = uplBytes - (task.sessionStartBytes || 0);
            var speed    = elapsed > 1 ? sesBytes / elapsed : 0;
            var remaining = task.fileSize - uplBytes;
            var eta      = speed > 0 ? remaining / speed : -1;

            var txt = pct.toFixed(0) + '%';
            if (speed > 0) txt += ' · ' + fmtBytes(Math.round(speed)) + '/s';
            if (eta > 0)   txt += ' · ETA ' + fmtTime(eta);
            return txt;
        },

        _calcUploadedBytes: function (task) {
            var completed = 0;
            if (task.completedParts && task.completedParts.length && task.chunkSize) {
                var fullChunks = task.completedParts.filter(function (p) { return p < task.totalParts; }).length;
                var hasLast    = task.completedParts.indexOf(task.totalParts) !== -1;
                var lastSize   = task.fileSize - (task.totalParts - 1) * task.chunkSize;
                completed = (fullChunks * task.chunkSize) + (hasLast ? Math.max(lastSize, 0) : 0);
            }
            var inFlight = task._getInFlightBytes ? task._getInFlightBytes() : 0;
            return completed + inFlight;
        },

        _updateCard: function (task) {
            var $card = $('#cu-task-' + task.id);
            if (!$card.length) return;
            $card.attr('data-status', task.status);
            this._updateProgressBar(task);
            $('#cu-st-' + task.id).text(this._statusLabel(task));
            this._syncActionButtons(task);
        },

        _updateProgressBar: function (task) {
            var pct = task.fileSize ? (this._calcUploadedBytes(task) / task.fileSize) * 100 : 0;
            $('#cu-pf-' + task.id).css('width', Math.min(pct, 100) + '%');
        },

        _syncActionButtons: function (task) {
            var $c = $('#cu-task-' + task.id);
            $c.find('.cu-pause-btn').css('display',    task.status === 'uploading' ? 'flex' : 'none');
            $c.find('.cu-resume-btn').css('display',   (task.status === 'paused' || task.status === 'failed') ? 'flex' : 'none');
            $c.find('.cu-reattach-btn').css('display', task.status === 'needs-reattach' ? 'flex' : 'none');
            $c.find('.cu-cancel-btn').css('display',
                (task.status !== 'completed' && task.status !== 'cancelled') ? 'flex' : 'none');
        },

        _updateCount: function () {
            var staged   = 0;
            var uploading = 0;
            var completed = 0;
            this.tasks.forEach(function (t) {
                // Tasks moved into chat messages are no longer the panel's concern
                if (t._movedToMessage) return;
                if (t.status === 'staged' || t.status === 'hashing' || t.status === 'queued') staged++;
                if (t.status === 'uploading')  uploading++;
                if (t.status === 'completed')  completed++;
            });

            var parts = [];
            if (staged)    parts.push(staged + ' staged');
            if (uploading) parts.push(uploading + ' uploading');
            if (completed) parts.push(completed + ' done');
            this.$count.text(parts.length ? parts.join(' · ') : '');
        },

        /* ===========================================================
           Upload engine
        =========================================================== */
        _initUpload: async function (task) {
            var o = this.opts;
            var res = await this._apiFetch(
                o.apiBase + '/tickets/AttachmentUpload?TicketId=' + task.ticketId +
                '&CommentId=' + task.commentId +
                '&OriginalFileName=' + encodeURIComponent(task.fileName) +
                '&FileBytesSize=' + task.fileSize +
                '&OriginalSha256=' + task.sha256 +
                '&ActionName=Initiate',
                { method: 'POST' }
            );
            var data = await res.json();
            task.tempId         = data.Id;
            task.chunkSize      = data.ChunkSizeBytes;
            task.totalParts     = data.TotalParts;
            task.completedParts = task.completedParts || [];
            this._dbPut(task);
        },

        _uploadChunks: async function (task, file) {
            var self = this;
            var o    = this.opts;
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
                            o.apiBase + '/tickets/AttachmentUpload?TicketId=' + task.ticketId +
                            '&TempAttachmentId=' + task.tempId +
                            '&PartNumber=' + partNum +
                            '&ActionName=UploadChunk',
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

            var workerCount = Math.min(o.parallel, pending.length);
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
        },

        _completeUpload: async function (task) {
            var o = this.opts;
            await this._apiFetch(
                o.apiBase + '/tickets/AttachmentUpload?TicketId=' + task.ticketId +
                '&TempAttachmentId=' + task.tempId +
                '&ActionName=Finalize',
                { method: 'POST' }
            );
        },

        _runUpload: async function (task) {
            var self = this;
            var file = this.fileRefs.get(task.id);
            if (!file) {
                this._setStatus(task, 'needs-reattach');
                return;
            }

            try {
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
                this.opts.onUploadComplete.call(this.$el[0], task);

                this._checkAllComplete();

            } catch (err) {
                if (task.status !== 'paused' && task.status !== 'cancelled') {
                    this._setStatus(task, 'failed');
                    this._toast('Upload failed: ' + task.fileName, 'error');
                    this.opts.onError.call(this.$el[0], task, err);
                    console.error('[ChunkUploader]', task.fileName, err);
                }
            }
        },

        _checkAllComplete: function () {
            var allDone = true;
            var hasUploaded = false;
            this.tasks.forEach(function (t) {
                if (t.status === 'completed') hasUploaded = true;
                else if (t.status !== 'cancelled' && t.status !== 'staged' && t.status !== 'hashing') {
                    allDone = false;
                }
            });
            if (allDone && hasUploaded) {
                this.opts.onAllComplete.call(this.$el[0]);
            }
        },

        _setStatus: function (task, status) {
            task.status = status;
            if (status !== 'completed' && status !== 'cancelled') this._dbPut(task);
            this._updateCard(task);
            this._updateCount();
        },

        /* ===========================================================
           Task creation — addFile
        =========================================================== */
        addFile: async function (file) {
            var self = this;
            var o    = this.opts;

            if (file.size === 0) {
                this._toast(file.name + ' is empty — skipped', 'error');
                return;
            }
            if (o.maxFileSize && file.size > o.maxFileSize) {
                this._toast(file.name + ' exceeds ' + fmtBytes(o.maxFileSize) + ' limit', 'error');
                return;
            }

            var id    = uuid();
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
                status:          'hashing',
                ticketId:        null,
                commentId:       null
            };

            this.tasks.set(id, task);
            this.fileRefs.set(id, file);
            this._renderFileCard(task);
            this._updateCount();
            o.onFileAdded.call(this.$el[0], task, file);

            // Auto-open the panel when a file is added
            if (!this._isOpen) this.open();

            try {
                task.sha256 = await this._computeHash(file);
                this._setStatus(task, 'staged');
            } catch (err) {
                this._toast('Hash failed for ' + file.name, 'error');
                this._setStatus(task, 'failed');
            }
        },

        /* ===========================================================
           Public: upload(ticketId, commentId)
           Called by YOUR send button after YOUR comment API returns.

           Returns:  a jQuery collection of the detached file-card
                     elements so you can append them into your chat
                     message (WhatsApp-style inline progress).
                     The cards keep receiving live progress updates
                     because they are located via global ID selectors.
        =========================================================== */
        upload: function (ticketId, commentId) {
            var self       = this;
            var stagedTasks = [];

            this.tasks.forEach(function (task) {
                if (task.status === 'staged' || task.status === 'queued' || task.status === 'hashing') {
                    stagedTasks.push(task);
                }
            });

            if (!stagedTasks.length) {
                this._toast('No files to upload', 'info');
                return $();
            }

            if (ticketId == null || commentId == null) {
                console.error('[ChunkUploader] upload() requires ticketId and commentId');
                return $();
            }

            // Assign ticket/comment to all staged tasks and mark as moved
            stagedTasks.forEach(function (task) {
                task.ticketId        = ticketId;
                task.commentId       = commentId;
                task._movedToMessage = true;
                self._dbPut(task);
            });

            // Detach cards from the panel list so they can be placed
            // in the consumer's chat message bubble.
            var $cards = $();
            stagedTasks.forEach(function (task) {
                var $card = $('#cu-task-' + task.id).detach();
                $cards = $cards.add($card);
            });

            // Fire onUploadStart (includes the detached $cards)
            this.opts.onUploadStart.call(this.$el[0], {
                ticketId:  ticketId,
                commentId: commentId,
                tasks:     stagedTasks,
                $cards:    $cards
            });

            // Start uploads
            stagedTasks.forEach(function (task) {
                self._runUpload(task);
            });

            this._updateCount();

            // Optionally close the panel
            if (this.opts.closeOnUpload) this.close();

            return $cards;
        },

        /* ===========================================================
           Public: getFiles / hasFiles / clear
        =========================================================== */
        getFiles: function () {
            var result = [];
            this.tasks.forEach(function (t) {
                if (t.status === 'staged' || t.status === 'hashing' || t.status === 'queued') {
                    result.push({
                        id:       t.id,
                        name:     t.fileName,
                        size:     t.fileSize,
                        type:     t.fileType,
                        thumb:    t.thumbDataUrl,
                        sha256:   t.sha256,
                        status:   t.status
                    });
                }
            });
            return result;
        },

        hasFiles: function () {
            var found = false;
            this.tasks.forEach(function (t) {
                if (t.status === 'staged' || t.status === 'hashing' || t.status === 'queued') found = true;
            });
            return found;
        },

        clear: function () {
            var self = this;
            var toRemove = [];
            this.tasks.forEach(function (t) {
                if (t.status === 'staged' || t.status === 'hashing' || t.status === 'queued') {
                    toRemove.push(t.id);
                }
            });
            toRemove.forEach(function (id) {
                self._dbDelete(id);
                self.tasks.delete(id);
                self.fileRefs.delete(id);
                $('#cu-task-' + id).slideUp(200, function () { $(this).remove(); });
            });
            this._updateCount();
        },

        /* ===========================================================
           Public controls
        =========================================================== */
        pause: function (id) {
            var task = this.tasks.get(id);
            if (!task || task.status !== 'uploading') return;
            if (task._activeXhrs) {
                task._activeXhrs.forEach(function (xhr) { xhr.abort(); });
            }
            this._setStatus(task, 'paused');
            this._toast(task.fileName + ' paused', 'info');
        },

        resume: function (id) {
            var task = this.tasks.get(id);
            if (!task) return;
            if (task.status === 'paused' || task.status === 'failed') {
                this._runUpload(task);
            }
        },

        cancel: async function (id) {
            var self = this;
            var task = this.tasks.get(id);
            if (!task) return;

            var wasUploading = (task.status === 'uploading' || task.status === 'initializing' ||
                               task.status === 'completing');

            if (task._activeXhrs) {
                task._activeXhrs.forEach(function (xhr) { xhr.abort(); });
            }
            task.status = 'cancelled';
            this._updateCard(task);

            if (wasUploading && task.tempId && task.ticketId) {
                try {
                    await this._apiFetch(
                        this.opts.apiBase + '/tickets/AttachmentUpload?TicketId=' + task.ticketId +
                        '&TempAttachmentId=' + task.tempId + '&ActionName=Delete',
                        { method: 'DELETE' }
                    );
                } catch (_) { /* best-effort */ }
            }

            this._dbDelete(id);
            this.tasks.delete(id);
            this.fileRefs.delete(id);
            $('#cu-task-' + id).slideUp(200, function () { $(this).remove(); });
            this._updateCount();
            this._toast(task.fileName + ' removed', 'info');
            this.opts.onFileRemoved.call(this.$el[0], task);
        },

        _reattach: function (id) {
            this.reattachTargetId = id;
            this.$reattach.trigger('click');
        },

        _handleReattach: async function (file) {
            var task = this.tasks.get(this.reattachTargetId);
            this.reattachTargetId = null;
            if (!task) return;

            if (file.name !== task.fileName || file.size !== task.fileSize) {
                this._toast(
                    'File does not match — expected "' + task.fileName +
                    '" (' + fmtBytes(task.fileSize) + ')',
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
            this._runUpload(task);
        },

        /* ===========================================================
           Recovery
        =========================================================== */
        _recoverTasks: async function () {
            var self     = this;
            var saved    = await this._dbGetAll();
            var recovered = 0;

            saved.forEach(function (task) {
                if (task.status === 'completed' || task.status === 'cancelled') {
                    self._dbDelete(task.id);
                    return;
                }
                task.status = 'needs-reattach';
                delete task._movedToMessage;   // card is back in the panel now
                self.tasks.set(task.id, task);
                self._renderFileCard(task);
                recovered++;
            });

            if (recovered > 0) {
                this._toast(recovered + ' upload(s) can be resumed — re-attach files to continue', 'info', 6000);
                if (!this._isOpen) this.open();
            }
            this._updateCount();
        },

        /* ===========================================================
           Online / Offline
        =========================================================== */
        _updateOnlineStatus: function () {
            var self   = this;
            var online = navigator.onLine;
            this.$conn
                .html('<span class="cu-dot ' + (online ? 'cu-online' : 'cu-offline') + '"></span>')
                .attr('title', online ? 'Online' : 'Offline');

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
        },

        /* ===========================================================
           Event bindings
        =========================================================== */
        _bindEvents: function () {
            var self = this;

            // Online / offline
            this._updateOnlineStatus();
            this._onlineHandler = function () { self._updateOnlineStatus(); };
            $(window).on('online offline', this._onlineHandler);

            // Close button
            this.$closeBtn.on('click', function () { self.close(); });

            // Backdrop click closes
            if (this.$backdrop.length) {
                this.$backdrop.on('click', function () { self.close(); });
            }

            // Drop zone → opens file picker
            this.$drop.on('click', function () { self.$fileInput.trigger('click'); });
            this.$drop.on('dragover', function (e) { e.preventDefault(); $(this).addClass('cu-dragover'); });
            this.$drop.on('dragleave drop', function () { $(this).removeClass('cu-dragover'); });
            this.$drop.on('drop', function (e) {
                e.preventDefault();
                var files = e.originalEvent.dataTransfer.files;
                for (var i = 0; i < files.length; i++) self.addFile(files[i]);
            });

            // File input
            this.$fileInput.on('change', function () {
                for (var i = 0; i < this.files.length; i++) self.addFile(this.files[i]);
                this.value = '';
            });

            // Re-attach input
            this.$reattach.on('change', function () {
                if (this.files[0]) self._handleReattach(this.files[0]);
                this.value = '';
            });

            // Paste support (on the panel itself)
            this._pasteHandler = function (e) {
                var items = (e.originalEvent.clipboardData || {}).items;
                if (!items) return;
                for (var i = 0; i < items.length; i++) {
                    if (items[i].kind === 'file') {
                        var f = items[i].getAsFile();
                        if (f) self.addFile(f);
                    }
                }
            };
            this.$panel.on('paste', this._pasteHandler);

            // Delegated action buttons (on document so they work after
            // cards are moved into chat message bubbles via upload()).
            var ns = '.cu-' + this.id;
            $(document).on('click' + ns, '.cu-pause-btn',    function () { self.pause($(this).data('id')); });
            $(document).on('click' + ns, '.cu-resume-btn',   function () { self.resume($(this).data('id')); });
            $(document).on('click' + ns, '.cu-reattach-btn', function () { self._reattach($(this).data('id')); });
            $(document).on('click' + ns, '.cu-cancel-btn',   function () { self.cancel($(this).data('id')); });

            // Warn before leaving with active uploads
            this._beforeUnloadHandler = function (e) {
                var active = false;
                self.tasks.forEach(function (t) { if (t.status === 'uploading') active = true; });
                if (active) {
                    e.preventDefault();
                    return '';
                }
            };
            $(window).on('beforeunload', this._beforeUnloadHandler);
        },

        /* ===========================================================
           Destroy
        =========================================================== */
        destroy: function () {
            this.tasks.forEach(function (task) {
                if (task._activeXhrs) {
                    task._activeXhrs.forEach(function (xhr) { xhr.abort(); });
                }
            });
            if (this.hashWorker) this.hashWorker.terminate();
            $(document).off('.cu-' + this.id);
            $(window).off('online offline', this._onlineHandler);
            $(window).off('beforeunload', this._beforeUnloadHandler);
            this.$el.empty();
            this.$el.removeData('chunkUploader');
        }
    };

    /* ===============================================================
       jQuery plugin bridge
    =============================================================== */
    $.fn.chunkUploader = function (optionsOrMethod) {
        var args = Array.prototype.slice.call(arguments, 1);

        // Methods that return values (not chainable)
        var returnMethods = { isOpen: 1, getFiles: 1, hasFiles: 1, upload: 1 };

        if (typeof optionsOrMethod === 'string' && returnMethods[optionsOrMethod]) {
            var instance = this.first().data('chunkUploader');
            if (!instance) {
                console.error('[ChunkUploader] Not initialized on', this[0]);
                return undefined;
            }
            return instance[optionsOrMethod].apply(instance, args);
        }

        return this.each(function () {
            var $this    = $(this);
            var instance = $this.data('chunkUploader');

            if (typeof optionsOrMethod === 'string') {
                if (!instance) {
                    console.error('[ChunkUploader] Not initialized on', this);
                    return;
                }
                switch (optionsOrMethod) {
                    case 'open':     instance.open();            break;
                    case 'close':    instance.close();           break;
                    case 'toggle':   instance.toggle();          break;
                    case 'addFiles':
                        var files = args[0];
                        if (files) {
                            for (var i = 0; i < files.length; i++) instance.addFile(files[i]);
                        }
                        break;
                    case 'clear':    instance.clear();           break;
                    case 'pause':    instance.pause(args[0]);    break;
                    case 'resume':   instance.resume(args[0]);   break;
                    case 'cancel':   instance.cancel(args[0]);   break;
                    case 'destroy':  instance.destroy();         break;
                    default:
                        console.warn('[ChunkUploader] Unknown method:', optionsOrMethod);
                }
            } else {
                if (instance) instance.destroy();
                var uploader = new ChunkUploader(this, optionsOrMethod || {});
                $this.data('chunkUploader', uploader);
            }
        });
    };

    $.fn.chunkUploader.defaults = DEFAULTS;

})(jQuery);
