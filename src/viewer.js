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
  supportsItalic,
  supportsBold,
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
  w: 'textbox',
  p: 'pen',
  h: 'highlight',
  b: 'rect',
  o: 'ellipse',
  l: 'line',
  a: 'arrow',
  k: 'tick',
  x: 'cross',
  s: 'stamp',
  i: 'image',
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
  wireTextSelection();
  wireDropTarget();

  // The export measures where the baseline sits in every family it might stamp,
  // and measuring a font that has not loaded returns the fallback's metrics.
  document.fonts?.load('16px Handlee').catch(() => {});
  document.fonts?.load('16px "Indie Flower"').catch(() => {});
  document.fonts?.load('16px "Patrick Hand"').catch(() => {});

  await restoreStylePrefs();

  // Left encoded on purpose: for the redirect rule this fragment is the
  // original URL, and decoding it would corrupt percent-escaped paths.
  const hash = location.hash.slice(1);
  if (!hash) {
    claimFocus();
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
  discardPrintFrame();
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
  claimFocus();
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

  el.helpBtn.addEventListener('click', () => showShortcuts(true));
  el.shortcutClose.addEventListener('click', () => showShortcuts(false));
  el.shortcutDialog.addEventListener('click', (event) => {
    if (event.target === el.shortcutDialog) showShortcuts(false);
  });

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
  // click on bare page never reaches it. Empty-page drags become a marquee that
  // gathers text notes; a plain click still clears the selection. PDF text
  // selection on the text layer is left alone so highlight / underline still work.
  //
  // On the way down, not on the way back up: the same click can create a note
  // and select it, and a deselect arriving afterwards would undo that. It looks
  // like the new note is selected, since the caret is sitting in it, while the
  // style controls quietly have nothing to act on.
  el.scroller.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0) return;
      if (event.target.closest('.anno')) return;
      if (
        event.target.closest(
          '#toolbar, #findBar, #selectionBar, dialog, button, input, textarea, select, label, a'
        )
      ) {
        return;
      }

      if (annotations.tool === 'select') {
        // The text layer covers the whole page. Only real glyph spans need
        // native PDF selection; treating any .textLayer hit as "selecting
        // text" meant the marquee never started.
        const onPdfGlyph = event.target.closest('.textLayer span');
        if (onPdfGlyph) {
          annotations.deselect();
          return;
        }
        const pageNode = event.target.closest('.page');
        if (!pageNode) {
          annotations.deselect();
          return;
        }
        const started = annotations.beginMarquee(Number(pageNode.dataset.index), event);
        if (started) event.preventDefault();
        return;
      }

      annotations.deselect();
    },
    true
  );

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
  selectTool('select');

  el.highlightSelectTip.addEventListener('click', () => {
    selectTool('select');
    flash('Drag across words on the page, then press Highlight, U or S.');
  });

  el.fontFamily.addEventListener('change', () => {
    style({ font: el.fontFamily.value });
    syncFontControls(el.fontFamily.value);
  });
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
  el.highlightOpacity.addEventListener('input', () => {
    style({ opacity: Number(el.highlightOpacity.value) });
  });
  el.fillPicker.addEventListener('input', () => style({ fill: el.fillPicker.value }));
  el.fillClear.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    style({ fill: null });
  });

  el.markColor.addEventListener('input', () => style({ color: el.markColor.value }));
  el.markSize.addEventListener('input', () => style({ sizePt: Number(el.markSize.value) }));

  for (const [id, edge, label] of [
    ['alignLeftBtn', 'left', 'Left edges lined up.'],
    ['alignRightBtn', 'right', 'Right edges lined up.'],
    ['alignTopBtn', 'top', 'Tops lined up.'],
    ['alignBottomBtn', 'bottom', 'Bottoms lined up.'],
  ]) {
    el[id].addEventListener('click', () => {
      if (annotations.alignTexts(edge)) flash(label);
      else flash('Select at least two text notes first (drag a box, Ctrl+A, or Shift-click).', true);
    });
  }

  for (const [id, align] of [
    ['textAlignLeftBtn', 'left'],
    ['textAlignCenterBtn', 'center'],
    ['textAlignRightBtn', 'right'],
  ]) {
    el[id].addEventListener('click', () => {
      style({ align });
      syncTextAlignButtons(align);
    });
  }

  keepSelectionOnControls();
}

