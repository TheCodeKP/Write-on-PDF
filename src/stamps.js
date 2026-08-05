// Saved signatures and stamps.
//
// Kept in chrome.storage.local as PNG data URLs: they need to outlive the tab,
// they get embedded into exported PDFs, and PNG keeps the transparency that
// makes a signature sit on the page instead of in a white box.
//
// Building one is split from saving it so the dialog can show a live preview,
// which is the only honest way to offer background removal: whether it worked
// depends entirely on the photo.

const KEY = 'stamps';
const MAX_DIMENSION = 1000; // plenty for print, small enough to store comfortably
const WORKING_DIMENSION = 1500; // headroom over MAX_DIMENSION so cropping loses nothing
const WHITE_CUTOFF = 238; // above this a pixel counts as background
const WHITE_SOFT = 200; // below this it is fully opaque; between the two it ramps
const TRIM_ALPHA = 8; // anything fainter is treated as empty when cropping

export async function listStamps() {
  const { [KEY]: stamps } = await chrome.storage.local.get(KEY);
  return Array.isArray(stamps) ? stamps : [];
}

export async function saveStamp({ name, dataUrl, aspect }) {
  const stamp = {
    id: crypto.randomUUID(),
    name: name?.trim() || 'Signature',
    dataUrl,
    aspect,
    added: Date.now(),
  };

  const stamps = await listStamps();
  stamps.push(stamp);
  await chrome.storage.local.set({ [KEY]: stamps });
  return stamp;
}

export async function deleteStamp(id) {
  const stamps = await listStamps();
  await chrome.storage.local.set({ [KEY]: stamps.filter((stamp) => stamp.id !== id) });
}

// Phone photos arrive at a dozen megapixels, which would make every flick of
// the background switch stutter. Everything downstream works at a size the
// final PNG can actually use.
export async function bitmapFromFile(file) {
  const bitmap = await createImageBitmap(file);
  const longest = Math.max(bitmap.width, bitmap.height);
  if (longest <= WORKING_DIMENSION) return bitmap;

  const scale = WORKING_DIMENSION / longest;
  const resized = await createImageBitmap(bitmap, {
    resizeWidth: Math.round(bitmap.width * scale),
    resizeHeight: Math.round(bitmap.height * scale),
    resizeQuality: 'high',
  });
  bitmap.close?.();
  return resized;
}

// Re-run on every toggle of the background switch, so it has to feel instant.
export function buildFromBitmap(bitmap, { dropBackground = true } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);

  if (dropBackground) keyOutBackground(context, canvas.width, canvas.height);
  return trimAndExport(canvas);
}

// A signature drawn in the dialog already has clean transparency, so it only
// needs the same crop and downscale as an imported one.
export function buildFromInk(canvas) {
  return trimAndExport(canvas);
}

// Photographed and scanned signatures arrive on paper, so the page shows through
// as a solid white block. Fading out by luminance rather than hard-thresholding
// keeps the anti-aliased edges of the pen strokes from turning jagged.
function keyOutBackground(context, width, height) {
  const image = context.getImageData(0, 0, width, height);
  const data = image.data;

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

    if (luminance >= WHITE_CUTOFF) {
      data[i + 3] = 0;
    } else if (luminance > WHITE_SOFT) {
      const fade = (WHITE_CUTOFF - luminance) / (WHITE_CUTOFF - WHITE_SOFT);
      data[i + 3] = Math.round(data[i + 3] * fade);
    }
  }

  context.putImageData(image, 0, 0);
}

// Cropping to the ink matters more than it sounds. A phone photo is mostly
// margin, and without this you drop a signature on the page and the writing
// lands as a small smudge somewhere inside a much larger invisible box. On a
// fully opaque image the bounds come back as the whole canvas, so this is safe
// to run whether or not the background was removed.
function trimAndExport(canvas) {
  const box = inkBounds(canvas);
  if (!box) return null;

  const cropWidth = box.right - box.left + 1;
  const cropHeight = box.bottom - box.top + 1;
  const scale = Math.min(1, MAX_DIMENSION / Math.max(cropWidth, cropHeight));

  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(cropWidth * scale));
  out.height = Math.max(1, Math.round(cropHeight * scale));
  out
    .getContext('2d')
    .drawImage(canvas, box.left, box.top, cropWidth, cropHeight, 0, 0, out.width, out.height);

  return {
    dataUrl: out.toDataURL('image/png'),
    aspect: out.height / out.width,
    width: out.width,
    height: out.height,
  };
}

function inkBounds(canvas) {
  const { width, height } = canvas;
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height);

  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] <= TRIM_ALPHA) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }

  if (right < 0) return null; // nothing but transparency
  return { left, top, right, bottom };
}
