import * as pdfjsLib from '../vendor/pdf.min.mjs';
import { Annotations, rotateRatio } from './annotations.js';
import { Finder } from './find.js';
import {
  listStamps,
  saveStamp,
  deleteStamp,
  bitmapFromFile,
  buildFromBitmap,
  buildFromInk,
} from './stamps.js';
import {
  stampPdf,
  toPdfBlobUrl,
  downloadBytes,
  measureAllBaselineRatios,
  normaliseAngle,
} from './export.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.mjs');
const STANDARD_FONTS = chrome.runtime.getURL('vendor/standard_fonts/');

const MIN_SCALE = 0.15;
const MAX_SCALE = 8;
const GAP = 14; // vertical space between pages
const PAD_X = 24;

// Pages within this distance of the viewport are mounted and rendered; anything
// beyond is torn down. A 1600 page file cannot hold 1600 canvases at once.
const RENDER_MARGIN = 900;

// Chrome refuses to allocate very large canvases, and PDF.js caps itself the
// same way. Past this the bitmap is rendered smaller and stretched, which goes
// slightly soft rather than failing outright.
const MAX_CANVAS_PIXELS = 16_777_216;
const MAX_CONCURRENT_RENDERS = 2;
const ZOOM_SETTLE_MS = 160;

// R is left for rotate, matching every other PDF viewer, so the rectangle takes
// B for box.
const TOOL_KEYS = {
  v: 'select',
  t: 'text',
  h: 'highlight',
  b: 'rect',
  o: 'ellipse',
  l: 'line',
  a: 'arrow',
  k: 'tick',
  x: 'cross',
  s: 'stamp',
};

const el = {};
for (const node of document.querySelectorAll('[id]')) el[node.id] = node;

const state = {
  bytes: null, // pristine copy; PDF.js detaches whatever buffer it is handed
  doc: null,
  pageCount: 0,
  natural: [], // unscaled page sizes at the page's own /Rotate
  offsets: [],
  widths: [],
  heights: [],
  totalHeight: 0,
  contentWidth: 0,
  scale: 1.25,
  viewRotation: 0,
  fitMode: null, // 'width' keeps the fit as the window resizes
  currentIndex: 0,
  mounted: new Map(), // pageIndex -> entry
  fileName: 'document.pdf',
  originalUrl: null,
  docKey: null,
  generation: 0, // bumped on zoom/rotate so stale renders are discarded
  ready: false,
};

const queue = new Set();
let inFlight = 0;
let zoomTimer = null;

const history = { past: [], future: [], suspended: false };

const annotations = new Annotations({
  onChange: () => {
    scheduleSave();
    schedulePush();
    updateClearButton();
  },
  onSelect: (record) => onSelectionChanged(record),
  onPlace: () => {
    // Straight into Select, because the next thing anyone does with a freshly
    // dropped signature is nudge it into place.
    selectTool('select');
    flash('Drag to move it, or pull a corner to resize.');
  },
});

let finder = null;

// ---------------------------------------------------------------------- boot

boot().catch((error) => fail(error.message || String(error)));

async function boot() {
  wireToolbar();
  wireTools();
  wireFind();
  wireStamps();
  wireKeyboard();
  wireDropTarget();
  await restoreStylePrefs();

  // Left encoded on purpose: for the redirect rule this fragment is the
  // original URL, and decoding it would corrupt percent-escaped paths.
  const hash = location.hash.slice(1);
  if (!hash) {
    return showOverlay(
      'Open a PDF',
      'Drop a PDF anywhere on this window, or use the Open button above.'
    );
  }

  if (hash.startsWith('k=')) {
    const source = await chrome.runtime.sendMessage({ type: 'get-source', key: hash.slice(2) });
    if (!source) {
      return showOverlay(
        'That PDF is no longer available',
        'The handoff expired, which usually means the page was reloaded. Open the PDF again, or drop the file here.'
      );
    }
    if (source.kind === 'bytes') {
      return loadBytes(base64ToBytes(source.b64), source.name || 'document.pdf');
    }
    return loadUrl(source.url, source.name);
  }

  return loadUrl(hash, fileNameFromUrl(hash));
}

async function loadUrl(url, name) {
  state.originalUrl = /^(https?|file):/.test(url) ? url : null;
  showOverlay('Loading', url.length > 120 ? `${url.slice(0, 120)}...` : url);

  try {
    const isHttp = /^https?:/.test(url);
    const response = await fetch(url, isHttp ? { credentials: 'include' } : undefined);
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    const buffer = await response.arrayBuffer();
    await loadBytes(new Uint8Array(buffer), name || fileNameFromUrl(url));
  } catch (error) {
    if (url.startsWith('file://')) {
      return fail(
        'Could not read that local file. Open chrome://extensions, find Write on PDF, and turn on "Allow access to file URLs".'
      );
    }
    fail(`Could not download that PDF. ${error.message}`);
  }
}

async function loadBytes(bytes, name) {
  state.bytes = bytes;
  // Cleared before anything can autosave, so opening a second file cannot write
  // its blank state over the first one's notes.
  state.docKey = null;
  state.fileName = name || 'document.pdf';
  el.fileName.textContent = state.fileName;
  el.fileName.title = state.fileName;
  el.chromeViewerBtn.hidden = !state.originalUrl;
  document.title = `${state.fileName} - Write on PDF`;

  const task = pdfjsLib.getDocument({
    data: bytes.slice(), // PDF.js transfers this buffer to its worker
    standardFontDataUrl: STANDARD_FONTS,
  });

  task.onPassword = (submit, reason) => {
    askPassword(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD).then((password) => {
      if (password === null) task.destroy();
      else submit(password);
    });
  };

  try {
    state.doc = await task.promise;
  } catch (error) {
    if (error?.name === 'PasswordException' || /password/i.test(error?.message || '')) {
      return fail('This PDF is password protected and no password was given.');
    }
    return fail(`This file could not be opened as a PDF. ${error.message || ''}`.trim());
  }

  hideOverlay();
  await buildDocument();
  await restoreAnnotations();
  await restorePosition();
  seedHistory();
}

// ----------------------------------------------------------------- document

