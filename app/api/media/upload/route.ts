import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { getMaxUploadBytes } from "@/lib/env";
import {
  SUPPORTED_UPLOAD_MIME_TYPES,
  buildMediaKey,
  getMediaStorage,
} from "@/lib/storage";
import { UPLOAD_TOO_LARGE, capUploadBytes } from "@/lib/storage/byte-cap";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

// Uploads are large and per-user; nothing about this is cacheable.
export const dynamic = "force-dynamic";
// The whole point is streaming a multi-hundred-megabyte file to disk, which
// only works on the Node runtime.
export const runtime = "nodejs";

/**
 * Accepts the ORIGINAL video file and streams it straight to media storage.
 *
 * Deliberately absent: any transcode, compression, thumbnail, or probe pass.
 * The master is stored byte-for-byte as the user sent it. (Every platform
 * re-encodes on their side — see the research findings — but that is theirs to
 * do, not ours.)
 *
 * The body is sent as a raw stream rather than multipart/form-data: parsing
 * multipart would mean buffering the file, and the web process is capped at
 * 400 MB RSS by PM2.
 */
export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Forbidden" },
      { status: 403 }
    );
  }

  const contentType = (request.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();

  if (!SUPPORTED_UPLOAD_MIME_TYPES.includes(contentType)) {
    return NextResponse.json(
      {
        success: false,
        error: `Unsupported media type. Accepted: ${SUPPORTED_UPLOAD_MIME_TYPES.join(", ")}`,
      },
      { status: 415 }
    );
  }

  const maxBytes = getMaxUploadBytes();
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > maxBytes) {
    return NextResponse.json(
      {
        success: false,
        error: `File exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit`,
      },
      { status: 413 }
    );
  }

  if (!request.body) {
    return NextResponse.json(
      { success: false, error: "Request body is empty" },
      { status: 400 }
    );
  }

  const filename = request.headers.get("x-filename") ?? undefined;
  const key = buildMediaKey(context.workspaceId, contentType, filename);
  const storage = getMediaStorage();

  // Content-Length is a client claim. Count the real bytes as they pass and
  // abort the moment the cap is crossed, so a lying header cannot fill the disk.
  // The counting happens inside the pipeline — see `capUploadBytes` for why a
  // `data` listener here silently truncated every upload.
  const source = Readable.fromWeb(
    request.body as unknown as Parameters<typeof Readable.fromWeb>[0]
  );

  try {
    const meta = await storage.put(key, capUploadBytes(source, maxBytes), {
      contentType,
    });

    return NextResponse.json({
      success: true,
      data: {
        mediaStorageKey: key,
        mimeType: meta.contentType,
        sizeBytes: meta.size,
        filename: filename ?? null,
      },
    });
  } catch (error) {
    // Best-effort cleanup: a partial file is useless and still occupies disk.
    await storage.delete(key).catch(() => {});

    if (error instanceof Error && error.message === UPLOAD_TOO_LARGE) {
      return NextResponse.json(
        {
          success: false,
          error: `File exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit`,
        },
        { status: 413 }
      );
    }

    console.error("[Media Upload] Failed:", error);
    return NextResponse.json(
      { success: false, error: "Upload failed" },
      { status: 500 }
    );
  }
}
