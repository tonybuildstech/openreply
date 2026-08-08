import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAROUSEL_MAX_ITEMS,
  CAROUSEL_MIN_ITEMS,
} from "../lib/scheduler/types";

/**
 * Instagram's three post shapes, pinned against the 2026-08-08 research.
 *
 * Every assertion here is a documented Instagram-Login fact that is easy to get
 * subtly wrong and impossible to notice without a live account:
 *
 *  - `children` is a comma-joined STRING. Meta's own reference calls it
 *    `<ARRAY_OF_CAROUSEL_CONTAINER_IDS>`, which reads like JSON.
 *  - Video children take `media_type=VIDEO`, never `REELS` — "reels are not
 *    supported" as carousel items.
 *  - A single feed image sends NO `media_type` at all.
 *  - Captions belong on the carousel PARENT; a child carrying one is wrong.
 *  - Child order is the user's chosen carousel order.
 *
 * Get any of these wrong and the failure is a `(#100)` with no useful message,
 * or worse, a post that publishes in the wrong order.
 */

vi.mock("@/lib/scheduler/tokens", () => ({
  resolveAccessToken: vi.fn(async () => "IG-test-token"),
}));

vi.mock("@/lib/storage/public-url", () => ({
  buildSignedMediaUrl: (key: string) => `https://example.test/media/${key}`,
}));

interface FakeCall {
  url: string;
  params: URLSearchParams;
}

/** Every POST /media and /media_publish the adapter made, in order. */
let calls: FakeCall[];
let containerSeq: number;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A stand-in Meta that answers by endpoint rather than by call order.
 *
 * Order-based mocks would make these tests re-record themselves every time the
 * number of poll requests changed, which is exactly the detail under test.
 */
function fakeMeta(options: { quotaUsage?: number } = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    const params = new URLSearchParams((init?.body as string) ?? "");

    if (target.includes("content_publishing_limit")) {
      return json({
        data: [
          { quota_usage: options.quotaUsage ?? 0, config: { quota_total: 50 } },
        ],
      });
    }

    if (target.includes("/media_publish")) {
      calls.push({ url: target, params });
      return json({ id: "ig_media_published" });
    }

    if (target.endsWith("/media")) {
      calls.push({ url: target, params });
      containerSeq += 1;
      return json({ id: `container_${containerSeq}` });
    }

    if (target.includes("fields=status_code")) {
      return json({ status_code: "FINISHED" });
    }

    throw new Error(`unexpected request: ${target}`);
  });
}

function mediaItem(
  position: number,
  kind: "IMAGE" | "VIDEO" = "IMAGE"
): Record<string, unknown> {
  return {
    position,
    storageKey: `ws1/item${position}.${kind === "IMAGE" ? "jpg" : "mp4"}`,
    mimeType: kind === "IMAGE" ? "image/jpeg" : "video/mp4",
    kind,
  };
}

function makePost(
  mediaType: string,
  media: Array<Record<string, unknown>>,
  caption = "shared caption",
  platformOptions: Record<string, unknown> = {}
) {
  return { mediaType, caption, platformOptions, media } as never;
}

const account = { platformAccountId: "ig_user_1" } as never;

