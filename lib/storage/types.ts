/**
 * Media storage seam.
 *
 * The scheduler stores the user's ORIGINAL video file and hands its bytes to
 * each platform's upload API. Today that file lives on the VPS's local disk;
 * this interface exists so an S3/R2 driver can replace it later without any
 * adapter changing.
 *
 * The `range` option on `createReadStream` is the important part: TikTok and
 * YouTube upload in chunks, and the worker runs under a 250 MB RSS cap
 * (`deploy/ecosystem.config.js`). Chunks are read from disk a slice at a time
 * and piped straight out. Nothing in this pipeline may load a whole video into
 * memory.
 */

import type { Readable } from "node:stream";

export interface MediaObjectMeta {
  size: number;
  contentType: string;
}

export interface MediaByteRange {
  /** First byte, inclusive. */
  start: number;
  /** Last byte, inclusive — matching HTTP Range and Node's createReadStream. */
  end: number;
}

export interface MediaStorageDriver {
  put(
    key: string,
    body: Readable,
    meta: { contentType: string }
  ): Promise<MediaObjectMeta>;

  createReadStream(key: string, range?: MediaByteRange): Readable;

  stat(key: string): Promise<MediaObjectMeta>;

  delete(key: string): Promise<void>;
}

export class MediaStorageError extends Error {
  constructor(
    message: string,
    readonly code:
      | "NOT_FOUND"
      | "INVALID_KEY"
      | "TOO_LARGE"
      | "IO_ERROR"
  ) {
    super(message);
    this.name = "MediaStorageError";
  }
}
