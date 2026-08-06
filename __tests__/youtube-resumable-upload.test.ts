import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The resumable-upload loop is the riskiest code in the scheduler: it runs
 * inside the single worker process, moves up to 8 MB per request with a
 * 10-minute timeout, and each completed upload costs 1,600 of the project's
 * 10,000 daily quota units.
 *
 * Two failure modes are covered here.
 *
 *  1. A 308 that reports no forward progress used to set `offset = offset` and
 *     `continue`, re-sending the same chunk forever. Nothing bounded it, so a
 *     wedged session pinned the worker until PM2's memory cap killed it and
 *     every other scheduled post queued behind it.
 *
 *  2. The resume position must come from YouTube's `Range` header, never from
 *     our own arithmetic — it reports what YouTube actually STORED, which is
 *     not necessarily what we sent.
 */

const { recordQuotaUsage } = vi.hoisted(() => ({
  recordQuotaUsage: vi.fn(async () => {}),
}));

vi.mock("@/lib/scheduler/quota", () => ({
  YOUTUBE_UPLOAD_UNIT_COST: 1600,
  YOUTUBE_UPDATE_UNIT_COST: 50,
  getYouTubeQuotaState: vi.fn(async () => ({
    canUpload: true,
    used: 0,
    limit: 10_000,
  })),
  recordQuotaUsage,
}));

vi.mock("@/lib/scheduler/tokens", () => ({
  resolveAccessToken: vi.fn(async () => "ya29.test-token"),
}));

const VIDEO_BYTES = 20 * 1024 * 1024; // forces 3 chunks at 8 MB each

vi.mock("@/lib/storage", () => ({
  getMediaStorage: () => ({
    stat: async () => ({ size: VIDEO_BYTES, contentType: "video/mp4" }),
    createReadStream: (_key: string, range?: { start: number; end: number }) =>
      Readable.from(
        Buffer.alloc(range ? range.end - range.start + 1 : VIDEO_BYTES)
      ),
    put: async () => ({ size: VIDEO_BYTES, contentType: "video/mp4" }),
    delete: async () => {},
  }),
}));

/** A 308 carrying the last byte YouTube claims to have stored. */
function stalled(lastStoredByte?: number): Response {
  return new Response(null, {
    status: 308,
    headers:
      lastStoredByte === undefined
        ? {}
        : { range: `bytes=0-${lastStoredByte}` },
  });
}

function sessionStarted(): Response {
  return new Response(null, {
    status: 200,
    headers: { location: "https://upload.googleapis.com/session/abc" },
  });
}