async function buildDocument() {
  for (const index of [...state.mounted.keys()]) unmountPage(index);
  queue.clear();
  annotations.clearAll();
  el.pages.textContent = '';

  state.pageCount = state.doc.numPages;
  state.natural = new Array(state.pageCount);
  state.offsets = new Array(state.pageCount);
  state.widths = new Array(state.pageCount);
  state.heights = new Array(state.pageCount);
  state.currentIndex = 0;
  state.viewRotation = 0;
  state.fitMode = null;
  state.ready = true;

  // Page one's size stands in for every page until each is loaded for real.
  // Documents that mix sizes correct themselves as you reach them.
  const first = await state.doc.getPage(1);
  const base = first.getViewport({ scale: 1 });
  for (let index = 0; index < state.pageCount; index += 1) {
    state.natural[index] = { width: base.width, height: base.height };
  }

  finder = new Finder({
    getPage: (index) => state.doc.getPage(index + 1),
    pageCount: state.pageCount,
    onUpdate: (info) => onFindUpdate(info),
    onGeometry: (index) => {
      const entry = state.mounted.get(index);
      if (entry) paintFindLayer(index, entry);
    },
  });

  el.pageInput.max = String(state.pageCount);
  relayout();

  // A page wider than the window is the common case on a laptop, and starting
  // scrolled sideways feels broken, so fit rather than use the default zoom.
  if (state.widths[0] > el.scroller.clientWidth - PAD_X * 2) fitToWidth();

  updateWindow();
  // Annotations track their own scale, and nothing else has told them about
  // this document yet. Restored notes are mounted right after this.
  annotations.relayout(state.scale, state.viewRotation, layoutBoxes());
  updateChrome();
}

function displaySize(index) {
  const natural = state.natural[index];
  return state.viewRotation % 180 === 0
    ? { width: natural.width, height: natural.height }
    : { width: natural.height, height: natural.width };
}

// Positions are kept in a flat array so the visible range is a binary search
// instead of a walk over every page.
function relayout() {
  let top = GAP;
  let widest = 0;

  for (let index = 0; index < state.pageCount; index += 1) {
    const size = displaySize(index);
    const width = Math.round(size.width * state.scale);
    const height = Math.round(size.height * state.scale);

    state.offsets[index] = top;
    state.widths[index] = width;
    state.heights[index] = height;
    top += height + GAP;
    if (width > widest) widest = width;
  }

  state.totalHeight = top;
  state.contentWidth = Math.max(el.scroller.clientWidth, widest + PAD_X * 2);

  el.pages.style.height = `${state.totalHeight}px`;
  el.pages.style.width = `${state.contentWidth}px`;

  for (const [index, entry] of state.mounted) positionPage(index, entry);
}

function positionPage(index, entry) {
  const width = state.widths[index];
  const height = state.heights[index];

  entry.container.style.left = `${Math.round((state.contentWidth - width) / 2)}px`;
  entry.container.style.top = `${state.offsets[index]}px`;
  entry.container.style.width = `${width}px`;
  entry.container.style.height = `${height}px`;
  entry.container.style.setProperty('--scale-factor', String(state.scale));

  if (entry.canvas) {
    // Stretch whatever bitmap is already there so zooming never shifts the
    // layout; the re-render that follows sharpens it back up.
    entry.canvas.style.width = `${width}px`;
    entry.canvas.style.height = `${height}px`;
  }

  paintFindLayer(index, entry);
}

// ------------------------------------------------------------------ windowing

