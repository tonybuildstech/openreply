/**
 * Serves a workspace's own uploaded media back to the dashboard.
 *
 * Separate from `app/api/media/public/[...]` on purpose, even though both
 * stream the same files. That route exists for Meta's fetcher: its signed URL
 * is the whole credential, and `buildSignedMediaUrl` deliberately THROWS on a
 * localhost base URL — so reusing it for previews would break them in exactly
 * the environment the app is developed in.
 *
 * Here the session cookie is the credential, and the authorisation check is a
 * single line: the storage key must sit under the caller's workspace. Keys are
 * `{workspaceId}/{yyyy}/{mm}/{uuid}{ext}` (see `buildMediaKey`), so the prefix
 * IS the owner. Getting that check wrong would let any signed-in user read any
 * other workspace's media by guessing a key.
 */

import { NextRequest, NextResponse } from "next/server";
import { MediaStorageError, getMediaStorage } from "@/lib/storage";
import {
  mediaGetResponse,
  mediaHeadResponse,
  type ServableMedia,
} from "@/lib/storage/serve";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";

// Per-user and per-file; nothing here is safe to cache in a shared layer.
export const dynamic = "force-dynamic";
// Streaming a file off local disk is Node-only.
export const runtime = "nodejs";

/**
 * Private to one browser, and short. Long enough that scrubbing a video or
 * re-rendering the tray does not re-fetch the whole file; short enough that a
 * replaced file does not linger.
 */
const CACHE_CONTROL = "private, max-age=300";

type Resolution =
  | { ok: true; media: ServableMedia }
  | { ok: false; response: NextResponse };

/**
 * 404 for every failure — missing, not yours, or not signed in.
 *
 * Distinguishing "no such file" from "not your file" would confirm that a
 * guessed key exists in someone else's workspace, which is the one thing this
 * route must not leak.
 */
function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

async function resolveMedia(context: {
  params: Promise<{ segments: string[] }>;
}): Promise<Resolution> {
  const workspace = await getCurrentWorkspaceContext();
  if (!workspace) return { ok: false, response: notFound() };

  const { segments } = await context.params;
  if (!segments || segments.length === 0) {
    return { ok: false, response: notFound() };
  }

  // Next has already decoded each segment; rejoining reconstructs the key.
  const key = segments.join("/");

  // The authorisation check. The trailing slash matters: without it a workspace
  // called "ws1" could read "ws10/…".
  if (!key.startsWith(`${workspace.workspaceId}/`)) {
    return { ok: false, response: notFound() };
  }

  try {
    const { size, contentType } = await getMediaStorage().stat(key);
    return { ok: true, media: { key, size, contentType } };
  } catch (error) {
    if (error instanceof MediaStorageError) {
      return { ok: false, response: notFound() };
    }
    console.error("[Media Preview] stat failed:", error);
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
