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
// blob: navigations often skip webNavigation events, so once we have the bytes
// we also claim any tab that is already showing that URL.
const claimedBlobTabs = new Set(); // `${tabId}:${blobUrl}`
// Saves we just wrote ourselves. Firefox may open the finished download as
// file://; Path C must not intercept those or Save opens a dead editor tab.
const recentOwnDownloads = new Map(); // absolute path or basename -> expiry ms
const OWN_DOWNLOAD_TTL_MS = 60 * 1000;
const isFirefox = typeof chrome.runtime.getBrowserInfo === 'function';
// Cached so Firefox stream capture can decide synchronously in onBeforeRequest.
let takeoverEnabled = true;

async function refreshTakeoverFlag() {
  try {
    const { takeover } = await getSettings();
    takeoverEnabled = takeover !== false;
  } catch {
    takeoverEnabled = true;
  }
}

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
    // Firefox: DNR redirect forces a second fetch from moz-extension://, which
    // Cloudflare-style hosts reject with 403. Stream-capture Path A instead.
    if (isFirefox) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [PDF_RULE_ID],
        addRules: [],
      });
      return;
    }

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
  if (area === 'local' && changes.takeover) {
    syncRedirectRule();
    refreshTakeoverFlag();
  }
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

  // Do not wait for onBeforeNavigate. Chrome often never reports blob: PDF
  // navigations there, which left captured bytes stranded.
  await claimOpenBlobTabs(url, b64);
  // The tab often appears a beat after createObjectURL. Poll briefly.
  void pollClaimBlobTab(url, b64);
}

async function pollClaimBlobTab(blobUrl, b64) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({});
    } catch {
      return;
    }
    const match = tabs.find((tab) => (tab.url || tab.pendingUrl || '') === blobUrl);
    if (!match) continue;
    await claimBlobTab(match.id, blobUrl, b64);
    return;
  }
}

async function claimOpenBlobTabs(blobUrl, b64) {
  const { takeover } = await getSettings();
  if (!takeover) return;

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }

  for (const tab of tabs) {
    const seen = tab.url || tab.pendingUrl || '';
    if (seen === blobUrl) await claimBlobTab(tab.id, blobUrl, b64);
  }
}

async function claimBlobTab(tabId, blobUrl, b64) {
  const claimKey = `${tabId}:${blobUrl}`;
  if (claimedBlobTabs.has(claimKey)) return;
  if (shouldSkip(tabId, blobUrl)) return;

  claimedBlobTabs.add(claimKey);
  await openInViewer(tabId, { kind: 'bytes', b64, name: 'document.pdf' });
}