// What is in the caret's way here is focus. A style control acts on whatever is
// selected, so taking focus to reach one drops a text box mid-edit and can bin
// an empty one outright. Buttons therefore refuse focus, which also leaves the
// caret exactly where it was, and the controls that genuinely need it, colour
// wells and sliders, give it back when they are done.
let resumeTarget = null;

function keepSelectionOnControls() {
  for (const row of document.querySelectorAll('.options')) {
    row.addEventListener('mousedown', (event) => {
      if (event.target.closest('button')) event.preventDefault();
    });
    row.addEventListener('pointerdown', (event) => {
      if (!event.target.closest('button')) rememberEditing();
    });
    row.addEventListener('change', resumeEditing);
  }
}

function rememberEditing() {
  const active = document.activeElement;
  if (!active?.isContentEditable) {
    resumeTarget = null;
    return;
  }

  const selection = window.getSelection();
  resumeTarget = {
    node: active,
    range: selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null,
  };
}

function resumeEditing() {
  const saved = resumeTarget;
  resumeTarget = null;
  if (!saved || !saved.node.isConnected) return;

  saved.node.focus();
  if (!saved.range) return;

  // Focusing a contenteditable drops the caret at the start, which would send
  // the next keystroke to the wrong end of the line.
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(saved.range);
}

function style(patch) {
  annotations.applyStyle(patch);
  syncColourInputs();
  if ('background' in patch) syncBgSwatch(patch.background);
  if ('fill' in patch) syncFillSwatch(patch.fill);
  saveStylePrefs();
}

// The colour input always shows a hue (browsers cannot show "empty"), so when
// background is off we mark the swatch as none and cover the misleading colour.
function syncBgSwatch(background) {
  const none = !background;
  el.bgSwatch.classList.toggle('is-none', none);
  el.bgSwatch.title = none
    ? 'Text background (none). Click to add a fill'
    : 'Text background';
  el.bgClear.setAttribute('aria-pressed', String(none));
  el.bgClear.title = none ? 'No background (current)' : 'Clear background';
  if (background) el.bgPicker.value = background;
}

function syncFillSwatch(fill) {
  const none = !fill;
  el.fillSwatch.classList.toggle('is-none', none);
  el.fillSwatch.title = none
    ? 'Fill (none). Click to add a fill'
    : 'Fill colour';
  el.fillClear.setAttribute('aria-pressed', String(none));
  el.fillClear.title = none ? 'No fill (current)' : 'Clear fill';
  if (fill) el.fillPicker.value = fill;
}

function selectTool(tool) {
  // The bar acts on selected words, and only Select can select them.
  if (tool !== 'select') hideSelectionBar();
  annotations.setTool(tool);
  for (const button of document.querySelectorAll('.tool')) {
    button.classList.toggle('selected', button.dataset.tool === tool);
  }

  // Always leave the caret / letter highlight behind when changing tools.
  // Select may keep the annotation selected for styling, but not the
  // contenteditable focus that paints the blue text selection.
  annotations.endTextEditing();

  // Keep the active chip matched to the tool in hand, so the ghost preview is
  // a signature under Signature and a photo under Image.
  if (tool === 'stamp' || tool === 'image') {
    const active = annotations.stampIndex.get(annotations.activeStampId);
    const match = tool === 'image' ? isImageStamp : isSignatureStamp;
    if (!match(active)) {
      const first = [...annotations.stampIndex.values()].find(match);
      annotations.setActiveStamp(first?.id || null);
    }
  }

  // A drawing tool needs its own options row (signature strip, thickness, …).
  // Keeping a prior selection used to leave shapeOpts up while the signature
  // ghost was already following the cursor, so the strip only appeared after
  // place (when the new image became the selection).
  if (tool !== 'select') {
    annotations.deselect();
    showOptionsFor(tool);
  } else if (annotations.selected) {
    onSelectionChanged(annotations.selected);
  } else {
    showOptionsFor(tool);
  }
}