function firstVisibleIndex(top) {
  let low = 0;
  let high = state.pageCount - 1;
  let found = 0;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (state.offsets[mid] + state.heights[mid] >= top) {
      found = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return found;
}

function visibleRange() {
  if (!state.pageCount) return [0, -1];

  const top = el.scroller.scrollTop - RENDER_MARGIN;
  const bottom = el.scroller.scrollTop + el.scroller.clientHeight + RENDER_MARGIN;

  const first = firstVisibleIndex(top);
  let last = first;
  while (last + 1 < state.pageCount && state.offsets[last + 1] < bottom) last += 1;
  return [first, last];
}

function updateWindow() {
  if (!state.ready) return;
  const [first, last] = visibleRange();

  for (const index of [...state.mounted.keys()]) {
    if (index < first || index > last) unmountPage(index);
  }
  for (let index = first; index <= last; index += 1) mountPage(index);

  updateCurrentPage();
  pump();
}

function mountPage(index) {
  if (state.mounted.has(index)) return;

  const container = document.createElement('div');
  container.className = 'page blank';
  container.dataset.index = String(index);

  const findLayer = document.createElement('div');
  findLayer.className = 'findLayer';

  const layer = document.createElement('div');
  layer.className = 'layer';

  container.append(findLayer, layer);
  el.pages.appendChild(container);

  const entry = { container, layer, findLayer, canvas: null, page: null, task: null, textLayer: null };
  state.mounted.set(index, entry);

  positionPage(index, entry);
  annotations.mountPage(index, layer, { width: state.widths[index], height: state.heights[index] });
  queue.add(index);
}

function unmountPage(index) {
  const entry = state.mounted.get(index);
  if (!entry) return;

  entry.task?.cancel();
  entry.textLayer?.cancel();
  annotations.unmountPage(index);
  entry.container.remove();
  state.mounted.delete(index);
  queue.delete(index);
}

// ------------------------------------------------------------------ rendering

function pump() {
  while (inFlight < MAX_CONCURRENT_RENDERS) {
    const next = nearestQueued();
    if (next === -1) return;
    queue.delete(next);
    renderPage(next);
  }
}

// Whatever is closest to the reader gets drawn first, so scrolling fast never
// leaves the visible page waiting behind pages already scrolled past.
function nearestQueued() {
  let best = -1;
  let bestDistance = Infinity;
  for (const index of queue) {
    const distance = Math.abs(index - state.currentIndex);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

async function renderPage(index) {
  const entry = state.mounted.get(index);
  if (!entry) return;

  inFlight += 1;
  const generation = state.generation;

  try {
    if (!entry.page) entry.page = await state.doc.getPage(index + 1);
    if (generation !== state.generation || !state.mounted.has(index)) return;

    const page = entry.page;
    const natural = page.getViewport({ scale: 1 });
    if (
      Math.abs(natural.width - state.natural[index].width) > 0.5 ||
      Math.abs(natural.height - state.natural[index].height) > 0.5
    ) {
      // Every page below this one shifts. Correcting the scroll by the same
      // amount stops a mixed-size document from jumping under the reader.
      const before = state.offsets[state.currentIndex];
      state.natural[index] = { width: natural.width, height: natural.height };
      relayout();
      annotations.relayout(state.scale, state.viewRotation, layoutBoxes());
      el.scroller.scrollTop += state.offsets[state.currentIndex] - before;
    }

    const viewport = page.getViewport({
      scale: state.scale,
      rotation: normaliseAngle(page.rotate + state.viewRotation),
    });
    const output = outputScaleFor(viewport);

    if (!entry.canvas) {
      entry.canvas = document.createElement('canvas');
      entry.container.insertBefore(entry.canvas, entry.findLayer);
    }

    entry.canvas.style.width = `${state.widths[index]}px`;
    entry.canvas.style.height = `${state.heights[index]}px`;
    entry.canvas.width = Math.floor(viewport.width * output);
    entry.canvas.height = Math.floor(viewport.height * output);

    entry.task?.cancel();
    entry.task = page.render({
      canvasContext: entry.canvas.getContext('2d', { alpha: false }),
      viewport,
      transform: output === 1 ? null : [output, 0, 0, output, 0, 0],
    });
    await entry.task.promise;
    entry.task = null;

    if (generation !== state.generation) return;
    entry.container.classList.remove('blank');

    buildTextLayer(index, entry, viewport, generation);
  } catch (error) {
    if (error?.name !== 'RenderingCancelledException') {
      console.warn(`Could not render page ${index + 1}`, error);
    }
  } finally {
    inFlight -= 1;
    pump();
  }
}

function outputScaleFor(viewport) {
  const dpr = window.devicePixelRatio || 1;
  const pixels = Math.max(1, viewport.width * viewport.height);
  return Math.max(0.1, Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / pixels)));
}

// Selectable text sits in an invisible layer of positioned spans over the
// canvas. It is built after the pixels land so it never delays them.
async function buildTextLayer(index, entry, viewport, generation) {
  if (entry.textLayer || entry.textDiv) return;

  const div = document.createElement('div');
  div.className = 'textLayer';
  entry.textDiv = div;
  entry.container.insertBefore(div, entry.layer);

  try {
    const layer = new pdfjsLib.TextLayer({
      textContentSource: entry.page.streamTextContent(),
      container: div,
      viewport,
    });
    entry.textLayer = layer;
    await layer.render();
    if (generation !== state.generation) {
      div.remove();
      entry.textDiv = null;
      entry.textLayer = null;
    }
  } catch {
    div.remove();
    entry.textDiv = null;
    entry.textLayer = null;
  }
}

function layoutBoxes() {
  const boxes = new Map();
  for (const index of state.mounted.keys()) {
    boxes.set(index, { width: state.widths[index], height: state.heights[index] });
  }
  return boxes;
}

// ------------------------------------------------------------- zoom & rotate

function setScale(scale, { keepFit = false } = {}) {
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
  if (Math.abs(next - state.scale) < 0.0005) return;
  if (!keepFit) state.fitMode = null;

  // Hold the reader's place: remember how far into the current page they are,
  // then restore that same fraction once everything has been re-measured.
  const anchor = state.currentIndex;
  const into = state.heights[anchor]
    ? (el.scroller.scrollTop - state.offsets[anchor]) / state.heights[anchor]
    : 0;

  state.scale = next;
  state.generation += 1;
  relayout();
  annotations.relayout(state.scale, state.viewRotation, layoutBoxes());
  el.scroller.scrollTop = state.offsets[anchor] + into * state.heights[anchor];

  updateChrome();
  updateWindow();

  // Re-rendering on every wheel notch would thrash the worker, so the stretched
  // bitmaps stand in until the zoom stops moving.
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => {
    for (const index of state.mounted.keys()) queue.add(index);
    pump();
  }, ZOOM_SETTLE_MS);
}

function fitToWidth() {
  if (!state.pageCount) return;
  const available = el.scroller.clientWidth - PAD_X * 2;
  state.fitMode = 'width';
  setScale(available / displaySize(state.currentIndex).width, { keepFit: true });
}

function rotateView() {
  if (!state.pageCount) return;
  state.viewRotation = normaliseAngle(state.viewRotation + 90);
  state.generation += 1;

  // Every canvas and text layer is now the wrong shape, so start them over.
  const anchor = state.currentIndex;
  for (const index of [...state.mounted.keys()]) unmountPage(index);

  relayout();
  // Rotation before remounting, so pages come back already facing the right way
  // instead of being painted twice.
  annotations.relayout(state.scale, state.viewRotation, new Map());
  el.scroller.scrollTop = state.offsets[anchor];
  updateWindow();
}

function updateCurrentPage() {
  if (!state.pageCount) return;
  const middle = el.scroller.scrollTop + el.scroller.clientHeight / 2;
  const index = Math.min(state.pageCount - 1, firstVisibleIndex(middle));
  if (index === state.currentIndex) return;
  state.currentIndex = index;
  if (document.activeElement !== el.pageInput) el.pageInput.value = String(index + 1);
}

function updateChrome() {
  el.zoomLevel.textContent = `${Math.round(state.scale * 100)}%`;
  el.pageTotal.textContent = `/ ${state.pageCount || '-'}`;
  if (document.activeElement !== el.pageInput) {
    el.pageInput.value = String(state.currentIndex + 1);
  }
}

function goToPage(number) {
  if (!state.pageCount) return;
  const target = Math.min(state.pageCount, Math.max(1, Math.round(number) || 1)) - 1;
  el.scroller.scrollTop = Math.max(0, state.offsets[target] - GAP);
  state.currentIndex = target;
  updateChrome();
  updateWindow();
}

// ------------------------------------------------------------------- toolbar

