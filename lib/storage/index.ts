/**
 * Media storage entry point. Everything else imports `getMediaStorage()` — the
 * driver choice lives here alone, so adding an S3 driver is a change to this
 * file and nothing else.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { localMediaStorage } from "@/lib/storage/local-driver";
import type { MediaStorageDriver } from "@/lib/storage/types";

export * from "@/lib/storage/types";

export function getMediaStorage(): MediaStorageDriver {
  return localMediaStorage;
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "image/jpeg": ".jpg",
  "image/png": ".png",
};

/**
 * What the upload endpoint will store. Deliberately WIDER than what any one
 * platform accepts — storage is platform-agnostic, and per-platform rules live
 * in `lib/scheduler/constraints.ts` where they can produce a useful message.
 *
 * PNG is stored but currently rejected for Instagram: Meta publishes no list of
 * accepted image formats, so JPEG is the only one we can defend (see
 * `imageMimeTypes` there). Storing it anyway means the cropper in step 6 can
 * convert a PNG to JPEG client-side without a second upload round-trip.
 */
export const SUPPORTED_UPLOAD_MIME_TYPES = Object.keys(EXTENSION_BY_MIME);

/**
 * Whether a stored object is a still or a video.
 *
 * Always derived from the content type the storage layer recorded — never from
 * anything the client sent. A client that could declare its own `kind` could
 * claim a video is an image and route it down Instagram's `image_url` path,
 * where the failure surfaces as an opaque container ERROR ten minutes later.
 */
export function mediaKindFor(mimeType: string): "IMAGE" | "VIDEO" {
  return mimeType.toLowerCase().startsWith("image/") ? "IMAGE" : "VIDEO";
}

/**
 * Keys are `{workspaceId}/{yyyy}/{mm}/{uuid}{ext}` — sharded by month so a
 * single directory never accumulates unbounded entries, and prefixed by
 * workspace so a whole workspace's media can be removed with one recursive
 * delete when it is deleted.
 */
export function buildMediaKey(
  workspaceId: string,
  contentType: string,
  originalFilename?: string
): string {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");

  const ext =
    EXTENSION_BY_MIME[contentType] ??
    (originalFilename ? path.extname(originalFilename).toLowerCase() : "") ??
    "";

  return `${workspaceId}/${year}/${month}/${randomUUID()}${ext}`;
}
