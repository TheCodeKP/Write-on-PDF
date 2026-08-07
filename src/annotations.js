// Annotations layered over the rendered pages.
//
// Two rules hold the whole thing together:
//
// 1. Positions are ratios of the page box, never pixels, so zoom can't shift a
//    note and the export maths stays independent of the viewer.
// 2. Records live here centrally while their DOM comes and goes, because the
//    viewer only keeps pages near the viewport mounted.
//
// Each record also carries the view rotation it was made under. Ratios are
// relative to *that* orientation, so rotating the view re-projects for display
// only and never rewrites what is stored.

const LINE_HEIGHT = 1.2;
const MIN_DRAG_RATIO = 0.008; // below this a drag counts as a click
const HANDLE_KINDS = new Set(['box', 'image', 'ink']);

// How close a new text note has to land to an existing one's left edge before
// it is pulled into that column. Tuned for form lines stacked under each other.
const TEXT_COLUMN_SNAP = 0.028;

// Tools that put their mark down on the press. Everything else is drawn out by
// dragging, so it has a release to wait for before it knows what was meant.
const STAMPING_TOOLS = new Set(['text', 'tick', 'cross', 'stamp', 'image']);

// A tool picks up its own kind of mark and passes straight through everything
// else. Picking up whatever the press happened to land on sounds friendlier
// until you draw a rectangle as a signature box: an outlined box answers the
// pointer across its whole interior, so it swallowed the signature meant to go
// inside it, and the tick and the note too.
const PICKS_UP = {
  text: (record) => record.kind === 'text',
  textbox: (record) => record.kind === 'text',
  pen: (record) => record.kind === 'ink',
  line: (record) => record.kind === 'line',
  arrow: (record) => record.kind === 'line',
  tick: (record) => record.kind === 'mark',
  cross: (record) => record.kind === 'mark',
  stamp: (record) => record.kind === 'image',
  image: (record) => record.kind === 'image',
  rect: isOutline,
  ellipse: isOutline,
  highlight: (record) =>
    record.kind === 'box' && (record.shape === 'highlight' || record.shape === 'band'),
};

function isOutline(record) {
  return record.kind === 'box' && (record.shape === 'rect' || record.shape === 'ellipse');
}

// Pointer moves arrive far denser than a stroke needs, and every extra point is
// another segment in the exported PDF. Sampling at roughly a millimetre keeps
// the curve smooth without recording the hand's jitter.
const INK_SAMPLE_RATIO = 0.0025;
const MIN_INK_RATIO = 0.001; // a dead straight stroke still needs a box to live in

// Roughly a line of body text on A4. A highlighter is swiped along a line, so
// the gesture is almost flat and the raw drag height would be nearly nothing.
const MIN_HIGHLIGHT_RATIO = 0.018;

// Clicking rather than dragging drops one of these instead. Shapes, lines and
// arrows are deliberately absent: they are drawn out, so a stray click should
// leave nothing behind. The highlighter and the pen are absent for the same
// reason. Tick and cross are stamping tools and go through STAMPING_TOOLS.
const DEFAULT_SIZES = {
  textbox: { w: 0.32, h: 0.08 },
};

const STYLE_KEYS = {
  text: ['fontPt', 'font', 'bold', 'italic', 'underline', 'strike', 'color', 'background', 'align'],
  box: ['color', 'strokeWidth', 'opacity', 'fill'],
  line: ['color', 'strokeWidth'],
  ink: ['color', 'strokeWidth'],
  mark: ['color', 'sizePt'],
  image: [],
};

// Tick and cross are drawn inside a 100-unit square, both here and in the
// export. Keeping the pen width proportional means resizing a mark can never
// leave the printed stroke out of step with the one on screen.
const MARK_STROKE_RATIO = 0.12;

const GLYPH_POINTS = {
  tick: '14,54 40,80 88,20',
  cross: null, // drawn as two separate lines
};

// Focus landing on one of the toolbar's style controls means the box that just
// lost it is being restyled, not abandoned, so an empty one is spared. Anywhere
// else and the usual clean-up applies.
const STYLE_CONTROLS = '.options';

export class Annotations {
  constructor({ onChange, onSelect, onPlace } = {}) {
    this.records = new Map(); // id -> record
    this.byPage = new Map(); // pageIndex -> Set<id>
    this.elements = new Map(); // id -> { record, element, ...parts } for mounted pages only
    this.pages = new Map(); // pageIndex -> { layer, width, height }

    this.scale = 1;
    this.viewRotation = 0;
    this.tool = 'select';
    this.activeId = null;
    this.selection = new Set(); // ids showing as selected; activeId is the last one
    this.activeStampId = null;
    this.stampIndex = new Map(); // stampId -> { dataUrl, aspect }

    this.onChange = onChange || (() => {});
    this.onSelect = onSelect || (() => {});
    this.onPlace = onPlace || (() => {});

    this.style = {
      fontPt: 12,
      font: 'helvetica',
      bold: false,
      italic: false,
      underline: false,
      strike: false,
      color: '#d0021b',
      background: null,
      align: 'left',
      strokeWidth: 1.5,
      opacity: 0.35,
      fill: null, // rect / ellipse interior; null means outline only
      sizePt: 18,
      stampWidth: 0.24, // fraction of the page a placed signature spans
    };

    this.drag = null;
    this.pending = null;
    this.ghost = null;
    this.marquee = null;
    // Session clipboard for annotations. Not the system clipboard: Ctrl+C while
    // editing a text box still copies letters, and PDF text selection still
    // copies through the browser when nothing on the layer is selected.
    this.clipboard = [];

    window.addEventListener('pointermove', (event) => this.#onPointerMove(event));
    window.addEventListener('pointerup', () => this.#onPointerUp());
  }

  // ------------------------------------------------------------------- mounting

  mountPage(pageIndex, layer, box) {
    this.pages.set(pageIndex, { layer, ...box });
    this.#applyToolTo(layer);
    layer.addEventListener('pointerdown', (event) => this.#onLayerPointerDown(event, pageIndex));
    layer.addEventListener('pointermove', (event) => this.#trackGhost(event, pageIndex));
    layer.addEventListener('pointerleave', () => this.#hideGhost());

    for (const id of this.byPage.get(pageIndex) || []) {
      const record = this.records.get(id);
      if (record) this.#mount(record);
    }
  }

  unmountPage(pageIndex) {
    for (const id of this.byPage.get(pageIndex) || []) {
      this.elements.get(id)?.element.remove();
      this.elements.delete(id);
      // Keeping a selection on a page that has scrolled away would leave the
      // style controls editing something invisible.
      this.selection.delete(id);
      if (this.activeId === id) {
        this.activeId = [...this.selection].at(-1) || null;
        this.onSelect(this.records.get(this.activeId) || null);
      }
    }
    this.pages.delete(pageIndex);
  }

  // -------------------------------------------------------------------- state

  // Zoom and rotation both move every mounted page at once, so they go through
  // a single call rather than repainting once per changed page.
  relayout(scale, viewRotation, boxes) {
    this.scale = scale;
    this.viewRotation = viewRotation;
    for (const [pageIndex, box] of boxes) {
      const page = this.pages.get(pageIndex);
      if (page) Object.assign(page, box);
    }
    this.#repaintAll();
  }

  setTool(tool) {
    this.tool = tool;
    this.#hideGhost();
    for (const { layer } of this.pages.values()) this.#applyToolTo(layer);
  }

  // In select mode the layer lets the pointer through so the text underneath
  // stays selectable; individual annotations opt back in via CSS.
  //
  // With a drawing tool in hand it works the other way round: the layer takes
  // the pointer and what is already on it stops out of the way, because the
  // press that starts a new mark must reach the page. A stroke's corner handle
  // or the fat invisible copy of its path would otherwise catch a stroke drawn
  // alongside it and quietly resize or drag the earlier one instead.
  #applyToolTo(layer) {
    const drawing = this.tool !== 'select';
    layer.style.pointerEvents = drawing ? 'auto' : 'none';
    layer.classList.toggle('drawing', drawing);
    layer.style.cursor = this.tool === 'text' ? 'text' : drawing ? 'crosshair' : 'default';
  }

  setStamps(stamps) {
    this.stampIndex = new Map(stamps.map((stamp) => [stamp.id, stamp]));
    this.#hideGhost();
    this.#repaintAll();
  }

  // One-shot images stay on the page via dataUrl on the record; this only
  // feeds the strip / ghost for stamps that should be placeable again.
  registerStamp(stamp) {
    if (!stamp?.id || !stamp.dataUrl) return;
    this.stampIndex.set(stamp.id, stamp);
  }

  setActiveStamp(stampId) {
    this.activeStampId = stampId;
    this.#hideGhost();
  }

  setLockAspect(locked) {
    const entry = this.elements.get(this.activeId);
    if (!entry || entry.record.kind !== 'image') return false;
    entry.record.lockAspect = Boolean(locked);
    this.onChange();
    return true;
  }

  // Drop an image at a page point (ratios of the page box). Used by the Image
  // tool and by the Signature tool's click-to-place path.
  placeImage(pageIndex, point, stamp, { lockAspect = true } = {}) {
    if (!stamp?.dataUrl || stamp.aspect == null) return null;
    const page = this.pages.get(pageIndex);
    if (!page) return null;

    const wRatio = this.style.stampWidth;
    const hRatio = (wRatio * page.width * stamp.aspect) / page.height;

    const record = this.#add({
      kind: 'image',
      pageIndex,
      stampId: stamp.id,
      dataUrl: stamp.dataUrl,
      aspect: stamp.aspect,
      lockAspect,
      ...this.#toRecordBox(point.x - wRatio / 2, point.y - hRatio / 2, wRatio, hRatio),
    });

    this.#hideGhost();
    this.#select(record.id);
    this.onPlace(record);
    return record;
  }

  // ------------------------------------------------------------- stamp ghost

  // Following the cursor with a translucent copy is the whole trick: you can
  // see what you are about to place, at the size it will be, before committing.
  #trackGhost(event, pageIndex) {
    const stamp = this.stampIndex.get(this.activeStampId);
    const page = this.pages.get(pageIndex);
    if ((this.tool !== 'stamp' && this.tool !== 'image') || !stamp || !page) {
      return this.#hideGhost();
    }

    if (!this.ghost) {
      this.ghost = document.createElement('img');
      this.ghost.className = 'stamp-ghost';
      this.ghost.draggable = false;
    }
    if (this.ghost.src !== stamp.dataUrl) this.ghost.src = stamp.dataUrl;
    if (this.ghost.parentElement !== page.layer) page.layer.appendChild(this.ghost);

    const rect = page.layer.getBoundingClientRect();
    const width = this.style.stampWidth * page.width;
    const height = width * stamp.aspect;

    this.ghost.style.width = `${width}px`;
    this.ghost.style.height = `${height}px`;
    this.ghost.style.left = `${event.clientX - rect.left - width / 2}px`;
    this.ghost.style.top = `${event.clientY - rect.top - height / 2}px`;
  }

  #hideGhost() {
    this.ghost?.remove();
  }

