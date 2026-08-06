import { describe, expect, it } from "vitest";
import {
  NATIVE_PLATFORMS,
  QUEUED_PLATFORMS,
  getAdapter,
  getDispatchMode,
} from "../lib/scheduler/adapters";
import { toUserTagsParam } from "../lib/scheduler/adapters/instagram";
import { toTagList } from "../lib/scheduler/adapters/youtube";
import { MEDIA_TYPE_BY_PLATFORM, PublishError } from "../lib/scheduler/types";

/**
 * The native/queued split is the spine of this feature, and getting a platform
 * on the wrong side is a silent failure: a NATIVE platform in the fire-time
 * poll would be uploaded twice, and a QUEUED platform left out of it would
 * never publish at all. These assertions pin the split to what research
 * established (2026-08-06/09).
 */
describe("dispatch routing", () => {
  it("routes Instagram and TikTok through the worker queue", () => {
    // Neither has any scheduling parameter in its API.
    expect(getDispatchMode("INSTAGRAM")).toBe("QUEUED");
    expect(getDispatchMode("TIKTOK")).toBe("QUEUED");
    expect(QUEUED_PLATFORMS.sort()).toEqual(["INSTAGRAM", "TIKTOK"]);
  });

  it("lets Facebook and YouTube hold their own schedule", () => {
    // Facebook Reels DO schedule natively (video_state=SCHEDULED) — this was
    // the open question the research round settled.
    expect(getDispatchMode("FACEBOOK_PAGE")).toBe("NATIVE");
    expect(getDispatchMode("YOUTUBE")).toBe("NATIVE");
    expect(NATIVE_PLATFORMS.sort()).toEqual(["FACEBOOK_PAGE", "YOUTUBE"]);
  });

  it("puts every platform on exactly one side of the split", () => {
    const all = [...QUEUED_PLATFORMS, ...NATIVE_PLATFORMS];

    expect(all).toHaveLength(4);
    expect(new Set(all).size).toBe(4);
  });

  it("gives natively-scheduled platforms a cancel path", () => {
    // Without cancel(), deleting our row would leave the platform to publish
    // anyway — the UI's cancel button would be a lie.
    for (const platform of NATIVE_PLATFORMS) {
      expect(getAdapter(platform).cancel).toBeTypeOf("function");
    }
  });

  it("reports the platform it claims to be", () => {
    for (const platform of [...QUEUED_PLATFORMS, ...NATIVE_PLATFORMS]) {
      expect(getAdapter(platform).platform).toBe(platform);
    }
  });
});

describe("media types per platform", () => {
  it("maps each platform to media types only it accepts", () => {
    expect(MEDIA_TYPE_BY_PLATFORM.INSTAGRAM).toEqual(["REEL"]);
    expect(MEDIA_TYPE_BY_PLATFORM.YOUTUBE).toEqual(["SHORT"]);
    expect(MEDIA_TYPE_BY_PLATFORM.TIKTOK).toEqual(["TIKTOK_VIDEO"]);
    expect(MEDIA_TYPE_BY_PLATFORM.FACEBOOK_PAGE).toEqual([
      "FACEBOOK_REEL",
      "FACEBOOK_VIDEO",
    ]);
  });

  it("shares no media type between platforms", () => {
    const all = Object.values(MEDIA_TYPE_BY_PLATFORM).flat();

    expect(new Set(all).size).toBe(all.length);
  });
});

/**
 * The composer collects friendly comma-separated lists; both platforms want
 * something else. These conversions fail silently if wrong — the post publishes
 * without the tags rather than erroring — so they are worth pinning.
 */
describe("composer option conversions", () => {
  it("turns an Instagram username list into Meta's user_tags JSON", () => {
    expect(toUserTagsParam("maya.co, alex")).toBe(
      '[{"username":"maya.co"},{"username":"alex"}]'
    );
  });

  it("strips a leading @ and ignores blank entries", () => {
    expect(toUserTagsParam("@maya, , @alex,")).toBe(
      '[{"username":"maya"},{"username":"alex"}]'
    );
  });

  it("returns null for an empty list so the param is omitted entirely", () => {
    // Sending user_tags=[] is not the same as not sending it.
    expect(toUserTagsParam("")).toBeNull();
    expect(toUserTagsParam("  ,  ")).toBeNull();
  });

  it("splits YouTube tags into an array and trims them", () => {
    expect(toTagList("studio, behind the scenes ,vlog")).toEqual([
      "studio",
      "behind the scenes",
      "vlog",
    ]);
  });

  it("yields an empty array for absent YouTube tags", () => {
    expect(toTagList(undefined)).toEqual([]);
    expect(toTagList("")).toEqual([]);
    expect(toTagList(" , ")).toEqual([]);
  });
});

describe("PublishError classification", () => {
  it("carries a retry verdict the worker can act on", () => {
    expect(new PublishError("rate limited", true).retryable).toBe(true);
    expect(new PublishError("bad media", false).retryable).toBe(false);
  });

  it("flags a dead credential separately from a failed publish", () => {
    const error = new PublishError("token revoked", false, {
      needsReauth: true,
    });

    // needsReauth must never be retryable — retrying a revoked token just
    // burns attempts and leaves the account looking healthy.
    expect(error.retryable).toBe(false);
    expect(error.options.needsReauth).toBe(true);
  });
});