async function claimBlobTabIfCaptured(tabId, blobUrl) {
  const { takeover } = await getSettings();
  if (!takeover) return;
  const captured = await getCapture(blobUrl);
  if (!captured?.b64) return;
  await claimBlobTab(tabId, blobUrl, captured.b64);
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
    if (isRecentOwnDownload(url)) return;
    // Firefox reports file access as allowed, but moz-extension pages still
    // cannot fetch file://. Opening the viewer with kind:url always fails and
    // races Path D. Leave local file tabs alone; Path D handles downloads.
    if (isFirefox) return;
    let fileAccess = false;
    try {
      fileAccess = await chrome.extension.isAllowedFileSchemeAccess();
    } catch {
      fileAccess = false;
    }
    if (!fileAccess) return;
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

// Path A (Firefox): capture the first navigation response body. DNR redirect is
// cleared above because a second fetch from moz-extension:// often gets 403.
if (isFirefox && chrome.webRequest?.filterResponseData) {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.type !== 'main_frame' || details.tabId < 0) return;
      if (!takeoverEnabled) return;
      if (shouldSkip(details.tabId, details.url)) return;
      if (!/\.pdf(\?.*)?$/i.test(details.url)) return;

      let filter;
      try {
        filter = chrome.webRequest.filterResponseData(details.requestId);
      } catch {
        return;
      }

      const chunks = [];
      let total = 0;

      filter.ondata = (event) => {
        chunks.push(event.data);
        total += event.data.byteLength;
      };

      filter.onstop = () => {
        const bytes = new Uint8Array(total > MAX_BYTES ? 0 : total);
        if (total > 0 && total <= MAX_BYTES) {
          let offset = 0;
          for (const chunk of chunks) {
            const view = new Uint8Array(chunk);
            bytes.set(view, offset);
            offset += view.byteLength;
          }
        }

        const okPdf = total > 0 && total <= MAX_BYTES && looksLikePdf(bytes);
        if (!okPdf) {
          for (const chunk of chunks) {
            try {
              filter.write(chunk);
            } catch {
              // ignore
            }
          }
          try {
            filter.close();
          } catch {
            // ignore
          }
          return;
        }

        try {
          filter.close();
        } catch {
          // ignore
        }

        void (async () => {
          try {
            const key = await stashSource({
              kind: 'bytes',
              b64: bytesToBase64(bytes),
              name: fileNameFromUrl(details.url),
            });
            await chrome.tabs.update(details.tabId, { url: `${VIEWER_URL}#k=${key}` });
          } catch {
            // Tab may have closed.
          }
        })();
      };

      filter.onerror = () => {
        try {
          filter.disconnect();
        } catch {
          // ignore
        }
      };
    },
    { urls: ['<all_urls>'], types: ['main_frame'] },
    ['blocking']
  );
}

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
  const skipOwnId = item.byExtensionId === chrome.runtime.id;
  const skipOwnUrl =
    Boolean(item.url?.startsWith(ownPrefix)) ||
    Boolean(item.finalUrl?.startsWith(ownPrefix));
  if (skipOwnId || skipOwnUrl) {
    rememberOwnDownload(item.filename);
    return;
  }

  const name = item.filename.split(/[\\/]/).pop();
  const remote = [item.finalUrl, item.url].find((u) => /^https?:/i.test(u || ''));

  if (remote) {
    const remoteBytes = await loadRemotePdfBytes(remote, item.referrer || '');
    if (remoteBytes.ok && remoteBytes.b64) {
      const key = await stashSource({ kind: 'bytes', b64: remoteBytes.b64, name });
      chrome.tabs.create({ url: `${VIEWER_URL}#k=${key}` });
      return;
    }
  }

  let fileAccess = false;
  try {
    fileAccess = await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    fileAccess = false;
  }

  const fileUrl = pathToFileUrl(item.filename);
  if (fileAccess && !isFirefox) {
    try {
      const response = await fetch(fileUrl);
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > MAX_BYTES || !looksLikePdf(bytes)) return;
        const key = await stashSource({ kind: 'bytes', b64: bytesToBase64(bytes), name });
        chrome.tabs.create({ url: `${VIEWER_URL}#k=${key}` });
        return;
      }
    } catch {
      // fall through
    }
    const key = await stashSource({ kind: 'url', url: fileUrl, name });
    chrome.tabs.create({ url: `${VIEWER_URL}#k=${key}` });
    return;
  }

  if (!isFirefox) return;

  // Firefox cannot read the saved path. If the download itself is a tiny HTML
  // stub (Cloudflare / hotlink page saved as .pdf), skip the empty editor.
  const savedBytes = Number(item.fileSize ?? item.totalBytes ?? 0);
  if (savedBytes > 0 && savedBytes < 4096) return;

  chrome.tabs.create({ url: VIEWER_URL });
  try {
    await chrome.downloads.show(item.id);
  } catch {
    // ignore
  }
});

chrome.tabs.onRemoved.addListener((tabId) => revokeBypass(tabId));

// -------------------------------------------------------------------- helpers

function rememberOwnDownload(filename) {
  if (!filename) return;
  const expiry = Date.now() + OWN_DOWNLOAD_TTL_MS;
  recentOwnDownloads.set(filename, expiry);
  const base = filename.split(/[\\/]/).pop();
  if (base) recentOwnDownloads.set(base, expiry);
}

