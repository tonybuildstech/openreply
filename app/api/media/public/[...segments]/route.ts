/**
 * Serves a stored media file to whoever holds a valid signed URL.
 *
 * This exists for one caller: Meta's video fetcher, which downloads the file
 * named by `video_url` when an Instagram Reels container is created. It cannot
 * send a session cookie or a bearer token, so the signature in the path is the
 * whole of the authentication — see `lib/storage/public-url.ts`.
 *
 * Range support is not decoration. Meta's fetcher probes with a `HEAD` and then
 * pulls large files in ranges; without `Accept-Ranges` and a correct 206 the
 * download stalls and the container lands in ERROR with no useful reason.
 */

import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { getMediaStorage, MediaStorageError } from "@/lib/storage";
import { verifySignedMediaToken } from "@/lib/storage/public-url";

// A signed URL is per-file and expiring; caching it anywhere shared would
// outlive the signature it was granted under.
export const dynamic = "force-dynamic";
// Streaming a file off local disk is Node-only.
export const runtime = "nodejs";

interface ResolvedMedia {
  key: string;
  size: number;
  contentType: string;
}

type Resolution =
  | { ok: true; media: ResolvedMedia }
  | { ok: false; response: NextResponse };

/**
 * Every failure answers 404 with no detail. A signed-URL endpoint that
 * distinguished "bad signature" from "expired" from "no such file" would be a
 * probing oracle, and there is no human on the other end to help.
 */
function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

async function resolveMedia(
  context: { params: Promise<{ segments: string[] }> }
): Promise<Resolution> {
  const { segments } = await context.params;
  const token = segments?.[0];
  if (!token) return { ok: false, response: notFound() };

  const verified = verifySignedMediaToken(token);
  if (!verified.ok) return { ok: false, response: notFound() };

  try {
    const { size, contentType } = await getMediaStorage().stat(verified.key);
    return { ok: true, media: { key: verified.key, size, contentType } };
  } catch (error) {
    if (error instanceof MediaStorageError) {
      return { ok: false, response: notFound() };
    }
    console.error("[Media Public] stat failed:", error);
    return {
      ok: false,
      response: NextResponse.json({ error: "Unavailable" }, { status: 500 }),
    };
  }
}

/**
 * `bytes=a-b`, `bytes=a-`, and `bytes=-n` per RFC 7233. Anything else — a
 * multi-range request included, which we do not serve — returns `unsatisfiable`
 * so the caller gets a 416 instead of silently wrong bytes.
 */
function parseRange(
  header: string | null,
  size: number
): { start: number; end: number } | null | "unsatisfiable" {
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

function baseHeaders(media: ResolvedMedia): Headers {
  return new Headers({
    "Content-Type": media.contentType,
    "Accept-Ranges": "bytes",
    "Content-Disposition": "inline",
    "Cache-Control": "private, no-store",
  });
}

function unsatisfiable(media: ResolvedMedia): NextResponse {
  return new NextResponse(null, {
    status: 416,
    headers: { "Content-Range": `bytes */${media.size}` },
  }) as NextResponse;
}

export async function HEAD(
  request: NextRequest,
  context: { params: Promise<{ segments: string[] }> }
): Promise<NextResponse> {
  const resolved = await resolveMedia(context);
  if (!resolved.ok) return resolved.response;

  const headers = baseHeaders(resolved.media);
  headers.set("Content-Length", String(resolved.media.size));

  return new NextResponse(null, { status: 200, headers }) as NextResponse;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ segments: string[] }> }
): Promise<NextResponse> {
  const resolved = await resolveMedia(context);
  if (!resolved.ok) return resolved.response;

  const { media } = resolved;
  const range = parseRange(request.headers.get("range"), media.size);
  if (range === "unsatisfiable") return unsatisfiable(media);

  const headers = baseHeaders(media);
  const length = range ? range.end - range.start + 1 : media.size;
  headers.set("Content-Length", String(length));
  if (range) {
    headers.set(
      "Content-Range",
      `bytes ${range.start}-${range.end}/${media.size}`
    );
  }

  // Piped straight from disk. The web process runs under a 400 MB RSS cap and
  // these files can be far larger than that, so nothing here may buffer.
  const stream = getMediaStorage().createReadStream(
    media.key,
    range ?? undefined
  );

  return new NextResponse(
    Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
    { status: range ? 206 : 200, headers }
  ) as NextResponse;
}
