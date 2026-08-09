import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  decryptToken,
  encryptToken,
  encryptOptionalToken,
} from "../lib/crypto/token-cipher";
import {
  CAROUSEL_MAX_ITEMS,
  CAROUSEL_MIN_ITEMS,
} from "../lib/scheduler/types";
import {
  PLATFORM_CONSTRAINTS,
  type MediaItemForValidation,
  validateCaptionForPlatform,
  validateMediaForPlatform,
  validateScheduleWindow,
} from "../lib/scheduler/constraints";
import { scrubSecrets, toResponseSnippet } from "../lib/scheduler/http";
import { planChunks } from "../lib/scheduler/adapters/tiktok";
import {
  createConnectionState,
  verifyConnectionState,
} from "../lib/scheduler/oauth/state";
import { utcDayStart } from "../lib/scheduler/quota";

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret-with-enough-length");
  vi.stubEnv(
    "ENCRYPTION_KEY",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  );
});

describe("token cipher", () => {
  it("round-trips a token", () => {
    const encrypted = encryptToken("ya29.super-secret-google-token");
    expect(encrypted).not.toContain("ya29");
    expect(decryptToken(encrypted)).toBe("ya29.super-secret-google-token");
  });

  it("produces a different ciphertext each time (random IV)", () => {
    expect(encryptToken("same")).not.toBe(encryptToken("same"));
  });

  it("rejects tampered ciphertext rather than returning garbage", () => {
    const encrypted = encryptToken("token");
    const bytes = Buffer.from(encrypted, "base64");
    bytes[bytes.length - 1] ^= 0xff;

    expect(() => decryptToken(bytes.toString("base64"))).toThrow();
  });

  it("passes null through for absent refresh tokens", () => {
    expect(encryptOptionalToken(null)).toBeNull();
    expect(encryptOptionalToken(undefined)).toBeNull();
    expect(decryptToken(encryptOptionalToken("x")!)).toBe("x");
  });
});

