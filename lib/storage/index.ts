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
};

/** Every platform accepts MP4; MOV and WebM are TikTok-only. */
export const SUPPORTED_UPLOAD_MIME_TYPES = Object.keys(EXTENSION_BY_MIME);

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