  // The ghost only redraws on pointer move; keep its size honest when the
  // slider changes while the cursor is still.
  #syncGhostSize() {
    if (!this.ghost?.isConnected) return;
    const stamp = this.stampIndex.get(this.activeStampId);
    if (!stamp) return;

    let page = null;
    for (const candidate of this.pages.values()) {
      if (candidate.layer === this.ghost.parentElement) {
        page = candidate;
        break;
      }
    }
    if (!page) return;

    const width = this.style.stampWidth * page.width;
    const height = width * stamp.aspect;
    this.ghost.style.width = `${width}px`;
    this.ghost.style.height = `${height}px`;
  }

  // Applies to every selected annotation when there is a set (marquee / Shift /
  // Ctrl+A), and always updates the defaults used for the next annotation.
  applyStyle(patch) {
    Object.assign(this.style, patch);
    if (patch.stampWidth != null) this.#syncGhostSize();

    const ids = this.selection.size
      ? [...this.selection]
      : this.activeId
        ? [this.activeId]
        : [];
    if (!ids.length) return;

    let touched = false;
    for (const id of ids) {
      const entry = this.elements.get(id);
      if (!entry) continue;

      if (entry.record.kind === 'image' && patch.stampWidth != null) {
        this.#resizeImage(entry, patch.stampWidth);
        touched = true;
        continue;
      }

      // Underline and strike are filled bands: the visible weight is hRatio, not
      // a stroked border. Keep that height in step with the thickness control.
      if (
        entry.record.kind === 'box' &&
        entry.record.shape === 'band' &&
        patch.strokeWidth != null
      ) {
        this.#resizeBand(entry, patch.strokeWidth);
        touched = true;
        continue;
      }

      const allowed = STYLE_KEYS[entry.record.kind] || [];
      let local = false;
      for (const [key, value] of Object.entries(patch)) {
        if (!allowed.includes(key)) continue;
        // Opacity only drives the highlighter. Fill only drives outline shapes.
        if (key === 'opacity' && entry.record.shape !== 'highlight') continue;
        if (
          key === 'fill' &&
          entry.record.shape !== 'rect' &&
          entry.record.shape !== 'ellipse'
        ) {
          continue;
        }
        entry.record[key] = value;
        local = true;
      }
      if (!local) continue;
      this.#paint(entry);
      touched = true;
    }

    if (touched) this.onChange();
  }

  #resizeImage(entry, wRatio) {
    const aspect =
      entry.record.aspect ?? this.stampIndex.get(entry.record.stampId)?.aspect;
    if (aspect == null) return;

    const { spaceWidth, spaceHeight } = this.#displayGeometry(entry.record);
    entry.record.wRatio = wRatio;
    entry.record.hRatio = (wRatio * spaceWidth * aspect) / spaceHeight;

    this.#paint(entry);
    this.onChange();
  }

  #resizeBand(entry, strokeWidth) {
    const next = Number(strokeWidth);
    if (!Number.isFinite(next) || next <= 0) return;

    const oldH = entry.record.hRatio;
    const newH = this.#bandThicknessRatio(entry.record.pageIndex, next);
    entry.record.strokeWidth = next;
    entry.record.hRatio = newH;
    // Grow and shrink around the centre so underline and strike stay on the
    // letters instead of creeping down the page.
    entry.record.yRatio = clamp(entry.record.yRatio + (oldH - newH) / 2);

    this.#paint(entry);
    this.onChange();
  }

  // strokeWidth is a CSS-pixel weight at scale 1. Bands store height as a page
  // fraction, so convert through the unscaled page height.
  #bandThicknessRatio(pageIndex, strokeWidth) {
    const page = this.pages.get(pageIndex);
    const pageHeightAt1 = page ? page.height / this.scale : 800;
    return Math.max(strokeWidth / pageHeightAt1, 0.0012);
  }

  // After a corner drag the band height has changed; write strokeWidth back so
  // the thickness slider matches what is on the page.
  #syncBandStrokeFromHeight(record) {
    const page = this.pages.get(record.pageIndex);
    if (!page) return;
    const pageHeightAt1 = page.height / this.scale;
    const stroke = record.hRatio * pageHeightAt1;
    record.strokeWidth = Math.min(8, Math.max(0.5, Math.round(stroke * 2) / 2));
  }

  get selected() {
    return this.records.get(this.activeId) || null;
  }

  deleteSelected() {
    const ids = this.selection.size ? [...this.selection] : this.activeId ? [this.activeId] : [];
    if (!ids.length) return false;
    for (const id of ids) this.#destroy(id);
    this.onChange();
    return true;
  }

  // Snapshot of whatever is selected. Returns how many were taken so the
  // viewer can leave Ctrl+C alone when the selection is empty (PDF text copy).
  copySelected() {
    const ids = this.selection.size ? [...this.selection] : this.activeId ? [this.activeId] : [];
    if (!ids.length) return 0;

    const taken = [];
    for (const id of ids) {
      const record = this.records.get(id);
      if (!record) continue;
      taken.push(cloneRecord(record));
    }
    if (!taken.length) return 0;

    this.clipboard = taken;
    return taken.length;
  }

  // Copy then remove. The clipboard keeps the marks so Ctrl+V brings them back
  // offset, which is the usual cut behaviour in a drawing tool.
  cutSelected() {
    const count = this.copySelected();
    if (!count) return 0;
    this.deleteSelected();
    return count;
  }

  // Drop a slightly offset clone of the clipboard on the same pages the
  // originals came from. The clipboard is then updated to those clones so a
  // second paste steps further rather than stacking on the first.
  pasteClipboard() {
    if (!this.clipboard.length) return 0;

    const OFFSET = 0.025;
    const made = [];

    for (const raw of this.clipboard) {
      const fields = cloneRecord(raw);
      delete fields.id;
      offsetRecord(fields, OFFSET, OFFSET);
      made.push(this.#add(fields));
    }

    for (const id of this.selection) {
      this.elements.get(id)?.element.classList.remove('active');
    }
    this.selection.clear();
    for (const record of made) {
      this.selection.add(record.id);
      this.elements.get(record.id)?.element.classList.add('active');
    }
    this.activeId = made.at(-1)?.id || null;
    this.onSelect(this.records.get(this.activeId) || null);

    this.clipboard = made.map((record) => cloneRecord(record));
    return made.length;
  }

  hasTextOnPage(pageIndex) {
    for (const id of this.byPage.get(pageIndex) || []) {
      if (this.records.get(id)?.kind === 'text') return true;
    }
    return false;
  }

  // Every text note on a page, for Ctrl+A with Select in hand.
  selectAllText(pageIndex) {
    const ids = [...(this.byPage.get(pageIndex) || [])].filter(
      (id) => this.records.get(id)?.kind === 'text'
    );
    return this.selectTexts(ids);
  }

  // Replace (or grow) the text selection. Used by Ctrl+A and by drag-marquee.
  selectTexts(ids, { additive = false } = {}) {
    const textIds = ids.filter((id) => this.records.get(id)?.kind === 'text');

    if (!additive) {
      for (const id of this.selection) {
        this.elements.get(id)?.element.classList.remove('active');
      }
      this.selection.clear();
    } else {
      for (const otherId of [...this.selection]) {
        if (this.records.get(otherId)?.kind !== 'text') {
          this.elements.get(otherId)?.element.classList.remove('active');
          this.selection.delete(otherId);
        }
      }
    }

    for (const id of textIds) {
      this.selection.add(id);
      this.elements.get(id)?.element.classList.add('active');
    }

    this.activeId = textIds.at(-1) ?? [...this.selection].at(-1) ?? null;
    this.onSelect(this.records.get(this.activeId) || null);
    return this.selection.size;
  }

  // CorelDRAW-style rubber band: drag empty page space with Select to gather
  // text notes. PDF text selection on the text layer is left alone (viewer).
  beginMarquee(pageIndex, event) {
    if (this.tool !== 'select' || event.button !== 0) return false;
    if (this.marquee || this.drag || this.pending) return false;
    const page = this.pages.get(pageIndex);
    if (!page) return false;

    const rect = page.layer.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;

    this.#endTextEditing();

    const box = document.createElement('div');
    box.className = 'marquee';
    page.layer.appendChild(box);

    const x = clamp((event.clientX - rect.left) / rect.width);
    const y = clamp((event.clientY - rect.top) / rect.height);
    this.marquee = {
      pageIndex,
      rect,
      startX: x,
      startY: y,
      curX: x,
      curY: y,
      box,
      additive: event.shiftKey,
      moved: false,
    };

    this.#paintMarquee();
    return true;
  }

  // Line up selected text notes on a shared edge. Needs at least two. Boxes are
  // read from the live elements so wrapped notes and short ones share an edge
  // by what is on screen, not by a guessed width.
  alignTexts(edge = 'left') {
    const targets = [...this.selection]
      .map((id) => this.records.get(id))
      .filter((record) => record?.kind === 'text');

    if (targets.length < 2) return false;

    const boxes = targets.map((record) => ({ record, box: this.#displayBox(record) }));
    let ref;
    if (edge === 'left') ref = Math.min(...boxes.map(({ box }) => box.x));
    else if (edge === 'right') ref = Math.max(...boxes.map(({ box }) => box.x + box.w));
    else if (edge === 'top') ref = Math.min(...boxes.map(({ box }) => box.y));
    else if (edge === 'bottom') ref = Math.max(...boxes.map(({ box }) => box.y + box.h));
    else return false;

    for (const { record, box } of boxes) {
      let x = box.x;
      let y = box.y;
      if (edge === 'left') x = ref;
      else if (edge === 'right') x = ref - box.w;
      else if (edge === 'top') y = ref;
      else if (edge === 'bottom') y = ref - box.h;

      const point = this.#toRecordPoint(x, y);
      record.xRatio = point.xRatio;
      record.yRatio = point.yRatio;
      const entry = this.elements.get(record.id);
      if (entry) this.#paint(entry);
    }

    this.onChange();
    return true;
  }

  #displayBox(record) {
    const entry = this.elements.get(record.id);
    const page = this.pages.get(record.pageIndex);
    if (entry && page) {
      const er = entry.element.getBoundingClientRect();
      const pr = page.layer.getBoundingClientRect();
      if (pr.width > 0 && pr.height > 0) {
        return {
          x: (er.left - pr.left) / pr.width,
          y: (er.top - pr.top) / pr.height,
          w: er.width / pr.width,
          h: er.height / pr.height,
        };
      }
    }

    const anchor = this.#anchorOf(record);
    return {
      x: anchor.x,
      y: anchor.y,
      w: record.wRatio || 0,
      h: record.hRatio || 0,
    };
  }

  // ---------------------------------------------------------------- lifecycle

  load(records) {
    for (const raw of records || []) {
      const record = normalise(raw);
      this.records.set(record.id, record);
      if (!this.byPage.has(record.pageIndex)) this.byPage.set(record.pageIndex, new Set());
      this.byPage.get(record.pageIndex).add(record.id);
      if (this.pages.has(record.pageIndex)) this.#mount(record);
    }
  }

  clearAll() {
    this.replaceAll([]);
  }

  // Used by undo and by clearing. Mounted pages stay mounted, so load()
  // rebuilds their DOM. Note this does not fire onChange: callers that are
  // making an edit rather than restoring one have to persist it themselves.
  replaceAll(records) {
    for (const { element } of this.elements.values()) element.remove();
    this.elements.clear();
    this.records.clear();
    this.byPage.clear();
    this.selection.clear();
    this.activeId = null;
    this.onSelect(null);
    this.load(records);
  }

  serialize() {
    return [...this.records.values()]
      .filter((record) => (record.kind === 'text' ? record.text.trim().length > 0 : true))
      .map((record) => ({ ...record }));
  }

  get count() {
    return this.serialize().length;
  }

  // --------------------------------------------------------------- creation

  #onLayerPointerDown(event, pageIndex) {
    if (event.button !== 0) return;
    const page = this.pages.get(pageIndex);
    if (!page) return;
    if (this.tool === 'select') return;

    // A press that lands on a mark this tool would pick up is read on release:
    // move the hand and it draws a new one, keep it still and it takes the one
    // underneath. That way a tool in hand is no reason to go back to Select
    // just to fix a word or recolour a box, and drawing across earlier marks
    // still draws rather than dragging them about.
    let over = null;
    if (event.target !== page.layer) {
      over = event.target.closest?.('.anno');
      if (!over) return;
    }

    const candidate = over ? this.records.get(over.dataset.id) : null;
    const overId = candidate && PICKS_UP[this.tool]?.(candidate) ? candidate.id : null;

    // A press inside text this tool would pick up anyway is left to the browser,
    // so the caret lands on the letter it was aimed at.
    if (overId && event.target.closest('.content')) return;

    const rect = page.layer.getBoundingClientRect();
    const point = {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };

    // preventDefault below stops the browser moving focus, which would
    // otherwise blur an open text box and let it clean itself up if empty.
    if (document.activeElement?.isContentEditable) document.activeElement.blur();

    event.preventDefault();

    // These tools place their mark on the press and have no drag to wait for,
    // so the choice between drawing and picking up is made here.
    if (STAMPING_TOOLS.has(this.tool)) {
      if (overId) {
        this.#pickUp(overId);
        return;
      }

      this.deselect();
      if (this.tool === 'text') this.#createText(pageIndex, point);
      else if (this.tool === 'stamp' || this.tool === 'image') this.#createImage(pageIndex, point);
      else this.#createMark(pageIndex, point, this.tool);
      return;
    }

    this.deselect();
    this.pending = { tool: this.tool, pageIndex, origin: point, current: point, id: null, overId };
    if (this.tool === 'pen') this.pending.raw = [point];
  }

  // Selects an existing mark. Under Select, text is only highlighted: a double
  // click opens the caret. With the Text or Text box tool in hand, picking one
  // up still drops the caret, since that tool is for writing.
  #pickUp(id) {
    this.#select(id);
    if (
      this.records.get(id)?.kind === 'text' &&
      (this.tool === 'text' || this.tool === 'textbox')
    ) {
      this.elements.get(id)?.content.focus();
    }
  }

  #beginTextEdit(id) {
    const entry = this.elements.get(id);
    if (!entry?.content || this.records.get(id)?.kind !== 'text') return;
    this.#select(id);
    entry.content.focus();
  }

  #createText(pageIndex, point) {
    const lineHeightRatio =
      (this.style.fontPt * this.scale * LINE_HEIGHT) / (this.pages.get(pageIndex)?.height || 1);

    // A click near an existing note's left edge joins that column, which is how
    // form lines under each other stay lined up without a second tool.
    const x = this.#snapTextX(pageIndex, point.x) ?? point.x;

    const record = this.#addText(pageIndex, {
      ...this.#toRecordPoint(x, point.y - lineHeightRatio / 2),
    });

    this.elements.get(record.id)?.content.focus();
  }

  #snapTextX(pageIndex, displayX) {
    let best = null;
    let bestDist = TEXT_COLUMN_SNAP;
    for (const id of this.byPage.get(pageIndex) || []) {
      const record = this.records.get(id);
      if (!record || record.kind !== 'text') continue;
      const dist = Math.abs(this.#anchorOf(record).x - displayX);
      if (dist < bestDist) {
        bestDist = dist;
        best = this.#anchorOf(record).x;
      }
    }
    return best;
  }

  // A plain text note grows along one line and is anchored by a point. A text
  // box is given a width and wraps inside it, so it also carries a box. The two
  // share everything else, including how they are styled and exported.
  #addText(pageIndex, geometry) {
    return this.#add({
      kind: 'text',
      pageIndex,
      ...geometry,
      fontPt: this.style.fontPt,
      font: this.style.font,
      bold: this.style.bold,
      italic: this.style.italic,
      underline: this.style.underline,
      strike: this.style.strike,
      color: this.style.color,
      background: this.style.background,
      align: this.style.align || 'left',
      text: '',
    });
  }

  #createMark(pageIndex, point, glyph) {
    const page = this.pages.get(pageIndex);
    const sizeRatioX = (this.style.sizePt * this.scale) / page.width;
    const sizeRatioY = (this.style.sizePt * this.scale) / page.height;

    const record = this.#add({
      kind: 'mark',
      glyph,
      pageIndex,
      ...this.#toRecordPoint(point.x - sizeRatioX / 2, point.y - sizeRatioY / 2),
      sizePt: this.style.sizePt,
      color: this.style.color,
    });

    this.#select(record.id);
  }

  #createImage(pageIndex, point) {
    const stamp = this.stampIndex.get(this.activeStampId);
    if (!stamp) return;
    // Selected straight away so the resize handles are already showing, which
    // is the difference between "did that work?" and "there it is, drag it".
    this.placeImage(pageIndex, point, stamp, { lockAspect: true });
  }

  #finishPending() {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;

    // A pen is either a stroke or nothing. Clicking with it and getting a dot
    // you did not ask for is the sort of stray mark that ends up printed.
    if (pending.tool === 'pen') {
      if (pending.id && pending.raw.length > 1) this.#select(pending.id);
      else {
        if (pending.id) this.#destroy(pending.id);
        if (pending.overId && this.records.has(pending.overId)) this.#pickUp(pending.overId);
      }
      if (pending.id) this.onChange();
      return;
    }

    const dx = pending.current.x - pending.origin.x;
    const dy = pending.current.y - pending.origin.y;
    const tiny = Math.abs(dx) < MIN_DRAG_RATIO && Math.abs(dy) < MIN_DRAG_RATIO;

    // The hand never moved and there was something under it, so this was a
    // click on an existing mark rather than the start of a new one.
    if (tiny && pending.overId && this.records.has(pending.overId)) {
      if (pending.id) {
        this.#destroy(pending.id);
        this.onChange();
      }

      this.#pickUp(pending.overId);
      return;
    }

    // A text box that was dragged out is ready to type into, and one that was
    // only clicked gets a sensible size rather than a sliver.
    if (pending.tool === 'textbox') {
      const record = pending.id
        ? this.records.get(pending.id)
        : this.#addText(pending.pageIndex, {
            ...this.#toRecordBox(pending.origin.x, pending.origin.y, 0, 0),
            wrap: true,
          });

      if (tiny) {
        const preset = DEFAULT_SIZES.textbox;
        Object.assign(record, { wRatio: preset.w, hRatio: preset.h });
        const entry = this.elements.get(record.id);
        if (entry) this.#paint(entry);
      }

      this.#select(record.id);
      this.elements.get(record.id)?.content.focus();
      this.onChange();
      return;
    }

    // Left selected so the colour and thickness controls act on what was just
    // drawn. Without it the next thing touched is the default for the following
    // shape, which looks like the control simply doing nothing.
    if (pending.id && !tiny) {
      this.#select(pending.id);
      this.onChange();
      return;
    }

    // A plain click still produces something usable rather than nothing.
    if (pending.id) this.#destroy(pending.id);

    // Except for tools with no preset, which want a drag or nothing at all.
    const preset = DEFAULT_SIZES[pending.tool];
    if (!preset) {
      if (pending.id) this.onChange();
      return;
    }

    const record =
      pending.tool === 'line' || pending.tool === 'arrow'
        ? this.#addLine(pending.pageIndex, pending.origin, {
            x: pending.origin.x + preset.w,
            y: pending.origin.y,
          }, pending.tool === 'arrow')
        : this.#addBox(pending.pageIndex, pending.tool, pending.origin.x, pending.origin.y, preset.w, preset.h);

    this.#select(record.id);
    this.onChange();
  }

  // Marks laid over text that has been selected rather than swiped across.
  // Rects are fractions of the displayed page, one per line, and they take the
  // current colour so both ways of marking text agree.
  //
  // A highlight covers the line; a rule is a solid band placed within it, near
  // the feet of the letters for an underline and through the middle for a
  // strikethrough. Band height follows the thickness control so the slider that
  // shows after selecting one actually changes the weight. All three are the
  // same kind of record underneath, so moving, recolouring, deleting and
  // undoing need nothing new.
  markSelection(pageIndex, rects, kind = 'highlight') {
    const made = rects.map((rect) => {
      if (kind === 'highlight') {
        return this.#addBox(pageIndex, 'highlight', rect.x, rect.y, rect.w, rect.h);
      }

      const thickness = this.#bandThicknessRatio(pageIndex, this.style.strokeWidth);
      const y = kind === 'strike' ? rect.y + rect.h / 2 - thickness / 2 : rect.y + rect.h * 0.82;
      return this.#addBox(pageIndex, 'band', rect.x, y, rect.w, thickness);
    });

    // A single line is one thing, and selecting it puts the colour control
    // straight onto it. Several lines are a set, and outlining only the last
    // would say something untrue about what was made.
    if (made.length === 1) this.#select(made[0].id);
    return made;
  }

  #addBox(pageIndex, shape, x, y, w, h) {
    const outline = shape === 'rect' || shape === 'ellipse';
    return this.#add({
      kind: 'box',
      shape,
      pageIndex,
      ...this.#toRecordBox(x, y, w, h),
      color: this.style.color,
      strokeWidth: this.style.strokeWidth,
      opacity: this.style.opacity,
      fill: outline ? this.style.fill : null,
    });
  }

  #addInk(pageIndex) {
    return this.#add({
      kind: 'ink',
      pageIndex,
      ...this.#toRecordBox(0, 0, 0, 0),
      points: [],
      color: this.style.color,
      strokeWidth: this.style.strokeWidth,
    });
  }

  // A stroke is kept as a bounding box plus points inside a 100 unit square,
  // the same shape a tick or a cross uses. Dragging a corner then scales the
  // drawing for free, and the export needs to know nothing about how it was
  // drawn. The box is recomputed from the raw points on every move, so the
  // stroke stays exact however far it wanders from where it started.
  #reshapeInk(record, raw) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of raw) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }

    // A dead straight stroke has no extent across itself, and dividing by that
    // would send every point to infinity.
    const width = Math.max(maxX - minX, MIN_INK_RATIO);
    const height = Math.max(maxY - minY, MIN_INK_RATIO);

    Object.assign(record, this.#toRecordBox(minX, minY, width, height), {
      points: raw.map((point) => [
        round2(((point.x - minX) / width) * 100),
        round2(((point.y - minY) / height) * 100),
      ]),
    });
  }

  #addLine(pageIndex, from, to, arrow) {
    const a = this.#toRecordPoint(from.x, from.y);
    const b = this.#toRecordPoint(to.x, to.y);
    return this.#add({
      kind: 'line',
      pageIndex,
      x1Ratio: a.xRatio,
      y1Ratio: a.yRatio,
      x2Ratio: b.xRatio,
      y2Ratio: b.yRatio,
      arrow,
      color: this.style.color,
      strokeWidth: this.style.strokeWidth,
    });
  }

  #add(fields) {
    const record = normalise({ id: crypto.randomUUID(), rot: this.viewRotation, ...fields });
    this.records.set(record.id, record);
    if (!this.byPage.has(record.pageIndex)) this.byPage.set(record.pageIndex, new Set());
    this.byPage.get(record.pageIndex).add(record.id);
    if (this.pages.has(record.pageIndex)) this.#mount(record);
    this.onChange();
    return record;
  }

  // ------------------------------------------------------- rotation projection

  // A record is stored in the orientation it was created under, so at creation
  // time display space and record space are one and the same. Conversion is only
  // needed afterwards, when a note is edited under a different view rotation.
  #toRecordPoint(x, y) {
    return { xRatio: clamp(x), yRatio: clamp(y) };
  }

  #toRecordBox(x, y, w, h) {
    return { xRatio: clamp(x), yRatio: clamp(y), wRatio: w, hRatio: h };
  }

  // Where the record's top-left corner currently sits on screen. Combined with
  // transform-origin 0 0 and a rotation, the element then sweeps out exactly the
  // region the record describes, whichever way the view is turned.
  #anchorOf(record) {
    return rotateRatio(record.xRatio, record.yRatio, record.rot, this.viewRotation);
  }

  #displayGeometry(record) {
    const delta = angleDelta(record.rot, this.viewRotation);
    const swapped = delta % 180 === 90;
    const page = this.pages.get(record.pageIndex);

    // Sizes are fractions of the page as the record saw it, so under a quarter
    // turn the two page dimensions trade places.
    const spaceWidth = swapped ? page.height : page.width;
    const spaceHeight = swapped ? page.width : page.height;

    return { delta, swapped, spaceWidth, spaceHeight, page };
  }

  // -------------------------------------------------------------------- DOM

  #mount(record) {
    const page = this.pages.get(record.pageIndex);
    if (!page) return null;

    const element = document.createElement('div');
    element.className = `anno anno-${record.kind}`;
    if (record.wrap) element.classList.add('anno-wrap');
    element.dataset.id = record.id;

    // Kept clear of the corner handles and drawn as a cross, so it reads as
    // "remove this" rather than another resize control.
    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.type = 'button';
    remove.title = 'Delete';
    remove.setAttribute('aria-label', 'Delete');
    remove.innerHTML =
      '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2 2 10"/></svg>';

    const entry = { record, element, remove };

    switch (record.kind) {
      case 'text':
        this.#buildText(entry);
        break;
      case 'box':
        this.#buildBox(entry);
        break;
      case 'line':
        this.#buildLine(entry);
        break;
      case 'ink':
        this.#buildInk(entry);
        break;
      case 'mark':
        this.#buildMark(entry);
        break;
      case 'image':
        this.#buildImage(entry);
        break;
      default:
        break;
    }

    element.appendChild(remove);
    remove.addEventListener('pointerdown', (event) => {
      if (this.tool !== 'select') return;
      event.preventDefault();
      event.stopPropagation();
      this.#destroy(record.id);
      this.onChange();
    });

    if (HANDLE_KINDS.has(record.kind) || record.wrap) this.#addCornerHandles(entry);

    element.addEventListener('pointerdown', (event) => {
      // Stand aside for a drawing tool, letting the press reach the page.
      if (this.tool !== 'select') return;
      if (event.target.closest('.handle, .remove')) return;

      // Already typing in this note: leave the press to the caret.
      if (
        record.kind === 'text' &&
        event.target.closest('.content') &&
        document.activeElement === entry.content
      ) {
        return;
      }

      // First click on a text note selects (and can drag). Editing is a
      // double click, so a single press must not drop the caret.
      if (record.kind === 'text' && event.target.closest('.content')) {
        event.preventDefault();
        event.stopPropagation();
        this.#select(record.id, { add: event.shiftKey });
        if (!event.shiftKey) this.#beginDrag(event, record.id, 'move');
        return;
      }

      event.stopPropagation();
      this.#select(record.id, { add: event.shiftKey });
      // Shift-click is for building a set to align; dragging would scatter it.
      if (event.shiftKey) return;
      if (record.kind === 'text' && !event.target.closest('.grip')) return;
      this.#beginDrag(event, record.id, 'move');
    });

    if (record.kind === 'text') {
      element.addEventListener('dblclick', (event) => {
        if (this.tool !== 'select') return;
        if (event.target.closest('.handle, .remove, .grip')) return;
        event.preventDefault();
        event.stopPropagation();
        this.#beginTextEdit(record.id);
      });
    }

    page.layer.appendChild(element);
    this.elements.set(record.id, entry);
    this.#paint(entry);
    return entry;
  }

  #buildText(entry) {
    const grip = document.createElement('button');
    grip.className = 'grip';
    grip.title = 'Drag to move';
    grip.textContent = '\u2725';

    const content = document.createElement('div');
    content.className = 'content';
    content.contentEditable = 'plaintext-only';
    content.spellcheck = false;
    content.textContent = entry.record.text;

    entry.element.append(grip, content);
    entry.content = content;

    content.addEventListener('input', () => {
      entry.record.text = content.innerText.replace(/\n$/, '');
      if (entry.record.wrap) {
        entry.element.classList.toggle('empty', !entry.record.text.trim());
      }
      this.onChange();
    });
    content.addEventListener('focus', () => {
      entry.element.classList.add('editing');
      this.#select(entry.record.id);
    });
    content.addEventListener('focusout', (event) => {
      entry.element.classList.remove('editing');
      if (event.relatedTarget?.closest(STYLE_CONTROLS)) return;
      if (!entry.record.text.trim()) this.#destroy(entry.record.id);
      else this.onChange();
    });
    content.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        content.blur();
        return;
      }
      // Stay in the note and indent, instead of jumping to the next control.
      if (event.key === 'Tab') {
        event.preventDefault();
        document.execCommand('insertText', false, '\t');
      }
    });
  }

  #buildBox(entry) {
    const body = document.createElement('div');
    body.className = 'body';
    entry.element.appendChild(body);
    entry.body = body;
  }

  #buildLine(entry) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    const head = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    head.setAttribute('fill', 'none');

    // A line's bounding box is mostly empty space, so only a fat invisible
    // stroke over the line itself takes the pointer. The rest stays clickable
    // through to the page.
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    hit.setAttribute('class', 'hit');

    svg.append(line, head, hit);
    entry.element.appendChild(svg);
    Object.assign(entry, { svg, line, head, hit });

    for (const name of ['p1', 'p2']) {
      const handle = document.createElement('span');
      handle.className = 'handle';
      handle.dataset.handle = name;
      handle.title = 'Move end';
      handle.addEventListener('pointerdown', (event) => {
        if (this.tool !== 'select') return;
        event.preventDefault();
        event.stopPropagation();
        this.#select(entry.record.id);
        this.#beginDrag(event, entry.record.id, name);
      });
      entry.element.appendChild(handle);
      entry[name] = handle;
    }
  }

  // preserveAspectRatio none lets the square of points stretch to whatever the
  // box became, and a non-scaling stroke keeps the nib round while it does.
  #buildInk(entry) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hit.setAttribute('class', 'hit');
    for (const node of [path, hit]) {
      node.setAttribute('fill', 'none');
      node.setAttribute('vector-effect', 'non-scaling-stroke');
    }

    svg.append(path, hit);
    entry.element.appendChild(svg);
    Object.assign(entry, { svg, path, hit });
  }

  #buildMark(entry) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');

    if (entry.record.glyph === 'cross') {
      for (const points of [
        [18, 18, 82, 82],
        [82, 18, 18, 82],
      ]) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', points[0]);
        line.setAttribute('y1', points[1]);
        line.setAttribute('x2', points[2]);
        line.setAttribute('y2', points[3]);
        svg.appendChild(line);
      }
    } else {
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      poly.setAttribute('points', GLYPH_POINTS.tick);
      poly.setAttribute('fill', 'none');
      svg.appendChild(poly);
    }

    entry.element.appendChild(svg);
    entry.svg = svg;
  }

  #buildImage(entry) {
    const img = document.createElement('img');
    img.draggable = false;
    entry.element.appendChild(img);
    entry.img = img;
  }

  #addCornerHandles(entry) {
    for (const name of ['nw', 'ne', 'sw', 'se']) {
      const handle = document.createElement('span');
      handle.className = `handle handle-${name}`;
      handle.dataset.handle = name;
      handle.title = 'Resize';
      handle.addEventListener('pointerdown', (event) => {
        if (this.tool !== 'select') return;
        event.preventDefault();
        event.stopPropagation();
        this.#select(entry.record.id);
        this.#beginDrag(event, entry.record.id, name);
      });
      entry.element.appendChild(handle);
    }
  }

  // ------------------------------------------------------------------ painting

  #paint(entry) {
    const { record, element } = entry;
    if (!this.pages.has(record.pageIndex)) return;

    const { delta, spaceWidth, spaceHeight } = this.#displayGeometry(record);
    element.style.transformOrigin = '0 0';
    element.style.transform = delta ? `rotate(${delta}deg)` : '';

    switch (record.kind) {
      case 'text':
        this.#paintText(entry, spaceWidth, spaceHeight);
        break;
      case 'box':
        this.#paintBox(entry, spaceWidth, spaceHeight);
        break;
      case 'line':
        this.#paintLine(entry);
        break;
      case 'ink':
        this.#paintInk(entry, spaceWidth, spaceHeight);
        break;
      case 'mark':
        this.#paintMark(entry, spaceWidth, spaceHeight);
        break;
      case 'image':
        this.#paintImage(entry, spaceWidth, spaceHeight);
        break;
      default:
        break;
    }
  }

  #paintText({ record, element }, spaceWidth, spaceHeight) {
    const anchor = this.#anchorOf(record);
    element.style.left = `${anchor.x * 100}%`;
    element.style.top = `${anchor.y * 100}%`;

    // Width is what makes the text wrap, so it is fixed. Height is only where
    // the box started: more text than fits pushes the bottom down rather than
    // disappearing under it.
    if (record.wrap) {
      element.style.width = `${record.wRatio * spaceWidth}px`;
      element.style.minHeight = `${record.hRatio * spaceHeight}px`;
      element.classList.toggle('empty', !record.text.trim());
    }

    element.style.fontSize = `${record.fontPt * this.scale}px`;
    element.style.fontFamily = cssFontFor(record.font);
    element.style.fontWeight = record.bold && boldAllowed(record.font) ? '700' : '400';
    element.style.fontStyle = record.italic && italicAllowed(record.font) ? 'italic' : 'normal';
    element.style.color = record.color;
    // An empty wrapping box leaves background to CSS so the wash that makes the
    // box readable can show. A chosen highlight colour still wins.
    if (record.wrap && !record.text.trim() && !record.background) {
      element.style.background = '';
    } else {
      element.style.background = record.background || 'transparent';
    }

    const decorations = [];
    if (record.underline) decorations.push('underline');
    if (record.strike) decorations.push('line-through');
    element.style.textDecoration = decorations.join(' ') || 'none';
    element.style.textAlign = record.wrap ? record.align || 'left' : '';
  }

  #paintBox({ record, element, body }, spaceWidth, spaceHeight) {
    const anchor = this.#anchorOf(record);
    element.style.left = `${anchor.x * 100}%`;
    element.style.top = `${anchor.y * 100}%`;
    element.style.width = `${record.wRatio * spaceWidth}px`;
    element.style.height = `${record.hRatio * spaceHeight}px`;

    body.style.borderRadius = record.shape === 'ellipse' ? '50%' : '0';
    if (record.shape === 'highlight' || record.shape === 'band') {
      body.style.background = record.color;
      body.style.opacity = record.shape === 'band' ? '1' : String(record.opacity ?? 0.35);
      body.style.border = 'none';
    } else {
      body.style.background = record.fill || 'transparent';
      body.style.opacity = '1';
      body.style.border = `${Math.max(1, record.strokeWidth * this.scale)}px solid ${record.color}`;
    }
  }

  #paintLine(entry) {
    const { record, element, svg, line, head } = entry;
    const page = this.pages.get(record.pageIndex);

    // Both endpoints are projected into display space, so unlike the other kinds
    // a line needs no CSS rotation of its own.
    const a = rotateRatio(record.x1Ratio, record.y1Ratio, record.rot, this.viewRotation);
    const b = rotateRatio(record.x2Ratio, record.y2Ratio, record.rot, this.viewRotation);
    element.style.transform = '';

    const x1 = a.x * page.width;
    const y1 = a.y * page.height;
    const x2 = b.x * page.width;
    const y2 = b.y * page.height;

    const pad = Math.max(12, record.strokeWidth * this.scale * 6);
    const left = Math.min(x1, x2) - pad;
    const top = Math.min(y1, y2) - pad;

    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.width = `${Math.abs(x2 - x1) + pad * 2}px`;
    element.style.height = `${Math.abs(y2 - y1) + pad * 2}px`;

    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');

    line.setAttribute('x1', x1 - left);
    line.setAttribute('y1', y1 - top);
    line.setAttribute('x2', x2 - left);
    line.setAttribute('y2', y2 - top);
    line.setAttribute('stroke', record.color);
    line.setAttribute('stroke-width', Math.max(1, record.strokeWidth * this.scale));
    line.setAttribute('stroke-linecap', 'round');

    for (const attribute of ['x1', 'y1', 'x2', 'y2']) {
      entry.hit.setAttribute(attribute, line.getAttribute(attribute));
    }

    if (record.arrow) {
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const size = Math.max(6, record.strokeWidth * this.scale * 4);
      const wing = (spread) => [
        x2 - left + size * Math.cos(angle + spread),
        y2 - top + size * Math.sin(angle + spread),
      ];
      const [ax, ay] = wing(Math.PI * 0.82);
      const [bx, by] = wing(-Math.PI * 0.82);
      head.setAttribute('points', `${ax},${ay} ${x2 - left},${y2 - top} ${bx},${by}`);
      head.setAttribute('stroke', record.color);
      head.setAttribute('stroke-width', Math.max(1, record.strokeWidth * this.scale));
      head.setAttribute('stroke-linecap', 'round');
    } else {
      head.removeAttribute('points');
    }

    entry.p1.style.left = `${x1 - left}px`;
    entry.p1.style.top = `${y1 - top}px`;
    entry.p2.style.left = `${x2 - left}px`;
    entry.p2.style.top = `${y2 - top}px`;
  }

  #paintInk({ record, element, path, hit, svg }, spaceWidth, spaceHeight) {
    const anchor = this.#anchorOf(record);
    element.style.left = `${anchor.x * 100}%`;
    element.style.top = `${anchor.y * 100}%`;
    element.style.width = `${record.wRatio * spaceWidth}px`;
    element.style.height = `${record.hRatio * spaceHeight}px`;

    // Without an explicit size, an SVG with a square viewBox keeps a square
    // used size even when inset:0 asks it to fill a tall or wide box. The path
    // then lives in that square while the selection outline follows the real
    // box, so a stroke looks like it is thrashing until the box happens to be
    // square again (a finished circle).
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');

    const d = inkPath(record.points);
    path.setAttribute('d', d);
    hit.setAttribute('d', d);
    path.setAttribute('stroke', record.color);
    path.setAttribute('stroke-width', Math.max(1, record.strokeWidth * this.scale));
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
  }

  #paintMark({ record, element, svg }) {
    const size = record.sizePt * this.scale;
    const anchor = this.#anchorOf(record);
    element.style.left = `${anchor.x * 100}%`;
    element.style.top = `${anchor.y * 100}%`;
    element.style.width = `${size}px`;
    element.style.height = `${size}px`;

    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    for (const shape of svg.children) {
      shape.setAttribute('stroke', record.color);
      shape.setAttribute('stroke-width', String(MARK_STROKE_RATIO * 100));
      shape.setAttribute('stroke-linecap', 'round');
      shape.setAttribute('stroke-linejoin', 'round');
    }
  }

  #paintImage({ record, element, img }, spaceWidth, spaceHeight) {
    const anchor = this.#anchorOf(record);
    element.style.left = `${anchor.x * 100}%`;
    element.style.top = `${anchor.y * 100}%`;
    element.style.width = `${record.wRatio * spaceWidth}px`;
    element.style.height = `${record.hRatio * spaceHeight}px`;

    const src = record.dataUrl || this.stampIndex.get(record.stampId)?.dataUrl;
    if (src && img.src !== src) img.src = src;
  }

  #repaintAll() {
    for (const entry of this.elements.values()) this.#paint(entry);
  }

  // ------------------------------------------------------------------ dragging

  #beginDrag(event, id, handle) {
    const record = this.records.get(id);
    const page = this.pages.get(record.pageIndex);
    if (!page) return;

    const rect = page.layer.getBoundingClientRect();
    this.drag = {
      id,
      handle,
      rect,
      startX: (event.clientX - rect.left) / rect.width,
      startY: (event.clientY - rect.top) / rect.height,
      snapshot: { ...record },
    };
  }

  #onPointerMove(event) {
    if (this.marquee) return this.#updateMarquee(event);
    if (this.pending) return this.#updatePending(event);
    if (!this.drag) return;

    const entry = this.elements.get(this.drag.id);
    if (!entry) return;

    const { rect, snapshot, handle } = this.drag;
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    const dx = x - this.drag.startX;
    const dy = y - this.drag.startY;

    const record = entry.record;
    if (record.kind === 'line') this.#dragLine(record, snapshot, handle, dx, dy, x, y);
    else if (handle === 'move') this.#dragMove(record, snapshot, dx, dy);
    else this.#dragResize(record, snapshot, handle, dx, dy);

    this.#paint(entry);
  }

  #dragMove(record, snapshot, dx, dy) {
    const shift = rotateDelta(dx, dy, this.viewRotation, record.rot);
    record.xRatio = clamp(snapshot.xRatio + shift.x);
    record.yRatio = clamp(snapshot.yRatio + shift.y);
  }

  #dragResize(record, snapshot, handle, dx, dy) {
    const shift = rotateDelta(dx, dy, this.viewRotation, record.rot);
    const west = handle.includes('w');
    const north = handle.includes('n');

    // Signatures stay locked by default (a stretched one looks forged). Photos
    // can unlock and free-resize like a box; lockAspect false falls through.
    if (record.kind === 'image' && record.lockAspect !== false) {
      const aspect = snapshot.hRatio / snapshot.wRatio;
      const wRatio = west ? snapshot.wRatio - shift.x : snapshot.wRatio + shift.x;
      if (wRatio < 0.02) return;
      const hRatio = wRatio * aspect;

      Object.assign(record, {
        wRatio,
        hRatio,
        // The corner opposite the one being dragged stays put.
        xRatio: clamp(west ? snapshot.xRatio + snapshot.wRatio - wRatio : snapshot.xRatio),
        yRatio: clamp(north ? snapshot.yRatio + snapshot.hRatio - hRatio : snapshot.yRatio),
      });

      return;
    }

    let { xRatio, yRatio, wRatio, hRatio } = snapshot;
    if (west) {
      xRatio = snapshot.xRatio + shift.x;
      wRatio = snapshot.wRatio - shift.x;
    } else {
      wRatio = snapshot.wRatio + shift.x;
    }
    if (north) {
      yRatio = snapshot.yRatio + shift.y;
      hRatio = snapshot.hRatio - shift.y;
    } else {
      hRatio = snapshot.hRatio + shift.y;
    }

    if (wRatio < 0.005 || hRatio < 0.005) return;
    Object.assign(record, {
      xRatio: clamp(xRatio),
      yRatio: clamp(yRatio),
      wRatio,
      hRatio,
    });
  }

  #dragLine(record, snapshot, handle, dx, dy, x, y) {
    if (handle === 'move') {
      const shift = rotateDelta(dx, dy, this.viewRotation, record.rot);
      record.x1Ratio = clamp(snapshot.x1Ratio + shift.x);
      record.y1Ratio = clamp(snapshot.y1Ratio + shift.y);
      record.x2Ratio = clamp(snapshot.x2Ratio + shift.x);
      record.y2Ratio = clamp(snapshot.y2Ratio + shift.y);
      return;
    }

    const point = rotateRatio(x, y, this.viewRotation, record.rot);
    if (handle === 'p1') {
      record.x1Ratio = clamp(point.x);
      record.y1Ratio = clamp(point.y);
    } else {
      record.x2Ratio = clamp(point.x);
      record.y2Ratio = clamp(point.y);
    }
  }

  #updatePending(event) {
    const pending = this.pending;
    const page = this.pages.get(pending.pageIndex);
    if (!page) return;

    const rect = page.layer.getBoundingClientRect();
    pending.current = {
      x: clamp((event.clientX - rect.left) / rect.width),
      y: clamp((event.clientY - rect.top) / rect.height),
    };

    const { origin, current } = pending;

    if (pending.tool === 'pen') {
      const last = pending.raw[pending.raw.length - 1];
      if (Math.hypot(current.x - last.x, current.y - last.y) < INK_SAMPLE_RATIO) return;
      pending.raw.push(current);

      const record = pending.id
        ? this.records.get(pending.id)
        : this.#addInk(pending.pageIndex);
      pending.id = record.id;

      this.#reshapeInk(record, pending.raw);
      const entry = this.elements.get(record.id);
      if (entry) this.#paint(entry);
      return;
    }

    if (!pending.id) {
      const record =
        pending.tool === 'line' || pending.tool === 'arrow'
          ? this.#addLine(pending.pageIndex, origin, current, pending.tool === 'arrow')
          : pending.tool === 'textbox'
            ? this.#addText(pending.pageIndex, {
                ...this.#toRecordBox(origin.x, origin.y, 0, 0),
                wrap: true,
              })
            : this.#addBox(pending.pageIndex, pending.tool, origin.x, origin.y, 0, 0);
      pending.id = record.id;
      return;
    }

    const entry = this.elements.get(pending.id);
    if (!entry) return;

    if (entry.record.kind === 'line') {
      const b = this.#toRecordPoint(current.x, current.y);
      entry.record.x2Ratio = b.xRatio;
      entry.record.y2Ratio = b.yRatio;
    } else {
      let top = Math.min(origin.y, current.y);
      let height = Math.abs(current.y - origin.y);

      // Swiping along a line of text hardly moves vertically, which would leave
      // a band too thin to see. Grow it around the swipe rather than below it.
      if (pending.tool === 'highlight' && height < MIN_HIGHLIGHT_RATIO) {
        height = MIN_HIGHLIGHT_RATIO;
        top = (origin.y + current.y) / 2 - height / 2;
      }

      Object.assign(
        entry.record,
        this.#toRecordBox(
          Math.min(origin.x, current.x),
          top,
          Math.abs(current.x - origin.x),
          height
        )
      );
    }
    this.#paint(entry);
  }

  #onPointerUp() {
    if (this.marquee) return this.#finishMarquee();
    if (this.pending) return this.#finishPending();
    if (!this.drag) return;

    const id = this.drag.id;
    this.drag = null;

    const record = this.records.get(id);
    if (record?.shape === 'band') {
      this.#syncBandStrokeFromHeight(record);
      this.onSelect(record);
    }

    this.onChange();
  }

  #updateMarquee(event) {
    const m = this.marquee;
    if (!m) return;

    // Keep using the start page's box so the band stays glued to that page
    // even if the pointer drifts onto the next one.
    m.curX = clamp((event.clientX - m.rect.left) / m.rect.width);
    m.curY = clamp((event.clientY - m.rect.top) / m.rect.height);
    const dist = Math.hypot(m.curX - m.startX, m.curY - m.startY);
    if (dist >= MIN_DRAG_RATIO) {
      if (!m.moved) {
        m.moved = true;
        window.getSelection()?.removeAllRanges?.();
      }
    }
    this.#paintMarquee();
  }

  #paintMarquee() {
    const m = this.marquee;
    if (!m?.box) return;
    const left = Math.min(m.startX, m.curX);
    const top = Math.min(m.startY, m.curY);
    const width = Math.abs(m.curX - m.startX);
    const height = Math.abs(m.curY - m.startY);
    m.box.style.left = `${left * 100}%`;
    m.box.style.top = `${top * 100}%`;
    m.box.style.width = `${width * 100}%`;
    m.box.style.height = `${height * 100}%`;
    m.box.hidden = !m.moved;
  }

  #finishMarquee() {
    const m = this.marquee;
    this.marquee = null;
    m?.box?.remove();
    if (!m) return;

    if (!m.moved) {
      if (!m.additive) this.deselect();
      return;
    }

    const band = {
      x: Math.min(m.startX, m.curX),
      y: Math.min(m.startY, m.curY),
      w: Math.abs(m.curX - m.startX),
      h: Math.abs(m.curY - m.startY),
    };

    const hit = [];
    for (const id of this.byPage.get(m.pageIndex) || []) {
      const record = this.records.get(id);
      if (record?.kind !== 'text') continue;
      const box = this.#displayBox(record);
      if (rectsOverlap(band, box)) hit.push(id);
    }

    this.selectTexts(hit, { additive: m.additive });
  }

  // ----------------------------------------------------------------- selection

  #select(id, { add = false } = {}) {
    const record = this.records.get(id);
    if (!record) return;

    // Shift-click builds a set of text notes to align. Anything else replaces
    // the selection, the way a plain click always has.
    const additive = add && record.kind === 'text';

    if (additive) {
      for (const otherId of [...this.selection]) {
        if (this.records.get(otherId)?.kind !== 'text') {
          this.elements.get(otherId)?.element.classList.remove('active');
          this.selection.delete(otherId);
        }
      }

      if (this.selection.has(id)) {
        this.selection.delete(id);
        this.elements.get(id)?.element.classList.remove('active');
        this.activeId = [...this.selection].at(-1) || null;
        if (this.activeId) this.elements.get(this.activeId)?.element.classList.add('active');
        this.onSelect(this.records.get(this.activeId) || null);
        return;
      }
    } else {
      if (this.activeId === id && this.selection.size <= 1) return;
      for (const otherId of this.selection) {
        if (otherId !== id) this.elements.get(otherId)?.element.classList.remove('active');
      }
      this.selection.clear();
    }

    this.selection.add(id);
    this.activeId = id;
    this.elements.get(id)?.element.classList.add('active');
    this.onSelect(record);
  }

  deselect() {
    this.#endTextEditing();
    if (!this.selection.size && !this.activeId) return;
    for (const id of this.selection) {
      this.elements.get(id)?.element.classList.remove('active');
    }
    this.selection.clear();
    this.activeId = null;
    this.onSelect(null);
  }

  // Drop the caret and any highlighted letters inside a note. Switching tools
  // (especially by shortcut) used to leave the blue native selection painted
  // on the text even after Select was in hand.
  endTextEditing() {
    this.#endTextEditing();
  }

  #endTextEditing() {
    const active = document.activeElement;
    if (active?.isContentEditable && active.closest?.('.anno')) {
      active.blur();
    }

    const sel = window.getSelection?.();
    if (!sel?.rangeCount) return;
    const node = sel.anchorNode;
    const host = node?.nodeType === 1 ? node : node?.parentElement;
    if (host?.closest?.('.anno .content')) sel.removeAllRanges();
  }

  #destroy(id) {
    const entry = this.elements.get(id);
    entry?.element.remove();
    this.elements.delete(id);

    const record = this.records.get(id);
    if (record) this.byPage.get(record.pageIndex)?.delete(id);
    this.records.delete(id);
    this.selection.delete(id);

    if (this.activeId === id) {
      this.activeId = [...this.selection].at(-1) || null;
      if (this.activeId) this.elements.get(this.activeId)?.element.classList.add('active');
      this.onSelect(this.records.get(this.activeId) || null);
    }
  }
}

