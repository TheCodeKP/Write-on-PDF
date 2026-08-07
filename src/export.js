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
  patrick: '"Patrick Hand", cursive',
  indie: '"Indie Flower", cursive',
  handlee: 'Handlee, cursive',
};

const PDF_FONTS = {
  // Indexed by (bold ? 1 : 0) + (italic ? 2 : 0)
  helvetica: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
  times: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
  courier: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
};

// Families that are not one of the fourteen every PDF reader already has, so
// the file itself has to carry them. Paths are relative to the extension root.
//
// These hands are single-weight static TTFs that subset and paint cleanly in
// Chrome's PDF viewer. Caveat did not (blank when subset, gappy when full), so
// notes that still say "caveat" are remapped to Handlee.
export const CUSTOM_FONTS = {
  handlee: {
    regular: 'vendor/fonts/Handlee-Regular.ttf',
    bold: 'vendor/fonts/Handlee-Regular.ttf',
    italic: false,
    hasBold: false,
  },
  indie: {
    regular: 'vendor/fonts/IndieFlower-Regular.ttf',
    bold: 'vendor/fonts/IndieFlower-Regular.ttf',
    italic: false,
    hasBold: false,
  },
  patrick: {
    regular: 'vendor/fonts/PatrickHand-Regular.ttf',
    bold: 'vendor/fonts/PatrickHand-Regular.ttf',
    italic: false,
    hasBold: false,
  },
};

// Old sessions stored Caveat under its own id.
export function resolveFontFamily(family) {
  if (family === 'caveat') return 'handlee';
  return family || 'helvetica';
}

export function supportsItalic(family) {
  const resolved = resolveFontFamily(family);
  return CUSTOM_FONTS[resolved]?.italic !== false;
}