// The contextual row follows whichever tool is in hand, and switches to match a
// selected annotation so its own settings are the ones on show.
function showOptionsFor(tool) {
  let group =
    tool === 'text' || tool === 'textbox'
      ? 'textOpts'
      : tool === 'tick' || tool === 'cross'
        ? 'markOpts'
        : tool === 'stamp'
          ? 'stampOpts'
          : tool === 'image'
            ? 'imageOpts'
            : tool === 'select'
              ? null
              : 'shapeOpts';

  // Select prefers the text align controls when this page has notes to line
  // up; otherwise the signature strip stays reachable without a trip back to
  // the Signature tool.
  if (tool === 'select') {
    if (annotations.hasTextOnPage(state.currentIndex)) group = 'textOpts';
    else if (annotations.stampIndex.size > 0) group = 'stampOpts';
  } else if (!group && annotations.stampIndex.size > 0) {
    group = 'stampOpts';
  }

  for (const id of ['textOpts', 'shapeOpts', 'markOpts', 'stampOpts', 'imageOpts']) {
    el[id].hidden = id !== group;
  }

  // A highlight is a filled band with no border, so thickness would do nothing.
  // Rect and ellipse can take an interior fill; lines and ink cannot.
  const highlighting = tool === 'highlight';
  const canFill = tool === 'rect' || tool === 'ellipse';
  el.thicknessField.hidden = highlighting;
  el.opacityField.hidden = !highlighting;
  el.fillSwatch.hidden = !canFill;
  el.highlightSelectTip.hidden = !highlighting;
  el.shapeHint.textContent = highlighting
    ? 'Drag across a line, or select words on the page then Highlight'
    : '';
  el.textHint.textContent =
    tool === 'textbox'
      ? 'Drag out a box, then type'
      : tool === 'text'
        ? 'Clicks near a column snap to it'
        : tool === 'select'
          ? 'Select words to highlight, or drag a box over notes to align'
          : '';

  if (highlighting) {
    el.highlightOpacity.value = String(
      annotations.selected?.shape === 'highlight'
        ? annotations.selected.opacity ?? annotations.style.opacity
        : annotations.style.opacity
    );
  }
  if (canFill) {
    const fill =
      annotations.selected &&
      (annotations.selected.shape === 'rect' || annotations.selected.shape === 'ellipse')
        ? annotations.selected.fill
        : annotations.style.fill;
    syncFillSwatch(fill || null);
  }

  syncTextAlignGroup();
  updateStampHint();
  updateImageHint();
}

function onSelectionChanged(record) {
  el.deleteBtn.disabled = !record;
  if (!record) {
    showOptionsFor(annotations.tool);
    // The slider was showing whatever was selected; hand it back to the size
    // the next signature will be placed at.
    el.stampSize.value = String(annotations.style.stampWidth);
    el.imageSize.value = String(annotations.style.stampWidth);
    syncLockAspectBtn(null);
    syncBgSwatch(annotations.style.background);
    syncFillSwatch(annotations.style.fill);
    syncAlignGroup();
    syncTextAlignGroup();
    updateStampHint();
    updateImageHint();
    return;
  }

  const group =
    record.kind === 'text'
      ? 'text'
      : record.kind === 'mark'
        ? 'tick'
        : record.kind === 'image'
          ? imageOptionsGroup(record)
          : record.shape === 'highlight'
            ? 'highlight'
            : record.shape === 'ellipse'
              ? 'ellipse'
              : record.shape === 'band' || record.kind === 'line' || record.kind === 'ink'
                ? 'line'
                : 'rect';
  showOptionsFor(group);

  if (record.kind === 'text') {
    el.fontFamily.value = record.font;
    el.fontSize.value = String(record.fontPt);
    syncFontControls(record.font);
    el.boldBtn.setAttribute('aria-pressed', String(Boolean(record.bold)));
    el.italicBtn.setAttribute('aria-pressed', String(Boolean(record.italic)));
    el.underlineBtn.setAttribute('aria-pressed', String(Boolean(record.underline)));
    el.strikeBtn.setAttribute('aria-pressed', String(Boolean(record.strike)));
    el.colorPicker.value = record.color;
    syncBgSwatch(record.background || null);
  } else if (record.kind === 'mark') {
    el.markColor.value = record.color;
    el.markSize.value = String(record.sizePt);
  } else if (record.kind === 'image') {
    el.stampSize.value = String(record.wRatio);
    el.imageSize.value = String(record.wRatio);
    syncLockAspectBtn(record);
    const lockMsg =
      record.lockAspect === false
        ? 'Aspect unlocked: corners stretch freely'
        : 'Aspect locked: corners scale evenly';
    updateStampHint(lockMsg);
    updateImageHint(lockMsg);
  } else if (record.kind === 'box' || record.kind === 'line' || record.kind === 'ink') {
    el.shapeColor.value = record.color;
    el.strokeWidth.value = String(record.strokeWidth ?? annotations.style.strokeWidth);
    if (record.shape === 'highlight') {
      el.highlightOpacity.value = String(record.opacity ?? 0.35);
    }
    if (record.shape === 'rect' || record.shape === 'ellipse') {
      syncFillSwatch(record.fill || null);
    }
  }

  syncAlignGroup();
  syncTextAlignGroup();
}

