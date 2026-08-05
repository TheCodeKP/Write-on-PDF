// Whole-document text search.
//
// Two caches, deliberately. Plain page text is small and worth keeping for every
// page so that typing another letter does not re-extract the whole document. The
// per-glyph geometry needed to draw a highlight is enormous by comparison, so it
// is only ever built for the handful of pages that actually contain a hit.
//
// Match positions are stored as ratios of the unrotated page, the same
// convention annotations use, so highlights survive zoom and view rotation.

const YIELD_EVERY = 6;

export class Finder {
  constructor({ getPage, pageCount, onUpdate, onGeometry }) {
    this.getPage = getPage;
    this.pageCount = pageCount;
    this.onUpdate = onUpdate || (() => {});
    this.onGeometry = onGeometry || (() => {});

    this.textCache = new Map(); // pageIndex -> { text, lower }
    this.preparing = new Set();

    this.matches = [];
    this.byPage = new Map(); // pageIndex -> match[]
    this.current = -1;
    this.token = 0;
  }

  get total() {
    return this.matches.length;
  }

  get ordinal() {
    return this.current < 0 ? 0 : this.current + 1;
  }

  get active() {
    return this.matches[this.current] || null;
  }

  clear() {
    this.token += 1;
    this.matches = [];
    this.byPage.clear();
    this.current = -1;
  }

  async search(query, { caseSensitive = false, startPage = 0 } = {}) {
    const token = ++this.token;
    this.matches = [];
    this.byPage.clear();
    this.current = -1;

    if (!query) {
      this.onUpdate({ done: true });
      return;
    }

    const needle = caseSensitive ? query : query.toLowerCase();

    for (let pageIndex = 0; pageIndex < this.pageCount; pageIndex += 1) {
      const page = await this.#textFor(pageIndex);
      if (token !== this.token) return;

      const haystack = caseSensitive ? page.text : page.lower;
      let from = 0;
      for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at === -1) break;

        const match = { pageIndex, start: at, end: at + needle.length, rects: null };
        this.matches.push(match);
        if (!this.byPage.has(pageIndex)) this.byPage.set(pageIndex, []);
        this.byPage.get(pageIndex).push(match);
        from = at + needle.length;
      }

      // Extraction is the slow part, so hand the tab back regularly or a long
      // document freezes the whole window while you type.
      if (pageIndex % YIELD_EVERY === 0) {
        this.onUpdate({ done: false, progress: (pageIndex + 1) / this.pageCount });
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (token !== this.token) return;
      }
    }

    // Document order throughout, but the first hit offered is the one nearest
    // to where the reader already is.
    const from = this.matches.findIndex((match) => match.pageIndex >= startPage);
    this.current = this.matches.length ? (from === -1 ? 0 : from) : -1;
    this.onUpdate({ done: true });
  }

  step(direction) {
    if (!this.matches.length) return null;
    this.current = (this.current + direction + this.matches.length) % this.matches.length;
    return this.active;
  }

  // Synchronous, for painting. Pages whose geometry is not built yet come back
  // empty and trigger a background build that repaints when it lands.
  rectsFor(pageIndex) {
    const matches = this.byPage.get(pageIndex);
    if (!matches?.length) return [];
    if (matches[0].rects) return matches;
    this.#prepare(pageIndex);
    return [];
  }

  async ensureRects(pageIndex) {
    await this.#prepare(pageIndex);
    return this.byPage.get(pageIndex) || [];
  }

  async #prepare(pageIndex) {
    const matches = this.byPage.get(pageIndex);
    if (!matches?.length || matches[0].rects || this.preparing.has(pageIndex)) return;

    this.preparing.add(pageIndex);
    const token = this.token;
    try {
      const geometry = await this.#geometryFor(pageIndex);
      if (token !== this.token) return;
      for (const match of matches) match.rects = buildRects(geometry, match.start, match.end);
      this.onGeometry(pageIndex);
    } finally {
      this.preparing.delete(pageIndex);
    }
  }

  async #textFor(pageIndex) {
    const cached = this.textCache.get(pageIndex);
    if (cached) return cached;

    const entry = { text: '', lower: '' };
    try {
      const page = await this.getPage(pageIndex);
      const content = await page.getTextContent();
      entry.text = content.items.map(itemText).join('');
      entry.lower = entry.text.toLowerCase();
    } catch {
      // A page that will not give up its text simply has no matches.
    }

    this.textCache.set(pageIndex, entry);
    return entry;
  }

  // The expensive half: every run's position and size on the page. Built only
  // for pages with hits, and thrown away with the Finder.
  async #geometryFor(pageIndex) {
    const geometry = { items: [], ranges: [], width: 1, height: 1 };

    try {
      const page = await this.getPage(pageIndex);
      const content = await page.getTextContent();
      const viewport = page.getViewport({ scale: 1 });

      let cursor = 0;
      for (const item of content.items) {
        const text = itemText(item);
        if (typeof item.str === 'string') {
          geometry.items.push({
            width: item.width,
            transform: applyTransform(viewport.transform, item.transform),
          });
          geometry.ranges.push({
            index: geometry.items.length - 1,
            start: cursor,
            end: cursor + item.str.length,
          });
        }
        cursor += text.length;
      }

      geometry.width = viewport.width;
      geometry.height = viewport.height;
    } catch {
      // Leave it empty; the match just gets no highlight.
    }

    return geometry;
  }
}

// Must produce exactly the same string as the geometry pass, or the character
// offsets a match was found at would point at the wrong run.
function itemText(item) {
  if (typeof item.str !== 'string') return '';
  const text = item.str.replace(/[\u00a0\u2007\u202f]/g, ' ');
  return item.hasEOL ? `${text}\n` : text;
}

// Turns a character span into one rect per text run it crosses.
function buildRects(geometry, start, end) {
  const rects = [];

  for (const range of geometry.ranges) {
    if (range.end <= start || range.start >= end) continue;

    const item = geometry.items[range.index];
    const length = range.end - range.start;
    if (!length) continue;

    const from = (Math.max(start, range.start) - range.start) / length;
    const to = (Math.min(end, range.end) - range.start) / length;

    const [a, b, c, d, e, f] = item.transform;
    const height = Math.hypot(c, d) || Math.hypot(a, b);
    const angle = Math.atan2(b, a);
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);

    const x0 = e + item.width * from * dirX;
    const y0 = f + item.width * from * dirY;
    const x1 = e + item.width * to * dirX;
    const y1 = f + item.width * to * dirY;

    // Perpendicular to the baseline, pointing at the ascender. Doing it this way
    // rather than assuming horizontal keeps sideways text boxed correctly.
    const ax = dirY * height;
    const ay = -dirX * height;

    const xs = [x0, x1, x0 + ax, x1 + ax];
    const ys = [y0, y1, y0 + ay, y1 + ay];

    rects.push({
      x: Math.min(...xs) / geometry.width,
      y: Math.min(...ys) / geometry.height,
      w: (Math.max(...xs) - Math.min(...xs)) / geometry.width,
      h: (Math.max(...ys) - Math.min(...ys)) / geometry.height,
    });
  }

  return rects;
}

// pdfjsLib.Util.transform, inlined so this module needs no import.
function applyTransform(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}
