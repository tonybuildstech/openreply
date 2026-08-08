/**
 * Client-side image cropping, resizing and re-encoding.
 *
 * Browser-only (canvas). This is the ONE place in OpenReply that re-encodes a
 * user's file, and it does so only when the user explicitly asks — the
 * "Original" default uploads the bytes untouched, which is what keeps the
 * promise in `app/api/media/upload/route.ts` true for every file nobody chose
 * to change.
 *
 * It exists because Instagram **rejects** stills outside 4:5–1.91:1 rather than
 * cropping them, so for an out-of-range image this is the only route to
 * publishing at all. It also carries the answer to the 8 MB cap: Meta documents
 * a maximum width of 1440px "(will be scaled down to the maximum if
 * necessary)", so an oversized photo can be fitted by doing that downscale here
 * instead — the published pixels are identical either way.
 *
 * Cropping happens here rather than on the server on purpose: the web process
 * runs under a 400 MB RSS cap and server-side image decoding would put an
 * attacker-controlled decompression bomb inside it. The browser already has the
 * decoded pixels.
 */

import {
  CENTRED_FOCUS,
  INSTAGRAM_MAX_WIDTH_PX,
  computeCoverCrop,
  fitWithinWidth,
  type CropFocus,
} from "@/lib/media/aspect";

export interface PreparedImage {
  blob: Blob;
  widthPx: number;
  heightPx: number;
  /** The ratio label to record on the media row, e.g. "Vertical 4:5". */
  ratioLabel: string;
  /** True when the output had to be shrunk below the requested width. */
  downscaled: boolean;
}

/**
 * Encoder qualities to try, in order, when a byte budget is given.
 *
 * The first is the only one most images ever see. Instagram re-encodes
 * everything on its side anyway, so going above 0.92 buys nothing visible and
 * costs upload time; the rest of the ladder exists so a pathological source
 * degrades gracefully instead of failing.
 */
const QUALITY_LADDER = [0.92, 0.85, 0.78, 0.7, 0.6];

/** Browsers cap canvas dimensions. This applies to the OUTPUT, not the source. */
const MAX_CANVAS_DIMENSION = 8192;

async function toBitmap(file: File): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== "function") {
    throw new Error(
      "This browser cannot crop images. Upload a file that already fits the required aspect ratio."
    );
  }
  return createImageBitmap(file);
}

interface DrawRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * Draw the kept region of `bitmap` into a canvas of exactly `outWidth`×
 * `outHeight`, resampling in the same step.
 *
 * Cropping and resizing together is what removes the old 8192px source limit:
 * the canvas is the OUTPUT size, so a 6000px photo needs no 6000px canvas.
 */
function drawTo(
  bitmap: ImageBitmap,
  rect: DrawRect,
  outWidth: number,
  outHeight: number
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = outWidth;
  canvas.height = outHeight;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error(
      "This browser refused a 2D canvas, so cropping is unavailable."
    );
  }

  // Downscaling by a large factor in one step aliases badly without this.
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  // computeCoverCrop guarantees the source rect sits inside the bitmap, so this
  // never samples a transparent edge that would survive as a black line.
  context.drawImage(
    bitmap,
    rect.sx,
    rect.sy,
    rect.sw,
    rect.sh,
    0,
    0,
    outWidth,
    outHeight
  );

  return canvas;
}

function canvasToJpeg(
  canvas: HTMLCanvasElement,
  quality: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("The browser could not encode the cropped image.")),
      "image/jpeg",
      quality
    );
  });
}

/**
 * Encode at the highest quality that fits `maxBytes`.
 *
 * Returns the smallest attempt when nothing fits rather than throwing: the
 * composer already shows the resulting size and validates it against the
 * platform, and one size check that everything flows through beats a second
 * one hidden in here that disagrees with it.
 */
async function encodeWithinBudget(
  canvas: HTMLCanvasElement,
  maxBytes?: number
): Promise<Blob> {
  if (maxBytes === undefined) {
    return canvasToJpeg(canvas, QUALITY_LADDER[0]);
  }

  let smallest: Blob | null = null;

  for (const quality of QUALITY_LADDER) {
    const blob = await canvasToJpeg(canvas, quality);
    if (blob.size <= maxBytes) return blob;
    if (!smallest || blob.size < smallest.size) smallest = blob;
  }

  return smallest as Blob;
}

export interface PrepareImageOptions {
  /**
   * width ÷ height for the crop. Null means "keep the source framing" — used
   * by the compress-only path, where the point is bytes, not shape.
   */
  targetRatio: number | null;
  /** Where the crop window sits. Defaults to centred, as Instagram would. */
  focus?: CropFocus;
  /** Recorded on the media row so the post remembers what was applied. */
  ratioLabel: string;
  /** Widest output to produce. Instagram scales anything wider down itself. */
  maxWidthPx?: number;
  /** Drop encoder quality until the result fits. Omit for "best effort". */
  maxBytes?: number;
}

/**
 * Crop, resize and re-encode `file` as JPEG.
 *
 * Always JPEG, whatever came in: Meta's media reference lists JPEG as the image
 * format for publishing, so a cropped PNG would trade one rejection for
 * another. That also means this doubles as the PNG → JPEG conversion path.
 */
export async function prepareImage(
  file: File,
  options: PrepareImageOptions
): Promise<PreparedImage> {
  const {
    targetRatio,
    focus = CENTRED_FOCUS,
    ratioLabel,
    maxWidthPx = INSTAGRAM_MAX_WIDTH_PX,
    maxBytes,
  } = options;

  const bitmap = await toBitmap(file);

  try {
    // A null target keeps the source framing, so the whole bitmap is the rect.
    const rect: DrawRect =
      targetRatio === null
        ? { sx: 0, sy: 0, sw: bitmap.width, sh: bitmap.height }
        : computeCoverCrop(bitmap.width, bitmap.height, targetRatio, focus);

    const out = fitWithinWidth(
      rect.sw,
      rect.sh,
      Math.min(maxWidthPx, MAX_CANVAS_DIMENSION),
      // Rounding the resize must respect the ratio the CROP promised, not the
      // source's — otherwise a boundary crop can be rounded back out of range.
      targetRatio ?? undefined
    );

    const canvas = drawTo(bitmap, rect, out.width, out.height);
    const blob = await encodeWithinBudget(canvas, maxBytes);

    return {
      blob,
      widthPx: out.width,
      heightPx: out.height,
      ratioLabel,
      downscaled: out.width < rect.sw,
    };
  } finally {
    // Frees the decoded pixels immediately. A twenty-item carousel of 4000px
    // photos is well over a gigabyte of bitmap if these are left to GC.
    bitmap.close();
  }
}
