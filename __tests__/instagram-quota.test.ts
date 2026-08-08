import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

/**
 * The publishing-limit pre-flight, which used to read a field Instagram does
 * not return.
 *
 * `GET /{ig-user-id}/content_publishing_limit` answers
 * `{ data: [{ quota_usage, config: { quota_total, quota_duration } }] }`.
 * There is no top-level `quota_limit`. Asking for one meant the read always
 * fell through to its hardcoded default of 25 against a real cap of 50 — so
 * between 25 and 50 posts in a day, this threw `retryable: true` and the worker
 * requeued posts Instagram would have published.
 *
 * The failure was invisible: no error, no log, just posts quietly not going
 * out. These tests exist so the field name cannot regress unnoticed.
 */

vi.mock("@/lib/scheduler/tokens", () => ({
  resolveAccessToken: vi.fn(async () => "IG-test-token"),
}));

vi.mock("@/lib/storage/public-url", () => ({
  buildSignedMediaUrl: () => "https://example.test/api/media/public/tok/media.mp4",
}));

const post = {
  // Required since step 4: the adapter branches on post shape and refuses one
  // it has no path for, rather than defaulting to Reels.
  mediaType: "REEL",
  caption: "",
  // One media row at position 0 — the shape every post has had since the
  // ScheduledPostMedia migration. Adapters read storage keys from here.
  media: [
    {
      position: 0,
      storageKey: "ws1/clip.mp4",
      mimeType: "video/mp4",
      kind: "VIDEO",
    },
  ],
  platformOptions: {},
} as never;

const account = { platformAccountId: "ig_user_1" } as never;

function quotaResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Enough of the publish flow to get past the quota check and stop there. */
function containerCreationFails(): Response {
  return new Response(
    JSON.stringify({ error: { message: "stop here", code: 100 } }),
    { status: 400, headers: { "content-type": "application/json" } }
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("META_GRAPH_API_VERSION", "v25.0");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

async function loadAdapter() {
  const { instagramAdapter } = await import(
    "../lib/scheduler/adapters/instagram"
  );
  return instagramAdapter;
}

/** The quota URL is the first call; the adapter never gets further here. */
async function runUntilContainerCreation() {
  const adapter = await loadAdapter();
  return adapter.schedule(post, account).catch((error: Error) => error);
}

describe("instagram content_publishing_limit pre-flight", () => {
  it("requests the config field, not the non-existent quota_limit", async () => {
    fetchMock
      .mockResolvedValueOnce(
        quotaResponse({ data: [{ quota_usage: 1, config: { quota_total: 50 } }] })
      )
      .mockResolvedValueOnce(containerCreationFails());

    await runUntilContainerCreation();

    const quotaUrl = String(fetchMock.mock.calls[0][0]);
    expect(quotaUrl).toContain("content_publishing_limit");
    expect(quotaUrl).toContain("fields=quota_usage,config");
    expect(quotaUrl).not.toContain("quota_limit");
  });

  it("reads the limit from config.quota_total", async () => {
    // 30 used against a real cap of 50: publishable. Under the old code this
    // compared 30 against a defaulted 25 and refused.
    fetchMock
      .mockResolvedValueOnce(
        quotaResponse({ data: [{ quota_usage: 30, config: { quota_total: 50 } }] })
      )
      .mockResolvedValueOnce(containerCreationFails());

    const result = await runUntilContainerCreation();

    // It got past the quota gate and failed on the next call instead.
    expect(String(result)).toContain("stop here");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still refuses when Instagram reports the account is genuinely full", async () => {
    fetchMock.mockResolvedValueOnce(
      quotaResponse({ data: [{ quota_usage: 50, config: { quota_total: 50 } }] })
    );

    const result = (await runUntilContainerCreation()) as Error & {
      retryable?: boolean;
    };

    expect(result.message).toContain("publishing limit reached");
    expect(result.message).toContain("50/50");
    // The 24h window rolls forward, so this succeeds later — requeue, not fail.
    expect(result.retryable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to 50, not 25, when config is absent", async () => {
    // 30 used, no config returned. The fallback must not be the old 25, or we
    // reintroduce the exact bug this file documents.
    fetchMock
      .mockResolvedValueOnce(quotaResponse({ data: [{ quota_usage: 30 }] }))
      .mockResolvedValueOnce(containerCreationFails());

    const result = await runUntilContainerCreation();

    expect(String(result)).toContain("stop here");
  });

  it("publishes anyway when the pre-flight itself fails", async () => {
    // A broken check must never block a publish — media_publish enforces the
    // real limit and says so plainly.
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "nope", code: 100 } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(containerCreationFails());

    const result = await runUntilContainerCreation();

    expect(String(result)).toContain("stop here");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
