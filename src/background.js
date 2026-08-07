const VIEWER_URL = chrome.runtime.getURL('src/viewer.html');
const PDF_RULE_ID = 1;
const BYPASS_RULE_BASE = 1000;
const BYPASS_MS = 20000;
const MAX_BYTES = 100 * 1024 * 1024;
const CAPTURE_TTL_MS = 2 * 60 * 1000;
const SOURCE_TTL_MS = 10 * 60 * 1000;

const DEFAULTS = { takeover: true, openDownloads: true };

// Authoritative in-memory stores. Both are mirrored into chrome.storage.session
// on a best-effort basis so a service worker restart mid-handoff isn't fatal.
const capturedBlobs = new Map(); // blob: URL -> { b64, size, ts }
const pendingSources = new Map(); // key -> { kind, b64|url, name, ts }
const captureWaiters = new Map(); // blob: URL -> resolve[]
const bypassTabs = new Map(); // tabId -> { expiry, url, ruleId }

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

function pdfRedirectRule() {
  return {
    id: PDF_RULE_ID,
    priority: 1,
    action: {
      type: 'redirect',
      redirect: { regexSubstitution: `${VIEWER_URL}#\\0` },
    },
    condition: {
      regexFilter: String.raw`^https?://.+\.pdf(\?.*)?$`,
      resourceTypes: ['main_frame'],
    },
  };
}

// Compared field by field rather than wholesale, because getDynamicRules fills
// in defaults that were never set here and a blind comparison would rewrite the
// rule on every wake. Comparing the shape as well as the presence means an
// update that changes the rule still replaces the old one.
function ruleMatches(live, wanted) {
  if (!live || !wanted) return live === wanted;
  return (
    live.priority === wanted.priority &&
    live.action?.type === wanted.action.type &&
    live.action?.redirect?.regexSubstitution === wanted.action.redirect.regexSubstitution &&
    live.condition?.regexFilter === wanted.condition.regexFilter &&
    String(live.condition?.resourceTypes) === String(wanted.condition.resourceTypes)
  );
}

// Dynamic rules persist per profile, so a profile whose rule went missing stays
// broken until something puts it back. Reconciling on every worker start covers
// that, and the read-before-write above keeps it from writing on each wake.
async function syncRedirectRule() {
  try {
    const { takeover } = await getSettings();
    const wanted = takeover ? pdfRedirectRule() : null;
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    const live = rules.find((rule) => rule.id === PDF_RULE_ID) || null;
    if (ruleMatches(live, wanted)) return;

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [PDF_RULE_ID],
      addRules: wanted ? [wanted] : [],
    });
  } catch {
    // This also runs during top-level evaluation, where an unhandled rejection
    // would take every listener registration in this file down with it.
  }
}

chrome.runtime.onInstalled.addListener(syncRedirectRule);
chrome.runtime.onStartup.addListener(syncRedirectRule);

// The rule only applies to hosts the extension can actually reach, so widening
// or narrowing site access changes the answer without any setting here moving.
chrome.permissions.onAdded.addListener(syncRedirectRule);
chrome.permissions.onRemoved.addListener(syncRedirectRule);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.takeover) syncRedirectRule();
});

// ---------------------------------------------------------------- byte stores

function sweep() {
  const now = Date.now();
  for (const [url, rec] of capturedBlobs) {
    if (now - rec.ts > CAPTURE_TTL_MS) capturedBlobs.delete(url);
  }
  for (const [key, rec] of pendingSources) {
    if (now - rec.ts > SOURCE_TTL_MS) pendingSources.delete(key);
  }
  for (const [tabId, bypass] of bypassTabs) {
    if (now > bypass.expiry) revokeBypass(tabId);
  }
}

async function mirror(storageKey, value) {
  try {
    await chrome.storage.session.set({ [storageKey]: value });
  } catch {
    // Session storage is capped at 10 MB; the in-memory copy still works.
  }
}

async function storeCapture(url, b64, size) {
  sweep();
  const rec = { b64, size, ts: Date.now() };
  capturedBlobs.set(url, rec);
  await mirror(`cap:${url}`, rec);

  const waiters = captureWaiters.get(url);
  if (waiters) {
    captureWaiters.delete(url);
    waiters.forEach((resolve) => resolve(rec));
  }
}

async function getCapture(url) {
  const local = capturedBlobs.get(url);
  if (local) return local;
  const stored = await chrome.storage.session.get(`cap:${url}`);
  return stored[`cap:${url}`] || null;
}

