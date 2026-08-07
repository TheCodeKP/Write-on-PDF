const takeover = document.getElementById('takeover');
const openDownloads = document.getElementById('openDownloads');
const rescue = document.getElementById('rescue');
const blank = document.getElementById('blank');
const note = document.getElementById('note');
const diagSummary = document.getElementById('diagSummary');
const diagDot = document.getElementById('diagDot');
const diagText = document.getElementById('diagText');
const diagList = document.getElementById('diagList');
const diagOpen = document.getElementById('diagOpen');
const diagHint = document.getElementById('diagHint');

// Mirrors PDF_RULE_ID in background.js. Only read here, never written.
const PDF_RULE_ID = 1;

const DETAILS_URL = `chrome://extensions/?id=${chrome.runtime.id}`;

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
  diagnose();
}

takeover.addEventListener('change', () => {
  chrome.storage.local.set({ takeover: takeover.checked });
  say(takeover.checked ? 'PDFs will open in the editor.' : 'PDFs will open in Chrome as usual.');
  // The rule is written by the background script in response to that write, so
  // give it a moment before asking whether it landed.
  setTimeout(diagnose, 300);
});

openDownloads.addEventListener('change', () => {
  chrome.storage.local.set({ openDownloads: openDownloads.checked });
  diagnose();
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

// ----------------------------------------------------------------- diagnostics

// Three settings decide whether a PDF actually reaches the editor, all of them
// per profile, none of them synced, and none of them owned by this extension.
// Two can be read back, so they are reported instead of guessed at. Chrome's own
// PDF preference cannot be read at all, so it is only ever offered as a hint.
async function diagnose() {
  const settings = await chrome.storage.local.get({ takeover: true, openDownloads: true });
  const checks = [];

  if (settings.takeover) {
    const live = await hasRedirectRule();
    checks.push({
      ok: live,
      title: live ? 'Redirect rule is registered' : 'Redirect rule is missing',
      detail: live
        ? 'PDF links on sites this extension can reach will open here.'
        : 'Switch the first setting off and on again, or reload the extension.',
    });
  }

  const origin = await currentOrigin();
  if (origin) {
    const granted = await hasSiteAccess(origin);
    checks.push({
      ok: granted,
      needsDetails: !granted,
      title: granted ? 'Site access on this site' : 'No site access on this site',
      detail: granted
        ? `Allowed on ${origin}.`
        : 'Set Site access to "On all sites". Without it the redirect never runs and PDFs stay in Chrome\u2019s viewer.',
    });
  }

  const fileAccess = await hasFileAccess();
  if (settings.openDownloads || !fileAccess) {
    checks.push({
      ok: fileAccess,
      needsDetails: !fileAccess,
      title: fileAccess ? 'Local file access is on' : 'Local file access is off',
      detail: fileAccess
        ? 'Downloaded and local PDFs can be opened.'
        : 'Turn on "Allow access to file URLs". Downloaded PDFs are handed over as a local file, so without it they cannot be opened.',
    });
  }

  render(checks);
}

let showPasses = false;
let failures = 0;

function render(checks) {
  failures = checks.filter((check) => !check.ok).length;

  diagDot.className = failures ? 'dot bad' : 'dot';
  diagText.textContent = failures
    ? `Takeover is limited on this profile (${failures})`
    : 'Takeover is active on this profile';

  diagList.textContent = '';
  for (const check of checks) {
    const item = document.createElement('li');
    if (check.ok) item.className = 'pass';

    const dot = document.createElement('span');
    dot.className = check.ok ? 'dot' : 'dot bad';

    const body = document.createElement('p');
    const title = document.createElement('strong');
    title.textContent = check.title;
    body.appendChild(title);
    body.appendChild(document.createTextNode(check.detail));

    item.append(dot, body);
    diagList.appendChild(item);
  }

  diagOpen.hidden = !checks.some((check) => !check.ok && check.needsDetails);
  diagHint.hidden = failures === 0;
  if (failures) {
    diagHint.textContent =
      'Still opening in Chrome? Check chrome://settings/content/pdfDocuments opens PDFs rather than downloading them.';
  }
  applyView();
}

// Problems show themselves; passing checks stay behind the summary line. A popup
// is capped at 600px tall and three expanded checks overflow it, so the default
// view is only what needs acting on.
function applyView() {
  diagList.hidden = !showPasses && failures === 0;
  diagList.classList.toggle('failures-only', !showPasses);
  diagSummary.setAttribute('aria-expanded', String(showPasses));
}

diagSummary.addEventListener('click', () => {
  showPasses = !showPasses;
  applyView();
});

diagOpen.addEventListener('click', async () => {
  try {
    await chrome.tabs.create({ url: DETAILS_URL });
    window.close();
  } catch {
    // Chrome can refuse to let an extension navigate to its own settings page.
    // Showing the address is the next best thing.
    diagHint.hidden = false;
    diagHint.textContent = '';
    diagHint.append(document.createTextNode('Open this address yourself: '));
    const code = document.createElement('code');
    code.textContent = DETAILS_URL;
    diagHint.appendChild(code);
  }
});

async function hasRedirectRule() {
  try {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    return rules.some((rule) => rule.id === PDF_RULE_ID);
  } catch {
    return false;
  }
}

async function hasFileAccess() {
  try {
    return await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    return false;
  }
}

async function hasSiteAccess(origin) {
  try {
    return await chrome.permissions.contains({ origins: [`${origin}/*`] });
  } catch {
    return false;
  }
}

// Only http and https can be spoken for. The editor's own pages, chrome:// and
// the Web Store are all places no extension is allowed to reach, and reporting
// them as a failure would be noise rather than news.
async function currentOrigin() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url || '');
    return /^https?:$/.test(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}