// --------------------------------------------------------------------- helpers

// Joining sampled points with straight segments shows every corner once the
// page is zoomed. Curving each pair through their midpoint costs nothing and
// reads as a drawn line rather than a chain of ticks.
export function inkPath(points) {
  if (!points?.length) return '';
  if (points.length === 1) return `M${points[0][0]} ${points[0][1]}l0 0`;

  let d = `M${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const [cx, cy] = points[i];
    const [nx, ny] = points[i + 1];
    d += `Q${cx} ${cy} ${round2((cx + nx) / 2)} ${round2((cy + ny) / 2)}`;
  }

  const last = points[points.length - 1];
  return `${d}L${last[0]} ${last[1]}`;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// Maps a point ratio from one view rotation's display space into another's.
export function rotateRatio(x, y, fromRotation, toRotation) {
  switch (angleDelta(fromRotation, toRotation)) {
    case 90:
      return { x: 1 - y, y: x };
    case 180:
      return { x: 1 - x, y: 1 - y };
    case 270:
      return { x: y, y: 1 - x };
    default:
      return { x, y };
  }
}

// The same rotation applied to a displacement, which has no origin to flip about.
function rotateDelta(dx, dy, fromRotation, toRotation) {
  switch (angleDelta(fromRotation, toRotation)) {
    case 90:
      return { x: -dy, y: dx };
    case 180:
      return { x: -dx, y: -dy };
    case 270:
      return { x: dy, y: -dx };
    default:
      return { x: dx, y: dy };
  }
}

function angleDelta(from, to) {
  return (((to - from) % 360) + 360) % 360;
}

function cssFontFor(family) {
  if (family === 'times') return '"Times New Roman", Times, serif';
  if (family === 'courier') return '"Courier New", Courier, monospace';
  if (family === 'handlee' || family === 'caveat') return 'Handlee, cursive';
  if (family === 'indie') return '"Indie Flower", cursive';
  if (family === 'patrick') return '"Patrick Hand", cursive';
  return 'Helvetica, Arial, sans-serif';
}

const HAND_FONTS = new Set(['patrick', 'caveat', 'indie', 'handlee']);

// These hands have no italic or bold cut, and the export will not fake them, so
// neither does the screen. Anything else would print differently from how it was typed.
function italicAllowed(family) {
  return !HAND_FONTS.has(family);
}

function boldAllowed(family) {
  return !HAND_FONTS.has(family);
}

// Records written by the first version have no kind and no rot.
function normalise(record) {
  return { kind: 'text', rot: 0, ...record };
}

function cloneRecord(record) {
  return JSON.parse(JSON.stringify(record));
}

// Shift a record in display ratios. Lines have two ends; everything else is
// anchored by a top-left. Sizes and stroke points stay put, since ink points
// live inside the box.
function offsetRecord(record, dx, dy) {
  if (record.kind === 'line') {
    record.x1Ratio = clamp(record.x1Ratio + dx);
    record.y1Ratio = clamp(record.y1Ratio + dy);
    record.x2Ratio = clamp(record.x2Ratio + dx);
    record.y2Ratio = clamp(record.y2Ratio + dy);
    return;
  }
  if (record.xRatio != null) record.xRatio = clamp(record.xRatio + dx);
  if (record.yRatio != null) record.yRatio = clamp(record.yRatio + dy);
}

function clamp(value) {
  return Math.min(0.999, Math.max(0, value));
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
