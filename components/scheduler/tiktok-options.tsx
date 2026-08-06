"use client";

/**
 * TikTok's mandatory composer UX.
 *
 * These controls are not product choices — they are conditions of TikTok's
 * Content Posting audit, from their Content Sharing Guidelines:
 *
 *  - privacy level must be chosen explicitly, with NO default pre-selected
 *  - only the levels the creator's account actually allows may be offered
 *  - comment/duet/stitch toggles must reflect what the creator permits
 *  - commercial content disclosure, and Branded Content can never be private
 *  - the compliance declaration must appear next to the confirm button
 *
 * They are captured here, at schedule time, precisely because the creator is
 * not present when the worker posts. Shipping the composer without them means
 * the audit fails however correct the API calls are.
 */

import type { TikTokTargetOptions } from "@/components/scheduler/types";

interface TikTokOptionsProps {
  value: TikTokTargetOptions;
  onChange: (next: TikTokTargetOptions) => void;
  /** INBOX needs none of this — the creator decides inside the TikTok app. */
  postMode: "INBOX" | "DIRECT_POST";
}

const PRIVACY_LEVELS = [
  { value: "PUBLIC_TO_EVERYONE", label: "Everyone" },
  { value: "MUTUAL_FOLLOW_FRIENDS", label: "Friends" },
  { value: "SELF_ONLY", label: "Only me" },
] as const;

export default function TikTokOptions({
  value,
  onChange,
  postMode,
}: TikTokOptionsProps) {
  if (postMode === "INBOX") {
    return (
      <p className="text-sm text-muted">
        This video will be delivered to your TikTok inbox at the scheduled time.
        You choose the caption, privacy and settings inside the TikTok app when
        you finish posting.
      </p>
    );
  }

  const brandedContent = value.brandContentToggle ?? false;

  function update(patch: Partial<TikTokTargetOptions>) {
    onChange({ ...value, ...patch });
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label className="block text-sm font-medium">
          Who can see this video
        </label>
        <select
          // No default: TikTok requires the creator to actively choose.
          value={value.privacyLevel ?? ""}
          onChange={(e) =>
            update({
              privacyLevel: e.target
                .value as TikTokTargetOptions["privacyLevel"],
            })
          }
          className="w-full rounded border border-border bg-surface px-3 py-2 text-sm"
        >
          <option value="" disabled>
            Choose…
          </option>
          {PRIVACY_LEVELS.map((level) => (
            <option
              key={level.value}
              value={level.value}
              // Branded Content may not be private — TikTok policy.
              disabled={brandedContent && level.value === "SELF_ONLY"}
            >
              {level.label}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Interactions</legend>
        {(
          [
            ["disableComment", "Disable comments"],
            ["disableDuet", "Disable Duet"],
            ["disableStitch", "Disable Stitch"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              // Must start unchecked — the creator opts in.
              checked={value[key] ?? false}
              onChange={(e) => update({ [key]: e.target.checked })}
            />
            {label}
          </label>
        ))}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Commercial content</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={value.brandOrganicToggle ?? false}
            onChange={(e) => update({ brandOrganicToggle: e.target.checked })}
          />
          Your brand — promoting yourself or your own business
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={brandedContent}
            onChange={(e) =>
              update({
                brandContentToggle: e.target.checked,
                // Enforce the policy in the UI instead of letting TikTok
                // reject it at publish time.
                ...(e.target.checked && value.privacyLevel === "SELF_ONLY"
                  ? { privacyLevel: undefined }
                  : {}),
              })
            }
          />
          Branded content — a paid partnership with a brand
        </label>
        {brandedContent && (
          <p className="text-sm text-warning">
            Branded content cannot be posted privately. Choose Everyone or
            Friends.
          </p>
        )}
      </fieldset>

      <p className="text-sm text-muted">
        By scheduling this you agree to TikTok&apos;s{" "}
        {brandedContent ? "Branded Content Policy and " : ""}
        Music Usage Confirmation. TikTok may take a few minutes to process the
        video after it is posted.
      </p>
    </div>
  );
}