describe("secret scrubbing", () => {
  it("redacts tokens from platform error bodies", () => {
    const raw =
      'Error at https://graph.instagram.com/v25.0/me?access_token=IGQVJYbGl2ZAE&fields=id';
    const scrubbed = scrubSecrets(raw);

    expect(scrubbed).not.toContain("IGQVJYbGl2ZAE");
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("redacts JSON token fields and bearer headers", () => {
    const raw = JSON.stringify({
      access_token: "ya29.a0AfB_secret",
      authorization: "Bearer ya29.another_secret_value_here",
    });
    const scrubbed = scrubSecrets(raw);

    expect(scrubbed).not.toContain("a0AfB_secret");
    expect(scrubbed).not.toContain("another_secret_value_here");
  });

  it("redacts client secrets and TikTok upload tokens", () => {
    expect(scrubSecrets("client_secret=abc123xyz")).not.toContain("abc123xyz");
    expect(
      scrubSecrets("https://open-upload.tiktokapis.com/video/?upload_token=Xza123")
    ).not.toContain("Xza123");
  });

  it("redacts our own signed media URLs, which Meta echoes back on failure", () => {
    // The signature in the path is a read capability on the file — it must not
    // survive into PublishJobLog or the dashboard's error text.
    const raw = JSON.stringify({
      error: {
        message:
          "Only photo or video can be accepted as media type. video_url=https://openreply.ivanovic.dev/api/media/public/eyJrIjoiYSJ9.s1gnATur3/media.mp4",
      },
    });
    const scrubbed = scrubSecrets(raw);

    expect(scrubbed).not.toContain("s1gnATur3");
    expect(scrubbed).not.toContain("eyJrIjoiYSJ9");
    expect(scrubbed).toContain("/api/media/public/[REDACTED]");
  });

  it("truncates snippets so a huge body cannot bloat the log table", () => {
    expect(toResponseSnippet("x".repeat(5000)).length).toBeLessThanOrEqual(500);
  });
});

/**
 * The `*PlaintextToken` naming convention only earns its keep if something
 * checks it. This walks the scheduler source and fails if a decrypted token
 * variable is passed to a logger — the exact mistake that would persist a live
 * publishing credential to disk.
 */
describe("no plaintext token reaches a log", () => {
  function collectSourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return collectSourceFiles(full);
      return full.endsWith(".ts") ? [full] : [];
    });
  }

  it("never logs a *PlaintextToken variable", () => {
    const roots = [
      path.resolve(__dirname, "../lib/scheduler"),
      path.resolve(__dirname, "../lib/crypto"),
      path.resolve(__dirname, "../lib/queue"),
    ];

    const offenders: string[] = [];
    // [^)]* already spans newlines, so no dotAll flag is needed (and the `s`
    // flag would need an es2018+ target).
    const logCall = /console\.(log|warn|error|info|debug)\(([^)]*)\)/g;

    for (const root of roots) {
      for (const file of collectSourceFiles(root)) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(logCall)) {
          if (/PlaintextToken/.test(match[2])) {
            offenders.push(`${path.basename(file)}: ${match[0].slice(0, 80)}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("scheduler OAuth state", () => {
  it("round-trips workspace and platform", () => {
    const state = createConnectionState("workspace_1", "YOUTUBE");
    const parsed = verifyConnectionState(state);

    expect(parsed?.workspaceId).toBe("workspace_1");
    expect(parsed?.platform).toBe("YOUTUBE");
  });

  it("rejects a tampered signature", () => {
    const state = createConnectionState("workspace_1", "TIKTOK");
    const [payload] = state.split(".");

    expect(verifyConnectionState(`${payload}.forged`)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const state = createConnectionState("workspace_1", "TIKTOK");
    const [, signature] = state.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        workspaceId: "workspace_2",
        platform: "TIKTOK",
        ts: Date.now(),
      })
    ).toString("base64url");

    expect(verifyConnectionState(`${forged}.${signature}`)).toBeNull();
  });

  it("rejects expired state", () => {
    vi.useFakeTimers();
    const state = createConnectionState("workspace_1", "INSTAGRAM");
    vi.advanceTimersByTime(11 * 60 * 1000);

    expect(verifyConnectionState(state)).toBeNull();
    vi.useRealTimers();
  });
});

describe("TikTok chunk planning", () => {
  it("uploads a small file whole, since 5 MB is TikTok's chunk minimum", () => {
    const plan = planChunks(3 * 1024 * 1024);

    expect(plan.totalChunkCount).toBe(1);
    expect(plan.chunkSize).toBe(3 * 1024 * 1024);
  });

  it("uses floor(size / chunkSize), so the last chunk absorbs the remainder", () => {
    // 12 MB at a 5 MB chunk is 2 chunks, not 3 — the trailing 2 MB rides along
    // on the final chunk. TikTok rejects the arithmetic otherwise.
    const plan = planChunks(12 * 1024 * 1024);

    expect(plan.chunkSize).toBe(5 * 1024 * 1024);
    expect(plan.totalChunkCount).toBe(2);
  });

  it("stays within TikTok's 1000-chunk ceiling for huge files", () => {
    const plan = planChunks(4 * 1024 * 1024 * 1024);

    expect(plan.totalChunkCount).toBeLessThanOrEqual(1000);
    expect(plan.chunkSize).toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  // The 5–10 MB window: floor(size / 5 MB) is 1, so this uploads as one chunk
  // — and a lone chunk carries the whole file, whatever chunk_size claims.
  // Declaring 5 MB for an 8.55 MB video is what TikTok answered with "The
  // chunk size is invalid".
  it("sends a single chunk as the whole file, not the 5 MB minimum", () => {
    const plan = planChunks(8_966_079);

    expect(plan.totalChunkCount).toBe(1);
    expect(plan.chunkSize).toBe(8_966_079);
  });

  it("keeps chunk_size consistent with total_chunk_count at every size", () => {
    const sizes = [
      1,
      1024,
      5 * 1024 * 1024 - 1,
      5 * 1024 * 1024,
      5 * 1024 * 1024 + 1,
      8_966_079,
      10 * 1024 * 1024 - 1,
      10 * 1024 * 1024,
      37 * 1024 * 1024,
      500 * 1024 * 1024,
      4 * 1024 * 1024 * 1024,
    ];

    for (const size of sizes) {
      const plan = planChunks(size);

      // TikTok's own arithmetic. Anything else is a 400 at init or a 416
      // partway through the upload.
      expect(plan.totalChunkCount).toBe(
        Math.floor(size / plan.chunkSize)
      );
      // A single chunk IS the file.
      if (plan.totalChunkCount === 1) expect(plan.chunkSize).toBe(size);
      // The 5 MB floor applies once the file is big enough to be split.
      if (size >= 10 * 1024 * 1024) {
        expect(plan.chunkSize).toBeGreaterThanOrEqual(5 * 1024 * 1024);
      }
      expect(plan.chunkSize).toBeLessThanOrEqual(64 * 1024 * 1024);
      expect(plan.totalChunkCount).toBeLessThanOrEqual(1000);
      // The final chunk absorbs the remainder and may not exceed 128 MB.
      const finalChunk = size - (plan.totalChunkCount - 1) * plan.chunkSize;
      expect(finalChunk).toBeLessThanOrEqual(128 * 1024 * 1024);
    }
  });

  it("never plans a zero-length chunk", () => {
    for (const size of [1, 5 * 1024 * 1024 + 1, 100 * 1024 * 1024]) {
      const plan = planChunks(size);
      expect(plan.chunkSize).toBeGreaterThan(0);
      expect(plan.totalChunkCount).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("schedule window validation", () => {
  const now = new Date("2026-08-09T12:00:00Z");

  it("rejects a Facebook post inside the documented 10-minute floor", () => {
    const issue = validateScheduleWindow(
      "FACEBOOK_PAGE",
      new Date("2026-08-09T12:05:00Z"),
      now
    );

    expect(issue?.code).toBe("TOO_SOON");
  });

  it("rejects a Facebook post beyond 75 days", () => {
    const issue = validateScheduleWindow(
      "FACEBOOK_PAGE",
      new Date("2026-12-09T12:00:00Z"),
      now
    );

    expect(issue?.code).toBe("TOO_FAR");
  });

  it("requires an hour of lead time for YouTube", () => {
    expect(
      validateScheduleWindow("YOUTUBE", new Date("2026-08-09T12:30:00Z"), now)
        ?.code
    ).toBe("TOO_SOON");
    expect(
      validateScheduleWindow("YOUTUBE", new Date("2026-08-09T14:00:00Z"), now)
    ).toBeNull();
  });

  it("accepts a valid Instagram window", () => {
    expect(
      validateScheduleWindow("INSTAGRAM", new Date("2026-08-09T13:00:00Z"), now)
    ).toBeNull();
  });

  // The composer picks whole minutes. Counting the seconds already elapsed in
  // the current minute against that turned a visible six minutes into 5m20s,
  // and TikTok's five-minute floor then refused it.
  it("counts lead time in whole minutes, not elapsed seconds", () => {
    const midMinute = new Date("2026-08-09T12:19:40Z");

    expect(
      validateScheduleWindow("TIKTOK", new Date("2026-08-09T12:25:00Z"), midMinute)
    ).toBeNull();

    // Still refuses what is genuinely inside the floor.
    expect(
      validateScheduleWindow("TIKTOK", new Date("2026-08-09T12:23:00Z"), midMinute)
        ?.code
    ).toBe("TOO_SOON");
  });
});

describe("media validation", () => {
  const video = (over: Partial<MediaItemForValidation> = {}) => ({
    mimeType: "video/mp4",
    sizeBytes: 10_000,
    kind: "VIDEO" as const,
    ...over,
  });
  const image = (over: Partial<MediaItemForValidation> = {}) => ({
    mimeType: "image/jpeg",
    sizeBytes: 10_000,
    kind: "IMAGE" as const,
    ...over,
  });

  it("rejects MOV for Instagram but accepts it for TikTok", () => {
    const media = [video({ mimeType: "video/quicktime" })];

    expect(validateMediaForPlatform("INSTAGRAM", "REEL", media)).toMatch(
      /video\/mp4/
    );
    expect(
      validateMediaForPlatform("TIKTOK", "TIKTOK_VIDEO", media)
    ).toBeNull();
  });

  it("rejects a file over the platform's size ceiling", () => {
    const issue = validateMediaForPlatform("TIKTOK", "TIKTOK_VIDEO", [
      video({ sizeBytes: 5 * 1024 ** 3 }),
    ]);

    expect(issue).toMatch(/larger than/);
  });

  it("refuses still images on platforms that only take video", () => {
    for (const [platform, postType] of [
      ["TIKTOK", "TIKTOK_VIDEO"],
      ["YOUTUBE", "SHORT"],
      ["FACEBOOK_PAGE", "FACEBOOK_REEL"],
    ] as const) {
      expect(validateMediaForPlatform(platform, postType, [image()])).not.toBeNull();
    }
  });

  describe("TikTok photo carousels", () => {
    it("accepts a JPEG set as a TikTok photo post", () => {
      expect(
        validateMediaForPlatform("TIKTOK", "TIKTOK_PHOTO", [image(), image()])
      ).toBeNull();
    });

    it("accepts up to 35, and refuses the 36th", () => {
      const many = (count: number) => Array.from({ length: count }, image);

      expect(
        validateMediaForPlatform("TIKTOK", "TIKTOK_PHOTO", many(35))
      ).toBeNull();
      expect(
        validateMediaForPlatform("TIKTOK", "TIKTOK_PHOTO", many(36))
      ).toMatch(/between 2 and 35/);
      // ...and the same 35 are far too many for an Instagram carousel. This
      // pair IS the composer's "min across the ticked platforms" rule.
      expect(
        validateMediaForPlatform("INSTAGRAM", "CAROUSEL", many(35))
      ).toMatch(/between 2 and 10/);
    });

    it("takes WebP, which Instagram will not", () => {
      const webp = [
        image({ mimeType: "image/webp" }),
        image({ mimeType: "image/webp" }),
      ];

      expect(
        validateMediaForPlatform("TIKTOK", "TIKTOK_PHOTO", webp)
      ).toBeNull();
      expect(validateMediaForPlatform("INSTAGRAM", "CAROUSEL", webp)).toMatch(
        /image\/jpeg/
      );
    });

    it("refuses a video in a photo post", () => {
      expect(
        validateMediaForPlatform("TIKTOK", "TIKTOK_PHOTO", [image(), video()])
      ).toMatch(/cannot contain/);
    });

    it("does not check aspect ratio, because TikTok documents no range", () => {
      // Instagram REJECTS 9:16 stills; TikTok publishes them. Checking a
      // guessed range here would refuse pictures TikTok would have taken.
      const tall = [
        image({ widthPx: 1080, heightPx: 1920 }),
        image({ widthPx: 1080, heightPx: 1920 }),
      ];

      expect(
        validateMediaForPlatform("TIKTOK", "TIKTOK_PHOTO", tall)
      ).toBeNull();
      expect(validateMediaForPlatform("INSTAGRAM", "CAROUSEL", tall)).toMatch(
        /outside the 4:5 to 1.91:1 range/
      );
    });

    it("allows an image Instagram's 8 MB cap would refuse", () => {
      // TikTok's ceiling is 20 MB. A photo set prepared for Instagram is always
      // inside it, but a TikTok-only post is not held to Instagram's limit.
      const big = [
        image({ sizeBytes: 12 * 1024 * 1024 }),
        image({ sizeBytes: 12 * 1024 * 1024 }),
      ];

      expect(validateMediaForPlatform("TIKTOK", "TIKTOK_PHOTO", big)).toBeNull();
      expect(validateMediaForPlatform("INSTAGRAM", "CAROUSEL", big)).toMatch(
        /8 MB limit/
      );
    });
  });

  describe("caption length", () => {
    it("refuses a TikTok caption past 4000 and allows the same one elsewhere", () => {
      const long = "x".repeat(4001);

      // Our own schema allows 5000, so without this the post schedules cleanly
      // and fails in the worker at the scheduled minute.
      expect(validateCaptionForPlatform("TIKTOK", long)).toMatch(/4000/);
      expect(validateCaptionForPlatform("INSTAGRAM", long)).toBeNull();
    });

    it("allows a caption exactly at the limit", () => {
      expect(validateCaptionForPlatform("TIKTOK", "x".repeat(4000))).toBeNull();
    });
  });

  it("accepts a JPEG as an Instagram image post", () => {
    expect(
      validateMediaForPlatform("INSTAGRAM", "IMAGE", [image()])
    ).toBeNull();
  });

  it("rejects PNG for Instagram until the format is confirmed", () => {
    // Meta publishes no list of accepted image formats. Rejecting here gives a
    // readable error instead of an opaque container ERROR at publish time.
    expect(
      validateMediaForPlatform("INSTAGRAM", "IMAGE", [
        image({ mimeType: "image/png" }),
      ])
    ).toMatch(/image\/jpeg/);
  });

  it("enforces Instagram's documented 8 MiB image ceiling", () => {
    expect(
      validateMediaForPlatform("INSTAGRAM", "IMAGE", [
        image({ sizeBytes: 9 * 1024 * 1024 }),
      ])
    ).toMatch(/8 MB limit/);

    expect(
      validateMediaForPlatform("INSTAGRAM", "IMAGE", [
        image({ sizeBytes: 7 * 1024 * 1024 }),
      ])
    ).toBeNull();
  });

  /**
   * The check that exists because Instagram REJECTS out-of-range stills rather
   * than cropping them — without it, the failure lands in the worker at the
   * scheduled minute instead of in the composer.
   */
  describe("Instagram still aspect ratio", () => {
    it("accepts the documented range and its boundaries", () => {
      for (const [w, h] of [
        [1080, 1080], // 1:1
        [1080, 1350], // 4:5, the floor
        [1910, 1000], // 1.91:1, the ceiling
      ]) {
        expect(
          validateMediaForPlatform("INSTAGRAM", "IMAGE", [
            image({ widthPx: w, heightPx: h }),
          ])
        ).toBeNull();
      }
    });

    it("rejects a too-tall 9:16 still and names the ratio", () => {
      const issue = validateMediaForPlatform("INSTAGRAM", "IMAGE", [
        image({ widthPx: 1080, heightPx: 1920 }),
      ]);

      expect(issue).toMatch(/9:16/);
      expect(issue).toMatch(/4:5 to 1\.91:1/);
    });

    it("accepts 16:9, which sits just inside the 1.91 ceiling", () => {
      // 1.778 < 1.91. Worth pinning: it is the most common landscape format and
      // an over-eager range check would reject it.
      expect(
        validateMediaForPlatform("INSTAGRAM", "IMAGE", [
          image({ widthPx: 1920, heightPx: 1080 }),
        ])
      ).toBeNull();
    });

    it("rejects a genuinely too-wide 2:1 still", () => {
      const issue = validateMediaForPlatform("INSTAGRAM", "IMAGE", [
        image({ widthPx: 2000, heightPx: 1000 }),
      ]);

      expect(issue).toMatch(/2000×1000/);
      expect(issue).toMatch(/4:5 to 1\.91:1/);
    });

    it("says nothing when the browser could not probe dimensions", () => {
      // Unknown is not invalid. Refusing here would block every upload from a
      // browser where the probe failed.
      expect(
        validateMediaForPlatform("INSTAGRAM", "IMAGE", [
          image({ widthPx: null, heightPx: null }),
        ])
      ).toBeNull();
    });

    it("ignores ratio for video, which Instagram does not reject the same way", () => {
      expect(
        validateMediaForPlatform("INSTAGRAM", "REEL", [
          video({ widthPx: 1080, heightPx: 1920 }),
        ])
      ).toBeNull();
    });
  });

  describe("item counts per post type", () => {
    it("accepts a carousel anywhere inside the bounds", () => {
      for (const count of [CAROUSEL_MIN_ITEMS, 5, CAROUSEL_MAX_ITEMS]) {
        const items = Array.from({ length: count }, () => image());
        expect(
          validateMediaForPlatform("INSTAGRAM", "CAROUSEL", items)
        ).toBeNull();
      }
    });

    it("rejects a carousel outside the bounds", () => {
      const bounds = new RegExp(
        `between ${CAROUSEL_MIN_ITEMS} and ${CAROUSEL_MAX_ITEMS} files`
      );

      expect(
        validateMediaForPlatform("INSTAGRAM", "CAROUSEL", [image()])
      ).toMatch(bounds);

      const overCeiling = Array.from({ length: CAROUSEL_MAX_ITEMS + 1 }, () =>
        image()
      );
      expect(
        validateMediaForPlatform("INSTAGRAM", "CAROUSEL", overCeiling)
      ).toMatch(bounds);
    });

    it("keeps the constraints table and the shape map on the same number", () => {
      // Six files used to carry this literal. These two are what the composer
      // and the validator each read, so a split between them is the drift that
      // would actually reach a user.
      expect(PLATFORM_CONSTRAINTS.INSTAGRAM.carousel).toEqual({
        minItems: CAROUSEL_MIN_ITEMS,
        maxItems: CAROUSEL_MAX_ITEMS,
        allowsVideo: true,
      });
    });

    it("allows a carousel to mix images and video", () => {
      expect(
        validateMediaForPlatform("INSTAGRAM", "CAROUSEL", [image(), video()])
      ).toBeNull();
    });

    it("rejects more than one file on any single-file post type", () => {
      expect(
        validateMediaForPlatform("INSTAGRAM", "REEL", [video(), video()])
      ).toMatch(/exactly 1 file/);
      expect(
        validateMediaForPlatform("TIKTOK", "TIKTOK_VIDEO", [video(), video()])
      ).toMatch(/exactly 1 file/);
    });

    it("names which item is at fault in a carousel", () => {
      const issue = validateMediaForPlatform("INSTAGRAM", "CAROUSEL", [
        image(),
        image({ mimeType: "image/png" }),
      ]);

      expect(issue).toMatch(/^Item 2: /);
    });
  });

  it("documents a daily cap for every platform that publishes one", () => {
    // Instagram is 50, not the 25 this asserted until 2026-08-08 — Meta's own
    // content-publishing guide documents 50 per rolling 24h, with a carousel
    // counting as one. See __tests__/instagram-quota.test.ts for the pre-flight
    // that reads the account's real number.
    expect(PLATFORM_CONSTRAINTS.INSTAGRAM.dailyPostCap).toBe(50);
    expect(PLATFORM_CONSTRAINTS.FACEBOOK_PAGE.dailyPostCap).toBe(30);
    expect(PLATFORM_CONSTRAINTS.TIKTOK.dailyPostCap).toBe(15);
  });

  it("keeps the composer's stated Instagram cap in step with the constraint", () => {
    // These two drifting apart is how the UI ends up promising a limit the
    // adapter does not enforce.
    const cap = PLATFORM_CONSTRAINTS.INSTAGRAM.dailyPostCap;
    expect(
      PLATFORM_CONSTRAINTS.INSTAGRAM.notes.some((note) =>
        note.includes(`${cap} posts per rolling 24 hours`)
      )
    ).toBe(true);
  });
});

describe("quota day bucketing", () => {
  it("normalises to UTC midnight, matching how platforms define the day", () => {
    const bucket = utcDayStart(new Date("2026-08-09T23:59:59Z"));

    expect(bucket.toISOString()).toBe("2026-08-09T00:00:00.000Z");
  });

  it("puts times either side of UTC midnight in different buckets", () => {
    const before = utcDayStart(new Date("2026-08-09T23:59:00Z"));
    const after = utcDayStart(new Date("2026-08-10T00:01:00Z"));

    expect(before.getTime()).not.toBe(after.getTime());
  });
});