function wireToolbar() {
  el.openBtn.addEventListener('click', () => el.filePicker.click());
  el.filePicker.addEventListener('change', async () => {
    const file = el.filePicker.files?.[0];
    if (file) await openFile(file);
    el.filePicker.value = '';
  });

  el.zoomIn.addEventListener('click', () => setScale(state.scale * 1.15));
  el.zoomOut.addEventListener('click', () => setScale(state.scale / 1.15));
  el.zoomLevel.addEventListener('click', () => setScale(1));
  el.fitWidth.addEventListener('click', fitToWidth);
  el.rotateBtn.addEventListener('click', rotateView);

  el.pageInput.addEventListener('change', () => goToPage(Number(el.pageInput.value)));
  el.pageInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    goToPage(Number(el.pageInput.value));
    el.pageInput.blur();
  });

  el.printBtn.addEventListener('click', () => runExport('print'));
  el.saveBtn.addEventListener('click', () => runExport('save'));

  el.undoBtn.addEventListener('click', undo);
  el.redoBtn.addEventListener('click', redo);
  el.deleteBtn.addEventListener('click', () => annotations.deleteSelected());
  el.clearBtn.addEventListener('click', clearEverything);

  el.chromeViewerBtn.addEventListener('click', async () => {
    const tab = await chrome.tabs.getCurrent();
    if (tab && state.originalUrl) {
      chrome.runtime.sendMessage({ type: 'bypass', tabId: tab.id, url: state.originalUrl });
    }
  });

  el.scroller.addEventListener(
    'scroll',
    () => {
      updateWindow();
      updateChrome();
      schedulePositionSave();
    },
    { passive: true }
  );

  // In select mode the annotation layer is transparent to the pointer, so a
  // click on bare page never reaches it. Clear the selection from out here.
  el.scroller.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('.anno')) annotations.deselect();
  });

  el.scroller.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setScale(state.scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
    },
    { passive: false }
  );

  window.addEventListener('resize', () => {
    if (state.fitMode === 'width') fitToWidth();
    else {
      relayout();
      updateWindow();
    }
  });

  window.addEventListener('beforeunload', () => {
    persistAnnotations();
    persistPosition();
  });
}

// ---------------------------------------------------------------------- tools

function wireTools() {
  for (const button of document.querySelectorAll('.tool')) {
    button.addEventListener('click', () => selectTool(button.dataset.tool));
  }
  selectTool('text');

  el.fontFamily.addEventListener('change', () => style({ font: el.fontFamily.value }));
  el.fontSize.addEventListener('change', () => {
    const fontPt = Math.min(96, Math.max(4, Number(el.fontSize.value) || 12));
    el.fontSize.value = String(fontPt);
    style({ fontPt });
  });

  for (const [id, key] of [
    ['boldBtn', 'bold'],
    ['italicBtn', 'italic'],
    ['underlineBtn', 'underline'],
    ['strikeBtn', 'strike'],
  ]) {
    el[id].addEventListener('click', () => {
      const next = el[id].getAttribute('aria-pressed') !== 'true';
      el[id].setAttribute('aria-pressed', String(next));
      style({ [key]: next });
    });
  }

  el.colorPicker.addEventListener('input', () => style({ color: el.colorPicker.value }));
  el.bgPicker.addEventListener('input', () => style({ background: el.bgPicker.value }));
  el.bgClear.addEventListener('click', (event) => {
    event.preventDefault();
    style({ background: null });
  });

  el.shapeColor.addEventListener('input', () => style({ color: el.shapeColor.value }));
  el.strokeWidth.addEventListener('input', () => style({ strokeWidth: Number(el.strokeWidth.value) }));

  el.markColor.addEventListener('input', () => style({ color: el.markColor.value }));
  el.markSize.addEventListener('input', () => style({ sizePt: Number(el.markSize.value) }));
}

function style(patch) {
  annotations.applyStyle(patch);
  syncColourInputs();
  saveStylePrefs();
}

function selectTool(tool) {
  annotations.setTool(tool);
  for (const button of document.querySelectorAll('.tool')) {
    button.classList.toggle('selected', button.dataset.tool === tool);
  }

  // A selected annotation keeps its own controls on show; with nothing
  // selected the row follows whichever tool is in hand.
  if (annotations.selected) onSelectionChanged(annotations.selected);
  else showOptionsFor(tool);

  // Reaching for the signature tool with nothing saved has exactly one sensible
  // next step, so take it rather than showing an empty strip.
  if (tool === 'stamp' && annotations.stampIndex.size === 0) openSignDialog();
}

// The contextual row follows whichever tool is in hand, and switches to match a
// selected annotation so its own settings are the ones on show.
function showOptionsFor(tool) {
  const group =
    tool === 'text'
      ? 'textOpts'
      : tool === 'tick' || tool === 'cross'
        ? 'markOpts'
        : tool === 'stamp'
          ? 'stampOpts'
          : tool === 'select'
            ? null
            : 'shapeOpts';

  for (const id of ['textOpts', 'shapeOpts', 'markOpts', 'stampOpts']) {
    el[id].hidden = id !== group;
  }

  // A highlight is a filled band with no border, so thickness would do nothing.
  // It is also the one shape that has to be dragged, which is worth saying.
  const highlighting = tool === 'highlight';
  el.thicknessField.hidden = highlighting;
  el.shapeHint.textContent = highlighting ? 'Drag across what you want to highlight' : '';
}

function onSelectionChanged(record) {
  el.deleteBtn.disabled = !record;
  if (!record) {
    showOptionsFor(annotations.tool);
    // The slider was showing whatever was selected; hand it back to the size
    // the next signature will be placed at.
    el.stampSize.value = String(annotations.style.stampWidth);
    updateStampHint();
    return;
  }

  const group =
    record.kind === 'text'
      ? 'text'
      : record.kind === 'mark'
        ? 'tick'
        : record.kind === 'image'
          ? 'stamp'
          : record.shape === 'highlight'
            ? 'highlight'
            : 'rect';
  showOptionsFor(group);

  if (record.kind === 'text') {
    el.fontFamily.value = record.font;
    el.fontSize.value = String(record.fontPt);
    el.boldBtn.setAttribute('aria-pressed', String(Boolean(record.bold)));
    el.italicBtn.setAttribute('aria-pressed', String(Boolean(record.italic)));
    el.underlineBtn.setAttribute('aria-pressed', String(Boolean(record.underline)));
    el.strikeBtn.setAttribute('aria-pressed', String(Boolean(record.strike)));
    el.colorPicker.value = record.color;
    if (record.background) el.bgPicker.value = record.background;
  } else if (record.kind === 'mark') {
    el.markColor.value = record.color;
    el.markSize.value = String(record.sizePt);
  } else if (record.kind === 'image') {
    el.stampSize.value = String(record.wRatio);
    updateStampHint('Drag to move it, corners to resize');
  } else if (record.kind === 'box' || record.kind === 'line') {
    el.shapeColor.value = record.color;
    el.strokeWidth.value = String(record.strokeWidth);
  }
}