function waitForCapture(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    getCapture(url).then((existing) => {
      if (existing) return resolve(existing);

      const waiters = captureWaiters.get(url) || [];
      waiters.push(resolve);
      captureWaiters.set(url, waiters);

      setTimeout(() => {
        const remaining = (captureWaiters.get(url) || []).filter((w) => w !== resolve);
        if (remaining.length) captureWaiters.set(url, remaining);
        else captureWaiters.delete(url);
        resolve(null);
      }, timeoutMs);
    });
  });
}

async function stashSource(source) {
  sweep();
  const key = crypto.randomUUID();
  const rec = { ...source, ts: Date.now() };
  pendingSources.set(key, rec);
  await mirror(`src:${key}`, rec);
  return key;
}

async function takeSource(key) {
  let rec = pendingSources.get(key);
  if (!rec) {
    const stored = await chrome.storage.session.get(`src:${key}`);
    rec = stored[`src:${key}`] || null;
  }
  return rec;
}

// ------------------------------------------------------------------ redirects

async function openInViewer(tabId, source) {
  const key = await stashSource(source);
  await chrome.tabs.update(tabId, { url: `${VIEWER_URL}#k=${key}` });
}

function isOurs(url) {
  return url.startsWith(VIEWER_URL) || url.startsWith(`blob:${chrome.runtime.getURL('')}`);
}

// Checked by several listeners for the same navigation, so this must not consume
// the entry. It expires on a timer, or when the bypassed page commits.
function shouldSkip(tabId, url) {
  if (isOurs(url)) return true;
  const bypass = bypassTabs.get(tabId);
  return Boolean(bypass && Date.now() < bypass.expiry);
}

// "Open in Chrome's viewer" has to defeat the redirect rule too, and a static
// rule can't be made conditional per tab. Session rules can: they accept tabIds.
async function grantBypass(tabId, url) {
  const ruleId = BYPASS_RULE_BASE + (tabId % 10000);
  bypassTabs.set(tabId, { expiry: Date.now() + BYPASS_MS, url, ruleId });

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [
        {
          id: ruleId,
          priority: 2,
          action: { type: 'allow' },
          condition: {
            regexFilter: '^https?://',
            resourceTypes: ['main_frame'],
            tabIds: [tabId],
          },
        },
      ],
    });
  } catch {
    // Without the rule the redirect still wins, but the other paths stand down.
  }

  setTimeout(() => revokeBypass(tabId), BYPASS_MS);
}

async function revokeBypass(tabId) {
  const bypass = bypassTabs.get(tabId);
  if (!bypass) return;
  bypassTabs.delete(tabId);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [bypass.ruleId] });
  } catch {
    // Already gone.
  }
}

// Once the bypassed page has actually committed, the exemption is no longer
// needed. Clearing it here means an evicted service worker can't strand it.
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0) return;
  const bypass = bypassTabs.get(tabId);
  if (bypass && url === bypass.url) setTimeout(() => revokeBypass(tabId), 1500);
});

// Reads a blob: URL from inside the page that created it. Blob URLs are strictly
// same-origin, so this is the only way an extension can ever see those bytes.
async function fetchBlobFromTab(tabId, blobUrl) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (url) => {
        try {
          const response = await fetch(url);
          const buffer = await response.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = '';
          const CHUNK = 0x8000;
          for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
          }
          return btoa(binary);
        } catch {
          return null;
        }
      },
      args: [blobUrl],
    });
    return injection?.result || null;
  } catch {
    return null;
  }
}

async function resolveBlob(tabId, blobUrl) {
  const captured = await waitForCapture(blobUrl);
  if (captured) return captured.b64;

  // The hook missed it (created in a worker, or before our script ran). Try the
  // tab that opened this one, since the blob lives on its origin.
  let openerTabId = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    openerTabId = tab.openerTabId ?? null;
  } catch {
    openerTabId = null;
  }

  for (const candidate of [openerTabId, tabId]) {
    if (candidate == null) continue;
    const b64 = await fetchBlobFromTab(candidate, blobUrl);
    if (b64) return b64;
  }
  return null;
}

// Path B and C: blob:, file: and data: navigations, none of which produce a
// network request that declarativeNetRequest could match.
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;

  const { url, tabId } = details;
  // Scheme test first: this fires on every navigation in the browser, and there
  // is no reason to hit storage for ordinary page loads.
  if (!/^(blob:|file:\/\/|data:application\/pdf)/.test(url)) return;
  if (shouldSkip(tabId, url)) return;

  const { takeover } = await getSettings();
  if (!takeover) return;

  if (url.startsWith('blob:')) {
    const b64 = await resolveBlob(tabId, url);
    if (b64) {
      await openInViewer(tabId, { kind: 'bytes', b64, name: 'document.pdf' });
    }
    return;
  }

  if (url.startsWith('file://')) {
    if (!/\.pdf(\?.*)?$/i.test(url)) return;
    await openInViewer(tabId, { kind: 'url', url, name: fileNameFromUrl(url) });
    return;
  }

  if (url.startsWith('data:application/pdf')) {
    await openInViewer(tabId, { kind: 'url', url, name: 'document.pdf' });
  }
});

