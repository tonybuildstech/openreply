/**
 * Serves a stored media file to whoever holds a valid signed URL.
 *
 * This exists for one caller: Meta's fetcher, which downloads the file named by
 * `video_url` / `image_url` when an Instagram container is created. It cannot
 * send a session cookie or a bearer token, so the signature in the path is the
 * whole of the authentication — see `lib/storage/public-url.ts`.
 *
 * Range support is not decoration. Meta's fetcher probes with a `HEAD` and then
 * pulls large files in ranges; without `Accept-Ranges` and a correct 206 the
 * download stalls and the container lands in ERROR with no useful reason. That
 * handling now lives in `lib/storage/serve.ts`, shared with the session-gated
 * preview route so there is only one implementation of it to get right.
 */

import { NextRequest, NextResponse } from "next/server";
import { MediaStorageError, getMediaStorage } from "@/lib/storage";
import { verifySignedMediaToken } from "@/lib/storage/public-url";
import {
  mediaGetResponse,
  mediaHeadResponse,
  type ServableMedia,
} from "@/lib/storage/serve";

// A signed URL is per-file and expiring; caching it anywhere shared would
// outlive the signature it was granted under.
export const dynamic = "force-dynamic";
// Streaming a file off local disk is Node-only.
export const runtime = "nodejs";

const CACHE_CONTROL = "private, no-store";

type Resolution =
  | { ok: true; media: ServableMedia }
  | { ok: false; response: NextResponse };

/**
 * Every failure answers 404 with no detail. A signed-URL endpoint that
 * distinguished "bad signature" from "expired" from "no such file" would be a
 * probing oracle, and there is no human on the other end to help.
 */
function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

async function resolveMedia(context: {
  params: Promise<{ segments: string[] }>;
}): Promise<Resolution> {
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

export async function HEAD(
  _request: NextRequest,
  context: { params: Promise<{ segments: string[] }> }
): Promise<NextResponse> {
  const resolved = await resolveMedia(context);
  if (!resolved.ok) return resolved.response;

  return mediaHeadResponse(resolved.media, CACHE_CONTROL);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ segments: string[] }> }
): Promise<NextResponse> {
  const resolved = await resolveMedia(context);
  if (!resolved.ok) return resolved.response;

  return mediaGetResponse(
    resolved.media,
    request.headers.get("range"),
    CACHE_CONTROL
  );
}
