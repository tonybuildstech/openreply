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
  /** TikTok only — INBOX needs no options at all. */
  tiktokPostMode?: "INBOX" | "DIRECT_POST" | null;
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

function InstagramOptions({
  value,
  onChange,
}: Pick<PlatformOptionsProps, "value" | "onChange">) {
  return (
    <div className="space-y-4">
      <OptionGrid>
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

        <Field label="Location ID" hint="A Facebook Page ID for the location.">
          <TextInput
            value={value.locationId}
            onChange={(v) => onChange({ locationId: v || undefined })}
            placeholder="1234567890"
          />
        </Field>

        <Field
          label="Collaborators"
          hint="Usernames, comma separated. They receive an invite."
        >
          <TextInput
            value={value.collaborators}
            onChange={(v) => onChange({ collaborators: v || undefined })}
            placeholder="brandpartner, studio"
          />
        </Field>

        <Field label="Tag people" hint="Usernames, comma separated.">
          <TextInput
            value={value.userTags}
            onChange={(v) => onChange({ userTags: v || undefined })}
            placeholder="maya.co, alex"
          />
        </Field>
      </OptionGrid>

      <Toggle
        label="Also share to feed"
        hint="Show the Reel in your main profile grid as well as the Reels tab."
        checked={value.shareToFeed ?? true}
        onChange={(checked) => onChange({ shareToFeed: checked })}
      />
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

const TIKTOK_PRIVACY_LEVELS = [
  { value: "PUBLIC_TO_EVERYONE", label: "Everyone" },
  { value: "MUTUAL_FOLLOW_FRIENDS", label: "Friends" },
  { value: "SELF_ONLY", label: "Only me" },
] as const;

function TikTokOptions({
  value,
  onChange,
  tiktokPostMode,
}: Pick<PlatformOptionsProps, "value" | "onChange" | "tiktokPostMode">) {
  if (tiktokPostMode !== "DIRECT_POST") {
    return (
      <p className="rounded-md border border-border bg-background px-3 py-2 text-sm text-muted">
        This video is delivered to your TikTok inbox at the scheduled time. You
        set the caption, privacy and everything else in the TikTok app when you
        finish posting — so there is nothing to configure here.
      </p>
    );
  }

  const brandedContent = value.brandContentToggle ?? false;

  return (
    <div className="space-y-4">
      <Field
        label="Who can see this video"
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
          {TIKTOK_PRIVACY_LEVELS.map((level) => (
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

      <fieldset className="space-y-2.5">
        <legend className="mb-1 text-sm font-medium text-foreground">
          Interactions
        </legend>
        <Toggle
          label="Disable comments"
          checked={value.disableComment ?? false}
          onChange={(checked) => onChange({ disableComment: checked })}
        />
        <Toggle
          label="Disable Duet"
          checked={value.disableDuet ?? false}
          onChange={(checked) => onChange({ disableDuet: checked })}
        />
        <Toggle
          label="Disable Stitch"
          checked={value.disableStitch ?? false}
          onChange={(checked) => onChange({ disableStitch: checked })}
        />
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
        Confirmation. TikTok may take a few minutes to process the video after
        posting.
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
  tiktokPostMode,
}: PlatformOptionsProps) {
  switch (platform) {
    case "INSTAGRAM":
      return <InstagramOptions value={value} onChange={onChange} />;
    case "YOUTUBE":
      return <YouTubeOptions value={value} onChange={onChange} />;
    case "TIKTOK":
      return (
        <TikTokOptions
          value={value}
          onChange={onChange}
          tiktokPostMode={tiktokPostMode}
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
