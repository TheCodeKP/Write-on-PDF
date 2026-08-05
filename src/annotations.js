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
const HANDLE_KINDS = new Set(['box', 'image']);

// Roughly a line of body text on A4. A highlighter is swiped along a line, so
// the gesture is almost flat and the raw drag height would be nearly nothing.
const MIN_HIGHLIGHT_RATIO = 0.018;

// Clicking rather than dragging drops one of these instead. The highlighter is
// deliberately absent: it is only ever used by dragging across something, so a
// stray click should leave nothing behind.
const DEFAULT_SIZES = {
  rect: { w: 0.2, h: 0.09 },
  ellipse: { w: 0.2, h: 0.09 },
  line: { w: 0.2, h: 0 },
  arrow: { w: 0.2, h: 0 },
};

const STYLE_KEYS = {
  text: ['fontPt', 'font', 'bold', 'italic', 'underline', 'strike', 'color', 'background'],
  box: ['color', 'strokeWidth'],
  line: ['color', 'strokeWidth'],
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

export class Annotations {
  constructor({ onChange, onSelect, onPlace } = {}) {
    this.records = new Map(); // id -> record
    this.byPage = new Map(); // pageIndex -> Set<id>
    this.elements = new Map(); // id -> { record, element, ...parts } for mounted pages only
    this.pages = new Map(); // pageIndex -> { layer, width, height }

    this.scale = 1;
    this.viewRotation = 0;
    this.tool = 'text';
    this.activeId = null;
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
      strokeWidth: 1.5,
      opacity: 0.35, // fixed: what makes the highlighter translucent, no control
      sizePt: 18,
      stampWidth: 0.24, // fraction of the page a placed signature spans
    };

    this.drag = null;
    this.pending = null;
    this.ghost = null;

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
      if (this.activeId === id) this.deselect();
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
  #applyToolTo(layer) {
    layer.style.pointerEvents = this.tool === 'select' ? 'none' : 'auto';
    layer.style.cursor =
      this.tool === 'text' ? 'text' : this.tool === 'select' ? 'default' : 'crosshair';
  }

  setStamps(stamps) {
    this.stampIndex = new Map(stamps.map((stamp) => [stamp.id, stamp]));
    this.#hideGhost();
    this.#repaintAll();
  }

  setActiveStamp(stampId) {
    this.activeStampId = stampId;
    this.#hideGhost();
  }

  // ------------------------------------------------------------- stamp ghost

  // Following the cursor with a translucent copy is the whole trick: you can
  // see what you are about to place, at the size it will be, before committing.
  #trackGhost(event, pageIndex) {
    const stamp = this.stampIndex.get(this.activeStampId);
    const page = this.pages.get(pageIndex);
    if (this.tool !== 'stamp' || !stamp || !page) return this.#hideGhost();

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

  // Applies to the selection when there is one, and always updates the defaults
  // used for the next annotation.
  applyStyle(patch) {
    Object.assign(this.style, patch);

    const entry = this.elements.get(this.activeId);
    if (!entry) return;

    if (entry.record.kind === 'image' && patch.stampWidth != null) {
      this.#resizeImage(entry, patch.stampWidth);
      return;
    }

    const allowed = STYLE_KEYS[entry.record.kind] || [];
    let touched = false;
    for (const [key, value] of Object.entries(patch)) {
      if (!allowed.includes(key)) continue;
      entry.record[key] = value;
      touched = true;
    }
    if (!touched) return;

    this.#paint(entry);
    this.onChange();
  }

  #resizeImage(entry, wRatio) {
    const stamp = this.stampIndex.get(entry.record.stampId);
    if (!stamp) return;

    const { spaceWidth, spaceHeight } = this.#displayGeometry(entry.record);
    entry.record.wRatio = wRatio;
    entry.record.hRatio = (wRatio * spaceWidth * stamp.aspect) / spaceHeight;

    this.#paint(entry);
    this.onChange();
  }

  get selected() {
    return this.records.get(this.activeId) || null;
  }

  deleteSelected() {
    if (!this.activeId) return false;
    this.#destroy(this.activeId);
    this.onChange();
    return true;
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
    if (!page || event.target !== page.layer) return;
    if (this.tool === 'select') return;

    const rect = page.layer.getBoundingClientRect();
    const point = {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };

    // preventDefault below stops the browser moving focus, which would
    // otherwise blur an open text box and let it clean itself up if empty.
    if (document.activeElement?.isContentEditable) document.activeElement.blur();

    event.preventDefault();
    this.deselect();

    switch (this.tool) {
      case 'text':
        this.#createText(pageIndex, point);
        return;
      case 'tick':
      case 'cross':
        this.#createMark(pageIndex, point, this.tool);
        return;
      case 'stamp':
        this.#createImage(pageIndex, point);
        return;
      default:
        this.pending = { tool: this.tool, pageIndex, origin: point, current: point, id: null };
    }
  }

  #createText(pageIndex, point) {
    const lineHeightRatio =
      (this.style.fontPt * this.scale * LINE_HEIGHT) / (this.pages.get(pageIndex)?.height || 1);

    const record = this.#add({
      kind: 'text',
      pageIndex,
      ...this.#toRecordPoint(point.x, point.y - lineHeightRatio / 2),
      fontPt: this.style.fontPt,
      font: this.style.font,
      bold: this.style.bold,
      italic: this.style.italic,
      underline: this.style.underline,
      strike: this.style.strike,
      color: this.style.color,
      background: this.style.background,
      text: '',
    });

    this.elements.get(record.id)?.content.focus();
  }

  #createMark(pageIndex, point, glyph) {
    const page = this.pages.get(pageIndex);
    const sizeRatioX = (this.style.sizePt * this.scale) / page.width;
    const sizeRatioY = (this.style.sizePt * this.scale) / page.height;

    this.#add({
      kind: 'mark',
      glyph,
      pageIndex,
      ...this.#toRecordPoint(point.x - sizeRatioX / 2, point.y - sizeRatioY / 2),
      sizePt: this.style.sizePt,
      color: this.style.color,
    });
  }

  #createImage(pageIndex, point) {
    const stamp = this.stampIndex.get(this.activeStampId);
    if (!stamp) return;

    const page = this.pages.get(pageIndex);
    const wRatio = this.style.stampWidth;
    // aspect is height over width, so it has to go through the page box to come
    // out as a height ratio that keeps the image undistorted.
    const hRatio = (wRatio * page.width * stamp.aspect) / page.height;

    const record = this.#add({
      kind: 'image',
      pageIndex,
      stampId: this.activeStampId,
      ...this.#toRecordBox(point.x - wRatio / 2, point.y - hRatio / 2, wRatio, hRatio),
    });

    // Selected straight away so the resize handles are already showing, which
    // is the difference between "did that work?" and "there it is, drag it".
    this.#hideGhost();
    this.#select(record.id);
    this.onPlace(record);
  }

  #finishPending() {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;

    const dx = pending.current.x - pending.origin.x;
    const dy = pending.current.y - pending.origin.y;
    const tiny = Math.abs(dx) < MIN_DRAG_RATIO && Math.abs(dy) < MIN_DRAG_RATIO;

    if (pending.id && !tiny) {
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

    if (pending.tool === 'line' || pending.tool === 'arrow') {
      this.#addLine(pending.pageIndex, pending.origin, {
        x: pending.origin.x + preset.w,
        y: pending.origin.y,
      }, pending.tool === 'arrow');
    } else {
      this.#addBox(pending.pageIndex, pending.tool, pending.origin.x, pending.origin.y, preset.w, preset.h);
    }
    this.onChange();
  }

  #addBox(pageIndex, shape, x, y, w, h) {
    return this.#add({
      kind: 'box',
      shape,
      pageIndex,
      ...this.#toRecordBox(x, y, w, h),
      color: this.style.color,
      strokeWidth: this.style.strokeWidth,
      opacity: this.style.opacity,
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
    element.dataset.id = record.id;

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.title = 'Delete';
    remove.textContent = '\u00d7';

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
      event.preventDefault();
      event.stopPropagation();
      this.#destroy(record.id);
      this.onChange();
    });

    if (HANDLE_KINDS.has(record.kind)) this.#addCornerHandles(entry);

    element.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.handle, .remove')) return;
      if (record.kind === 'text' && event.target.closest('.content')) return;
      event.stopPropagation();
      this.#select(record.id);
      if (record.kind === 'text' && !event.target.closest('.grip')) return;
      this.#beginDrag(event, record.id, 'move');
    });

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
      this.onChange();
    });
    content.addEventListener('focus', () => this.#select(entry.record.id));
    content.addEventListener('blur', () => {
      if (!entry.record.text.trim()) this.#destroy(entry.record.id);
      else this.onChange();
    });
    content.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        content.blur();
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
      handle.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.#select(entry.record.id);
        this.#beginDrag(event, entry.record.id, name);
      });
      entry.element.appendChild(handle);
      entry[name] = handle;
    }
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
      handle.addEventListener('pointerdown', (event) => {
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

  #paintText({ record, element }) {
    const anchor = this.#anchorOf(record);
    element.style.left = `${anchor.x * 100}%`;
    element.style.top = `${anchor.y * 100}%`;
    element.style.fontSize = `${record.fontPt * this.scale}px`;
    element.style.fontFamily = cssFontFor(record.font);
    element.style.fontWeight = record.bold ? '700' : '400';
    element.style.fontStyle = record.italic ? 'italic' : 'normal';
    element.style.color = record.color;
    element.style.background = record.background || 'transparent';

    const decorations = [];
    if (record.underline) decorations.push('underline');
    if (record.strike) decorations.push('line-through');
    element.style.textDecoration = decorations.join(' ') || 'none';
  }

  #paintBox({ record, element, body }, spaceWidth, spaceHeight) {
    const anchor = this.#anchorOf(record);
    element.style.left = `${anchor.x * 100}%`;
    element.style.top = `${anchor.y * 100}%`;
    element.style.width = `${record.wRatio * spaceWidth}px`;
    element.style.height = `${record.hRatio * spaceHeight}px`;

    body.style.borderRadius = record.shape === 'ellipse' ? '50%' : '0';
    if (record.shape === 'highlight') {
      body.style.background = record.color;
      body.style.opacity = String(record.opacity ?? 0.35);
      body.style.border = 'none';
    } else {
      body.style.background = 'transparent';
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

    const stamp = this.stampIndex.get(record.stampId);
    if (stamp?.dataUrl && img.src !== stamp.dataUrl) img.src = stamp.dataUrl;
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

    // A stretched signature looks forged, so images scale rather than reshape:
    // width follows the pointer and height follows the width.
    if (record.kind === 'image') {
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
    if (!pending.id) {
      const record =
        pending.tool === 'line' || pending.tool === 'arrow'
          ? this.#addLine(pending.pageIndex, origin, current, pending.tool === 'arrow')
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
    if (this.pending) return this.#finishPending();
    if (!this.drag) return;
    this.drag = null;
    this.onChange();
  }

  // ----------------------------------------------------------------- selection

  #select(id) {
    if (this.activeId === id) return;
    this.elements.get(this.activeId)?.element.classList.remove('active');
    this.activeId = id;
    const entry = this.elements.get(id);
    entry?.element.classList.add('active');
    this.onSelect(entry?.record || null);
  }

  deselect() {
    if (!this.activeId) return;
    this.elements.get(this.activeId)?.element.classList.remove('active');
    this.activeId = null;
    this.onSelect(null);
  }

  #destroy(id) {
    const entry = this.elements.get(id);
    entry?.element.remove();
    this.elements.delete(id);

    const record = this.records.get(id);
    if (record) this.byPage.get(record.pageIndex)?.delete(id);
    this.records.delete(id);

    if (this.activeId === id) {
      this.activeId = null;
      this.onSelect(null);
    }
  }
}

// --------------------------------------------------------------------- helpers

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
  return 'Helvetica, Arial, sans-serif';
}

// Records written by the first version have no kind and no rot.
function normalise(record) {
  return { kind: 'text', rot: 0, ...record };
}

function clamp(value) {
  return Math.min(0.999, Math.max(0, value));
}
