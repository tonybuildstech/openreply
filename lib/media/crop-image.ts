/**
 * Client-side image cropping.
 *
 * Browser-only (canvas). This is the ONE place in OpenReply that re-encodes a
 * user's file, and it does so only when the user explicitly picks a ratio — the
 * "Original" default uploads the bytes untouched, which is what keeps the
 * promise in `app/api/media/upload/route.ts` true for every file nobody chose
 * to crop.
 *
 * It exists because Instagram **rejects** stills outside 4:5–1.91:1 rather than
 * cropping them, so for an out-of-range image this is the only route to
 * publishing at all.
 *
 * Cropping happens here rather than on the server on purpose: the web process
 * runs under a 400 MB RSS cap and server-side image decoding would put an
 * attacker-controlled decompression bomb inside it. The browser already has the
 * decoded pixels.
 */

import { computeCoverCrop } from "@/lib/media/aspect";

export interface CroppedImage {
  blob: Blob;
  widthPx: number;
  heightPx: number;
  /** The ratio label to record on the media row, e.g. "4:5". */
  ratioLabel: string;
}

/**
 * JPEG quality. Instagram re-encodes everything on its side anyway, so higher
 * values buy nothing visible and cost upload time; lower ones show on flat
 * colour and gradients.
 */
const DEFAULT_QUALITY = 0.92;

/** Canvas has no useful error for "too big"; browsers cap dimensions instead. */
const MAX_CANVAS_DIMENSION = 8192;

async function toBitmap(file: File): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== "function") {
    throw new Error("This browser cannot crop images. Upload a file that already fits the required aspect ratio.");
  }
  return createImageBitmap(file);
}

function drawCrop(
  bitmap: ImageBitmap,
  rect: { sx: number; sy: number; sw: number; sh: number }
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = rect.sw;
  canvas.height = rect.sh;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("This browser refused a 2D canvas, so cropping is unavailable.");
  }

  // Source rect → whole canvas. computeCoverCrop guarantees the rect sits
  // inside the bitmap, so this never samples a transparent edge.
  context.drawImage(
    bitmap,
    rect.sx,
    rect.sy,
    rect.sw,
    rect.sh,
    0,
    0,
    rect.sw,
    rect.sh
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
 * Centre-crop `file` to `targetRatio` and re-encode it as JPEG.
 *
 * Always JPEG, whatever came in: it is the only image format Instagram is
 * confirmed to accept, so a cropped PNG would trade one rejection for another.
 * That also means this doubles as the PNG → JPEG conversion path.
 */
export async function cropImageToRatio(
  file: File,
  targetRatio: number,
  ratioLabel: string,
  quality: number = DEFAULT_QUALITY
): Promise<CroppedImage> {
  const bitmap = await toBitmap(file);

  try {
    if (
      bitmap.width > MAX_CANVAS_DIMENSION ||
      bitmap.height > MAX_CANVAS_DIMENSION
    ) {
      throw new Error(
        `This image is ${bitmap.width}×${bitmap.height}, too large for the browser to crop. Resize it below ${MAX_CANVAS_DIMENSION}px first.`
      );
    }

    const rect = computeCoverCrop(bitmap.width, bitmap.height, targetRatio);
    const canvas = drawCrop(bitmap, rect);
    const blob = await canvasToJpeg(canvas, quality);

    return {
      blob,
      widthPx: rect.sw,
      heightPx: rect.sh,
      ratioLabel,
    };
  } finally {
    // Frees the decoded pixels immediately. A ten-item carousel of 4000px
    // photos is well over a gigabyte of bitmap if these are left to GC.
    bitmap.close();
  }
}