// Saved signatures and saved photos share kind "image" on the page. Prefer the
// Image options when the active stamp is a photo, otherwise the Signature row.
function imageOptionsGroup(record) {
  const stamp = annotations.stampIndex.get(record.stampId);
  if (stamp?.kind === 'image') return 'image';
  if (stamp && isSignatureStamp(stamp)) return 'stamp';
  if (annotations.tool === 'stamp') return 'stamp';
  return 'image';
}

// Align is meaningless for one note. Keep the strip clear until a multi-select
// (marquee, Shift-click, or Ctrl+A) has at least two text notes.
function syncAlignGroup() {
  let textCount = 0;
  for (const id of annotations.selection) {
    if (annotations.records.get(id)?.kind === 'text') textCount += 1;
  }
  el.alignGroup.hidden = textCount < 2;
}

// Left / center / right inside a text box. Point text has no box width, so
// these only show for the Text box tool or a selected wrapping note.
function syncTextAlignGroup() {
  const record = annotations.selected;
  const forBox = annotations.tool === 'textbox' || (record?.kind === 'text' && record.wrap);
  el.textAlignGroup.hidden = !forBox;
  if (!forBox) return;

  const align =
    (record?.kind === 'text' && record.wrap ? record.align : null) ||
    annotations.style.align ||
    'left';
  syncTextAlignButtons(align);
}

function syncTextAlignButtons(align) {
  el.textAlignLeftBtn.setAttribute('aria-pressed', String(align === 'left'));
  el.textAlignCenterBtn.setAttribute('aria-pressed', String(align === 'center'));
  el.textAlignRightBtn.setAttribute('aria-pressed', String(align === 'right'));
}