export function supportsBold(family) {
  const resolved = resolveFontFamily(family);
  const custom = CUSTOM_FONTS[resolved];
  if (!custom) return true;
  return custom.hasBold !== false;
}

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
  const { baselineRatios = {}, stamps = new Map(), loadAsset = null, getFontkit = null } = options;
  const { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle } = globalThis.PDFLib;

  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = doc.getPages();

  const fontCache = new Map();
  let fontkitReady = false;

  // Custom faces have to ride inside the file. These hands subset cleanly and
  // paint in Chrome's viewer; Caveat did not, which is why it was replaced.
  const embedCustom = async (family, bold) => {
    const resolved = resolveFontFamily(family);
    const paths = CUSTOM_FONTS[resolved];
    if (!paths || !loadAsset || !getFontkit) return null;

    try {
      if (!fontkitReady) {
        doc.registerFontkit(await getFontkit());
        fontkitReady = true;
      }
      const bytes = await loadAsset(bold && paths.hasBold !== false ? paths.bold : paths.regular);
      return await doc.embedFont(bytes, { subset: true });
    } catch {
      // Losing the handwriting is a disappointment. Losing the notes because
      // one file failed to load would be a bug.
      return null;
    }
  };

  const getFont = async (family, bold, italic) => {
    const resolved = resolveFontFamily(family);
    const custom = CUSTOM_FONTS[resolved];
    const useBold = bold && supportsBold(resolved);
    const key = custom ? `${resolved}${useBold ? '-bold' : ''}` : null;
    if (key) {
      if (!fontCache.has(key)) {
        const embedded = await embedCustom(resolved, useBold);
        if (embedded) fontCache.set(key, embedded);
      }
      if (fontCache.has(key)) return fontCache.get(key);
    }

    const name = (PDF_FONTS[resolved] || PDF_FONTS.helvetica)[(useBold ? 1 : 0) + (italic ? 2 : 0)];
    if (!fontCache.has(name)) fontCache.set(name, await doc.embedFont(StandardFonts[name]));
    return fontCache.get(name);
  };

  const imageCache = new Map();
  // Prefer bytes stored on the annotation (one-shot Add image) so export still
  // works when the stamp was never kept in the strip.
  const getImage = async (annotation) => {
    const dataUrl = annotation.dataUrl || stamps.get(annotation.stampId)?.dataUrl;
    if (!dataUrl) return null;
    const cacheKey = annotation.stampId || dataUrl.slice(0, 48);
    if (imageCache.has(cacheKey)) return imageCache.get(cacheKey);
    const embedded = /^data:image\/png/i.test(dataUrl)
      ? await doc.embedPng(dataUrl)
      : await doc.embedJpg(dataUrl);
    imageCache.set(cacheKey, embedded);
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
      roundCap: LineCapStyle?.Round,
    };

    switch (annotation.kind || 'text') {
      case 'box':
        drawBox(annotation, context);
        break;
      case 'line':
        drawLine(annotation, context);
        break;
      case 'ink':
        drawInk(annotation, context);
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
  const family = resolveFontFamily(annotation.font);
  const font = await getFont(family, annotation.bold, annotation.italic && supportsItalic(family));
  const baseline = baselineRatios[family] ?? FALLBACK_BASELINE_RATIO;
  const colour = hexToRgb(annotation.color);

  const paragraphs = raw.split('\n').map(sanitise);
  const lines = annotation.wrap
    ? paragraphs.flatMap((paragraph) => wrapLine(paragraph, font, size, annotation.wRatio * displayWidth))
    : paragraphs;

  lines.forEach((line, index) => {
    if (!line) return;

    const boxLeft = annotation.xRatio * displayWidth;
    const boxWidth = (annotation.wRatio || 0) * displayWidth;
    const runWidth = font.widthOfTextAtSize(line, size);
    const align = annotation.wrap ? annotation.align || 'left' : 'left';
    let displayX = boxLeft;
    if (align === 'center' && boxWidth > 0) displayX = boxLeft + (boxWidth - runWidth) / 2;
    else if (align === 'right' && boxWidth > 0) displayX = boxLeft + boxWidth - runWidth;

    const lineTop = annotation.yRatio * displayHeight + index * LINE_STEP * size;
    const displayY = lineTop + baseline * size;

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

// Where the browser breaks a line and where pdf-lib does are two different
// measurements of the same font, so the export wraps with the metrics it is
// about to draw with. That guarantees no line overhangs the box, which is the
// thing that would actually look broken. Helvetica, Times and Courier all share
// their advance widths with the screen faces, so the breaks land in the same
// places for anything short of an unusual glyph.
function wrapLine(text, font, size, maxWidth) {
  if (!text) return [''];

  const measure = (value) => font.widthOfTextAtSize(value, size);
  if (maxWidth <= 0 || measure(text) <= maxWidth) return [text];

  const lines = [];
  let line = '';

  for (const word of text.split(/(\s+)/)) {
    if (!word) continue;

    const candidate = line + word;
    if (measure(candidate) <= maxWidth || !line.trim()) {
      // A single word longer than the box has to be cut somewhere.
      if (measure(candidate) > maxWidth && !line.trim() && !/\s/.test(word)) {
        let chunk = '';
        for (const character of word) {
          if (chunk && measure(chunk + character) > maxWidth) {
            lines.push(chunk);
            chunk = '';
          }
          chunk += character;
        }
        line = chunk;
        continue;
      }
      line = candidate;
      continue;
    }

    lines.push(line.replace(/\s+$/, ''));
    line = /\s/.test(word) ? '' : word;
  }

  if (line.trim()) lines.push(line.replace(/\s+$/, ''));
  return lines.length ? lines : [''];
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

  const band = annotation.shape === 'band';
  const filled = band || annotation.shape === 'highlight';
  drawDisplayRect(context, dx, dy, dw, dh, {
    color: paint,
    opacity: band ? 1 : filled ? (annotation.opacity ?? 0.35) : 0,
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

// The on-screen stroke is a curve through the sampled points, but at the
// spacing they are sampled at the difference from straight segments is under a
// tenth of a point, and segments avoid having to map bezier control points
// through the rotation. Round caps and dense points hide every joint.
function drawInk(annotation, context) {
  const points = annotation.points || [];
  if (points.length < 2) return;

  const { displayWidth, displayHeight, rgb, roundCap } = context;
  const colour = hexToRgb(annotation.color);
  const style = {
    thickness: annotation.strokeWidth ?? 1.5,
    color: rgb(colour.r, colour.g, colour.b),
    lineCap: roundCap,
  };

  const dx = annotation.xRatio * displayWidth;
  const dy = annotation.yRatio * displayHeight;
  const dw = annotation.wRatio * displayWidth;
  const dh = annotation.hRatio * displayHeight;
  const at = (point) => [dx + (point[0] / 100) * dw, dy + (point[1] / 100) * dh];

  for (let i = 0; i < points.length - 1; i += 1) {
    const [x1, y1] = at(points[i]);
    const [x2, y2] = at(points[i + 1]);
    drawDisplayLine(context, x1, y1, x2, y2, style);
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
  const embedded = await getImage(annotation);
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
