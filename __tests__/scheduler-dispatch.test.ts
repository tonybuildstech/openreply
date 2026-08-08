import { describe, expect, it } from "vitest";
import {
  NATIVE_PLATFORMS,
  QUEUED_PLATFORMS,
  getAdapter,
  getDispatchMode,
} from "../lib/scheduler/adapters";
import { toUserTagsParam } from "../lib/scheduler/adapters/instagram";
import { toTagList } from "../lib/scheduler/adapters/youtube";
import {
  derivePostType,
  selectionBlocker,
} from "../components/scheduler/platform-meta";
import {
  MEDIA_SHAPE_BY_POST_TYPE,
  MEDIA_TYPE_BY_PLATFORM,
  PublishError,
  requireSingleMedia,
  SCHEDULED_POST_TYPES,
} from "../lib/scheduler/types";

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
    // Instagram is the only platform that takes stills or more than one file.
    expect(MEDIA_TYPE_BY_PLATFORM.INSTAGRAM).toEqual([
      "REEL",
      "IMAGE",
      "CAROUSEL",
    ]);
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

/**
 * The backstop for the one genuinely destructive mistake this refactor could
 * make: publishing item 0 of a carousel to a platform that takes one file, and
 * calling it a success. The user would see a post go out that is not the post
 * they scheduled, with nothing in the logs to say so.
 *
 * The API and composer both refuse the combination earlier. This exists for
 * when they don't.
 */
describe("requireSingleMedia", () => {
  const item = (position: number) => ({
    id: `m${position}`,
    scheduledPostId: "p1",
    position,
    storageKey: `ws1/clip${position}.mp4`,
    mimeType: "video/mp4",
    // BigInt(...) not 1024n — tsconfig targets below ES2020.
    sizeBytes: BigInt(1024),
    kind: "VIDEO" as const,
    widthPx: null,
    heightPx: null,
    durationMs: null,
    croppedToRatio: null,
    createdAt: new Date(),
  });

  it("returns the only item when there is exactly one", () => {
    const post = { media: [item(0)] } as never;
    expect(requireSingleMedia(post).storageKey).toBe("ws1/clip0.mp4");
  });

  it("refuses a carousel rather than silently publishing its first item", () => {
    const post = { media: [item(0), item(1), item(2)] } as never;

    expect(() => requireSingleMedia(post)).toThrow(PublishError);
    // The message has to name the real problem — this surfaces in the
    // dashboard as the reason the post failed.
    expect(() => requireSingleMedia(post)).toThrow(/single file/);
  });

  it("refuses a post with no media at all", () => {
    expect(() => requireSingleMedia({ media: [] } as never)).toThrow(
      /no media/
    );
  });

  it("treats the failure as permanent, since a retry cannot fix it", () => {
    try {
      requireSingleMedia({ media: [item(0), item(1)] } as never);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as PublishError).retryable).toBe(false);
    }
  });
});

describe("media shape per post type", () => {
  it("lets only a carousel hold more than one file", () => {
    for (const [type, shape] of Object.entries(MEDIA_SHAPE_BY_POST_TYPE)) {
      if (type === "CAROUSEL") {
        expect(shape.maxItems).toBe(10);
        expect(shape.minItems).toBe(2);
      } else {
        expect(shape.minItems).toBe(1);
        expect(shape.maxItems).toBe(1);
      }
    }
  });

  it("only lets Instagram post types accept a still image", () => {
    const stillCapable = Object.entries(MEDIA_SHAPE_BY_POST_TYPE)
      .filter(([, shape]) => shape.kinds.includes("IMAGE"))
      .map(([type]) => type);

    expect(stillCapable.sort()).toEqual(["CAROUSEL", "IMAGE"]);
    // ...and both of those belong to Instagram alone.
    for (const type of stillCapable) {
      expect(MEDIA_TYPE_BY_PLATFORM.INSTAGRAM).toContain(type);
    }
  });

  it("covers every post type the platform map can produce", () => {
    for (const types of Object.values(MEDIA_TYPE_BY_PLATFORM)) {
      for (const type of types) {
        expect(MEDIA_SHAPE_BY_POST_TYPE[type]).toBeDefined();
      }
    }
  });

  /**
   * The API's zod enums are built from SCHEDULED_POST_TYPES. If that tuple
   * drifts from the shape map, a post type is either accepted by the API with
   * no rules to validate it against, or rejected despite being publishable.
   */
  it("keeps the API's post-type tuple in step with the shape map", () => {
    expect([...SCHEDULED_POST_TYPES].sort()).toEqual(
      Object.keys(MEDIA_SHAPE_BY_POST_TYPE).sort()
    );
  });

  it("offers every platform's post types through the API tuple", () => {
    for (const types of Object.values(MEDIA_TYPE_BY_PLATFORM)) {
      for (const type of types) {
        expect(SCHEDULED_POST_TYPES).toContain(type);
      }
    }
  });
});