beforeEach(() => {
  vi.stubEnv("META_GRAPH_API_VERSION", "v25.0");
  calls = [];
  containerSeq = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

async function publish(post: never) {
  const { instagramAdapter } = await import(
    "../lib/scheduler/adapters/instagram"
  );
  return instagramAdapter.schedule(post, account);
}

/** POST /media calls only — the children and the parent, in order. */
function containerCalls() {
  return calls.filter((call) => call.url.endsWith("/media"));
}

describe("Instagram carousel publishing", () => {
  it("marks every child as a carousel item and gives none of them a caption", async () => {
    vi.stubGlobal("fetch", fakeMeta());

    await publish(makePost("CAROUSEL", [mediaItem(0), mediaItem(1)]));

    const children = containerCalls().slice(0, -1);
    expect(children).toHaveLength(2);

    for (const child of children) {
      expect(child.params.get("is_carousel_item")).toBe("true");
      // The caption belongs to the parent. A child carrying one is at best
      // ignored and at worst a duplicate caption on the post.
      expect(child.params.get("caption")).toBeNull();
    }
  });

  it("sends video children as media_type=VIDEO, never REELS", async () => {
    vi.stubGlobal("fetch", fakeMeta());

    await publish(
      makePost("CAROUSEL", [mediaItem(0, "VIDEO"), mediaItem(1, "IMAGE")])
    );

    const [video, image] = containerCalls();

    expect(video.params.get("media_type")).toBe("VIDEO");
    expect(video.params.get("video_url")).toContain("item0.mp4");

    // An image child carries no media_type at all.
    expect(image.params.get("media_type")).toBeNull();
    expect(image.params.get("image_url")).toContain("item1.jpg");
  });

  it("joins children into a comma-separated string, not JSON", async () => {
    vi.stubGlobal("fetch", fakeMeta());

    await publish(
      makePost("CAROUSEL", [mediaItem(0), mediaItem(1), mediaItem(2)])
    );

    const parent = containerCalls().at(-1)!;
    const children = parent.params.get("children");

    expect(parent.params.get("media_type")).toBe("CAROUSEL");
    expect(children).toBe("container_1,container_2,container_3");
    // The thing this test exists to prevent.
    expect(children).not.toContain("[");
    expect(children).not.toContain('"');
  });

  it("puts the caption on the parent", async () => {
    vi.stubGlobal("fetch", fakeMeta());

    await publish(
      makePost("CAROUSEL", [mediaItem(0), mediaItem(1)], "look at these")
    );

    expect(containerCalls().at(-1)!.params.get("caption")).toBe(
      "look at these"
    );
  });

  it("builds children in the order the user arranged them", async () => {
    vi.stubGlobal("fetch", fakeMeta());

    // Deliberately shuffled: the adapter must publish the array as given —
    // dispatch.ts is what sorts by position, and this asserts nothing here
    // re-sorts or reverses it.
    const post = makePost("CAROUSEL", [
      mediaItem(2),
      mediaItem(0),
      mediaItem(1),
    ]);

    await publish(post);

    const urls = containerCalls()
      .slice(0, -1)
      .map((call) => call.params.get("image_url"));

    expect(urls).toEqual([
      expect.stringContaining("item2.jpg"),
      expect.stringContaining("item0.jpg"),
      expect.stringContaining("item1.jpg"),
    ]);
  });

  it("publishes the parent container, not a child", async () => {
    vi.stubGlobal("fetch", fakeMeta());

    const result = await publish(
      makePost("CAROUSEL", [mediaItem(0), mediaItem(1)])
    );

    const publishCall = calls.find((call) =>
      call.url.includes("/media_publish")
    )!;

    // container_3 is the parent: two children were created first.
    expect(publishCall.params.get("creation_id")).toBe("container_3");
    expect(result.platformPostId).toBe("ig_media_published");
  });

  it("refuses a one-item carousel before making any request", async () => {
    const fetchMock = fakeMeta();
    vi.stubGlobal("fetch", fetchMock);

    await expect(publish(makePost("CAROUSEL", [mediaItem(0)]))).rejects.toThrow(
      new RegExp(`between ${CAROUSEL_MIN_ITEMS} and ${CAROUSEL_MAX_ITEMS} items`)
    );

    // The quota pre-flight is allowed; nothing else should have happened.
    expect(containerCalls()).toHaveLength(0);
  });

  it("refuses a carousel one item over the ceiling, before any request", async () => {
    vi.stubGlobal("fetch", fakeMeta());

    const items = Array.from({ length: CAROUSEL_MAX_ITEMS + 1 }, (_, i) =>
      mediaItem(i)
    );

    await expect(publish(makePost("CAROUSEL", items))).rejects.toThrow(
      new RegExp(`between ${CAROUSEL_MIN_ITEMS} and ${CAROUSEL_MAX_ITEMS} items`)
    );
    expect(containerCalls()).toHaveLength(0);
  });

  it("accepts a carousel exactly at the ceiling", async () => {
    vi.stubGlobal("fetch", fakeMeta());

    const items = Array.from({ length: CAROUSEL_MAX_ITEMS }, (_, i) =>
      mediaItem(i)
    );
    await publish(makePost("CAROUSEL", items));

    // Every child, plus the parent.
    expect(containerCalls()).toHaveLength(CAROUSEL_MAX_ITEMS + 1);
  });

  it("treats a bad item count as permanent — a retry cannot fix it", async () => {
    vi.stubGlobal("fetch", fakeMeta());

    const error = await publish(
      makePost("CAROUSEL", [mediaItem(0)])
    ).catch((e: Error & { retryable?: boolean }) => e);

    expect((error as { retryable?: boolean }).retryable).toBe(false);
  });
});

describe("Instagram single image publishing", () => {
  it("sends image_url with NO media_type", async () => {
    vi.stubGlobal("fetch", fakeMeta());

    await publish(makePost("IMAGE", [mediaItem(0)], "a still"));

    const [container] = containerCalls();

    expect(container.params.get("image_url")).toContain("item0.jpg");
    expect(container.params.get("caption")).toBe("a still");
    // `IMAGE` is not a documented media_type value — the feed-image example
    // omits the parameter entirely.
    expect(container.params.get("media_type")).toBeNull();
    expect(container.params.get("is_carousel_item")).toBeNull();
  });
});

describe("Instagram Reel publishing", () => {
  it("still sends media_type=REELS with video_url", async () => {
    vi.stubGlobal("fetch", fakeMeta());

    await publish(makePost("REEL", [mediaItem(0, "VIDEO")], "a reel"));

    const [container] = containerCalls();

    expect(container.params.get("media_type")).toBe("REELS");
    expect(container.params.get("video_url")).toContain("item0.mp4");
    expect(container.params.get("caption")).toBe("a reel");
    expect(container.params.get("is_carousel_item")).toBeNull();
  });

  it("refuses a Reel post carrying more than one file", async () => {
    vi.stubGlobal("fetch", fakeMeta());

    await expect(
      publish(makePost("REEL", [mediaItem(0, "VIDEO"), mediaItem(1, "VIDEO")]))
    ).rejects.toThrow(/single file/);
  });
});

/**
 * Attribution: who the post is with, where it was, who is in it.
 *
 * These shipped for eight days reaching Meta on the REEL path only, while the
 * composer offered them on every shape. A collaborator typed onto a photo post
 * was validated, stored, and dropped when the request was built — so from the
 * outside it looked exactly like Instagram ignoring the parameter.
 */
describe("Instagram post attribution", () => {
  it("sends collaborators on a feed IMAGE, not only on a Reel", async () => {
    vi.stubGlobal("fetch", fakeMeta());

    await publish(
      makePost("IMAGE", [mediaItem(0)], "a still", {
        collaborators: "bmw_klub_karlovac",
      })
    );

    // The regression, stated as plainly as it can be: this was null.
    expect(containerCalls()[0].params.get("collaborators")).toBe(
      '["bmw_klub_karlovac"]'
    );
  });

  it("sends collaborators as a JSON array, not the raw comma string", async () => {
    vi.stubGlobal("fetch", fakeMeta());

    await publish(
      makePost("REEL", [mediaItem(0, "VIDEO")], "a reel", {
        // Spacing and @ prefixes are what a person actually types.
        collaborators: " @studio, brandpartner ",
      })
    );

    const sent = containerCalls()[0].params.get("collaborators");

    expect(JSON.parse(sent as string)).toEqual(["studio", "brandpartner"]);
  });

  it("puts collaborators and location on the carousel parent", async () => {
    vi.stubGlobal("fetch", fakeMeta());

    await publish(
      makePost("CAROUSEL", [mediaItem(0), mediaItem(1)], "many", {
        collaborators: "studio",
        locationId: "111339405701667",
        userTags: "maya.co",
      })
    );

    const containers = containerCalls();
    const parent = containers.at(-1)!;

    expect(parent.params.get("collaborators")).toBe('["studio"]');
    expect(parent.params.get("location_id")).toBe("111339405701667");
    // Meta tags people per carousel ITEM; a whole-post list cannot say which
    // item someone is in, so it must not be smuggled onto the parent.
    expect(parent.params.get("user_tags")).toBeNull();

    for (const child of containers.slice(0, -1)) {
      expect(child.params.get("collaborators")).toBeNull();
    }
  });

  it("publishes without the attribution rather than failing when Meta refuses it", async () => {
    // Meta rejects any container carrying `collaborators`, and accepts the
    // same container without it. The post is worth more than the tag.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const target = String(url);
        const params = new URLSearchParams((init?.body as string) ?? "");

        if (target.includes("content_publishing_limit")) {
          return json({ data: [{ quota_usage: 0, config: { quota_total: 50 } }] });
        }
        if (target.includes("/media_publish")) {
          calls.push({ url: target, params });
          return json({ id: "ig_media_published" });
        }
        if (target.endsWith("/media")) {
          calls.push({ url: target, params });
          if (params.get("collaborators")) {
            return json(
              { error: { message: "Invalid parameter", code: 100 } },
              400
            );
          }
          containerSeq += 1;
          return json({ id: `container_${containerSeq}` });
        }
        if (target.includes("fields=status_code")) {
          return json({ status_code: "FINISHED" });
        }
        throw new Error(`unexpected request: ${target}`);
      })
    );

    const result = await publish(
      makePost("IMAGE", [mediaItem(0)], "a still", { collaborators: "studio" })
    );

    expect(result.platformPostId).toBe("ig_media_published");
    // Two attempts: the rejected one and the clean retry.
    expect(containerCalls()).toHaveLength(2);
    expect(containerCalls()[1].params.get("collaborators")).toBeNull();
    // And the user is told. Publishing without what they asked for and saying
    // nothing is the one outcome worse than failing.
    expect(result.notice).toMatch(/collaborators/);
  });

  it("does not retry a throttle by stripping options that were not the problem", async () => {
    // Code 4 is a rate limit. Dropping the collaborator would not help, and a
    // second immediate attempt just spends more of the same budget.
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const target = String(url);
        if (target.includes("content_publishing_limit")) {
          return json({ data: [{ quota_usage: 0, config: { quota_total: 50 } }] });
        }
        if (target.endsWith("/media")) {
          attempts += 1;
          return json(
            { error: { message: "Application request limit reached", code: 4 } },
            429
          );
        }
        throw new Error(`unexpected request: ${target}`);
      })
    );

    await expect(
      publish(
        makePost("IMAGE", [mediaItem(0)], "a still", { collaborators: "studio" })
      )
    ).rejects.toThrow(/request limit/);

    expect(attempts).toBe(1);
  });

  it("makes no extra request when there is nothing to attribute", async () => {
    vi.stubGlobal("fetch", fakeMeta());

    await publish(makePost("IMAGE", [mediaItem(0)]));

    expect(containerCalls()).toHaveLength(1);
  });
});

describe("Instagram unsupported post shapes", () => {
  it("refuses a post type it has no path for rather than guessing", async () => {
    vi.stubGlobal("fetch", fakeMeta());

    // This is the failure mode that existed between widening
    // MEDIA_TYPE_BY_PLATFORM and writing these branches: a STORIES post would
    // have silently published as a Reel.
    await expect(
      publish(makePost("STORIES", [mediaItem(0, "VIDEO")]))
    ).rejects.toThrow(/cannot publish a STORIES post/);
  });
});
