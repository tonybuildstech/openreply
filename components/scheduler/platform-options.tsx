"use client";

/**
 * Per-platform post configuration.
 *
 * Every control here maps to a parameter the matching adapter actually sends.
 * If you add a field, add it to `lib/scheduler/adapters/*` in the same change —
 * an option that silently does nothing is worse than an absent one.
 *
 * The TikTok block is not a design choice. Its privacy selector, interaction
 * toggles, commercial-content disclosure and declaration text are conditions of
 * TikTok's Content Posting audit (Content Sharing Guidelines). They are
 * captured here, at schedule time, because the creator is not present when the
 * worker posts.
 */

import type { ReactNode } from "react";
import type { PlatformKey } from "@/components/scheduler/platform-meta";
import {
  YOUTUBE_CATEGORIES,
  type TargetOptions,
} from "@/components/scheduler/types";

interface PlatformOptionsProps {
  platform: PlatformKey;
  mediaType: string;
  value: TargetOptions;
  onChange: (patch: Partial<TargetOptions>) => void;
  /** How many files the post carries — drives TikTok's cover picker. */
  photoCount?: number;
  /** TikTok only — INBOX needs no options at all. */
  tiktokPostMode?: "INBOX" | "DIRECT_POST" | null;
  /**
   * Live settings from `/v2/post/publish/creator_info/query/`. TikTok requires
   * the privacy options and interaction toggles to reflect these rather than a
   * hardcoded list. Null while loading, or when the call failed — the UI then
   * falls back to the full list rather than blocking, since the publish path
   * re-verifies against the creator's settings before posting anyway.
   */
  tiktokCreatorInfo?: TikTokCreatorInfoView | null;
}

/** Mirrors `TikTokCreatorInfo` from the adapter, over the wire. */
export interface TikTokCreatorInfoView {
  creatorNickname?: string;
  creatorUsername?: string;
  privacyLevelOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec?: number;
}

// ─── Field primitives ───────────────────────────────────────────────────────

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-sm font-medium text-foreground">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  );
}

const inputClass =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-foreground/30 focus:outline-none";

