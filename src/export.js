// Stamps annotations into the original PDF with pdf-lib.
//
// Printing the on-screen canvas would send a bitmap to the printer. Drawing real
// text and vectors into the source document keeps the output sharp at any size.
//
// Annotation records store positions as ratios of the *displayed* page, where
// "displayed" means the page's own /Rotate combined with the view rotation the
// note was made under. toPdfSpace turns that back into unrotated PDF user space
// and is the single place that mapping lives.

const LINE_STEP = 1.2; // must match the line-height the boxes are laid out with
const FALLBACK_BASELINE_RATIO = 0.9465; // Arial in Chrome, if measuring fails

const UNDERLINE_OFFSET = 0.12; // below the baseline, as a fraction of font size
const STRIKE_OFFSET = -0.26; // above the baseline

export const CSS_FONTS = {
  helvetica: 'Helvetica, Arial, sans-serif',
  times: '"Times New Roman", Times, serif',
  courier: '"Courier New", Courier, monospace',
};

const PDF_FONTS = {
  // Indexed by (bold ? 1 : 0) + (italic ? 2 : 0)
  helvetica: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
  times: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
  courier: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
};

const MARK_STROKE_RATIO = 0.12; // must match the same constant in annotations.js

// Tick and cross drawn as line segments rather than ZapfDingbats characters:
// the Dingbats code points for check marks are easy to get wrong, and segments
// stay predictable at any size. Coordinates are fractions of the glyph box.
const GLYPH_STROKES = {
  tick: [
    [
      [0.14, 0.54],
      [0.4, 0.8],
      [0.88, 0.2],
    ],
  ],
  cross: [
    [
      [0.18, 0.18],
      [0.82, 0.82],
    ],
    [
      [0.82, 0.18],
      [0.18, 0.82],
    ],
  ],
};

// Distance from the top of a line box down to the baseline, as a fraction of
// font size. Measured from the live font so stamped text lands exactly where the
// on-screen text sat, instead of relying on hardcoded metrics. Families differ,
// so this is measured per family.
export function measureBaselineRatio(cssFont) {
  try {
    const context = document.createElement('canvas').getContext('2d');
    context.font = `100px ${cssFont}`;
    const metrics = context.measureText('Hxg');
    const ascent = metrics.fontBoundingBoxAscent / 100;
    const descent = metrics.fontBoundingBoxDescent / 100;
    if (!ascent || !descent) return FALLBACK_BASELINE_RATIO;
    return (LINE_STEP - (ascent + descent)) / 2 + ascent;
  } catch {
    return FALLBACK_BASELINE_RATIO;
  }
}

export function measureAllBaselineRatios() {
  const ratios = {};
  for (const [family, cssFont] of Object.entries(CSS_FONTS)) {
    ratios[family] = measureBaselineRatio(cssFont);
  }
  return ratios;
}

export async function stampPdf(bytes, annotations, options = {}) {
  const { baselineRatios = {}, stamps = new Map() } = options;
  const { PDFDocument, StandardFonts, rgb, degrees } = globalThis.PDFLib;

  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = doc.getPages();

  const fontCache = new Map();
  const getFont = async (family, bold, italic) => {
    const name = (PDF_FONTS[family] || PDF_FONTS.helvetica)[(bold ? 1 : 0) + (italic ? 2 : 0)];
    if (!fontCache.has(name)) fontCache.set(name, await doc.embedFont(StandardFonts[name]));
    return fontCache.get(name);
  };

  const imageCache = new Map();
  const getImage = async (stampId) => {
    if (imageCache.has(stampId)) return imageCache.get(stampId);
    const stamp = stamps.get(stampId);
    if (!stamp?.dataUrl) return null;
    const embedded = /^data:image\/png/i.test(stamp.dataUrl)
      ? await doc.embedPng(stamp.dataUrl)
      : await doc.embedJpg(stamp.dataUrl);
    imageCache.set(stampId, embedded);
    return embedded;
  };

  // Translucent highlights go down first. Drawn in creation order they would
  // wash over text added earlier, which is the one case where stamped order
  // deliberately differs from on-screen order.
  const isHighlight = (a) => a.kind === 'box' && a.shape === 'highlight';
  const ordered = [...annotations.filter(isHighlight), ...annotations.filter((a) => !isHighlight(a))];

  for (const annotation of ordered) {
    const page = pages[annotation.pageIndex];
    if (!page) continue;

    const { width, height } = page.getSize();
    const rotation = normaliseAngle(page.getRotation().angle + (annotation.rot || 0));
    const upright = rotation % 180 === 0;

    const context = {
      page,
      width,
      height,
      rotation,
      displayWidth: upright ? width : height,
      displayHeight: upright ? height : width,
      rgb,
      degrees,
    };

    switch (annotation.kind || 'text') {
      case 'box':
        drawBox(annotation, context);
        break;
      case 'line':
        drawLine(annotation, context);
        break;
      case 'mark':
        drawMark(annotation, context);
        break;
      case 'image':
        await drawImage(annotation, context, getImage);
        break;
      default:
        await drawText(annotation, context, getFont, baselineRatios);
    }
  }

  return doc.save();
}

