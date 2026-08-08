/**
 * Instagram's private-reply limits — Unit Tests
 *
 * Covers the 7-day window helper and the comment-creation-time that feeds it
 * out of the webhook payload. The one-reply-per-comment rule is enforced in the
 * DM worker against the database, so it is exercised there rather than here.
 */

import { describe, expect, it } from "vitest";
import {
  PRIVATE_REPLY_WINDOW_HOURS,
  PRIVATE_REPLY_WINDOW_MS,
  describePrivateReplyWindowExpiry,
  isWithinPrivateReplyWindow,
} from "../lib/meta/private-reply-window";
import { parseCommentEvents } from "../lib/meta/webhook";

const NOW = new Date("2026-08-08T12:00:00.000Z");

function agoMs(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

const DAY = 24 * 60 * 60 * 1000;

describe("isWithinPrivateReplyWindow", () => {
  it("accepts a fresh comment", () => {
    expect(isWithinPrivateReplyWindow(agoMs(60_000), NOW)).toBe(true);
  });

  it("accepts a comment just inside 7 days", () => {
    expect(
      isWithinPrivateReplyWindow(agoMs(PRIVATE_REPLY_WINDOW_MS - 60_000), NOW)
    ).toBe(true);
  });

  it("rejects a comment just past 7 days", () => {
    expect(
      isWithinPrivateReplyWindow(agoMs(PRIVATE_REPLY_WINDOW_MS + 60_000), NOW)
    ).toBe(false);
  });

  it("rejects the exact boundary — Meta's window is exclusive at the edge", () => {
    expect(isWithinPrivateReplyWindow(agoMs(PRIVATE_REPLY_WINDOW_MS), NOW)).toBe(
      false
    );
  });

  it("accepts ISO strings as well as Dates", () => {
    expect(isWithinPrivateReplyWindow(agoMs(2 * DAY).toISOString(), NOW)).toBe(
      true
    );
    expect(isWithinPrivateReplyWindow(agoMs(9 * DAY).toISOString(), NOW)).toBe(
      false
    );
  });

  it("allows the send when the timestamp is missing or unparseable", () => {
    // A field we failed to record must not become a reason to drop DMs —
    // Meta stays the authority. Rejecting here would turn a data gap into
    // silent lost sends.
    expect(isWithinPrivateReplyWindow(undefined, NOW)).toBe(true);
    expect(isWithinPrivateReplyWindow(null, NOW)).toBe(true);
    expect(isWithinPrivateReplyWindow("not-a-date", NOW)).toBe(true);
    expect(isWithinPrivateReplyWindow("", NOW)).toBe(true);
  });

  it("exposes the window in hours consistently with the ms value", () => {
    expect(PRIVATE_REPLY_WINDOW_HOURS * 60 * 60 * 1000).toBe(
      PRIVATE_REPLY_WINDOW_MS
    );
  });
});

describe("describePrivateReplyWindowExpiry", () => {
  it("reports the comment's age so the cause is obvious in DM logs", () => {
    const message = describePrivateReplyWindowExpiry(agoMs(9 * DAY), NOW);
    expect(message).toContain("9 days old");
    expect(message).toContain("7-day");
  });
});

describe("parseCommentEvents — comment creation time", () => {
  function payloadWithEntryTime(time: unknown) {
    return {
      object: "instagram",
      entry: [
        {
          id: "17841400000000000",
          time: time as number,
          changes: [
            {
              field: "comments",
              value: {
                id: "comment_1",
                text: "TEST",
                from: { id: "commenter_1", username: "someone" },
                media: { id: "media_1" },
              },
            },
          ],
        },
      ],
    };
  }

  it("converts Meta's seconds-based entry.time to an ISO string", () => {
    const seconds = Math.floor(NOW.getTime() / 1000);
    const [event] = parseCommentEvents(payloadWithEntryTime(seconds));
    expect(event.commentCreatedAt).toBe(NOW.toISOString());
  });

  it("also handles a millisecond entry.time without dating it to 1970", () => {
    const [event] = parseCommentEvents(payloadWithEntryTime(NOW.getTime()));
    expect(event.commentCreatedAt).toBe(NOW.toISOString());
  });

  it("leaves the timestamp undefined rather than inventing one", () => {
    for (const bad of [undefined, 0, -1, Number.NaN, "abc"]) {
      const [event] = parseCommentEvents(payloadWithEntryTime(bad));
      expect(event.commentCreatedAt).toBeUndefined();
      // A missing timestamp must not drop the event itself.
      expect(event.commentId).toBe("comment_1");
    }
  });

  it("produces a timestamp the window check accepts for a live webhook", () => {
    const seconds = Math.floor(NOW.getTime() / 1000);
    const [event] = parseCommentEvents(payloadWithEntryTime(seconds));
    expect(isWithinPrivateReplyWindow(event.commentCreatedAt, NOW)).toBe(true);
  });
});
