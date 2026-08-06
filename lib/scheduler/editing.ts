/**
 * What can still be changed about a scheduled post, and why.
 *
 * The governing rule: **our row must never disagree with what the platform will
 * actually publish.** That is what makes editing non-trivial here, because a
 * post's editability depends on whether the platform is already holding it:
 *
 *  - `QUEUED` / `FAILED` / `CANCELED` — nothing has been sent anywhere yet, so
 *    everything is editable and no API call is needed. This covers all
 *    Instagram and TikTok posts before their scheduled minute.
 *  - `SCHEDULED_REMOTE` — the video is **already uploaded** and the platform
 *    owns the timer. Metadata and time can be changed only by telling the
 *    platform, and the media itself cannot be changed at all: a different file
 *    means a different video. If the platform call fails we change nothing.
 *  - `UPLOADING` / `PUBLISHING` — a worker is mid-transfer. Editing now would
 *    race the upload.
 *  - `PUBLISHED` — too late; the platform is the only place to edit it.
 *
 * Shared by the PATCH route and the edit page so the UI disables exactly what
 * the API would reject.
 */

import type {
  ScheduledPost,
  SocialPlatform,
} from "@/app/generated/prisma/client";

export type EditableField =
  | "caption"
  | "scheduledAt"
  | "platformOptions"
  | "mediaType"
  | "media";

export interface EditPolicy {
  editable: EditableField[];
  /** True when saving requires calling the platform, not just a DB write. */
  requiresPlatformSync: boolean;
  /** Why editing is limited or refused, in words a user can act on. */
  reason: string | null;
}

const ALL_FIELDS: EditableField[] = [
  "caption",
  "scheduledAt",
  "platformOptions",
  "mediaType",
  "media",
];

/** Platforms whose adapter can push an edit to an already-scheduled post. */
const PLATFORMS_SUPPORTING_REMOTE_EDIT: SocialPlatform[] = [
  "YOUTUBE",
  "FACEBOOK_PAGE",
];

export function getEditPolicy(
  status: ScheduledPost["status"],
  platform: SocialPlatform
): EditPolicy {
  switch (status) {
    case "QUEUED":
    case "FAILED":
    case "CANCELED":
      // Nothing has left the building. Edit freely.
      return {
        editable: ALL_FIELDS,
        requiresPlatformSync: false,
        reason: null,
      };

    case "SCHEDULED_REMOTE":
      if (!PLATFORMS_SUPPORTING_REMOTE_EDIT.includes(platform)) {
        return {
          editable: [],
          requiresPlatformSync: false,
          reason:
            "This platform is already holding the post and offers no way to change it. Cancel it and schedule a new one.",
        };
      }
      return {
        editable: ["caption", "scheduledAt", "platformOptions"],
        requiresPlatformSync: true,
        reason:
          "The video is already uploaded to the platform, so the file itself cannot be swapped. Changing the caption or time updates it on the platform directly.",
      };

    case "UPLOADING":
    case "PUBLISHING":
      return {
        editable: [],
        requiresPlatformSync: false,
        reason:
          "This post is being uploaded right now. Wait for it to finish, then edit or retry it.",
      };

    case "PUBLISHED":
      return {
        editable: [],
        requiresPlatformSync: false,
        reason:
          "This post is already live. Edit it on the platform itself — OpenReply can no longer change it.",
      };
  }
}

export function canEdit(
  status: ScheduledPost["status"],
  platform: SocialPlatform
): boolean {
  return getEditPolicy(status, platform).editable.length > 0;
}

/**
 * Fields the caller asked to change that this post does not allow.
 * Returned rather than thrown so the API can name all of them at once.
 */
export function rejectedFields(
  policy: EditPolicy,
  requested: EditableField[]
): EditableField[] {
  return requested.filter((field) => !policy.editable.includes(field));
}
