/**
 * Serving stored media over HTTP, shared by the two routes that do it.
 *
 * There are two, and they authenticate completely differently:
 *
 *  - `app/api/media/public/[...]` — a signed URL is the whole credential,
 *    because Meta's fetcher cannot send a cookie or a bearer token.
 *  - `app/api/media/preview/[...]` — a session cookie, for showing a user their
 *    own already-uploaded media in the dashboard.
 *
 * What they share is everything after the authorisation decision, and range
 * support is the part worth not duplicating. Meta's fetcher probes with `HEAD`
 * and pulls large files in ranges; without `Accept-Ranges` and a correct 206 the
 * download stalls and the container lands in ERROR with no useful reason. A
 * `<video>` element scrubbing a preview needs exactly the same thing, so a
 * second hand-rolled copy would be a second chance to get 206 subtly wrong.
 */

import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { getMediaStorage } from "@/lib/storage";

export interface ServableMedia {
  key: string;
  size: number;
  contentType: string;
}

export type ParsedRange =
  | { start: number; end: number }
  | null
  | "unsatisfiable";

/**
 * `bytes=a-b`, `bytes=a-`, and `bytes=-n` per RFC 7233. Anything else — a
 * multi-range request included, which we do not serve — returns `unsatisfiable`
 * so the caller gets a 416 instead of silently wrong bytes.
 */
export function parseRange(header: string | null, size: number): ParsedRange {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "unsatisfiable";

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return "unsatisfiable";

  let start: number;
  let end: number;

  if (rawStart === "") {
    // Suffix range: the last N bytes.
    const suffix = Number(rawEnd);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }

  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

function baseHeaders(media: ServableMedia, cacheControl: string): Headers {
  return new Headers({
    "Content-Type": media.contentType,
    "Accept-Ranges": "bytes",
    "Content-Disposition": "inline",
    "Cache-Control": cacheControl,
  });
}

export function unsatisfiableResponse(media: ServableMedia): NextResponse {
  return new NextResponse(null, {
    status: 416,
    headers: { "Content-Range": `bytes */${media.size}` },
  }) as NextResponse;
}

export function mediaHeadResponse(
  media: ServableMedia,
  cacheControl: string
): NextResponse {
  const headers = baseHeaders(media, cacheControl);
  headers.set("Content-Length", String(media.size));

  return new NextResponse(null, { status: 200, headers }) as NextResponse;
}

/**
 * Stream the file, honouring a range request.
 *
 * Piped straight from disk. The web process runs under a 400 MB RSS cap and
 * these files can be far larger than that, so nothing here may buffer.
 */
export function mediaGetResponse(
  media: ServableMedia,
  rangeHeader: string | null,
  cacheControl: string
): NextResponse {
  const range = parseRange(rangeHeader, media.size);
  if (range === "unsatisfiable") return unsatisfiableResponse(media);

  const headers = baseHeaders(media, cacheControl);
  const length = range ? range.end - range.start + 1 : media.size;
  headers.set("Content-Length", String(length));
  if (range) {
    headers.set(
      "Content-Range",
      `bytes ${range.start}-${range.end}/${media.size}`
    );
  }

  const stream = getMediaStorage().createReadStream(
    media.key,
    range ?? undefined
  );

  return new NextResponse(
    Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
    { status: range ? 206 : 200, headers }
  ) as NextResponse;
}