/**
 * What the composer will and will not offer.
 *
 * These two decide whether the UI can present a combination the API rejects.
 * The failure they prevent is specific: a carousel selected against a TikTok
 * account, accepted by the composer, then either refused at submit (confusing)
 * or — before `requireSingleMedia` existed — published as one arbitrary item.
 */
describe("composer post-type derivation", () => {
  it("turns two or more Instagram items into a carousel", () => {
    expect(derivePostType("INSTAGRAM", ["IMAGE", "IMAGE"])).toBe("CAROUSEL");
    expect(derivePostType("INSTAGRAM", ["IMAGE", "VIDEO"])).toBe("CAROUSEL");
    expect(derivePostType("INSTAGRAM", ["VIDEO", "VIDEO"])).toBe("CAROUSEL");
  });

  it("distinguishes a single Instagram photo from a single Reel", () => {
    expect(derivePostType("INSTAGRAM", ["IMAGE"])).toBe("IMAGE");
    expect(derivePostType("INSTAGRAM", ["VIDEO"])).toBe("REEL");
  });

  it("leaves Facebook's Reel-or-feed decision to the user", () => {
    // The one genuine choice: same file, two valid destinations.
    expect(derivePostType("FACEBOOK_PAGE", ["VIDEO"])).toBe("FACEBOOK_REEL");
    expect(derivePostType("FACEBOOK_PAGE", ["VIDEO"], "FACEBOOK_VIDEO")).toBe(
      "FACEBOOK_VIDEO"
    );
  });

  it("gives single-video platforms their only post type", () => {
    expect(derivePostType("TIKTOK", ["VIDEO"])).toBe("TIKTOK_VIDEO");
    expect(derivePostType("YOUTUBE", ["VIDEO"])).toBe("SHORT");
  });

  it("only ever derives a post type the platform actually accepts", () => {
    const cases: ReadonlyArray<ReadonlyArray<"IMAGE" | "VIDEO">> = [
      ["VIDEO"],
      ["IMAGE"],
      ["IMAGE", "IMAGE"],
      ["VIDEO", "IMAGE", "VIDEO"],
    ];

    for (const platform of [...QUEUED_PLATFORMS, ...NATIVE_PLATFORMS]) {
      for (const kinds of cases) {
        const derived = derivePostType(platform, kinds);
        expect(MEDIA_TYPE_BY_PLATFORM[platform]).toContain(derived);
      }
    }
  });
});

describe("composer selection gating", () => {
  it("lets Instagram take anything", () => {
    expect(selectionBlocker("INSTAGRAM", ["IMAGE", "VIDEO"])).toBeNull();
    expect(selectionBlocker("INSTAGRAM", ["IMAGE"])).toBeNull();
  });

  it("blocks multi-item selections on every single-video platform", () => {
    for (const platform of ["TIKTOK", "YOUTUBE", "FACEBOOK_PAGE"] as const) {
      expect(selectionBlocker(platform, ["VIDEO", "VIDEO"])).toMatch(
        /single video/
      );
    }
  });

  it("blocks a photo on every platform that publishes video only", () => {
    for (const platform of ["TIKTOK", "YOUTUBE", "FACEBOOK_PAGE"] as const) {
      expect(selectionBlocker(platform, ["IMAGE"])).toMatch(/not accept photos/);
    }
  });

  it("blocks nothing before any file is chosen", () => {
    for (const platform of [...QUEUED_PLATFORMS, ...NATIVE_PLATFORMS]) {
      expect(selectionBlocker(platform, [])).toBeNull();
    }
  });

  it("allows exactly the selections each platform's post types can hold", () => {
    // The invariant tying the two functions together: if nothing is blocked,
    // the derived post type must be able to hold that many files of that kind.
    for (const platform of [...QUEUED_PLATFORMS, ...NATIVE_PLATFORMS]) {
      for (const kinds of [["VIDEO"], ["IMAGE"], ["IMAGE", "IMAGE"]] as const) {
        if (selectionBlocker(platform, kinds)) continue;

        const shape = MEDIA_SHAPE_BY_POST_TYPE[derivePostType(platform, kinds)];
        expect(kinds.length).toBeGreaterThanOrEqual(shape.minItems);
        expect(kinds.length).toBeLessThanOrEqual(shape.maxItems);
        for (const kind of kinds) expect(shape.kinds).toContain(kind);
      }
    }
  });
});