// A family with no italic or bold cut leaves the button showing a state it
// cannot deliver, so those go grey rather than lying about what a press would do.
function syncFontControls(family) {
  const italicOk = supportsItalic(family);
  el.italicBtn.disabled = !italicOk;
  el.italicBtn.title = italicOk ? 'Italic (Ctrl+I)' : 'This handwriting font has no italic';

  const boldOk = supportsBold(family);
  el.boldBtn.disabled = !boldOk;
  el.boldBtn.title = boldOk ? 'Bold (Ctrl+B)' : 'This handwriting font has no bold';
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

function isSignatureStamp(stamp) {
  return !stamp?.kind || stamp.kind === 'signature';
}

function isImageStamp(stamp) {
  return stamp?.kind === 'image';
}

function wireStamps() {
  el.stampAdd.addEventListener('click', openSignDialog);
  el.imageAdd.addEventListener('click', () => el.photoPicker.click());
  el.photoPicker.addEventListener('change', onPhotoPicked);
  el.stampLockBtn.addEventListener('click', toggleLockAspect);
  el.imageLockBtn.addEventListener('click', toggleLockAspect);
  el.stampSize.addEventListener('input', () => {
    const stampWidth = Number(el.stampSize.value);
    el.imageSize.value = String(stampWidth);
    annotations.applyStyle({ stampWidth });
    saveStylePrefs();
  });
  el.imageSize.addEventListener('input', () => {
    const stampWidth = Number(el.imageSize.value);
    el.stampSize.value = String(stampWidth);
    annotations.applyStyle({ stampWidth });
    saveStylePrefs();
  });

  wireSignDialog();
  refreshStamps();
}

async function onPhotoPicked() {
  const file = el.photoPicker.files?.[0];
  el.photoPicker.value = '';
  if (!file || !state.bytes) return;

  let bitmap;
  try {
    bitmap = await bitmapFromFile(file);
  } catch {
    flash('Could not read that image.', true);
    return;
  }

  // Photos keep their background; keying is for signature scans only.
  const built = buildFromBitmap(bitmap, { dropBackground: false });
  bitmap.close?.();
  if (!built) {
    flash('That image looks empty.', true);
    return;
  }

  const keep = Boolean(el.keepImage?.checked);
  let stamp = {
    id: crypto.randomUUID(),
    name: (file.name || 'Image').replace(/\.[^.]+$/, '') || 'Image',
    dataUrl: built.dataUrl,
    aspect: built.aspect,
    kind: 'image',
  };

  if (keep) {
    stamp = await saveStamp({
      name: stamp.name,
      dataUrl: stamp.dataUrl,
      aspect: stamp.aspect,
      kind: 'image',
    });
    await refreshStamps(stamp.id);
  } else {
    // Session-only: placeable now, not written to the strip. Click chooses where.
    annotations.registerStamp(stamp);
    annotations.setActiveStamp(stamp.id);
  }

  annotations.deselect();
  selectTool('image');
  updateImageHint('Click the page to place it');
  flash(keep ? 'Image ready. Click the page to place it (kept in strip).' : 'Image ready. Click the page to place it.');
}

function toggleLockAspect() {
  const record = annotations.selected;
  if (!record || record.kind !== 'image') return;
  const next = record.lockAspect === false;
  annotations.setLockAspect(next);
  syncLockAspectBtn(annotations.selected);
  const message = next
    ? 'Aspect locked: corners scale evenly'
    : 'Aspect unlocked: corners stretch freely';
  updateStampHint(message);
  updateImageHint(message);
}

function syncLockAspectBtn(record) {
  const image = record?.kind === 'image';
  for (const button of [el.stampLockBtn, el.imageLockBtn]) {
    button.hidden = !image;
    if (!image) continue;
    const locked = record.lockAspect !== false;
    button.setAttribute('aria-pressed', String(locked));
    button.title = locked ? 'Unlock aspect ratio' : 'Lock aspect ratio';
  }
}

// Saved signatures and images sit in their own strips next to the tool that
// uses them, so choosing one is a single click.
async function refreshStamps(selectId) {
  const stamps = await listStamps();
  annotations.setStamps(stamps);

  if (selectId) annotations.setActiveStamp(selectId);
  else if (!stamps.some((stamp) => stamp.id === annotations.activeStampId)) {
    annotations.setActiveStamp(stamps[0]?.id || null);
  }

  fillStampStrip(
    el.stampStrip,
    stamps.filter(isSignatureStamp),
    'stamp',
    updateStampHint
  );
  fillStampStrip(
    el.imageStrip,
    stamps.filter(isImageStamp),
    'image',
    updateImageHint
  );

  updateStampHint();
  updateImageHint();
}

function fillStampStrip(strip, stamps, placeTool, hint) {
  strip.textContent = '';

  for (const stamp of stamps) {
    const chip = document.createElement('button');
    chip.className = 'stamp-chip';
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

      // Deleting a stamp that is already on the page would otherwise leave
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
      annotations.deselect();
      selectTool(placeTool);
      for (const other of strip.children) other.classList.remove('selected');
      chip.classList.add('selected');
      hint();
    });
    chip.title = `Place "${stamp.name}"`;

    strip.appendChild(chip);
  }
}

function updateStampHint(message) {
  if (message) {
    el.stampHint.textContent = message;
    return;
  }
  const signatures = [...annotations.stampIndex.values()].filter(isSignatureStamp);
  const imageSelected =
    annotations.selected?.kind === 'image' &&
    isSignatureStamp(annotations.stampIndex.get(annotations.selected.stampId));
  el.stampHint.textContent = signatures.length
    ? 'Click the page to place it'
    : 'Add a signature to place it on the page';
  el.stampSizeField.hidden = !signatures.length && !imageSelected;
  if (!annotations.selected || annotations.selected.kind !== 'image') {
    el.stampLockBtn.hidden = true;
  }
}

