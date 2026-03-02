# ChunkUploader — Reusable jQuery Plugin

Enterprise-grade resumable chunk uploader that can be dropped into **any** page with a single `<div>` and a few lines of JavaScript.

---

## Features

- ✅ API-driven `ChunkSizeBytes` & `TotalParts`
- ✅ Web Worker SHA-256 (non-blocking, concurrent-safe)
- ✅ IndexedDB full task persistence (survives reload)
- ✅ Resume from exact completed parts
- ✅ Parallel chunk upload (configurable concurrency)
- ✅ Exponential back-off retry with jitter
- ✅ True progress bar with speed + ETA
- ✅ Pause / Resume / Cancel per-file
- ✅ Recover unfinished uploads on reload (re-attach flow)
- ✅ Online/offline awareness with auto-retry
- ✅ File validation, paste support, drag-and-drop
- ✅ Persistent data-URL thumbnails
- ✅ Fully configurable via options object
- ✅ Event callbacks for every lifecycle stage
- ✅ Public API methods for programmatic control
- ✅ CSS-namespaced (no style conflicts)
- ✅ Multiple instances on the same page

---

## Quick Start

### 1. Include the files

```html
<!-- jQuery (required) -->
<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>

<!-- ChunkUploader Plugin -->
<link rel="stylesheet" href="dist/chunk-uploader.css">
<script src="dist/chunk-uploader.js"></script>
```

### 2. Add a container div

```html
<div id="myUploader"></div>
```

### 3. Initialize

```javascript
var uploader = $('#myUploader').chunkUploader({
    apiBase:    '/api',
    ticketId:   3059,
    commentId:  49717,
    placedBy:   { EmployeeId: 1, ContactId: 1, Email: 'user@example.com' },
    workerPath: 'dist/chunk-uploader-worker.js'
});
```

That's it! The plugin renders the full UI inside your div.

---

## Files

```
dist/
  chunk-uploader.css          ← All styles (namespaced under .nct-uploader)
  chunk-uploader.js           ← jQuery plugin
  chunk-uploader-worker.js    ← SHA-256 Web Worker
demo.html                     ← Full working example
server.js                     ← Proxy server (optional, for same-origin auth)
```

---

## All Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiBase` | `string` | `'/api'` | Base URL for the upload API |
| `ticketId` | `number` | `null` | Ticket ID for upload endpoint |
| `commentId` | `number` | `null` | Comment ID attached to upload |
| `isPublic` | `boolean` | `true` | Whether attachment is public |
| `placedBy` | `object` | `null` | `{ EmployeeId, ContactId, Email }` |
| `parallel` | `number` | `1` | Concurrent chunk workers per file |
| `maxRetries` | `number` | `6` | Max retry attempts with back-off |
| `retryBaseMs` | `number` | `1000` | Base delay for exponential back-off (ms) |
| `thumbMaxPx` | `number` | `120` | Max thumbnail dimension in px |
| `maxFileSize` | `number` | `5GB` | Max file size in bytes |
| `dbName` | `string` | `'ChunkUploaderDB'` | IndexedDB database name |
| `dbVersion` | `number` | `2` | IndexedDB version |
| `dbStore` | `string` | `'tasks'` | IndexedDB store name |
| `workerPath` | `string` | `'chunk-uploader-worker.js'` | Path to hash Web Worker |
| `title` | `string` | `'💬 Attachment Uploader'` | Header title |
| `emptyText` | `string` | `'Your messages will appear here'` | Empty state text |
| `dropZoneText` | `string` | `'Drop files here or click to attach'` | Drop zone label |
| `commentPlaceholder` | `string` | `'Type a message…'` | Comment textarea placeholder |
| `showComment` | `boolean` | `true` | Show the comment textarea |
| `showHeader` | `boolean` | `true` | Show the header bar |
| `enablePaste` | `boolean` | `true` | Enable Ctrl+V paste support |
| `enableServiceWorker` | `boolean` | `false` | Register a service worker |
| `serviceWorkerPath` | `string` | `'sw.js'` | Path to the service worker |
| `autoRecover` | `boolean` | `true` | Auto-recover uploads on reload |

---

## Event Callbacks

```javascript
$('#el').chunkUploader({
    onFileAdded:      function (task) { },         // File staged
    onUploadStart:    function (task) { },         // Upload begins
    onUploadProgress: function (task, pct) { },    // Progress update (0-100)
    onUploadComplete: function (task) { },         // Single file done
    onUploadFailed:   function (task, error) { },  // Single file failed
    onAllComplete:    function () { },             // All uploads done
    onToast:          function (message, type) { } // Toast notification
});
```

---

## Public API

The plugin returns an instance with these methods:

```javascript
var uploader = $('#el').chunkUploader({ ... });

// Add files programmatically
uploader.addFiles(fileInputElement.files);

// Trigger send (with optional comment override)
uploader.send('My comment');

// Per-task controls
uploader.pause(taskId);
uploader.resume(taskId);
uploader.cancel(taskId);

// Bulk controls
uploader.pauseAll();
uploader.resumeAll();
uploader.cancelAll();

// Get all tasks (Map of id → task)
var tasks = uploader.getTasks();

// Completely tear down the plugin
uploader.destroy();
```

---

## Multiple Instances

You can have multiple uploaders on the same page, each with different configs:

```javascript
$('#uploader1').chunkUploader({
    ticketId: 100, commentId: 200, title: 'Project A'
});

$('#uploader2').chunkUploader({
    ticketId: 300, commentId: 400, title: 'Project B', showComment: false
});
```

Each instance has isolated state, IndexedDB, and event bindings.

---

## Proxy Server

The included `server.js` handles auth token management server-side so credentials are never exposed to the browser. Run it with:

```bash
npm install
npm start
```

Then point `apiBase` to your server (default `/api` on same origin).

---

## Browser Support

- Chrome / Edge 80+
- Firefox 78+
- Safari 14+
- Any browser with Web Workers, IndexedDB, and `crypto.subtle`