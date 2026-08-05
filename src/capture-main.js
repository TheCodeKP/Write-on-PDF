// Runs in the page's own JavaScript world at document_start.
//
// Blob URLs are strictly same-origin: an extension page calling
// fetch('blob:https://site.com/...') is rejected outright. The only way to ever
// read those bytes is from inside the page that created them, so this wraps
// URL.createObjectURL and keeps a copy of anything that looks like a PDF.

(() => {
  const EVENT = '__writeOnPdfCapture';
  const MAX_BYTES = 100 * 1024 * 1024;

  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  if (URL.createObjectURL.__writeOnPdf) return;

  const original = URL.createObjectURL.bind(URL);

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  async function looksLikePdf(blob) {
    if (blob.type === 'application/pdf' || blob.type === 'application/x-pdf') return true;
    // Plenty of sites build the blob without setting a type, so sniff the header.
    if (blob.type && blob.type !== 'application/octet-stream') return false;
    try {
      const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
      return String.fromCharCode(...head) === '%PDF-';
    } catch {
      return false;
    }
  }

  async function capture(url, blob) {
    try {
      if (blob.size > MAX_BYTES) return;
      if (!(await looksLikePdf(blob))) return;

      const buffer = await blob.arrayBuffer();
      document.dispatchEvent(
        new CustomEvent(EVENT, {
          detail: JSON.stringify({ url, size: buffer.byteLength, b64: toBase64(buffer) }),
        })
      );
    } catch {
      // Never let instrumentation break the host page.
    }
  }

  URL.createObjectURL = function createObjectURL(object) {
    const url = original(object);
    try {
      if (object instanceof Blob) capture(url, object);
    } catch {
      // Ignore and hand back the real URL regardless.
    }
    return url;
  };

  URL.createObjectURL.__writeOnPdf = true;
})();