function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
  maxLength,
}: {
  value: string | number | undefined;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  maxLength?: number;
}) {
  return (
    <input
      type={type}
      value={value ?? ""}
      maxLength={maxLength}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={inputClass}
    />
  );
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={`flex items-start gap-2.5 ${disabled ? "opacity-50" : ""}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <span className="space-y-0.5">
        <span className="block text-sm text-foreground">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
}

function OptionGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
}

// ─── Per platform ───────────────────────────────────────────────────────────

/**
 * Instagram's per-post options, filtered by the shape being published.
 *
 * **Every field here must be one the adapter actually sends for this
 * `mediaType`.** This component used to show all seven on every shape while
 * `lib/scheduler/adapters/instagram.ts` sent them only on the Reel path — so a
 * collaborator typed onto a photo post was accepted by the form, written to the
 * database, and dropped before the request was built. Nothing surfaced, because
 * from the outside a silently-omitted parameter and an ignored one look
 * identical.
 */
function InstagramOptions({
  mediaType,
  value,
  onChange,
}: Pick<PlatformOptionsProps, "mediaType" | "value" | "onChange">) {
  const isReel = mediaType === "REEL";

  return (
    <div className="space-y-4">
      <OptionGrid>
        {isReel && (
          <Field
            label="Audio name"
            hint="Label shown for the original audio track."
          >
            <TextInput
              value={value.audioName}
              onChange={(v) => onChange({ audioName: v || undefined })}
              placeholder="Original audio"
            />
          </Field>
        )}

        {isReel && (
          <Field
            label="Cover frame (ms)"
            hint="Milliseconds into the video. Ignored if a cover URL is set."
          >
            <TextInput
              type="number"
              value={value.thumbOffset}
              onChange={(v) =>
                onChange({ thumbOffset: v === "" ? undefined : Number(v) })
              }
              placeholder="0"
            />
          </Field>
        )}

        {isReel && (
          <Field
            label="Cover image URL"
            hint="Must be publicly reachable — Instagram fetches it."
          >
            <TextInput
              value={value.coverUrl}
              onChange={(v) => onChange({ coverUrl: v || undefined })}
              placeholder="https://…/cover.jpg"
            />
          </Field>
        )}

        <Field label="Location ID" hint="A Facebook Page ID for the location.">
          <TextInput
            value={value.locationId}
            onChange={(v) => onChange({ locationId: v || undefined })}
            placeholder="1234567890"
          />
        </Field>

        <Field
          label="Collaborators"
          hint="Usernames, comma separated. They get an invite — the post only shows them as collaborators once they accept it in Instagram."
        >
          <TextInput
            value={value.collaborators}
            onChange={(v) => onChange({ collaborators: v || undefined })}
            placeholder="brandpartner, studio"
          />
        </Field>

      </OptionGrid>

      {isReel && (
        <Toggle
          label="Also share to feed"
          hint="Show the Reel in your main profile grid as well as the Reels tab."
          checked={value.shareToFeed ?? true}
          onChange={(checked) => onChange({ shareToFeed: checked })}
        />
      )}

      {/*
        Tagging lives on the media tile, not here. Instagram tags a person in a
        specific photo — the container that carries the tag is that photo's own
        — so one list for the whole post cannot say who is in which item.
      */}
      <p className="text-xs text-muted">
        To tag people, use the tag button on each photo or video up in Media.
      </p>
    </div>
  );
}

function YouTubeOptions({
  value,
  onChange,
}: Pick<PlatformOptionsProps, "value" | "onChange">) {
  return (
    <div className="space-y-4">
      <Field
        label="Title"
        hint="Required by YouTube. Falls back to the first line of your caption."
      >
        <TextInput
          value={value.title}
          maxLength={100}
          onChange={(v) => onChange({ title: v || undefined })}
          placeholder="Video title"
        />
      </Field>

      <Field label="Description" hint="Defaults to the caption.">
        <textarea
          value={value.description ?? ""}
          rows={3}
          onChange={(e) =>
            onChange({ description: e.target.value || undefined })
          }
          placeholder="Description shown under the video"
          className={inputClass}
        />
      </Field>

      <OptionGrid>
        <Field label="Category">
          <select
            value={value.categoryId ?? "22"}
            onChange={(e) => onChange({ categoryId: e.target.value })}
            className={inputClass}
          >
            {YOUTUBE_CATEGORIES.map((category) => (
              <option key={category.id} value={category.id}>
                {category.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Tags" hint="Comma separated.">
          <TextInput
            value={value.tags}
            onChange={(v) => onChange({ tags: v || undefined })}
            placeholder="studio, behind the scenes"
          />
        </Field>
      </OptionGrid>

      {/* YouTube requires an audience declaration on every upload. */}
      <Toggle
        label="Made for kids"
        hint="Declare this video as children's content. Required by YouTube on every upload."
        checked={value.madeForKids ?? false}
        onChange={(checked) => onChange({ madeForKids: checked })}
      />

      <p className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted">
        Shorts are not an API setting — YouTube decides from the aspect ratio and
        duration. Upload vertical video under 3 minutes.
      </p>
    </div>
  );
}

/**
 * Labels for every level TikTok defines. Which of these are actually OFFERED is
 * decided by `creator_info` at composer time, never by this list — a public
 * account gets PUBLIC/FRIENDS/ONLY-ME, a private one gets
 * FOLLOWERS/FRIENDS/ONLY-ME. `FOLLOWER_OF_CREATOR` was missing here entirely,
 * so private-account creators were offered a level they cannot use
 * (`PUBLIC_TO_EVERYONE`) and denied the one they can.
 */
const TIKTOK_PRIVACY_LEVELS = [
  { value: "PUBLIC_TO_EVERYONE", label: "Everyone" },
  { value: "FOLLOWER_OF_CREATOR", label: "Followers" },
  { value: "MUTUAL_FOLLOW_FRIENDS", label: "Friends" },
  { value: "SELF_ONLY", label: "Only me" },
] as const;

function TikTokOptions({
  mediaType,
  value,
  onChange,
  photoCount,
  tiktokPostMode,
  tiktokCreatorInfo: creatorInfo,
}: Pick<
  PlatformOptionsProps,
  | "mediaType"
  | "value"
  | "onChange"
  | "photoCount"
  | "tiktokPostMode"
  | "tiktokCreatorInfo"
>) {
  const isPhoto = mediaType === "TIKTOK_PHOTO";

  if (tiktokPostMode !== "DIRECT_POST") {
    return (
      <div className="space-y-3">
        <p className="rounded-md border border-border bg-background px-3 py-2 text-sm text-muted">
          {/* The two paths genuinely differ on the caption, so the copy has to.
              The photo endpoint takes `post_info.description` even on the inbox
              path, so the caption IS sent and arrives pre-filled. The inbox
              VIDEO endpoint accepts `source_info` alone — there is no field to
              put a caption in, so it is dropped and the creator retypes it.
              See lib/scheduler/adapters/tiktok.ts. Saying "you set the caption"
              for photos sent people off to retype one they already had. */}
          {isPhoto
            ? "These photos are delivered to your TikTok inbox at the scheduled time, with your caption already filled in as the description. You choose the sound, privacy and everything else in the TikTok app when you finish posting."
            : "This video is delivered to your TikTok inbox at the scheduled time. TikTok's inbox upload carries no caption field, so your caption is not sent — you type it, along with privacy and everything else, in the TikTok app when you finish posting."}
        </p>
        {isPhoto && (
          // Worth saying plainly: this is the ONLY way to choose a specific
          // sound. TikTok's API has no track selector at all.
          <p className="text-xs text-muted">
            Finishing in the app is also the only way to pick a specific sound —
            TikTok&apos;s API cannot choose a track.
          </p>
        )}
      </div>
    );
  }

  const brandedContent = value.brandContentToggle ?? false;

  return (
    <div className="space-y-4">
      {isPhoto && (
        <>
          <Field
            label="Title"
            hint="Optional, up to 90 characters. Your caption becomes the description, where hashtags go."
          >
            <TextInput
              value={value.title}
              onChange={(v) => onChange({ title: v || undefined })}
              placeholder="A short headline"
            />
          </Field>

          <Field
            label="Cover photo"
            hint="Which photo TikTok shows on your profile grid."
          >
            <select
              value={String(value.photoCoverIndex ?? 0)}
              onChange={(e) =>
                onChange({ photoCoverIndex: Number(e.target.value) })
              }
              className={inputClass}
            >
              {Array.from({ length: Math.max(photoCount ?? 1, 1) }, (_, i) => (
                <option key={i} value={i}>
                  Photo {i + 1}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}

      <Field
        label={isPhoto ? "Who can see this post" : "Who can see this video"}
        hint="TikTok requires you to choose — there is no default."
      >
        <select
          value={value.privacyLevel ?? ""}
          onChange={(e) =>
            onChange({
              privacyLevel: e.target.value as TargetOptions["privacyLevel"],
            })
          }
          className={inputClass}
        >
          <option value="" disabled>
            Choose…
          </option>
          {TIKTOK_PRIVACY_LEVELS
            // Offer only what THIS creator can actually use. Until creator_info
            // arrives (or if the call failed) fall back to the full list rather
            // than an empty dropdown — the publish path re-verifies anyway.
            .filter(
              (level) =>
                !creatorInfo ||
                creatorInfo.privacyLevelOptions.length === 0 ||
                creatorInfo.privacyLevelOptions.includes(level.value)
            )
            .map((level) => (
              <option
                key={level.value}
                value={level.value}
                // TikTok policy: branded content may not be private.
                disabled={brandedContent && level.value === "SELF_ONLY"}
              >
                {level.label}
              </option>
            ))}
        </select>
      </Field>

      {/* Video-only. TikTok's photo endpoint documents no cover timestamp, no
          Duet and no Stitch, and the adapter omits those fields entirely — so
          offering them here would collect a setting nothing sends. */}
      {!isPhoto && (
        <Field label="Cover frame (ms)" hint="Milliseconds into the video.">
          <TextInput
            type="number"
            value={value.videoCoverTimestampMs}
            onChange={(v) =>
              onChange({
                videoCoverTimestampMs: v === "" ? undefined : Number(v),
              })
            }
            placeholder="1000"
          />
        </Field>
      )}

      {isPhoto && (
        <fieldset className="space-y-2.5">
          <legend className="mb-1 text-sm font-medium text-foreground">
            Sound
          </legend>
          <Toggle
            label="Let TikTok add music"
            hint="TikTok picks a recommended track. You can change it in the app afterwards."
            checked={value.autoAddMusic ?? false}
            onChange={(checked) => onChange({ autoAddMusic: checked })}
          />
          {/* The honest limitation, stated where someone would look for a track
              picker: there is no API for one, on any post type. */}
          <p className="text-xs text-muted">
            TikTok&apos;s API cannot choose a specific sound. To pick your own,
            switch this account to inbox delivery and finish the post in the
            TikTok app.
          </p>
        </fieldset>
      )}

      {/* Video only — TikTok does not document is_aigc on the photo endpoint. */}
      {!isPhoto && (
        <fieldset className="space-y-2.5">
          <legend className="mb-1 text-sm font-medium text-foreground">
            Content source
          </legend>
          <Toggle
            label="AI-generated content"
            hint="Adds TikTok's “Creator labeled as AI-generated” tag. TikTok expects AI content to carry it, and may restrict posts that do not."
            checked={value.isAigc ?? false}
            onChange={(checked) => onChange({ isAigc: checked })}
          />
        </fieldset>
      )}

      <fieldset className="space-y-2.5">
        <legend className="mb-1 text-sm font-medium text-foreground">
          Interactions
        </legend>
        {/* When the creator has turned an interaction off account-wide, TikTok
            forces it off for the post too and the guidelines require the
            control to reflect that. Shown as checked-and-locked rather than
            hidden, so the state is visible instead of merely absent.
            Duet/Stitch are video-only signals — TikTok says to ignore them for
            photo posts, and the photo branch below never renders them. */}
        <Toggle
          label="Disable comments"
          hint={
            creatorInfo?.commentDisabled
              ? "You have comments turned off for your whole account, so this post cannot allow them."
              : undefined
          }
          checked={creatorInfo?.commentDisabled || (value.disableComment ?? false)}
          disabled={creatorInfo?.commentDisabled}
          onChange={(checked) => onChange({ disableComment: checked })}
        />
        {!isPhoto && (
          <>
            <Toggle
              label="Disable Duet"
              hint={
                creatorInfo?.duetDisabled
                  ? "Duet is off for your whole account."
                  : undefined
              }
              checked={creatorInfo?.duetDisabled || (value.disableDuet ?? false)}
              disabled={creatorInfo?.duetDisabled}
              onChange={(checked) => onChange({ disableDuet: checked })}
            />
            <Toggle
              label="Disable Stitch"
              hint={
                creatorInfo?.stitchDisabled
                  ? "Stitch is off for your whole account."
                  : undefined
              }
              checked={
                creatorInfo?.stitchDisabled || (value.disableStitch ?? false)
              }
              disabled={creatorInfo?.stitchDisabled}
              onChange={(checked) => onChange({ disableStitch: checked })}
            />
          </>
        )}
      </fieldset>

      <fieldset className="space-y-2.5">
        <legend className="mb-1 text-sm font-medium text-foreground">
          Commercial content
        </legend>
        <Toggle
          label="Your brand"
          hint="Promoting yourself or your own business."
          checked={value.brandOrganicToggle ?? false}
          onChange={(checked) => onChange({ brandOrganicToggle: checked })}
        />
        <Toggle
          label="Branded content"
          hint="A paid partnership with another brand."
          checked={brandedContent}
          onChange={(checked) =>
            onChange({
              brandContentToggle: checked,
              // Enforce TikTok's rule here rather than letting the publish
              // call fail at the scheduled minute.
              ...(checked && value.privacyLevel === "SELF_ONLY"
                ? { privacyLevel: undefined }
                : {}),
            })
          }
        />
        {brandedContent && (
          <p className="text-xs text-warning">
            Branded content cannot be private. Choose Everyone or Friends.
          </p>
        )}
      </fieldset>

      <p className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted">
        By scheduling this you agree to TikTok&apos;s{" "}
        {brandedContent ? "Branded Content Policy and " : ""}Music Usage
        Confirmation. TikTok may take a few minutes to process the{" "}
        {isPhoto ? "photos" : "video"} after posting.
      </p>
    </div>
  );
}

function FacebookOptions({
  mediaType,
  value,
  onChange,
}: Pick<PlatformOptionsProps, "mediaType" | "value" | "onChange">) {
  if (mediaType === "FACEBOOK_REEL") {
    return (
      <p className="rounded-md border border-border bg-background px-3 py-2 text-sm text-muted">
        Facebook Reels take the caption as their description. Reels must be
        vertical, 3–90 seconds.
      </p>
    );
  }

  return (
    <Field label="Video title" hint="Shown above the post. Feed videos only.">
      <TextInput
        value={value.title}
        onChange={(v) => onChange({ title: v || undefined })}
        placeholder="Title"
      />
    </Field>
  );
}

export default function PlatformOptions({
  platform,
  mediaType,
  value,
  onChange,
  photoCount,
  tiktokPostMode,
  tiktokCreatorInfo,
}: PlatformOptionsProps) {
  switch (platform) {
    case "INSTAGRAM":
      return (
        <InstagramOptions
          mediaType={mediaType}
          value={value}
          onChange={onChange}
        />
      );
    case "YOUTUBE":
      return <YouTubeOptions value={value} onChange={onChange} />;
    case "TIKTOK":
      return (
        <TikTokOptions
          mediaType={mediaType}
          value={value}
          onChange={onChange}
          photoCount={photoCount}
          tiktokPostMode={tiktokPostMode}
          tiktokCreatorInfo={tiktokCreatorInfo}
        />
      );
    case "FACEBOOK_PAGE":
      return (
        <FacebookOptions
          mediaType={mediaType}
          value={value}
          onChange={onChange}
        />
      );
  }
}