function updateImageHint(message) {
  if (message) {
    el.imageHint.textContent = message;
    return;
  }
  const images = [...annotations.stampIndex.values()].filter(isImageStamp);
  const active = annotations.stampIndex.get(annotations.activeStampId);
  const ready = isImageStamp(active) || images.length > 0;
  const imageSelected =
    annotations.selected?.kind === 'image' &&
    isImageStamp(annotations.stampIndex.get(annotations.selected.stampId));
  el.imageHint.textContent = ready
    ? 'Click the page to place it'
    : 'Choose an image, then click the page to place it';
  el.imageSizeField.hidden = !ready && !imageSelected;
  if (!annotations.selected || annotations.selected.kind !== 'image') {
    el.imageLockBtn.hidden = true;
  }
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
    kind: 'signature',
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

// ------------------------------------------------------ selecting page text

// Swiping the highlighter across a line is a drawing gesture, and it lands
// where the hand went rather than where the words are. Selecting the words and
// acting on them is the other way round, and it is what anyone who has used a
// browser expects, so both are offered.
let selectionByPage = null;

function wireTextSelection() {
  // A drag is still a moving target, so the bar waits for the hand to stop.
  document.addEventListener('pointerup', () => setTimeout(readTextSelection, 0));
  document.addEventListener('keyup', (event) => {
    if (event.key.startsWith('Arrow') || event.key === 'a') setTimeout(readTextSelection, 0);
  });

  // Anything that moves the page out from under the bar dismisses it, since a
  // bar left pointing at nothing is worse than no bar.
  el.scroller.addEventListener('scroll', hideSelectionBar, { passive: true });
  window.addEventListener('resize', hideSelectionBar);
  document.addEventListener('selectionchange', () => {
    if (window.getSelection()?.isCollapsed) hideSelectionBar();
  });

  // preventDefault keeps the selection alive: without it the press clears the
  // very thing the button is about to act on.
  el.selectionBar.addEventListener('mousedown', (event) => event.preventDefault());
  el.highlightSelection.addEventListener('click', () => applyToSelection('highlight'));
  el.underlineSelection.addEventListener('click', () => applyToSelection('underline'));
  el.strikeSelection.addEventListener('click', () => applyToSelection('strike'));
}

function readTextSelection() {
  selectionByPage = selectedLinesByPage();
  if (!selectionByPage) return hideSelectionBar();

  // Anchored to the top line, which is where the eye already is.
  let top = Infinity;
  let left = 0;
  for (const page of selectionByPage) {
    for (const line of page.client) {
      if (line.top >= top) continue;
      top = line.top;
      left = (line.left + line.right) / 2;
    }
  }

  el.selectionBar.hidden = false;
  const bar = el.selectionBar.getBoundingClientRect();
  const margin = 8;
  el.selectionBar.style.left = `${Math.min(Math.max(left, bar.width / 2 + margin), window.innerWidth - bar.width / 2 - margin)}px`;
  // Below the line instead when the toolbar would swallow it.
  const above = top - margin;
  const floor = el.toolbar.getBoundingClientRect().bottom + bar.height + margin;
  el.selectionBar.style.top = `${above < floor ? top + margin + bar.height : above}px`;
}

function hideSelectionBar() {
  el.selectionBar.hidden = true;
  selectionByPage = null;
}

function applyToSelection(kind) {
  if (!selectionByPage) return;

  for (const page of selectionByPage) {
    annotations.markSelection(page.index, page.ratios, kind);
  }

  window.getSelection()?.removeAllRanges();
  hideSelectionBar();
}

// The selection as lines, per page, in both viewport pixels for placing the bar
// and page ratios for making the records.
function selectedLinesByPage() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const host = node.nodeType === 1 ? node : node.parentElement;
  // Text typed into a note is a different kind of selection entirely.
  if (!host?.closest('#pages') || host.closest('.anno')) return null;

  const byPage = new Map();
  for (const rect of range.getClientRects()) {
    if (rect.width < 1 || rect.height < 1) continue;
    const index = pageUnder(rect);
    if (index === null) continue;
    if (!byPage.has(index)) byPage.set(index, []);
    byPage.get(index).push(rect);
  }
  if (byPage.size === 0) return null;

  const pages = [];
  for (const [index, rects] of byPage) {
    const client = mergeIntoLines(rects);
    const box = state.mounted.get(index).layer.getBoundingClientRect();
    pages.push({
      index,
      client,
      ratios: client.map((line) => {
        // A highlighter overshoots a little above and below the letters, and
        // the glyph box on its own reads as a tight underline instead.
        const pad = (line.bottom - line.top) * 0.12;
        return {
          x: (line.left - box.left) / box.width,
          y: (line.top - pad - box.top) / box.height,
          w: (line.right - line.left) / box.width,
          h: (line.bottom - line.top + pad * 2) / box.height,
        };
      }),
    });
  }
  return pages;
}