function isRecentOwnDownload(fileUrlOrPath) {
  const now = Date.now();
  for (const [key, expiry] of recentOwnDownloads) {
    if (now > expiry) recentOwnDownloads.delete(key);
  }
  if (!fileUrlOrPath) return false;
  let path = fileUrlOrPath;
  try {
    if (/^file:/i.test(fileUrlOrPath)) path = decodeURIComponent(new URL(fileUrlOrPath).pathname);
  } catch {
    // keep raw
  }
  const normalised = path.replace(/\//g, '\\');
  const base = path.split(/[\\/]/).pop();
  return (
    recentOwnDownloads.has(fileUrlOrPath) ||
    recentOwnDownloads.has(path) ||
    recentOwnDownloads.has(normalised) ||
    (base ? recentOwnDownloads.has(base) : false)
  );
}

function pathToFileUrl(path) {
  const normalised = path.replace(/\\/g, '/');
  const withRoot = normalised.startsWith('/') ? normalised : `/${normalised}`;
  // encodeURI keeps the drive colon and separators intact, unlike encodeURIComponent.
  return encodeURI(`file://${withRoot}`).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function looksLikePdf(bytes) {
  return (
    bytes &&
    bytes.byteLength >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  ); // %PDF
}

function pdfHead(bytes) {
  if (!bytes?.byteLength) return '';
  const n = Math.min(bytes.byteLength, 8);
  let out = '';
  for (let i = 0; i < n; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

async function bytesFromResponse(response) {
  if (!response?.ok) return { ok: false, status: response?.status ?? null };
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) return { ok: false, status: response.status, err: 'too large' };
  if (!looksLikePdf(bytes)) {
    return {
      ok: false,
      status: response.status,
      err: 'not-pdf',
      bytes: bytes.byteLength,
      head: pdfHead(bytes),
    };
  }
  return {
    ok: true,
    status: response.status,
    bytes: bytes.byteLength,
    b64: bytesToBase64(bytes),
    head: pdfHead(bytes),
  };
}

async function loadRemotePdfBytes(pdfUrl, referrer) {
  // Prefer the HTTP cache: Save-link-as just filled it, and a normal re-fetch
  // often 403s or returns an HTML stub.
  for (const cache of ['force-cache', 'default']) {
    try {
      const response = await fetch(pdfUrl, { credentials: 'include', cache });
      const parsed = await bytesFromResponse(response);
      if (parsed.ok) return { ...parsed, via: `bg:${cache}` };
    } catch {
      // try next
    }
  }

  const viaPage = await fetchPdfViaPageTab(pdfUrl, referrer);
  if (viaPage?.ok) return { ...viaPage, via: 'page' };
  return viaPage || { ok: false, err: 'remote failed' };
}

// Fetch a PDF URL from inside a normal https tab so Referer / site cookies match
// what the download button used.
async function fetchPdfViaPageTab(pdfUrl, referrer) {
  const hosts = [];
  for (const candidate of [referrer, pdfUrl]) {
    try {
      hosts.push(new URL(candidate).origin);
    } catch {
      // ignore
    }
  }

  const tabs = [];
  for (const origin of hosts) {
    try {
      const found = await chrome.tabs.query({ url: `${origin}/*` });
      for (const tab of found) {
        if (tab.id != null && !tabs.some((t) => t.id === tab.id)) tabs.push(tab);
      }
    } catch {
      // query pattern rejected
    }
  }

  if (!tabs.length) return { ok: false, err: 'no matching site tab' };

  for (const tab of tabs) {
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: async (url) => {
          const tryCache = async (cache) => {
            const response = await fetch(url, { credentials: 'include', cache });
            if (!response.ok) return { ok: false, status: response.status, cache };
            const bytes = new Uint8Array(await response.arrayBuffer());
            const head = String.fromCharCode(...bytes.slice(0, Math.min(8, bytes.length)));
            if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
              return { ok: false, status: response.status, err: 'not-pdf', bytes: bytes.byteLength, head, cache };
            }
            let binary = '';
            const CHUNK = 0x8000;
            for (let i = 0; i < bytes.length; i += CHUNK) {
              binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
            }
            return { ok: true, b64: btoa(binary), bytes: bytes.byteLength, status: response.status, head, cache };
          };
          try {
            const cached = await tryCache('force-cache');
            if (cached.ok) return cached;
            return await tryCache('default');
          } catch (error) {
            return { ok: false, err: String(error?.message || error) };
          }
        },
        args: [pdfUrl],
      });
      const result = injection?.result;
      if (!result) continue;
      let tabHost = null;
      try {
        tabHost = new URL(tab.url || '').host;
      } catch {
        tabHost = null;
      }
      if (result.ok && result.b64) return { ...result, tabHost };
      if (result.status || result.err) return { ...result, tabHost };
    } catch (error) {
      return { ok: false, err: String(error?.message || error) };
    }
  }
  return { ok: false, err: 'page fetch failed' };
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

      case 'pdf-blob-open': {
        const captured = await getCapture(message.url);
        if (captured?.b64) {
          await claimOpenBlobTabs(message.url, captured.b64);
          void pollClaimBlobTab(message.url, captured.b64);
        } else {
          // Bytes may still be in flight from createObjectURL.
          void waitForCapture(message.url, 4000).then((rec) => {
            if (rec?.b64) {
              claimOpenBlobTabs(message.url, rec.b64);
              pollClaimBlobTab(message.url, rec.b64);
            }
          });
        }
        return sendResponse({ ok: true });
      }

      // Deliberately not dropped here, so reloading the viewer tab still works.
      // The TTL sweep clears it instead.
      case 'get-source': {
        const source = (await takeSource(message.key)) || null;
        return sendResponse(source);
      }

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

// blob: PDF tabs often skip webNavigation. Claim them from the tabs API instead.
chrome.tabs.onCreated.addListener((tab) => {
  const seen = tab.pendingUrl || tab.url || '';
  if (seen.startsWith('blob:')) void claimBlobTabIfCaptured(tab.id, seen);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const seen = changeInfo.url || tab.pendingUrl || '';
  if (seen.startsWith('blob:')) void claimBlobTabIfCaptured(tabId, seen);
});

// Last, so every listener above is registered synchronously before this yields.
syncRedirectRule();
refreshTakeoverFlag();
