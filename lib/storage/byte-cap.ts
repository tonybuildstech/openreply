/**
 * Enforce an upload size cap without consuming the stream.
 *
 * This exists because of a real corruption bug. The obvious way to count bytes
 * is a `data` listener on the request body:
 *
 *     source.on("data", (chunk) => { seen += chunk.length; });
 *     await storage.put(key, source, meta);   // put() awaits mkdir, then pipes
 *
 * Attaching `data` switches the stream into flowing mode immediately, but
 * `put()` awaits an mkdir before it starts piping. Every byte that arrived in
 * that gap was counted and then discarded — there was no destination yet. The
 * file landed on disk missing its head, which for an MP4 means no `ftyp`/`moov`
 * boxes. Nothing failed loudly: the truncated file had a consistent size, so
 * the chunked upload to YouTube/TikTok completed and the platform only rejected
 * it later, during its own transcode, as an unprocessable video.
 *
 * Counting inside a Transform keeps every byte in the pipeline. Bytes that
 * arrive early sit in the Transform's buffer and apply backpressure instead of
 * being dropped.
 */

import { Readable, Transform, pipeline } from "node:stream";

/** Thrown through the returned stream when the cap is crossed. */
export const UPLOAD_TOO_LARGE = "UPLOAD_TOO_LARGE";

/**
 * Wrap `source` in a pass-through that fails once more than `maxBytes` have
 * flowed. The returned stream is what should be handed to storage — never the
 * original source, which is now piped and must not be read from twice.
 */
export function capUploadBytes(source: Readable, maxBytes: number): Readable {
  let bytesSeen = 0;

  const capped = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesSeen += chunk.length;
      if (bytesSeen > maxBytes) {
        callback(new Error(UPLOAD_TOO_LARGE));
        return;
      }
      callback(null, chunk);
    },
  });

  // `pipeline` rather than `pipe`: it propagates errors in both directions and
  // destroys the other stream. A client that disconnects mid-upload surfaces on
  // `capped` (so the consumer's await rejects instead of hanging), and a body
  // that busts the cap tears down the source instead of leaving it producing
  // into a dead pipe. The callback is required — its absence is what turns
  // either case into an unhandled 'error' event.
  pipeline(source, capped, () => {
    // Both outcomes are already observable on `capped`; nothing to do here.
  });

  return capped;
}