function pageUnder(rect) {
  const x = (rect.left + rect.right) / 2;
  const y = (rect.top + rect.bottom) / 2;
  for (const [index, entry] of state.mounted) {
    const box = entry.layer.getBoundingClientRect();
    if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return index;
  }
  return null;
}

// getClientRects hands back one box per run of text, several to a line and one
// more wherever the styling changes. Merging them by line is what turns a
// paragraph into a few clean bands rather than a mosaic of fragments.
function mergeIntoLines(rects) {
  const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
  const lines = [];

  for (const rect of sorted) {
    const line = lines[lines.length - 1];
    const overlap = line ? Math.min(line.bottom, rect.bottom) - Math.max(line.top, rect.top) : 0;
    if (!line || overlap < Math.min(line.bottom - line.top, rect.height) * 0.5) {
      lines.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
      continue;
    }
    line.left = Math.min(line.left, rect.left);
    line.right = Math.max(line.right, rect.right);
    line.top = Math.min(line.top, rect.top);
    line.bottom = Math.max(line.bottom, rect.bottom);
  }

  return lines;
}

// ------------------------------------------------------------------- keyboard

// Every shortcut is bound to this document, so it only fires while this document
// holds focus. A tab opened by the redirect can start with focus still on the
// browser chrome, and the hidden print frame keeps focus after the print dialog
// closes, both of which swallow the next Ctrl+P. Parking focus on the scroller
// puts it back somewhere the shortcuts can see it.
function claimFocus() {
  const active = document.activeElement;
  const busy =
    active &&
    active !== document.body &&
    active !== el.scroller &&
    active !== printFrame &&
    active !== document.documentElement;
  if (busy) return;

  window.focus();
  el.scroller.focus({ preventScroll: true });
}

function showShortcuts(open) {
  el.shortcutDialog.hidden = !open;
  if (open) el.shortcutClose.focus();
  else claimFocus();
}