// One colour is shared across the tools, but a selected annotation keeps its
// own, so adjusting its width must not repaint the swatch with the default.
function syncColourInputs() {
  const colour = annotations.selected?.color ?? annotations.style.color;
  el.colorPicker.value = colour;
  el.shapeColor.value = colour;
  el.markColor.value = colour;
}

// --------------------------------------------------------------------- stamps

function wireStamps() {
  el.stampAdd.addEventListener('click', openSignDialog);
  el.stampSize.addEventListener('input', () => {
    annotations.applyStyle({ stampWidth: Number(el.stampSize.value) });
    saveStylePrefs();
  });

  wireSignDialog();
  refreshStamps();
}

// Saved signatures sit right in the toolbar as thumbnails rather than behind a
// menu, so choosing one is a single click and the current choice is always in
// view next to the tool that uses it.
async function refreshStamps(selectId) {
  const stamps = await listStamps();
  annotations.setStamps(stamps);

  if (selectId) annotations.setActiveStamp(selectId);
  else if (!stamps.some((stamp) => stamp.id === annotations.activeStampId)) {
    annotations.setActiveStamp(stamps[0]?.id || null);
  }

  el.stampStrip.textContent = '';

  for (const stamp of stamps) {
    const chip = document.createElement('button');
    chip.className = 'stamp-chip';
    chip.title = stamp.name;
    chip.classList.toggle('selected', stamp.id === annotations.activeStampId);

    const image = document.createElement('img');
    image.src = stamp.dataUrl;
    image.alt = stamp.name;
    chip.appendChild(image);

    // A span, not a button: a button inside a button is invalid and behaves
    // unpredictably. stopPropagation keeps the click off the chip.
    const drop = document.createElement('span');
    drop.className = 'drop';
    drop.title = `Remove "${stamp.name}"`;
    drop.textContent = '\u00d7';
    drop.addEventListener('click', async (event) => {
      event.stopPropagation();

      // Deleting a signature that is already on the page would otherwise leave
      // invisible empty boxes behind, so those go with it.
      const placed = annotations.serialize().filter((record) => record.stampId === stamp.id);
      if (placed.length) {
        const where = placed.length === 1 ? 'one place' : `${placed.length} places`;
        const ok = confirm(
          `"${stamp.name}" is on this document in ${where}. Delete it and remove those too?`
        );
        if (!ok) return;
        // replaceAll bypasses onChange, so the save has to be asked for.
        annotations.replaceAll(
          annotations.serialize().filter((record) => record.stampId !== stamp.id)
        );
        pushHistory();
        scheduleSave();
      }

      await deleteStamp(stamp.id);
      await refreshStamps();
    });
    chip.appendChild(drop);

    chip.addEventListener('click', () => {
      annotations.setActiveStamp(stamp.id);
      for (const other of el.stampStrip.children) other.classList.remove('selected');
      chip.classList.add('selected');
      updateStampHint();
    });

    el.stampStrip.appendChild(chip);
  }

  updateStampHint();
}

function updateStampHint(message) {
  if (message) {
    el.stampHint.textContent = message;
    return;
  }
  const hasStamps = annotations.stampIndex.size > 0;
  el.stampHint.textContent = hasStamps
    ? 'Click the page to place it'
    : 'Add a signature to get started';
  el.stampSizeField.hidden = !hasStamps;
}

// ------------------------------------------------------------ sign dialog

let signBitmap = null; // the uploaded image, kept so the toggle can re-key it
let signCandidate = null; // { dataUrl, aspect } ready to save
let signMode = 'draw';
let signName = 'Signature';

function wireSignDialog() {
  for (const button of el.signDialog.querySelectorAll('.seg')) {
    button.addEventListener('click', () => setSignMode(button.dataset.mode));
  }

  el.signCancel.addEventListener('click', closeSignDialog);
  el.signSave.addEventListener('click', saveSignature);
  el.signClear.addEventListener('click', clearSignPad);
  el.signRechoose.addEventListener('click', () => el.imagePicker.click());
  el.signDrop.addEventListener('click', () => el.imagePicker.click());
  el.signDropBg.addEventListener('change', renderUploadPreview);

  el.imagePicker.addEventListener('change', async () => {
    const file = el.imagePicker.files?.[0];
    el.imagePicker.value = '';
    if (file) await takeSignImage(file);
  });

  // Dropping onto the picker must not reach the document handler, which would
  // try to open the image as a PDF.
  for (const type of ['dragenter', 'dragover']) {
    el.signDrop.addEventListener(type, (event) => {
      event.preventDefault();
      event.stopPropagation();
      el.signDrop.classList.add('over');
    });
  }
  el.signDrop.addEventListener('dragleave', () => el.signDrop.classList.remove('over'));
  el.signDrop.addEventListener('drop', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    el.signDrop.classList.remove('over');
    const file = event.dataTransfer?.files?.[0];
    if (file) await takeSignImage(file);
  });

  el.signDialog.addEventListener('pointerdown', (event) => {
    if (event.target === el.signDialog) closeSignDialog();
  });

  wireSignPad();
}

function openSignDialog() {
  signBitmap = null;
  signCandidate = null;
  signName = 'Signature';

  el.signError.hidden = true;
  el.signResult.hidden = true;
  el.signDrop.hidden = false;
  el.signDialog.hidden = false;

  // Sizing the pad needs the dialog laid out, so this has to come after it is
  // no longer hidden.
  setSignMode('draw');
}

function closeSignDialog() {
  el.signDialog.hidden = true;
  signBitmap?.close?.();
  signBitmap = null;
  signCandidate = null;
}

function setSignMode(mode) {
  signMode = mode;
  for (const button of el.signDialog.querySelectorAll('.seg')) {
    button.classList.toggle('selected', button.dataset.mode === mode);
  }
  el.signDraw.hidden = mode !== 'draw';
  el.signUpload.hidden = mode !== 'upload';
  el.signError.hidden = true;
  if (mode === 'draw') resizeSignPad();
  updateSignSave();
}

async function takeSignImage(file) {
  try {
    signBitmap?.close?.();
    signBitmap = await bitmapFromFile(file);
    signName = file.name?.replace(/\.[^.]+$/, '') || 'Signature';
    el.signError.hidden = true;
    renderUploadPreview();
  } catch {
    signBitmap = null;
    signCandidate = null;
    showSignError('That file could not be read as an image.');
    updateSignSave();
  }
}

