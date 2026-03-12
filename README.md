# ChunkUploader — jQuery Attachment Panel Plugin

A **file-attachment panel** that integrates with your existing chat UI. It is **not** a chat widget — it only handles file staging, chunked uploads, progress, pause/resume/cancel.

**You** own the chat: message container, textarea, send button, attachment icon.  
**The plugin** owns the file panel that opens when the user clicks your 📎 icon.

---

## How It Works

```
User clicks 📎        →  panel.chunkUploader('toggle')
User drops/picks files →  files appear in the panel, hashed & staged
User types & hits Send →  YOUR code posts the comment to your API
                          then calls  var $cards = panel.chunkUploader('upload', ticketId, commentId)
                          $cards are detached from the panel — append them into your message bubble
Plugin uploads files   →  chunked, resumable, with progress — cards update in-place wherever they live
Panel is cleared       →  ready for the next set of attachments
```

---

## Quick Start

### 1. Include

```html
<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
<link  rel="stylesheet" href="dist/chunk-uploader.css">
<script src="dist/chunk-uploader.js"></script>
```

### 2. Add a container where the panel will render

```html
<!-- Inside your chat compose area, ABOVE the input bar -->
<div id="attachPanel"></div>

<!-- Your existing compose bar -->
<button id="attachIcon">📎</button>
<textarea id="myTextarea"></textarea>
<button id="sendBtn">Send</button>
```

### 3. Initialize & wire up

```javascript
// Initialize the plugin
$('#attachPanel').chunkUploader({
    apiBase:       '/api',
    hashWorkerUrl: 'dist/chunk-uploader-worker.js'
});

// Toggle panel when your 📎 icon is clicked
$('#attachIcon').on('click', function () {
    $('#attachPanel').chunkUploader('toggle');
});

// Your send button
$('#sendBtn').on('click', async function () {
    var text     = $('#myTextarea').val();
    var hasFiles = $('#attachPanel').chunkUploader('hasFiles');

    if (!text && !hasFiles) return;

    // 1. Post the comment to YOUR API
    var res  = await fetch('/api/comments', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text: text })
    });
    var data = await res.json();   // { ticketId, commentId }

    // 2. Render your chat message with an attachment container
    var $msg = $('<div class="msg me"></div>');
    if (text) $msg.append('<p>' + text + '</p>');
    if (hasFiles) $msg.append('<div class="cu-msg-cards"></div>');
    $('#messages').append($msg);

    // 3. Upload — cards are detached from the panel and moved
    //    into the message bubble (WhatsApp-style inline progress)
    if (hasFiles) {
        var $cards = $('#attachPanel').chunkUploader('upload', data.ticketId, data.commentId);
        $msg.find('.cu-msg-cards').append($cards);
    }

    // 4. Clear your textarea
    $('#myTextarea').val('');
});
```

That's it! The file cards move from the panel into your message bubble with
live progress bars, pause / resume / cancel controls — just like WhatsApp.
The panel clears automatically and is ready for the next set of attachments.

---

## Files

```
dist/
  chunk-uploader.css          ← Panel styles (all .cu- prefixed)
  chunk-uploader.js           ← jQuery plugin
  chunk-uploader-worker.js    ← SHA-256 Web Worker
demo.html                     ← Full working example with simulated chat UI
server.js                     ← Proxy server (handles auth server-side)
```

---

## All Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiBase` | `string` | `'/api'` | Base URL for upload endpoints |
| `hashWorkerUrl` | `string` | `'chunk-uploader-worker.js'` | Path to SHA-256 Web Worker |
| `swUrl` | `string\|null` | `null` | Service worker path (`null` = disabled) |
| `parallel` | `number` | `3` | Concurrent chunk workers per file |
| `maxRetries` | `number` | `6` | Max retry attempts with back-off |
| `retryBaseMs` | `number` | `1000` | Base delay for exponential back-off (ms) |
| `thumbMaxPx` | `number` | `120` | Max thumbnail dimension in px |
| `maxFileSize` | `number` | `5 GB` | Max file size in bytes |
| `dbName` | `string` | `'ChunkUploaderDB'` | IndexedDB database name |
| `dbVersion` | `number` | `2` | IndexedDB version |
| `dbStore` | `string` | `'tasks'` | IndexedDB store name |
| `title` | `string` | `'Attachments'` | Panel header title |
| `dropText` | `string` | `'Drop files here or click to browse'` | Drop zone label |
| `emptyText` | `string` | `'No files attached yet'` | Empty state text |
| `openOnInit` | `boolean` | `false` | Start with panel open |
| `closeOnUpload` | `boolean` | `false` | Auto-close panel when `upload()` is called |
| `backdrop` | `boolean` | `false` | Show semi-transparent backdrop behind panel |