// ---------------------------------------------------------------- annotations

async function drawText(annotation, context, getFont, baselineRatios) {
  const raw = (annotation.text || '').replace(/\r/g, '');
  if (!raw.trim()) return;

  const { page, displayWidth, displayHeight, rotation, rgb, degrees } = context;
  const size = annotation.fontPt;
  const family = annotation.font || 'helvetica';
  const font = await getFont(family, annotation.bold, annotation.italic);
  const baseline = baselineRatios[family] ?? FALLBACK_BASELINE_RATIO;
  const colour = hexToRgb(annotation.color);

  raw.split('\n').forEach((rawLine, index) => {
    const line = sanitise(rawLine);
    if (!line) return;

    const displayX = annotation.xRatio * displayWidth;
    const lineTop = annotation.yRatio * displayHeight + index * LINE_STEP * size;
    const displayY = lineTop + baseline * size;
    const runWidth = font.widthOfTextAtSize(line, size);

    if (annotation.background) {
      drawDisplayRect(
        context,
        displayX,
        lineTop,
        runWidth,
        LINE_STEP * size,
        { color: rgb(...toTuple(hexToRgb(annotation.background))), opacity: 1 }
      );
    }

    const { x, y } = toPdfSpace(displayX, displayY, rotation, context.width, context.height);
    page.drawText(line, {
      x,
      y,
      size,
      font,
      color: rgb(colour.r, colour.g, colour.b),
      rotate: degrees(rotation),
    });

    // pdf-lib has no underline or strikethrough, so both are drawn as rules.
    // Converting each endpoint separately means no rotation argument is needed.
    for (const [enabled, offset] of [
      [annotation.underline, UNDERLINE_OFFSET],
      [annotation.strike, STRIKE_OFFSET],
    ]) {
      if (!enabled) continue;
      drawDisplayLine(
        context,
        displayX,
        displayY + offset * size,
        displayX + runWidth,
        displayY + offset * size,
        { thickness: Math.max(0.5, size * 0.06), color: rgb(colour.r, colour.g, colour.b) }
      );
    }
  });
}

function drawBox(annotation, context) {
  const { page, displayWidth, displayHeight, rotation, rgb, degrees } = context;

  const dx = annotation.xRatio * displayWidth;
  const dy = annotation.yRatio * displayHeight;
  const dw = annotation.wRatio * displayWidth;
  const dh = annotation.hRatio * displayHeight;
  if (dw <= 0 || dh <= 0) return;

  const colour = hexToRgb(annotation.color);
  const paint = rgb(colour.r, colour.g, colour.b);

  if (annotation.shape === 'ellipse') {
    const centre = toPdfSpace(dx + dw / 2, dy + dh / 2, rotation, context.width, context.height);
    page.drawEllipse({
      x: centre.x,
      y: centre.y,
      xScale: dw / 2,
      yScale: dh / 2,
      rotate: degrees(rotation),
      borderColor: paint,
      borderWidth: annotation.strokeWidth ?? 1.5,
      opacity: 0,
    });
    return;
  }

  const filled = annotation.shape === 'highlight';
  drawDisplayRect(context, dx, dy, dw, dh, {
    color: paint,
    opacity: filled ? (annotation.opacity ?? 0.35) : 0,
    borderColor: filled ? undefined : paint,
    borderWidth: filled ? 0 : (annotation.strokeWidth ?? 1.5),
  });
}