function wireKeyboard() {
  // Coming back to the tab is the other moment focus can still be sitting in
  // the print frame.
  window.addEventListener('focus', () => {
    if (document.activeElement === printFrame) claimFocus();
  });

  document.addEventListener('keydown', (event) => {
    // Modals come first: Escape has to work even with a field focused inside.
    if (event.key === 'Escape' && !el.signDialog.hidden) {
      event.preventDefault();
      return closeSignDialog();
    }
    if (event.key === 'Escape' && !el.shortcutDialog.hidden) {
      event.preventDefault();
      return showShortcuts(false);
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
      // Select every text note on the page so they can be aligned as a set.
      // Left alone while typing so Ctrl+A still selects the letters in a box.
      if (key === 'a' && !typing) {
        event.preventDefault();
        if (annotations.tool !== 'select') selectTool('select');
        if (annotations.selectAllText(state.currentIndex)) {
          flash(
            annotations.selection.size === 1
              ? '1 text note selected.'
              : `${annotations.selection.size} text notes selected.`
          );
        } else {
          flash('No text notes on this page.', true);
        }
        return;
      }
      // Annotation copy only when something on the layer is selected. Otherwise
      // the browser keeps Ctrl+C for PDF text selection and for letters inside
      // a text box (those paths never reach here: typing short-circuits above
      // for the letter case, and an empty annotation selection falls through).
      if (key === 'c' && !typing) {
        const count = annotations.copySelected();
        if (!count) return;
        event.preventDefault();
        flash(count === 1 ? 'Copied.' : `${count} annotations copied.`);
        return;
      }
      if (key === 'x' && !typing) {
        const count = annotations.cutSelected();
        if (!count) return;
        event.preventDefault();
        flash(count === 1 ? 'Cut.' : `${count} annotations cut.`);
        return;
      }
      if (key === 'v' && !typing) {
        const count = annotations.pasteClipboard();
        if (!count) return;
        event.preventDefault();
        if (annotations.tool !== 'select') selectTool('select');
        flash(count === 1 ? 'Pasted.' : `${count} annotations pasted.`);
        return;
      }
      // Annotation history wins over the browser's contenteditable undo. With the
      // caret in a text box, native Ctrl+Z often looked broken (empty undo stack
      // or only one keystroke) while the same shortcut worked once the box only
      // had a selection outline. Always drive our own stack here.
      if (key === 'z') {
        event.preventDefault();
        return event.shiftKey ? redo() : undo();
      }
      if (key === 'y') {
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
      if (!el.selectionBar.hidden) hideSelectionBar();
      if (!el.findBar.hidden) closeFind();
      return;
    }
    if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();
      return rotateView();
    }
    if (event.key === '?') {
      event.preventDefault();
      return showShortcuts(el.shortcutDialog.hidden);
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
  if (!annoStyle) {
    syncBgSwatch(annotations.style.background || null);
    syncFillSwatch(annotations.style.fill || null);
    return;
  }

  annotations.applyStyle(annoStyle);
  el.fontFamily.value = annoStyle.font ?? 'helvetica';
  el.fontSize.value = String(annoStyle.fontPt ?? 12);
  el.boldBtn.setAttribute('aria-pressed', String(Boolean(annoStyle.bold)));
  el.italicBtn.setAttribute('aria-pressed', String(Boolean(annoStyle.italic)));
  el.underlineBtn.setAttribute('aria-pressed', String(Boolean(annoStyle.underline)));
  el.strikeBtn.setAttribute('aria-pressed', String(Boolean(annoStyle.strike)));
  el.strokeWidth.value = String(annoStyle.strokeWidth ?? 1.5);
  el.highlightOpacity.value = String(annoStyle.opacity ?? 0.35);
  el.markSize.value = String(annoStyle.sizePt ?? 18);
  el.stampSize.value = String(annoStyle.stampWidth ?? 0.24);
  el.imageSize.value = String(annoStyle.stampWidth ?? 0.24);
  syncBgSwatch(annoStyle.background || null);
  syncFillSwatch(annoStyle.fill || null);
  syncColourInputs();
  syncFontControls(el.fontFamily.value);
}

function saveStylePrefs() {
  chrome.storage.local.set({ annoStyle: { ...annotations.style } });
}

// -------------------------------------------------------------------- export

async function loadAsset(path) {
  const response = await fetch(chrome.runtime.getURL(path));
  if (!response.ok) throw new Error(`Could not read ${path}`);
  return response.arrayBuffer();
}

// Three quarters of a megabyte of font parser, needed only to embed a font that
// is not one of the fourteen every reader already has. Loading it on demand
// keeps it out of the way of opening a document, which is what people are
// actually waiting for.
let fontkitPromise = null;

function getFontkit() {
  if (globalThis.fontkit) return globalThis.fontkit;
  if (fontkitPromise) return fontkitPromise;

  fontkitPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('vendor/fontkit.umd.min.js');
    script.onload = () => resolve(globalThis.fontkit);
    script.onerror = () => reject(new Error('Could not load the font embedder'));
    document.head.appendChild(script);
  });
  return fontkitPromise;
}

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
          loadAsset,
          getFontkit,
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
let printFocusTimer = null;

// The frame has to be handed keyboard focus for the plugin to print, and Chrome
// leaves it there once the dialog closes. A second Ctrl+P then goes to the
// plugin, which reprints its own stale copy instead of running an export, which
// is why the shortcut worked once and then quietly printed the wrong thing.
// Nothing is removed while the dialog is up: focus is only taken back once the
// page itself has it again.
function watchPrintFocus() {
  stopWatchingPrintFocus();

  let ticks = 0;
  printFocusTimer = setInterval(() => {
    const stillOurs = printFrame?.isConnected && document.activeElement === printFrame;
    if (!stillOurs || ticks++ > 600) return stopWatchingPrintFocus();
    if (!document.hasFocus()) return;

    claimFocus();
    stopWatchingPrintFocus();
  }, 500);
}

function stopWatchingPrintFocus() {
  clearInterval(printFocusTimer);
  printFocusTimer = null;
}

// A frame left over from an earlier document would print that document, so it
// goes as soon as a new file is opened.
function discardPrintFrame() {
  stopWatchingPrintFocus();
  printFrame?.remove();
  printFrame = null;
}

async function printBytes(bytes) {
  const url = toPdfBlobUrl(bytes);

  discardPrintFrame();
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
    watchPrintFocus();
  } else {
    discardPrintFrame();
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
