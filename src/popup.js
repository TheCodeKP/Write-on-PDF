const takeover = document.getElementById('takeover');
const openDownloads = document.getElementById('openDownloads');
const rescue = document.getElementById('rescue');
const blank = document.getElementById('blank');
const note = document.getElementById('note');

const REASONS = {
  'already-open': 'This tab is already the editor.',
  'blob-unreadable': 'That PDF was generated in the page and has already been released. Save it, then drop the file into the editor.',
  unsupported: 'There is no PDF in this tab that can be opened.',
};

init();

async function init() {
  const settings = await chrome.storage.local.get({ takeover: true, openDownloads: true });
  takeover.checked = settings.takeover;
  openDownloads.checked = settings.openDownloads;
}

takeover.addEventListener('change', () => {
  chrome.storage.local.set({ takeover: takeover.checked });
  say(takeover.checked ? 'PDFs will open in the editor.' : 'PDFs will open in Chrome as usual.');
});

openDownloads.addEventListener('change', () => {
  chrome.storage.local.set({ openDownloads: openDownloads.checked });
});

rescue.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const result = await chrome.runtime.sendMessage({ type: 'rescue-tab', tabId: tab.id });
  if (result?.ok) return window.close();

  say(REASONS[result?.reason] || 'Could not read a PDF from this tab.', true);
});

blank.addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('src/viewer.html') });
  window.close();
});

function say(message, isError = false) {
  note.textContent = message;
  note.classList.toggle('error', isError);
}
