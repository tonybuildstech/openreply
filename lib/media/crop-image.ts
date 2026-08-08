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

/**
 * Widths to try, largest first, when an image will not fit its byte budget.
 *
 * **Resolution is only given up when it has to be**, and this ordering is the
 * reason. Cropping used to downscale to 1440 unconditionally, on the argument
 * that Instagram caps width there anyway — which is true, and still produced a
 * worse picture: our resample plus Instagram's re-encode is two lossy passes
 * where sending the full-size crop is one. It also turned a 6 MB photo into a
 * 700 KB one with no warning, which reads as damage whether or not it is.
 *
 * So the first candidate is always the crop's own width — no resampling at all
 * — and these are only reached when the encoder cannot hit the budget.
 */
const FALLBACK_WIDTHS = [INSTAGRAM_MAX_WIDTH_PX, 1080];

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
  /** Hard ceiling on output width. Only reached if the browser cannot go wider. */
  maxWidthPx?: number;
  /**
   * Shrink the result until it fits this many bytes. Omit to keep full size
   * and full quality whatever that costs.
   */
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
    maxWidthPx = MAX_CANVAS_DIMENSION,
    maxBytes,
  } = options;

  const bitmap = await toBitmap(file);

  try {
    // A null target keeps the source framing, so the whole bitmap is the rect.
    const rect: DrawRect =
      targetRatio === null
        ? { sx: 0, sy: 0, sw: bitmap.width, sh: bitmap.height }
        : computeCoverCrop(bitmap.width, bitmap.height, targetRatio, focus);

    const nativeWidth = Math.min(rect.sw, maxWidthPx, MAX_CANVAS_DIMENSION);

    // Full size first, then progressively smaller, and only then lower quality.
    // Losing pixels is more honest than losing detail everywhere: a 1440px
    // image at 0.92 beats a 4000px one at 0.6, and Instagram would have taken
    // it down to 1440 anyway.
    const widths = [nativeWidth, ...FALLBACK_WIDTHS].filter(
      (width, index, all) => width <= nativeWidth && all.indexOf(width) === index
    );

    let smallest: { blob: Blob; width: number; height: number } | null = null;

    for (const [index, width] of widths.entries()) {
      const out = fitWithinWidth(
        rect.sw,
        rect.sh,
        width,
        // Rounding the resize must respect the ratio the CROP promised, not
        // the source's — otherwise a boundary crop rounds back out of range.
        targetRatio ?? undefined
      );

      const canvas = drawTo(bitmap, rect, out.width, out.height);

      // Only the last width is allowed to trade quality away; above it, the
      // next size down is the better answer.
      const qualities =
        index === widths.length - 1 ? QUALITY_LADDER : [QUALITY_LADDER[0]];

      for (const quality of qualities) {
        const blob = await canvasToJpeg(canvas, quality);

        if (maxBytes === undefined || blob.size <= maxBytes) {
          return {
            blob,
            widthPx: out.width,
            heightPx: out.height,
            ratioLabel,
            downscaled: out.width < rect.sw,
          };
        }

        if (!smallest || blob.size < smallest.blob.size) {
          smallest = { blob, width: out.width, height: out.height };
        }
      }
    }

    // Nothing fit. Hand back the smallest attempt rather than throwing: the
    // composer already shows the size and validates it against the platform,
    // and one size check everything flows through beats a second one hidden
    // in here that disagrees with it.
    const fallback = smallest as { blob: Blob; width: number; height: number };
    return {
      blob: fallback.blob,
      widthPx: fallback.width,
      heightPx: fallback.height,
      ratioLabel,
      downscaled: fallback.width < rect.sw,
    };
  } finally {
    // Frees the decoded pixels immediately. A ten-item carousel of 4000px
    // photos is well over a gigabyte of bitmap if these are left to GC.
    bitmap.close();
  }
}