// Re-runs whenever the background switch moves, so the effect is something you
// watch happen instead of a promise you have to take on trust.
function renderUploadPreview() {
  if (!signBitmap) return;

  signCandidate = buildFromBitmap(signBitmap, { dropBackground: el.signDropBg.checked });

  if (!signCandidate) {
    showSignError(
      el.signDropBg.checked
        ? 'Removing the background left nothing behind. Try it switched off.'
        : 'That image looks empty.'
    );
    el.signResult.hidden = true;
    el.signDrop.hidden = false;
  } else {
    el.signError.hidden = true;
    el.signPreview.src = signCandidate.dataUrl;
    el.signResult.hidden = false;
    el.signDrop.hidden = true;
  }
  updateSignSave();
}

function showSignError(message) {
  el.signError.textContent = message;
  el.signError.hidden = false;
}

async function saveSignature() {
  const built = signMode === 'draw' ? buildFromInk(el.signPad) : signCandidate;
  if (!built) {
    showSignError(
      signMode === 'draw' ? 'Draw your signature first.' : 'Choose an image first.'
    );
    return;
  }

  const stamp = await saveStamp({
    name: signMode === 'draw' ? 'Signature' : signName,
    dataUrl: built.dataUrl,
    aspect: built.aspect,
  });

  closeSignDialog();
  await refreshStamps(stamp.id);
  selectTool('stamp');
  updateStampHint('Now click the page to place it');
  flash('Signature saved. Click anywhere on the page to place it.');
}

function updateSignSave() {
  el.signSave.disabled = signMode === 'draw' ? !signPadHasInk : !signCandidate;
}

// ------------------------------------------------------------- drawing pad

let signPadHasInk = false;

function wireSignPad() {
  const canvas = el.signPad;
  let drawing = false;
  let previous = null;
  let previousMid = null;

  const pointAt = (event) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * canvas.width) / rect.width,
      y: ((event.clientY - rect.top) * canvas.height) / rect.height,
    };
  };
  const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  canvas.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    drawing = true;
    previous = pointAt(event);
    previousMid = previous;

    // A dot, so a full stop or a tap still leaves a mark.
    const context = signPadContext();
    context.beginPath();
    context.arc(previous.x, previous.y, context.lineWidth / 2, 0, Math.PI * 2);
    context.fill();

    signPadHasInk = true;
    updateSignSave();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!drawing) return;
    const point = pointAt(event);
    const mid = midpoint(previous, point);

    // Curving through the midpoints rounds off the corners that raw segments
    // leave behind, which is what stops mouse-drawn writing looking spiky.
    const context = signPadContext();
    context.beginPath();
    context.moveTo(previousMid.x, previousMid.y);
    context.quadraticCurveTo(previous.x, previous.y, mid.x, mid.y);
    context.stroke();

    previous = point;
    previousMid = mid;
  });

  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
    canvas.addEventListener(type, () => {
      drawing = false;
    });
  }
}

function signPadContext() {
  const context = el.signPad.getContext('2d');
  context.lineWidth = Math.max(3, el.signPad.width / 260);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = '#111827';
  context.fillStyle = '#111827';
  return context;
}

// The backing store is matched to the box at twice the density, so strokes come
// out crisp and undistorted whatever width the dialog ends up.
function resizeSignPad() {
  const rect = el.signPad.getBoundingClientRect();
  if (!rect.width) return;
  el.signPad.width = Math.round(rect.width * 2);
  el.signPad.height = Math.round(rect.height * 2);
  clearSignPad();
}

function clearSignPad() {
  el.signPad.getContext('2d').clearRect(0, 0, el.signPad.width, el.signPad.height);
  signPadHasInk = false;
  updateSignSave();
}

// ----------------------------------------------------------------------- find

function wireFind() {
  el.findBtn.addEventListener('click', toggleFind);
  el.findClose.addEventListener('click', closeFind);
  el.findNext.addEventListener('click', () => stepFind(1));
  el.findPrev.addEventListener('click', () => stepFind(-1));
  el.findCase.addEventListener('change', () => runFind());

  let debounce = null;
  el.findInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(runFind, 220);
  });

  el.findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      stepFind(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeFind();
    }
  });
}

function toggleFind() {
  if (el.findBar.hidden) {
    el.findBar.hidden = false;
    el.findInput.focus();
    el.findInput.select();
  } else {
    closeFind();
  }
}

function closeFind() {
  el.findBar.hidden = true;
  finder?.clear();
  el.findCount.textContent = '\u00a0';
  repaintFindLayers();
}

function runFind() {
  if (!finder) return;
  const query = el.findInput.value;
  el.findCount.textContent = query ? 'Searching\u2026' : '\u00a0';
  el.progress.classList.toggle('busy', Boolean(query));
  finder.search(query, { caseSensitive: el.findCase.checked, startPage: state.currentIndex });
}

function stepFind(direction) {
  const match = finder?.step(direction);
  if (!match) return;
  el.findCount.textContent = `${finder.ordinal} of ${finder.total}`;
  revealMatch(match);
}

function onFindUpdate(info) {
  if (!finder) return;

  if (!info.done) {
    el.progressBar.style.width = `${Math.round((info.progress || 0) * 100)}%`;
    el.findCount.textContent = `${finder.total} so far\u2026`;
    return;
  }

  el.progress.classList.remove('busy');
  el.progressBar.style.width = '0';

  if (!el.findInput.value) {
    el.findCount.textContent = '\u00a0';
  } else {
    el.findCount.textContent = finder.total ? `${finder.ordinal} of ${finder.total}` : 'No matches';
  }

  repaintFindLayers();
  if (finder.active) revealMatch(finder.active);
}

async function revealMatch(match) {
  // Scroll to the page first so something moves immediately, then refine to the
  // exact line once the highlight geometry for that page has been worked out.
  if (match.pageIndex !== state.currentIndex) goToPage(match.pageIndex + 1);

  await finder.ensureRects(match.pageIndex);
  if (finder.active !== match) return;
  repaintFindLayers();

  const rect = match.rects?.[0];
  if (!rect) return;

  const target =
    state.offsets[match.pageIndex] +
    projectRect(rect).y * state.heights[match.pageIndex] -
    el.scroller.clientHeight / 3;
  el.scroller.scrollTop = Math.max(0, target);
  updateWindow();
}

