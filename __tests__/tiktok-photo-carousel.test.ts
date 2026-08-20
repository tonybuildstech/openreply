import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TIKTOK_PHOTO_MAX_ITEMS } from "../lib/scheduler/types";

/**
 * TikTok photo carousels, pinned against the 2026-08-08 research.
 *
 * Every assertion here is a documented fact that is easy to get subtly wrong
 * and expensive to discover — the failure lands in the worker at the scheduled
 * minute, with nobody watching:
 *
 *  - Photos use `/post/publish/content/init/`, NOT the video endpoint.
 *  - `PULL_FROM_URL` is the only transfer mode. There is no photo FILE_UPLOAD,
 *    so nothing is streamed and no `upload_url` comes back.
 *  - `disable_duet`, `disable_stitch` and `video_cover_timestamp_ms` are
 *    video-only. TikTok does not document whether an extraneous field is
 *    ignored or rejected, so they must be ABSENT — not `false`.
 *  - Direct Post fields (privacy, comments, music, brand toggles) are Direct
 *    Post only. Sending them on the inbox path claims a decision the creator
 *    has not made yet.
 *  - `auto_add_music` is the only music field in the entire API, and it merely
 *    asks TikTok to pick a track. There is no track selector to test for.
 */

vi.mock("@/lib/scheduler/tokens", () => ({
  resolveAccessToken: vi.fn(async () => "TT-test-token"),
}));

vi.mock("@/lib/storage/public-url", () => ({
  buildSignedMediaUrl: (key: string, ttlMs?: number) =>
    `https://example.test/api/media/public/token-${key}?ttl=${ttlMs}`,
}));

vi.mock("@/lib/scheduler/quota", () => ({
  recordQuotaUsage: vi.fn(async () => undefined),
}));

interface InitBody {
  media_type?: string;
  post_mode?: string;
  post_info?: Record<string, unknown>;
  source_info?: Record<string, unknown>;
}

/** Every init request the adapter made, decoded, in order. */
let calls: Array<{ url: string; body: InitBody }>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A stand-in TikTok that answers by endpoint rather than by call order, and
 * fails loudly on anything the photo path has no business requesting.
 */
function fakeTikTok(
  options: {
    error?: { code: string; message?: string };
    /** What creator_info reports this account may use. */
    privacyLevelOptions?: string[];
  } = {}
) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);

    // Direct Post re-checks the creator's CURRENT privacy options before init,
    // because a post scheduled days ago may name a level the account no longer
    // offers. Inbox posts never reach here — they send no privacy level.
    if (target.includes("/post/publish/creator_info/query/")) {
      return json({
        data: {
          privacy_level_options: options.privacyLevelOptions ?? [
            "PUBLIC_TO_EVERYONE",
            "MUTUAL_FOLLOW_FRIENDS",
            "FOLLOWER_OF_CREATOR",
            "SELF_ONLY",
          ],
          comment_disabled: false,
          duet_disabled: false,
          stitch_disabled: false,
        },
        error: { code: "ok", message: "" },
      });
    }

    if (target.includes("/post/publish/content/init/")) {
      const body = JSON.parse((init?.body as string) ?? "{}") as InitBody;
      calls.push({ url: target, body });

      if (options.error) {
        return json(
          { error: { code: options.error.code, message: options.error.message ?? "" } },
          400
        );
      }

      // Note what is NOT here: photo init returns a publish_id and no
      // upload_url, because there is nothing to upload to.
      return json({
        data: { publish_id: "p_pub_url~v2.123456789" },
        error: { code: "ok", message: "" },
      });
    }

    throw new Error(`unexpected request: ${target}`);
  });
}

function photo(position: number): Record<string, unknown> {
  return {
    position,
    storageKey: `ws1/photo${position}.jpg`,
    mimeType: "image/jpeg",
    kind: "IMAGE",
  };
}

function makePost(
  media: Array<Record<string, unknown>>,
  caption = "coast trip #travel",
  platformOptions: Record<string, unknown> = {}
) {
  return {
    mediaType: "TIKTOK_PHOTO",
    caption,
    platformOptions,
    media,
  } as never;
}

