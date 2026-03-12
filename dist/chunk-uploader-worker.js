/* ================================================================
   SHA-256 Web Worker — supports concurrent file hashing via message IDs.
   Each request carries a unique `id`; the response echoes it back so
   the main thread can match promises correctly.
================================================================ */

self.onmessage = async function (e) {
    const { id, file } = e.data;

    try {
        const buffer     = await file.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        const hashArray  = Array.from(new Uint8Array(hashBuffer));
        const hash       = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        self.postMessage({ id, hash, error: null });
    } catch (err) {
        self.postMessage({ id, hash: null, error: err.message });
    }
};