function repaintFindLayers() {
  for (const [index, entry] of state.mounted) paintFindLayer(index, entry);
}

function paintFindLayer(index, entry) {
  if (!entry.findLayer) return;

  const matches = finder && !el.findBar.hidden ? finder.rectsFor(index) : [];
  entry.findLayer.textContent = '';
  if (!matches.length) return;

  const active = finder.active;
  const width = state.widths[index];
  const height = state.heights[index];

  for (const match of matches) {
    for (const rect of match.rects || []) {
      const box = projectRect(rect);
      const hit = document.createElement('div');
      hit.className = match === active ? 'hit current' : 'hit';
      hit.style.left = `${box.x * width}px`;
      hit.style.top = `${box.y * height}px`;
      hit.style.width = `${box.w * width}px`;
      hit.style.height = `${box.h * height}px`;
      entry.findLayer.appendChild(hit);
    }
  }
}

// Search rects are measured on the unrotated page, the same convention
// annotations use, so a rotated view only re-projects them for display.
function projectRect(rect) {
  const a = rotateRatio(rect.x, rect.y, 0, state.viewRotation);
  const b = rotateRatio(rect.x + rect.w, rect.y + rect.h, 0, state.viewRotation);
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

// ------------------------------------------------------------------- keyboard

function wireKeyboard() {
  document.addEventListener('keydown', (event) => {
    // Modals come first: Escape has to work even with a field focused inside.
    if (event.key === 'Escape' && !el.signDialog.hidden) {
      event.preventDefault();
      return closeSignDialog();
    }

    const typing =
      event.target.isContentEditable ||
      ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName);
    const accel = event.ctrlKey || event.metaKey;

    if (accel) {
      const key = event.key.toLowerCase();
      if (key === 'p') {
        event.preventDefault();
        return runExport('print');
      }
      if (key === 's') {
        event.preventDefault();
        return runExport('save');
      }
      if (key === 'f') {
        event.preventDefault();
        return toggleFind();
      }
      if (key === 'z' && !typing) {
        event.preventDefault();
        return event.shiftKey ? redo() : undo();
      }
      if (key === 'y' && !typing) {
        event.preventDefault();
        return redo();
      }
      if (key === '=' || key === '+') {
        event.preventDefault();
        return setScale(state.scale * 1.15);
      }
      if (key === '-') {
        event.preventDefault();
        return setScale(state.scale / 1.15);
      }
      if (key === '0') {
        event.preventDefault();
        return setScale(1);
      }
      // Bold, italic and underline stay live while a text box is being typed
      // into, which is the moment they are most wanted.
      const editing = event.target.isContentEditable;
      if (typing && !editing) return;
      if (['b', 'i', 'u'].includes(key)) {
        event.preventDefault();
        const map = { b: 'boldBtn', i: 'italicBtn', u: 'underlineBtn' };
        return el[map[key]].click();
      }
      return;
    }

    if (typing) return;

    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (annotations.deleteSelected()) event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      if (!el.findBar.hidden) closeFind();
      return;
    }
    if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();
      return rotateView();
    }

    const tool = TOOL_KEYS[event.key.toLowerCase()];
    if (tool) {
      event.preventDefault();
      selectTool(tool);
    }
  });
}

// ---------------------------------------------------------------- undo & redo

let pushTimer = null;

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushHistory, 350);
}

function seedHistory() {
  history.past = [JSON.stringify(annotations.serialize())];
  history.future = [];
  updateHistoryButtons();
}

function pushHistory() {
  if (history.suspended) return;
  const snapshot = JSON.stringify(annotations.serialize());
  if (history.past[history.past.length - 1] === snapshot) return;

  history.past.push(snapshot);
  if (history.past.length > 80) history.past.shift();
  history.future = [];
  updateHistoryButtons();
}

function undo() {
  clearTimeout(pushTimer);
  pushHistory();
  if (history.past.length < 2) return;

  history.future.push(history.past.pop());
  applyHistory(history.past[history.past.length - 1]);
}

function redo() {
  if (!history.future.length) return;
  const snapshot = history.future.pop();
  history.past.push(snapshot);
  applyHistory(snapshot);
}

function applyHistory(snapshot) {
  history.suspended = true;
  annotations.replaceAll(JSON.parse(snapshot));
  history.suspended = false;
  updateHistoryButtons();
  scheduleSave();
}

function updateHistoryButtons() {
  el.undoBtn.disabled = history.past.length < 2;
  el.redoBtn.disabled = !history.future.length;
  updateClearButton();
}

// Counting through serialize() on every keystroke would be wasteful, and the
// raw record count answers the only question the button asks.
function updateClearButton() {
  el.clearBtn.disabled = annotations.records.size === 0;
}

function clearEverything() {
  if (!annotations.records.size) return;

  // count ignores text boxes that were opened but never typed into, and there
  // is nothing to warn anyone about losing those.
  const count = annotations.count;
  if (count) {
    const what = count === 1 ? 'the 1 change' : `all ${count} changes`;
    const ok = confirm(`Remove ${what} you have made to this document? Undo will bring them back.`);
    if (!ok) return;
  }

  annotations.replaceAll([]);
  pushHistory();
  scheduleSave();
  if (count) flash('Cleared. Ctrl+Z to bring it back.');
}

// -------------------------------------------------------------- drag and drop

function wireDropTarget() {
  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };

  // While the signature dialog is up, a dragged file is meant for its own drop
  // zone, so the whole-window PDF target stands down.
  const busy = () => !el.signDialog.hidden;

  for (const type of ['dragenter', 'dragover']) {
    document.addEventListener(type, (event) => {
      stop(event);
      if (!busy()) document.body.classList.add('dragging');
    });
  }

  for (const type of ['dragleave', 'dragend']) {
    document.addEventListener(type, (event) => {
      stop(event);
      if (event.relatedTarget === null) document.body.classList.remove('dragging');
    });
  }

  document.addEventListener('drop', async (event) => {
    stop(event);
    document.body.classList.remove('dragging');
    if (busy()) return;
    const file = event.dataTransfer?.files?.[0];
    if (file) await openFile(file);
  });
}

async function openFile(file) {
  state.originalUrl = null;
  const buffer = await file.arrayBuffer();
  await loadBytes(new Uint8Array(buffer), file.name);
}

// --------------------------------------------------------------- persistence

let saveTimer = null;
let positionTimer = null;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistAnnotations, 400);
}