/** `postMode` lives on the ACCOUNT, not the post — inbox is the default. */
function account(postMode?: "INBOX" | "DIRECT_POST", auditApproved = false) {
  return {
    id: "acc_1",
    metadata: postMode ? { postMode, auditApproved } : {},
  } as never;
}

/**
 * Put the APP on the far side of TikTok's Content Posting audit.
 *
 * An environment flag rather than account metadata, and deliberately so: the
 * audit is a property of the app, and reading it off the row is what let an
 * account connected before the scope and audit flags were separated claim an
 * approval it never had. Any test that posts publicly needs this — without it
 * TikTok accepts SELF_ONLY and nothing else.
 */
function audited() {
  vi.stubEnv("TIKTOK_CONTENT_POSTING_AUDITED", "true");
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

async function publish(post: never, acc: never) {
  const { tiktokAdapter } = await import("../lib/scheduler/adapters/tiktok");
  return tiktokAdapter.schedule(post, acc);
}

describe("TikTok photo carousel publishing", () => {
  it("posts to the content endpoint with PULL_FROM_URL and every image in order", async () => {
    vi.stubGlobal("fetch", fakeTikTok());

    await publish(makePost([photo(0), photo(1), photo(2)]), account());

    expect(calls).toHaveLength(1);
    const { url, body } = calls[0];

    // The video endpoint would be a silent disaster: it takes a completely
    // different body and would reject or, worse, misinterpret this one.
    expect(url).toContain("/post/publish/content/init/");
    expect(url).not.toContain("/video/init/");

    expect(body.media_type).toBe("PHOTO");
    expect(body.source_info?.source).toBe("PULL_FROM_URL");

    const images = body.source_info?.photo_images as string[];
    expect(images).toHaveLength(3);
    // Array order IS the order the viewer swipes through.
    expect(images[0]).toContain("photo0.jpg");
    expect(images[1]).toContain("photo1.jpg");
    expect(images[2]).toContain("photo2.jpg");
  });

  it("gives the signed URLs longer than the Instagram default to survive TikTok's download window", async () => {
    vi.stubGlobal("fetch", fakeTikTok());

    await publish(makePost([photo(0), photo(1)]), account());

    const images = calls[0].body.source_info?.photo_images as string[];
    const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

    // TikTok's download task can run for an hour AFTER it starts, and the docs
    // promise nothing about re-fetching. Two hours has no room for a retry.
    for (const image of images) {
      expect(image).toContain(`ttl=${FOUR_HOURS_MS}`);
    }
  });

  it("never sends the video-only fields, even as false", async () => {
    // About field omission, not the audit — and the default creator here is a
    // public account, which an unaudited client may not Direct Post to at all.
    audited();
    vi.stubGlobal("fetch", fakeTikTok());

    await publish(
      makePost([photo(0), photo(1)], "caption", {
        privacyLevel: "SELF_ONLY",
        // Deliberately supplied: a stored option set from a video post must not
        // leak into a photo body just because it is present.
        disableDuet: true,
        disableStitch: true,
        videoCoverTimestampMs: 1000,
      }),
      account("DIRECT_POST")
    );

    const postInfo = calls[0].body.post_info ?? {};

    // `toBeUndefined` is not enough — the key must be absent from the JSON.
    expect(Object.keys(postInfo)).not.toContain("disable_duet");
    expect(Object.keys(postInfo)).not.toContain("disable_stitch");
    expect(Object.keys(postInfo)).not.toContain("video_cover_timestamp_ms");
  });

  it("defaults to the inbox path and sends none of the Direct Post fields", async () => {
    vi.stubGlobal("fetch", fakeTikTok());

    const result = await publish(makePost([photo(0), photo(1)]), account());

    const { body } = calls[0];
    expect(body.post_mode).toBe("MEDIA_UPLOAD");

    const postInfo = body.post_info ?? {};
    // The creator makes all of these in the TikTok app. Sending them here would
    // claim a decision they have not made.
    for (const field of [
      "privacy_level",
      "disable_comment",
      "auto_add_music",
      "brand_content_toggle",
      "brand_organic_toggle",
    ]) {
      expect(Object.keys(postInfo)).not.toContain(field);
    }

    // The notice has to mention the sound: choosing one in the app is the whole
    // reason this path is the default.
    expect(result.notice).toMatch(/sound/i);
  });

  it("sends the Direct Post fields, with explicit brand booleans, when the account asks for it", async () => {
    audited();
    vi.stubGlobal("fetch", fakeTikTok());

    const result = await publish(
      makePost([photo(0), photo(1)], "caption", {
        privacyLevel: "PUBLIC_TO_EVERYONE",
        disableComment: true,
        autoAddMusic: true,
      }),
      account("DIRECT_POST")
    );

    const postInfo = calls[0].body.post_info ?? {};

    expect(calls[0].body.post_mode).toBe("DIRECT_POST");
    expect(postInfo.privacy_level).toBe("PUBLIC_TO_EVERYONE");
    expect(postInfo.disable_comment).toBe(true);
    expect(postInfo.auto_add_music).toBe(true);

    // TikTok's photo reference marks both required while its own example omits
    // them. Explicit booleans satisfy either reading.
    expect(postInfo.brand_content_toggle).toBe(false);
    expect(postInfo.brand_organic_toggle).toBe(false);

    // Audited, so the post goes out as asked and there is nothing to warn
    // about. The unaudited case does not reach here at all — it is refused
    // before init, because TikTok does not downgrade it, it rejects it.
    expect(result.notice).toBeUndefined();
  });

  it("refuses to post when the creator no longer allows the chosen privacy level", async () => {
    audited();
    // The account went private between scheduling and publishing, so
    // PUBLIC_TO_EVERYONE is gone from what TikTok offers.
    vi.stubGlobal(
      "fetch",
      fakeTikTok({
        privacyLevelOptions: [
          "FOLLOWER_OF_CREATOR",
          "MUTUAL_FOLLOW_FRIENDS",
          "SELF_ONLY",
        ],
      })
    );

    await expect(
      publish(
        makePost([photo(0), photo(1)], "caption", {
          privacyLevel: "PUBLIC_TO_EVERYONE",
        }),
        account("DIRECT_POST")
      )
    ).rejects.toThrow(/no longer allows/i);

    // Nothing was published. Silently downgrading to a level the account DOES
    // allow would post more privately than the user asked for without telling
    // them, which TikTok's own UX guidelines warn against.
    expect(calls).toHaveLength(0);
  });

  it("still publishes when the chosen privacy level is one the creator offers", async () => {
    audited();
    vi.stubGlobal(
      "fetch",
      fakeTikTok({ privacyLevelOptions: ["SELF_ONLY", "MUTUAL_FOLLOW_FRIENDS"] })
    );

    await publish(
      makePost([photo(0), photo(1)], "caption", {
        privacyLevel: "MUTUAL_FOLLOW_FRIENDS",
      }),
      account("DIRECT_POST")
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].body.post_info?.privacy_level).toBe(
      "MUTUAL_FOLLOW_FRIENDS"
    );
  });

  it("puts the caption in description, where TikTok's own example puts hashtags", async () => {
    vi.stubGlobal("fetch", fakeTikTok());

    await publish(makePost([photo(0), photo(1)], "a few photos #travel"), account());

    const postInfo = calls[0].body.post_info ?? {};
    expect(postInfo.description).toBe("a few photos #travel");
    // Title is a separate short headline, omitted entirely when unset — not the
    // caption repeated.
    expect(Object.keys(postInfo)).not.toContain("title");
  });

  it("sends a title only when one was collected, truncated to TikTok's 90", async () => {
    vi.stubGlobal("fetch", fakeTikTok());

    await publish(
      makePost([photo(0), photo(1)], "caption", { title: "x".repeat(200) }),
      account()
    );

    expect((calls[0].body.post_info?.title as string).length).toBe(90);
  });

  it("clamps a stale cover index rather than letting TikTok reject it", async () => {
    vi.stubGlobal("fetch", fakeTikTok());

    // An edit removed items after the cover was chosen.
    await publish(
      makePost([photo(0), photo(1)], "caption", { photoCoverIndex: 7 }),
      account()
    );

    expect(calls[0].body.source_info?.photo_cover_index).toBe(1);
  });

  it("defaults the cover to the first photo", async () => {
    vi.stubGlobal("fetch", fakeTikTok());

    await publish(makePost([photo(0), photo(1)]), account());

    expect(calls[0].body.source_info?.photo_cover_index).toBe(0);
  });

  it("succeeds on a response carrying a publish_id and no upload_url", async () => {
    vi.stubGlobal("fetch", fakeTikTok());

    const result = await publish(makePost([photo(0), photo(1)]), account());

    // The video path treats a missing upload_url as a failure. The photo path
    // must not — there is nothing to upload to.
    expect(result.containerId).toBe("p_pub_url~v2.123456789");
  });

  it("refuses more photos than TikTok accepts, without calling the API", async () => {
    vi.stubGlobal("fetch", fakeTikTok());

    const tooMany = Array.from({ length: TIKTOK_PHOTO_MAX_ITEMS + 1 }, (_, i) =>
      photo(i)
    );

    await expect(publish(makePost(tooMany), account())).rejects.toThrow(
      new RegExp(`at most ${TIKTOK_PHOTO_MAX_ITEMS} photos`)
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses a description past TikTok's 4000, without calling the API", async () => {
    vi.stubGlobal("fetch", fakeTikTok());

    await expect(
      publish(makePost([photo(0), photo(1)], "x".repeat(4001)), account())
    ).rejects.toThrow(/4000 characters/);
    expect(calls).toHaveLength(0);
  });

  it("treats an unverified domain as permanent and says where to fix it", async () => {
    vi.stubGlobal("fetch", fakeTikTok({ error: { code: "url_ownership_unverified" } }));

    try {
      await publish(makePost([photo(0), photo(1)]), account());
      expect.unreachable("should have thrown");
    } catch (error) {
      const publishError = error as { retryable: boolean; message: string };
      // Retrying cannot fix a console setting, and the message has to point at
      // the one place the operator can.
      expect(publishError.retryable).toBe(false);
      expect(publishError.message).toMatch(/developer console/i);
    }
  });

  /**
   * TikTok answers an audit refusal with the same "review our integration
   * guidelines" line it uses for several other rules, so the message alone
   * cannot be acted on — or even told apart from the others.
   */
  it("explains an audit refusal instead of repeating TikTok's guidelines link", async () => {
    vi.stubGlobal(
      "fetch",
      fakeTikTok({
        error: {
          code: "unaudited_client_can_only_post_to_private_accounts",
          message:
            "Please review our integration guidelines at https://developers.tiktok.com/doc/content-sharing-guidelines/",
        },
      })
    );

    try {
      await publish(makePost([photo(0), photo(1)]), account());
      expect.unreachable("should have thrown");
    } catch (error) {
      const publishError = error as { retryable: boolean; message: string };

      expect(publishError.retryable).toBe(false);
      expect(publishError.message).toMatch(/private/i);
      expect(publishError.message).not.toMatch(/integration guidelines/i);
    }
  });

  /**
   * The Content Posting audit, which is NOT the `video.publish` scope.
   *
   * An app can hold the scope — enough to call the Direct Post endpoints — and
   * still be refused any privacy level but SELF_ONLY. The two were one flag
   * until an install with the scope scheduled a public carousel and TikTok
   * refused it at the scheduled minute, so these pin them apart.
   */
  it("refuses a public Direct Post before contacting TikTok when unaudited", async () => {
    vi.stubGlobal("fetch", fakeTikTok());

    await expect(
      publish(
        makePost([photo(0), photo(1)], "caption", {
          privacyLevel: "PUBLIC_TO_EVERYONE",
        }),
        account("DIRECT_POST")
      )
    ).rejects.toThrow(/audited/i);

    // Not one request, not even creator_info: the answer is knowable without
    // asking, and the point is to fail before anything is prepared.
    expect(calls).toHaveLength(0);
  });

  /**
   * The restriction the error code actually names, and the one that reading it
   * loosely gets wrong.
   *
   * `unaudited_client_can_only_post_to_private_accounts` is about the ACCOUNT:
   * "all user accounts using the API client to post must be set to private at
   * the time of posting". So SELF_ONLY does NOT rescue a public account, and
   * advising it sends the user to change a setting that cannot help.
   *
   * A public account is identified by TikTok offering PUBLIC_TO_EVERYONE — a
   * private one is offered FOLLOWER_OF_CREATOR instead.
   */
  it("refuses an unaudited Direct Post to a PUBLIC account even with SELF_ONLY", async () => {
    vi.stubGlobal(
      "fetch",
      fakeTikTok({
        privacyLevelOptions: [
          "PUBLIC_TO_EVERYONE",
          "MUTUAL_FOLLOW_FRIENDS",
          "SELF_ONLY",
        ],
      })
    );

    try {
      await publish(
        makePost([photo(0), photo(1)], "caption", {
          privacyLevel: "SELF_ONLY",
        }),
        account("DIRECT_POST")
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      const publishError = error as { retryable: boolean; message: string };

      expect(publishError.retryable).toBe(false);
      // Must say the ACCOUNT, and must not suggest picking "Only me" — that is
      // the level already chosen here, and it changed nothing.
      expect(publishError.message).toMatch(/private/i);
      expect(publishError.message).toMatch(/inbox/i);
    }

    // creator_info was consulted; nothing was published.
    expect(calls).toHaveLength(0);
  });

  it("allows an unaudited Direct Post when the account itself is private", async () => {
    // No PUBLIC_TO_EVERYONE on offer — TikTok's own signal for a private one.
    vi.stubGlobal(
      "fetch",
      fakeTikTok({
        privacyLevelOptions: ["FOLLOWER_OF_CREATOR", "SELF_ONLY"],
      })
    );

    const result = await publish(
      makePost([photo(0), photo(1)], "caption", {
        privacyLevel: "SELF_ONLY",
      }),
      account("DIRECT_POST")
    );

    expect(calls[0].body.post_info?.privacy_level).toBe("SELF_ONLY");
    // Said plainly, because "published" and "anyone can see it" are not the
    // same thing here and the difference is the creator's to act on.
    expect(result.notice).toMatch(/privately/i);
  });

  it("lets an audited app post to a public account", async () => {
    audited();
    vi.stubGlobal("fetch", fakeTikTok());

    const result = await publish(
      makePost([photo(0), photo(1)], "caption", {
        privacyLevel: "PUBLIC_TO_EVERYONE",
      }),
      account("DIRECT_POST")
    );

    expect(calls[0].body.post_info?.privacy_level).toBe("PUBLIC_TO_EVERYONE");
    expect(result.notice).toBeUndefined();
  });

  it("ignores a stale auditApproved on the account row", async () => {
    // Written from the scope flag before the two approvals were separated.
    // Trusting it is exactly the bug: the app is not audited, whatever the
    // row says, and TikTok is the one that decides.
    vi.stubGlobal("fetch", fakeTikTok());

    await expect(
      publish(
        makePost([photo(0), photo(1)], "caption", {
          privacyLevel: "PUBLIC_TO_EVERYONE",
        }),
        account("DIRECT_POST", true)
      )
    ).rejects.toThrow(/audited/i);
    expect(calls).toHaveLength(0);
  });

  it("leaves the inbox path alone — it carries no privacy level to refuse", async () => {
    vi.stubGlobal("fetch", fakeTikTok());

    const result = await publish(makePost([photo(0), photo(1)]), account());

    expect(calls).toHaveLength(1);
    expect(result.notice).toMatch(/inbox/i);
  });

  /** An unrecognised code still has to arrive intact — it is the only handle. */
  it("keeps the error code on a refusal it has no explanation for", async () => {
    vi.stubGlobal(
      "fetch",
      fakeTikTok({
        error: { code: "something_new", message: "Please review our guidelines" },
      })
    );

    try {
      await publish(makePost([photo(0), photo(1)]), account());
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("(something_new)");
    }
  });
});