---

## Public Methods

### Panel control

```javascript
$('#el').chunkUploader('open');       // show the panel
$('#el').chunkUploader('close');      // hide the panel
$('#el').chunkUploader('toggle');     // toggle open/close

// Returns a value (not chainable):
var open = $('#el').chunkUploader('isOpen');   // true / false
```

### File management

```javascript
// Add files programmatically (e.g. from your own <input>)
$('#el').chunkUploader('addFiles', fileInputElement.files);

// Get list of staged files (returns array of objects)
var files = $('#el').chunkUploader('getFiles');
// → [{ id, name, size, type, thumb, sha256, status }, …]

// Check if there are staged files
var has = $('#el').chunkUploader('hasFiles');   // true / false

// Remove all staged files
$('#el').chunkUploader('clear');
```

### Upload

```javascript
// Start uploading all staged files against a ticket/comment.
// Returns a jQuery collection of detached file-card elements.
// Append them into your chat message for inline progress (WhatsApp-style).
var $cards = $('#el').chunkUploader('upload', ticketId, commentId);
$msg.find('.cu-msg-cards').append($cards);
```

### Per-file controls

```javascript
$('#el').chunkUploader('pause',  taskId);
$('#el').chunkUploader('resume', taskId);
$('#el').chunkUploader('cancel', taskId);
```

### Teardown

```javascript
$('#el').chunkUploader('destroy');
```

---

## Event Callbacks

```javascript
$('#el').chunkUploader({
    onOpen:           function ()           { },  // panel opened
    onClose:          function ()           { },  // panel closed
    onFileAdded:      function (task, file)  { },  // file staged
    onFileRemoved:    function (task)        { },  // file removed/cancelled
    onUploadStart:    function (info)        { },  // upload() called — { ticketId, commentId, tasks, $cards }
    onUploadComplete: function (task)        { },  // single file done
    onAllComplete:    function ()           { },  // all files done
    onError:          function (task, error) { }   // single file failed
});
```

---

## Features

- ✅ **Attachment panel** — opens/closes via your 📎 icon
- ✅ **WhatsApp-style send** — file cards move from panel into your chat message with live progress
- ✅ Drag & drop, click-to-browse, clipboard paste
- ✅ SHA-256 hashing via Web Worker (non-blocking)
- ✅ Chunked resumable upload with parallel workers
- ✅ IndexedDB persistence (survives page reload)
- ✅ Resume from exact completed chunks
- ✅ Exponential back-off retry with jitter
- ✅ Real progress bar with speed + ETA
- ✅ Pause / Resume / Cancel per-file
- ✅ Re-attach file to resume unfinished uploads
- ✅ Online/offline awareness with auto-retry
- ✅ File validation (size, empty check)
- ✅ Image thumbnails
- ✅ Toast notifications
- ✅ CSS-namespaced (`.cu-` prefix — zero conflicts)
- ✅ Multiple instances on the same page
- ✅ `getFiles()` / `hasFiles()` for integration with your send logic

---

## Proxy Server

The included `server.js` handles auth tokens server-side:

```bash
npm install
npm start
# → http://localhost:5000/demo.html
```

Endpoints:
- `POST /api/comments` — creates a comment, returns `{ ticketId, commentId }`
- `POST /api/tickets/AttachmentUpload` — init + finalize uploads
- `PUT  /api/tickets/AttachmentUpload` — upload chunks
- `DELETE /api/tickets/AttachmentUpload` — cancel uploads

---

## Browser Support

Chrome/Edge 80+ · Firefox 78+ · Safari 14+  
Requires: Web Workers, IndexedDB, `crypto.subtle`
