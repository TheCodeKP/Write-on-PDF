// Isolated-world half of the capture pair. The page world can't talk to
// chrome.runtime, so it hands bytes over via a DOM event and this relays them.

document.addEventListener('__writeOnPdfCapture', (event) => {
  let payload;
  try {
    payload = JSON.parse(event.detail);
  } catch {
    return;
  }

  if (!payload?.url?.startsWith('blob:') || typeof payload.b64 !== 'string') return;

  try {
    chrome.runtime.sendMessage(
      { type: 'pdf-blob-captured', url: payload.url, b64: payload.b64, size: payload.size },
      () => void chrome.runtime.lastError
    );
  } catch {
    // Extension context was invalidated (reloaded during development).
  }
});

document.addEventListener('__writeOnPdfOpen', (event) => {
  let payload;
  try {
    payload = JSON.parse(event.detail);
  } catch {
    return;
  }
  if (!payload?.url?.startsWith('blob:')) return;

  try {
    chrome.runtime.sendMessage(
      { type: 'pdf-blob-open', url: payload.url },
      () => void chrome.runtime.lastError
    );
  } catch {
    // Extension context was invalidated (reloaded during development).
  }
});
