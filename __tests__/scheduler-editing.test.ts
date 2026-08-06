import { describe, expect, it } from "vitest";
import { getAdapter, NATIVE_PLATFORMS } from "../lib/scheduler/adapters";
import {
  canEdit,
  getEditPolicy,
  rejectedFields,
  type EditableField,
} from "../lib/scheduler/editing";

/**
 * The governing rule for editing is that our row must never disagree with what
 * the platform will actually publish. Every assertion here exists to stop that
 * from drifting — most of these mistakes are silent, producing a dashboard that
 * confidently describes a post that publishes differently.
 */
describe("edit policy — nothing sent to the platform yet", () => {
  it.each(["QUEUED", "FAILED", "CANCELED"] as const)(
    "allows every field while %s",
    (status) => {
      const policy = getEditPolicy(status, "INSTAGRAM");

      expect(policy.editable).toEqual([
        "caption",
        "scheduledAt",
        "platformOptions",
        "mediaType",
        "media",
      ]);
      // Nothing has left the building, so saving is a plain database write.
      expect(policy.requiresPlatformSync).toBe(false);
      expect(policy.reason).toBeNull();
    }
  );

  it("allows full edits on every platform in those states", () => {
    for (const platform of [
      "INSTAGRAM",
      "TIKTOK",
      "YOUTUBE",
      "FACEBOOK_PAGE",
    ] as const) {
      expect(canEdit("QUEUED", platform)).toBe(true);
      expect(getEditPolicy("QUEUED", platform).requiresPlatformSync).toBe(false);
    }
  });
});

describe("edit policy — the platform already holds it", () => {
  it.each(["YOUTUBE", "FACEBOOK_PAGE"] as const)(
    "lets %s change metadata and time, but never the file",
    (platform) => {
      const policy = getEditPolicy("SCHEDULED_REMOTE", platform);

      expect(policy.editable).toEqual([
        "caption",
        "scheduledAt",
        "platformOptions",
      ]);
      // The video is already uploaded — a different file is a different video.
      expect(policy.editable).not.toContain("media");
      expect(policy.editable).not.toContain("mediaType");
      // Saving MUST reach the platform, or the row would diverge from reality.
      expect(policy.requiresPlatformSync).toBe(true);
      expect(policy.reason).toBeTruthy();
    }
  );

  it("has an update() on every platform whose policy promises remote sync", () => {
    // A policy that says requiresPlatformSync while the adapter cannot sync
    // would make the PATCH route dead-end at a 409.
    for (const platform of NATIVE_PLATFORMS) {
      const policy = getEditPolicy("SCHEDULED_REMOTE", platform);
      if (policy.requiresPlatformSync) {
        expect(getAdapter(platform).update).toBeTypeOf("function");
      }
    }
  });

  it("refuses outright on a platform that cannot push edits", () => {
    // Instagram and TikTok never reach SCHEDULED_REMOTE (they are worker-
    // published), but if one ever did, refusing beats a local-only edit.
    for (const platform of ["INSTAGRAM", "TIKTOK"] as const) {
      const policy = getEditPolicy("SCHEDULED_REMOTE", platform);

      expect(policy.editable).toEqual([]);
      expect(policy.requiresPlatformSync).toBe(false);
      expect(policy.reason).toMatch(/cancel it/i);
    }
  });
});

describe("edit policy — locked states", () => {
  it.each(["UPLOADING", "PUBLISHING"] as const)(
    "refuses while %s because a worker is mid-transfer",
    (status) => {
      const policy = getEditPolicy(status, "TIKTOK");

      expect(policy.editable).toEqual([]);
      expect(canEdit(status, "TIKTOK")).toBe(false);
      expect(policy.reason).toMatch(/uploaded right now/i);
    }
  );

  it("refuses once published and points at the platform", () => {
    const policy = getEditPolicy("PUBLISHED", "INSTAGRAM");

    expect(policy.editable).toEqual([]);
    expect(policy.reason).toMatch(/already live/i);
  });
});

describe("rejectedFields", () => {
  it("names every disallowed field at once, not just the first", () => {
    const policy = getEditPolicy("SCHEDULED_REMOTE", "YOUTUBE");
    const requested: EditableField[] = ["caption", "media", "mediaType"];

    expect(rejectedFields(policy, requested)).toEqual(["media", "mediaType"]);
  });

  it("returns nothing when every requested field is allowed", () => {
    const policy = getEditPolicy("QUEUED", "TIKTOK");

    expect(rejectedFields(policy, ["caption", "media"])).toEqual([]);
  });

  it("rejects everything when the post is locked", () => {
    const policy = getEditPolicy("PUBLISHED", "YOUTUBE");

    expect(rejectedFields(policy, ["caption"])).toEqual(["caption"]);
  });
});
