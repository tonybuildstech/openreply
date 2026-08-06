/**
 * Local-disk media storage driver.
 *
 * Files live under MEDIA_STORAGE_DIR, which must sit OUTSIDE the deploy
 * directory — `.github/workflows/deploy.yml` rsyncs with `--delete`.
 *
 * Web and worker share one VPS box today, so both processes read the same path.
 * If they are ever split across hosts, this is the file to replace (with an S3
 * driver), not the adapters.
 */

import { createReadStream as fsCreateReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat as fsStat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { getMediaStorageDir } from "@/lib/env";
import {
  MediaStorageError,
  type MediaByteRange,
  type MediaObjectMeta,
  type MediaStorageDriver,
} from "@/lib/storage/types";

// Sidecar holding the content type, so `stat` can answer without a database
// round-trip and the driver stays self-contained.
const META_SUFFIX = ".meta.json";

function storageRoot(): string {
  return path.resolve(getMediaStorageDir());
}

/**
 * Resolve a key to an absolute path and prove it stayed inside the root.
 * Keys reach us from the database, but a traversal here would read or delete
 * arbitrary files, so it is checked on every single operation rather than once
 * at creation.
 */
function resolveKey(key: string): string {
  if (!key || key.includes("\0")) {
    throw new MediaStorageError("Empty or invalid media key", "INVALID_KEY");
  }

  const root = storageRoot();
  const resolved = path.resolve(root, key);

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new MediaStorageError(
      "Media key escapes the storage root",
      "INVALID_KEY"
    );
  }

  return resolved;
}

async function readMeta(filePath: string): Promise<{ contentType: string }> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(filePath + META_SUFFIX, "utf8");
    const parsed = JSON.parse(raw) as { contentType?: string };
    return { contentType: parsed.contentType ?? "application/octet-stream" };
  } catch {
    return { contentType: "application/octet-stream" };
  }
}

export const localMediaStorage: MediaStorageDriver = {
  async put(key, body, meta): Promise<MediaObjectMeta> {
    const filePath = resolveKey(key);
    await mkdir(path.dirname(filePath), { recursive: true });

    // Streamed, never buffered — these are multi-hundred-megabyte videos and
    // the web process is capped at 400 MB RSS.
    await pipeline(body, createWriteStream(filePath));

    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      filePath + META_SUFFIX,
      JSON.stringify({ contentType: meta.contentType }),
      "utf8"
    );

    const stats = await fsStat(filePath);
    return { size: stats.size, contentType: meta.contentType };
  },

  createReadStream(key, range?: MediaByteRange): Readable {
    const filePath = resolveKey(key);
    return range
      ? fsCreateReadStream(filePath, { start: range.start, end: range.end })
      : fsCreateReadStream(filePath);
  },

  async stat(key): Promise<MediaObjectMeta> {
    const filePath = resolveKey(key);
    try {
      const [stats, meta] = await Promise.all([
        fsStat(filePath),
        readMeta(filePath),
      ]);
      return { size: stats.size, contentType: meta.contentType };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new MediaStorageError(`Media not found: ${key}`, "NOT_FOUND");
      }
      throw error;
    }
  },

  async delete(key): Promise<void> {
    const filePath = resolveKey(key);
    await rm(filePath, { force: true });
    await rm(filePath + META_SUFFIX, { force: true });
  },
};