// Path A fallback: PDFs served from URLs that don't end in .pdf, which the
// declarativeNetRequest rule cannot match because it only sees the URL.
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.type !== 'main_frame' || details.tabId < 0) return;
    if (shouldSkip(details.tabId, details.url)) return;
    if (/\.pdf(\?.*)?$/i.test(details.url)) return; // the DNR rule already got it

    const headers = details.responseHeaders || [];
    const header = (name) =>
      headers.find((h) => h.name.toLowerCase() === name)?.value || '';

    if (!header('content-type').toLowerCase().includes('application/pdf')) return;
    if (/attachment/i.test(header('content-disposition'))) return; // becomes a download

    getSettings().then(({ takeover }) => {
      if (!takeover) return;
      stashSource({ kind: 'url', url: details.url, name: fileNameFromUrl(details.url) }).then(
        (key) => {
          chrome.tabs.update(details.tabId, { url: `${VIEWER_URL}#k=${key}` }).catch(() => {});
        }
      );
    });
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
  ['responseHeaders']
);

// Path D: downloads never navigate, so nothing above can catch them.
chrome.downloads.onChanged.addListener(async (delta) => {
  if (delta.state?.current !== 'complete') return;

  const { takeover, openDownloads } = await getSettings();
  if (!takeover || !openDownloads) return;

  const [item] = await chrome.downloads.search({ id: delta.id });
  if (!item?.filename || !/\.pdf$/i.test(item.filename)) return;

  // Skip the copies we produce ourselves, otherwise Save would bounce straight
  // back into a new editor tab.
  const ownPrefix = `blob:${chrome.runtime.getURL('')}`;
  if (item.byExtensionId === chrome.runtime.id) return;
  if (item.url?.startsWith(ownPrefix) || item.finalUrl?.startsWith(ownPrefix)) return;

  const key = await stashSource({
    kind: 'url',
    url: pathToFileUrl(item.filename),
    name: item.filename.split(/[\\/]/).pop(),
  });
  chrome.tabs.create({ url: `${VIEWER_URL}#k=${key}` });
});

chrome.tabs.onRemoved.addListener((tabId) => revokeBypass(tabId));

// -------------------------------------------------------------------- helpers

function pathToFileUrl(path) {
  const normalised = path.replace(/\\/g, '/');
  const withRoot = normalised.startsWith('/') ? normalised : `/${normalised}`;
  // encodeURI keeps the drive colon and separators intact, unlike encodeURIComponent.
  return encodeURI(`file://${withRoot}`).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

function fileNameFromUrl(url) {
  if (!/^(https?|file):/i.test(url)) return 'document.pdf'; // data: has no useful name
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split('/').pop() || 'document.pdf');
  } catch {
    return 'document.pdf';
  }
}

// ------------------------------------------------------------------- messaging

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'pdf-blob-captured': {
        if (message.size > MAX_BYTES) return sendResponse({ ok: false });
        await storeCapture(message.url, message.b64, message.size);
        return sendResponse({ ok: true });
      }

      // Deliberately not dropped here, so reloading the viewer tab still works.
      // The TTL sweep clears it instead.
      case 'get-source':
        return sendResponse((await takeSource(message.key)) || null);

      case 'bypass': {
        await grantBypass(message.tabId, message.url);
        await chrome.tabs.update(message.tabId, { url: message.url });
        return sendResponse({ ok: true });
      }

      // Rescue path: pull whatever PDF is in the given tab into the viewer.
      case 'rescue-tab': {
        const tab = await chrome.tabs.get(message.tabId);
        const url = tab.url || '';

        if (isOurs(url)) return sendResponse({ ok: false, reason: 'already-open' });

        if (url.startsWith('blob:')) {
          const b64 = await resolveBlob(tab.id, url);
          if (!b64) return sendResponse({ ok: false, reason: 'blob-unreadable' });
          await openInViewer(tab.id, { kind: 'bytes', b64, name: 'document.pdf' });
          return sendResponse({ ok: true });
        }

        if (/^(https?|file|data):/.test(url)) {
          await openInViewer(tab.id, { kind: 'url', url, name: fileNameFromUrl(url) });
          return sendResponse({ ok: true });
        }

        return sendResponse({ ok: false, reason: 'unsupported' });
      }

      default:
        return sendResponse(null);
    }
  })();

  return true; // responses are asynchronous
});

// Last, so every listener above is registered synchronously before this yields.
syncRedirectRule();