function uploadComplete(): Response {
  return new Response(JSON.stringify({ id: "yt_video_123" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const post = {
  caption: "a caption",
  mediaStorageKey: "ws1/clip.mp4",
  mediaMimeType: "video/mp4",
  scheduledAt: new Date("2026-09-01T12:00:00.000Z"),
  platformOptions: { title: "Test short" },
} as never;

const account = { metadata: { projectAudited: true } } as never;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function loadAdapter() {
  const { youtubeAdapter } = await import("../lib/scheduler/adapters/youtube");
  return youtubeAdapter;
}

/** Run a promise to completion while auto-advancing the backoff timers. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  const raced = promise.catch((error: unknown) => ({ __error: error }) as never);
  await vi.runAllTimersAsync();
  const result = (await raced) as T & { __error?: unknown };
  if (result && typeof result === "object" && "__error" in result) {
    throw result.__error;
  }
  return result;
}

describe("parseResumeOffset", () => {
  it("resumes one byte past what YouTube stored", async () => {
    const { parseResumeOffset } = await import(
      "../lib/scheduler/adapters/youtube"
    );

    expect(parseResumeOffset("bytes=0-1048575")).toBe(1048576);
    expect(parseResumeOffset("bytes=0-0")).toBe(1);
  });

  /**
   * A malformed header must read as "no progress" and be retried. Coercing it
   * into a plausible number is how an upload silently skips or duplicates
   * bytes and the video fails transcoding much later.
   */
  it("returns null for anything it cannot read exactly", async () => {
    const { parseResumeOffset } = await import(
      "../lib/scheduler/adapters/youtube"
    );

    expect(parseResumeOffset(null)).toBeNull();
    expect(parseResumeOffset("")).toBeNull();
    expect(parseResumeOffset("bytes=0")).toBeNull();
    expect(parseResumeOffset("bytes=abc-def")).toBeNull();
    expect(parseResumeOffset("0-100")).toBeNull();
  });
});

describe("YouTube resumable upload loop", () => {
  it("advances through chunks using YouTube's reported position", async () => {
    fetchMock
      .mockResolvedValueOnce(sessionStarted())
      .mockResolvedValueOnce(stalled(8 * 1024 * 1024 - 1))
      .mockResolvedValueOnce(stalled(16 * 1024 * 1024 - 1))
      .mockResolvedValueOnce(uploadComplete());

    const adapter = await loadAdapter();
    const result = await settle(adapter.schedule(post, account));

    expect(result.platformPostId).toBe("yt_video_123");

    // Content-Range on each PUT must follow YouTube's answers, not our maths.
    const ranges = fetchMock.mock.calls
      .slice(1)
      .map(([, init]) => (init.headers as Record<string, string>)["Content-Range"]);

    expect(ranges).toEqual([
      `bytes 0-8388607/${VIDEO_BYTES}`,
      `bytes 8388608-16777215/${VIDEO_BYTES}`,
      `bytes 16777216-${VIDEO_BYTES - 1}/${VIDEO_BYTES}`,
    ]);
  });

  it("rewinds when YouTube reports storing less than we sent", async () => {
    fetchMock
      .mockResolvedValueOnce(sessionStarted())
      // We sent 0-8388607 but only 4 MB landed.
      .mockResolvedValueOnce(stalled(4 * 1024 * 1024 - 1))
      .mockResolvedValueOnce(stalled(16 * 1024 * 1024 - 1))
      .mockResolvedValueOnce(uploadComplete());

    const adapter = await loadAdapter();
    await settle(adapter.schedule(post, account));

    const ranges = fetchMock.mock.calls
      .slice(1)
      .map(([, init]) => (init.headers as Record<string, string>)["Content-Range"]);

    // Second PUT resumes at 4 MB, not at the 8 MB we optimistically sent.
    expect(ranges[1]).toBe(`bytes 4194304-12582911/${VIDEO_BYTES}`);
  });

  /** The regression: this used to never terminate. */
  it("gives up instead of looping forever when no Range header comes back", async () => {
    fetchMock.mockResolvedValue(stalled());
    fetchMock.mockResolvedValueOnce(sessionStarted());

    const adapter = await loadAdapter();

    await expect(settle(adapter.schedule(post, account))).rejects.toThrow(
      /stalled at byte 0 of 20971520 — 5 consecutive chunks stored nothing/
    );

    // 1 session start + exactly 5 bounded attempts, then stop.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("gives up when YouTube keeps reporting the same position", async () => {
    fetchMock.mockResolvedValue(stalled(8 * 1024 * 1024 - 1));
    fetchMock.mockResolvedValueOnce(sessionStarted());

    const adapter = await loadAdapter();

    // First PUT advances to 8 MB, then the identical answer stops advancing.
    await expect(settle(adapter.schedule(post, account))).rejects.toThrow(
      /stalled at byte 8388608 of 20971520/
    );

    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("marks a stall retryable so the job gets a fresh session", async () => {
    fetchMock.mockResolvedValue(stalled());
    fetchMock.mockResolvedValueOnce(sessionStarted());

    const adapter = await loadAdapter();
    const error = await settle(adapter.schedule(post, account)).catch(
      (caught: unknown) => caught
    );

    expect((error as { retryable: boolean }).retryable).toBe(true);
    // A stalled upload never completed, so it must not book the 1,600 units.
    expect(recordQuotaUsage).not.toHaveBeenCalled();
  });

  it("resets the stall count once progress resumes", async () => {
    fetchMock
      .mockResolvedValueOnce(sessionStarted())
      .mockResolvedValueOnce(stalled())
      .mockResolvedValueOnce(stalled())
      .mockResolvedValueOnce(stalled())
      .mockResolvedValueOnce(stalled())
      // 4 stalls — one short of the bound — then real progress.
      .mockResolvedValueOnce(stalled(8 * 1024 * 1024 - 1))
      .mockResolvedValueOnce(stalled())
      .mockResolvedValueOnce(stalled())
      .mockResolvedValueOnce(stalled(16 * 1024 * 1024 - 1))
      .mockResolvedValueOnce(uploadComplete());

    const adapter = await loadAdapter();
    const result = await settle(adapter.schedule(post, account));

    expect(result.platformPostId).toBe("yt_video_123");
    expect(recordQuotaUsage).toHaveBeenCalledWith({
      platform: "YOUTUBE",
      units: 1600,
      posts: 1,
    });
  });
});