async function persistAnnotations() {
  if (!state.docKey) return;
  const records = annotations.serialize();
  const key = `anno:${state.docKey}`;
  if (!records.length) await chrome.storage.local.remove(key);
  else await chrome.storage.local.set({ [key]: records });
}

async function restoreAnnotations() {
  state.docKey = await sha256Hex(state.bytes);
  const key = `anno:${state.docKey}`;
  const stored = await chrome.storage.local.get(key);
  const records = stored[key];
  if (!records?.length) return;

  annotations.load(records);
  flash(`Restored ${records.length} note${records.length === 1 ? '' : 's'} from last time.`);
}

function schedulePositionSave() {
  clearTimeout(positionTimer);
  positionTimer = setTimeout(persistPosition, 700);
}

function persistPosition() {
  if (!state.docKey) return;
  chrome.storage.local.set({
    [`pos:${state.docKey}`]: { page: state.currentIndex, scale: state.scale },
  });
}

async function restorePosition() {
  if (!state.docKey) return;
  const key = `pos:${state.docKey}`;
  const stored = await chrome.storage.local.get(key);
  const position = stored[key];
  if (!position) return;

  if (position.scale) setScale(position.scale);
  if (position.page) {
    goToPage(position.page + 1);
    flash(`Back on page ${position.page + 1}, where you left off.`);
  }
}

async function restoreStylePrefs() {
  const { annoStyle } = await chrome.storage.local.get('annoStyle');
  if (!annoStyle) return;

  // Highlighter opacity no longer has a control, so a value saved back when it
  // did must not stick: it would leave highlights wrong with no way to fix them.
  const { opacity, ...restorable } = annoStyle;
  annotations.applyStyle(restorable);
  el.fontFamily.value = annoStyle.font ?? 'helvetica';
  el.fontSize.value = String(annoStyle.fontPt ?? 12);
  el.boldBtn.setAttribute('aria-pressed', String(Boolean(annoStyle.bold)));
  el.italicBtn.setAttribute('aria-pressed', String(Boolean(annoStyle.italic)));
  el.underlineBtn.setAttribute('aria-pressed', String(Boolean(annoStyle.underline)));
  el.strikeBtn.setAttribute('aria-pressed', String(Boolean(annoStyle.strike)));
  el.strokeWidth.value = String(annoStyle.strokeWidth ?? 1.5);
  el.markSize.value = String(annoStyle.sizePt ?? 18);
  el.stampSize.value = String(annoStyle.stampWidth ?? 0.24);
  if (annoStyle.background) el.bgPicker.value = annoStyle.background;
  syncColourInputs();
}

function saveStylePrefs() {
  chrome.storage.local.set({ annoStyle: { ...annotations.style } });
}

// -------------------------------------------------------------------- export

async function runExport(mode) {
  if (!state.bytes) return;

  el.printBtn.disabled = true;
  el.saveBtn.disabled = true;
  el.progress.classList.add('busy');
  el.progressBar.style.width = '40%';

  try {
    const records = annotations.serialize();
    // With nothing added there is nothing to stamp, and re-saving through
    // pdf-lib would only risk changing a file that is already correct.
    const bytes = records.length
      ? await stampPdf(state.bytes, records, {
          baselineRatios: measureAllBaselineRatios(),
          stamps: annotations.stampIndex,
        })
      : state.bytes;

    el.progressBar.style.width = '100%';
    const baseName = state.fileName.replace(/\.pdf$/i, '');

    if (mode === 'save') {
      downloadBytes(bytes, records.length ? `${baseName} - annotated.pdf` : `${baseName}.pdf`);
      flash('Saved to your downloads folder.');
    } else {
      await printBytes(bytes);
    }
  } catch (error) {
    flash(`Export failed: ${error.message || error}`, true);
  } finally {
    el.printBtn.disabled = false;
    el.saveBtn.disabled = false;
    el.progress.classList.remove('busy');
    el.progressBar.style.width = '0';
  }
}

// Printing through a hidden frame goes straight to the print dialog. If the
// PDF plugin declines to load there, fall back to a normal tab.
let printFrame = null;

async function printBytes(bytes) {
  const url = toPdfBlobUrl(bytes);

  printFrame?.remove();
  printFrame = document.createElement('iframe');
  printFrame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;border:0';
  printFrame.src = url;

  const opened = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    printFrame.addEventListener('load', () => {
      clearTimeout(timer);
      try {
        printFrame.contentWindow.focus();
        printFrame.contentWindow.print();
        resolve(true);
      } catch {
        resolve(false);
      }
    });
    document.body.appendChild(printFrame);
  });

  if (opened) {
    flash('Print dialog opened.');
  } else {
    await chrome.tabs.create({ url });
    flash('Print-ready copy opened in a new tab. Press Ctrl+P there.');
  }

  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

// ------------------------------------------------------------------- password

function askPassword(retry) {
  return new Promise((resolve) => {
    el.passwordTitle.textContent = retry
      ? 'That password was not right'
      : 'This PDF is password protected';
    el.passwordModal.hidden = false;
    el.passwordInput.value = '';
    el.passwordInput.focus();

    const finish = (value) => {
      el.passwordModal.hidden = true;
      el.passwordForm.removeEventListener('submit', onSubmit);
      el.passwordCancel.removeEventListener('click', onCancel);
      resolve(value);
    };

    const onSubmit = (event) => {
      event.preventDefault();
      finish(el.passwordInput.value);
    };
    const onCancel = () => finish(null);

    el.passwordForm.addEventListener('submit', onSubmit);
    el.passwordCancel.addEventListener('click', onCancel);
  });
}

// ------------------------------------------------------------------- helpers

function showOverlay(title, text) {
  el.overlayTitle.textContent = title;
  el.overlayText.textContent = text;
  el.overlay.classList.add('show');
  el.scroller.style.display = 'none';
}

function hideOverlay() {
  el.overlay.classList.remove('show');
  el.scroller.style.display = '';
}

function fail(message) {
  showOverlay('Could not open this PDF', message);
}

let flashTimer = null;

function flash(message, isError = false) {
  el.status.textContent = message;
  el.status.classList.toggle('error', isError);
  el.status.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.status.classList.remove('show'), 5000);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fileNameFromUrl(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || 'document.pdf');
  } catch {
    return 'document.pdf';
  }
}