function drawLine(annotation, context) {
  const { displayWidth, displayHeight, rgb } = context;
  const colour = hexToRgb(annotation.color);
  const paint = rgb(colour.r, colour.g, colour.b);
  const thickness = annotation.strokeWidth ?? 1.5;

  const x1 = annotation.x1Ratio * displayWidth;
  const y1 = annotation.y1Ratio * displayHeight;
  const x2 = annotation.x2Ratio * displayWidth;
  const y2 = annotation.y2Ratio * displayHeight;

  drawDisplayLine(context, x1, y1, x2, y2, { thickness, color: paint });
  if (!annotation.arrow) return;

  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.max(6, thickness * 4);
  for (const spread of [Math.PI * 0.82, -Math.PI * 0.82]) {
    drawDisplayLine(
      context,
      x2,
      y2,
      x2 + head * Math.cos(angle + spread),
      y2 + head * Math.sin(angle + spread),
      { thickness, color: paint }
    );
  }
}

function drawMark(annotation, context) {
  const { displayWidth, displayHeight, rgb } = context;
  const colour = hexToRgb(annotation.color);
  const paint = rgb(colour.r, colour.g, colour.b);

  const size = annotation.sizePt;
  const dx = annotation.xRatio * displayWidth;
  const dy = annotation.yRatio * displayHeight;
  // Matches the on-screen stroke, which is drawn proportionally inside the same
  // 100-unit square, so a resized mark stays identical in print.
  const thickness = size * MARK_STROKE_RATIO;

  for (const stroke of GLYPH_STROKES[annotation.glyph] || GLYPH_STROKES.tick) {
    for (let i = 0; i < stroke.length - 1; i += 1) {
      drawDisplayLine(
        context,
        dx + stroke[i][0] * size,
        dy + stroke[i][1] * size,
        dx + stroke[i + 1][0] * size,
        dy + stroke[i + 1][1] * size,
        { thickness, color: paint }
      );
    }
  }
}

async function drawImage(annotation, context, getImage) {
  const embedded = await getImage(annotation.stampId);
  if (!embedded) return;

  const { page, displayWidth, displayHeight, rotation, degrees } = context;
  const dx = annotation.xRatio * displayWidth;
  const dy = annotation.yRatio * displayHeight;
  const dw = annotation.wRatio * displayWidth;
  const dh = annotation.hRatio * displayHeight;

  const anchor = toPdfSpace(dx, dy + dh, rotation, context.width, context.height);
  page.drawImage(embedded, {
    x: anchor.x,
    y: anchor.y,
    width: dw,
    height: dh,
    rotate: degrees(rotation),
  });
}

// ------------------------------------------------------------------- geometry

// drawRectangle and drawImage anchor at the bottom-left corner, which in display
// space is the box's bottom-left. Rotating about that anchor then sweeps the
// local axes back over exactly the intended region.
function drawDisplayRect(context, dx, dy, dw, dh, style) {
  const anchor = toPdfSpace(dx, dy + dh, context.rotation, context.width, context.height);
  context.page.drawRectangle({
    x: anchor.x,
    y: anchor.y,
    width: dw,
    height: dh,
    rotate: context.degrees(context.rotation),
    ...style,
  });
}

function drawDisplayLine(context, x1, y1, x2, y2, style) {
  const start = toPdfSpace(x1, y1, context.rotation, context.width, context.height);
  const end = toPdfSpace(x2, y2, context.rotation, context.width, context.height);
  context.page.drawLine({ start, end, ...style });
}

// Converts a point in what the user sees (origin top-left of the displayed page)
// into unrotated PDF user space (origin bottom-left), honouring /Rotate.
export function toPdfSpace(dx, dy, rotation, width, height) {
  switch (rotation) {
    case 90:
      return { x: dy, y: dx };
    case 180:
      return { x: width - dx, y: dy };
    case 270:
      return { x: width - dy, y: height - dx };
    default:
      return { x: dx, y: height - dy };
  }
}

export function normaliseAngle(angle) {
  const rounded = Math.round((angle || 0) / 90) * 90;
  return ((rounded % 360) + 360) % 360;
}

// The standard fonts are WinAnsi-encoded, and pdf-lib throws on anything it
// can't encode, so fold the common typographic characters down to Latin-1.
function sanitise(value) {
  return value
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/\t/g, '    ')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
}

function hexToRgb(hex) {
  const match = /^#?([\da-f]{6})$/i.exec(hex || '');
  if (!match) return { r: 0, g: 0, b: 0 };
  const value = parseInt(match[1], 16);
  return {
    r: ((value >> 16) & 255) / 255,
    g: ((value >> 8) & 255) / 255,
    b: (value & 255) / 255,
  };
}

function toTuple({ r, g, b }) {
  return [r, g, b];
}

// ------------------------------------------------------------------- delivery

export function toPdfBlobUrl(bytes) {
  return URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
}

export function downloadBytes(bytes, fileName) {
  const url = toPdfBlobUrl(bytes);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
