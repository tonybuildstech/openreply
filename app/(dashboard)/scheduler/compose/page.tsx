"use client";

/**
 * Composer — upload one video, schedule it to any number of accounts.
 *
 * Validation happens here, at selection time, against each platform's real
 * limits. The rule from the brief holds: warn or refuse, never silently
 * re-encode. Nothing in OpenReply touches the file.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  PLATFORM_META,
  PLATFORM_ORDER,
  type PlatformKey,
} from "@/components/scheduler/platform-meta";
import TikTokOptions from "@/components/scheduler/tiktok-options";
import type {
  ComposerAccount,
  ComposerTarget,
  TikTokTargetOptions,
} from "@/components/scheduler/types";

interface UploadedMedia {
  mediaStorageKey: string;
  mimeType: string;
  sizeBytes: number;
  filename: string | null;
}

interface PlatformConstraint {
  mimeTypes: string[];
  maxFileBytes?: number;
  minLeadTimeMinutes: number;
  maxLeadTimeDays: number;
  notes: string[];
}

/** Datetime-local wants local wall time, not an ISO instant. */
function toLocalInputValue(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export default function ComposePage() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<ComposerAccount[]>([]);
  const [constraints, setConstraints] = useState<
    Record<string, PlatformConstraint>
  >({});
  const [media, setMedia] = useState<UploadedMedia | null>(null);
  const [uploading, setUploading] = useState(false);
  const [caption, setCaption] = useState("");
  const [scheduledAt, setScheduledAt] = useState(() =>
    // Default two hours out: clears YouTube's 60-minute practical minimum and
    // Facebook's documented 10-minute floor without the user thinking about it.
    toLocalInputValue(new Date(Date.now() + 2 * 60 * 60_000))
  );
  const [targets, setTargets] = useState<ComposerTarget[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);

  // Wall-clock time, held as state rather than read during render: lead-time
  // warnings genuinely depend on "now", and re-ticking keeps a composer left
  // open for an hour from showing a stale verdict.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setTimeout(tick, 0);
    const interval = window.setInterval(tick, 30_000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void (async () => {
        const res = await fetch("/api/scheduler/accounts");
        const payload = await res.json();
        if (payload.success) {
          setAccounts(payload.data.accounts);
          setConstraints(payload.data.constraints);
        }
      })();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function upload(file: File) {
    setUploading(true);
    setError(null);
    try {
      // Sent as a raw stream, not multipart: the server pipes it straight to
      // disk and never buffers the whole video.
      const res = await fetch("/api/media/upload", {
        method: "POST",
        headers: {
          "Content-Type": file.type,
          "x-filename": encodeURIComponent(file.name),
        },
        body: file,
      });
      const payload = await res.json();
      if (!payload.success) {
        setError(payload.error ?? "Upload failed");
        return;
      }
      setMedia(payload.data);
    } catch {
      setError("Upload failed. Check your connection and try again.");
    } finally {
      setUploading(false);
    }
  }

  const toggleTarget = useCallback(
    (account: ComposerAccount) => {
      setTargets((current) => {
        const existing = current.find(
          (t) => t.connectedAccountId === account.id
        );
        if (existing) {
          return current.filter((t) => t.connectedAccountId !== account.id);
        }
        return [
          ...current,
          {
            connectedAccountId: account.id,
            mediaType: PLATFORM_META[account.platform].mediaTypes[0].value,
            caption: "",
            options: {},
          },
        ];
      });
    },
    []
  );

  function updateTarget(id: string, patch: Partial<ComposerTarget>) {
    setTargets((current) =>
      current.map((t) =>
        t.connectedAccountId === id ? { ...t, ...patch } : t
      )
    );
  }

  const accountById = useMemo(
    () => new Map(accounts.map((a) => [a.id, a])),
    [accounts]
  );

  /**
   * Client-side warnings for the platforms actually selected. The API
   * re-validates everything — this exists so the user finds out before
   * submitting, not after.
   */
  const warnings = useMemo(() => {
    if (!media || targets.length === 0 || now === null) return [];
    const when = new Date(scheduledAt);
    const minutesAhead = (when.getTime() - now) / 60_000;
    const seen = new Set<string>();
    const list: string[] = [];

    for (const target of targets) {
      const account = accountById.get(target.connectedAccountId);
      if (!account) continue;
      const constraint = constraints[account.platform];
      if (!constraint) continue;
      const label = PLATFORM_META[account.platform].label;

      if (!constraint.mimeTypes.includes(media.mimeType)) {
        const key = `${label}-mime`;
        if (!seen.has(key)) {
          seen.add(key);
          list.push(
            `${label} does not accept ${media.mimeType} — it needs ${constraint.mimeTypes.join(" or ")}.`
          );
        }
      }

      if (
        constraint.maxFileBytes &&
        media.sizeBytes > constraint.maxFileBytes
      ) {
        const key = `${label}-size`;
        if (!seen.has(key)) {
          seen.add(key);
          list.push(
            `${label} limits uploads to ${(constraint.maxFileBytes / 1024 ** 3).toFixed(1)} GB.`
          );
        }
      }

      if (minutesAhead < constraint.minLeadTimeMinutes) {
        const key = `${label}-soon`;
        if (!seen.has(key)) {
          seen.add(key);
          list.push(
            `${label} needs at least ${constraint.minLeadTimeMinutes} minutes of lead time.`
          );
        }
      }

      if (minutesAhead > constraint.maxLeadTimeDays * 24 * 60) {
        const key = `${label}-far`;
        if (!seen.has(key)) {
          seen.add(key);
          list.push(
            `${label} accepts schedules up to ${constraint.maxLeadTimeDays} days ahead.`
          );
        }
      }
    }

    return list;
  }, [media, targets, scheduledAt, constraints, accountById, now]);

  /** TikTok Direct Post is invalid until the creator picks a privacy level. */
  const missingTikTokPrivacy = targets.some((target) => {
    const account = accountById.get(target.connectedAccountId);
    return (
      account?.platform === "TIKTOK" &&
      account.tiktokPostMode === "DIRECT_POST" &&
      !(target.options as TikTokTargetOptions).privacyLevel
    );
  });

  const canSubmit =
    media !== null &&
    targets.length > 0 &&
    warnings.length === 0 &&
    !missingTikTokPrivacy &&
    !submitting;

  async function submit() {
    if (!media) return;
    setSubmitting(true);
    setError(null);
    setFieldErrors([]);

    const res = await fetch("/api/scheduler/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mediaStorageKey: media.mediaStorageKey,
        mediaMimeType: media.mimeType,
        caption,
        scheduledAt: new Date(scheduledAt).toISOString(),
        targets: targets.map((target) => ({
          connectedAccountId: target.connectedAccountId,
          mediaType: target.mediaType,
          caption: target.caption || undefined,
          platformOptions: target.options,
        })),
      }),
    });

    const payload = await res.json();
    setSubmitting(false);

    if (!payload.success) {
      setError(payload.error ?? "Could not schedule this post");
      setFieldErrors(
        (payload.data?.errors ?? []).map(
          (e: { error: string }) => e.error
        )
      );
      return;
    }

    router.push("/scheduler");
  }

  const activeAccounts = accounts.filter((a) => a.status === "ACTIVE");

  return (
    <div className="max-w-3xl space-y-8">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Schedule a post</h1>
        <p className="text-sm text-muted">
          Upload once, publish to as many accounts as you like. Your original
          file is uploaded untouched — OpenReply never re-encodes it.
        </p>
      </header>

      {/* 1 — media */}
      <section className="space-y-2">
        <h2 className="text-base font-medium">1. Video</h2>
        <input
          type="file"
          accept="video/mp4,video/quicktime,video/webm"
          disabled={uploading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
          className="block w-full text-sm"
        />
        {uploading && <p className="text-sm text-muted">Uploading…</p>}
        {media && (
          <p className="text-sm text-success">
            {media.filename ? decodeURIComponent(media.filename) : "Uploaded"} —{" "}
            {(media.sizeBytes / 1024 ** 2).toFixed(1)} MB, {media.mimeType}
          </p>
        )}
      </section>

      {/* 2 — caption */}
      <section className="space-y-2">
        <h2 className="text-base font-medium">2. Caption</h2>
        <textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          rows={4}
          placeholder="Shared caption. You can override it per account below."
          className="w-full rounded border border-border bg-surface px-3 py-2 text-sm"
        />
      </section>

      {/* 3 — time */}
      <section className="space-y-2">
        <h2 className="text-base font-medium">3. When</h2>
        <input
          type="datetime-local"
          value={scheduledAt}
          onChange={(e) => setScheduledAt(e.target.value)}
          className="rounded border border-border bg-surface px-3 py-2 text-sm"
        />
        <p className="text-sm text-muted">
          Your local time ({Intl.DateTimeFormat().resolvedOptions().timeZone}).
        </p>
      </section>

      {/* 4 — targets */}
      <section className="space-y-3">
        <h2 className="text-base font-medium">4. Where</h2>

        {activeAccounts.length === 0 && (
          <p className="rounded border border-border bg-surface px-4 py-3 text-sm text-muted">
            No accounts are connected yet.{" "}
            <a href="/scheduler/connections" className="underline">
              Connect one
            </a>
            .
          </p>
        )}

        {PLATFORM_ORDER.map((platform: PlatformKey) => {
          const platformAccounts = activeAccounts.filter(
            (a) => a.platform === platform
          );
          if (platformAccounts.length === 0) return null;
          const meta = PLATFORM_META[platform];

          return (
            <div key={platform} className="space-y-2">
              <p className="text-sm font-medium">{meta.label}</p>
              {platformAccounts.map((account) => {
                const target = targets.find(
                  (t) => t.connectedAccountId === account.id
                );
                const selected = Boolean(target);

                return (
                  <div
                    key={account.id}
                    className="rounded border border-border bg-surface px-4 py-3 space-y-3"
                  >
                    <label className="flex items-center gap-3 text-sm">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleTarget(account)}
                      />
                      <span className="font-medium">{account.displayName}</span>
                    </label>

                    {account.limitation && (
                      <p className="text-sm text-warning">
                        {account.limitation}
                      </p>
                    )}

                    {selected && target && (
                      <div className="space-y-3 border-t border-border pt-3">
                        {meta.mediaTypes.length > 1 && (
                          <div className="space-y-1">
                            <label className="block text-sm font-medium">
                              Post as
                            </label>
                            <select
                              value={target.mediaType}
                              onChange={(e) =>
                                updateTarget(account.id, {
                                  mediaType: e.target.value,
                                })
                              }
                              className="rounded border border-border bg-surface px-3 py-2 text-sm"
                            >
                              {meta.mediaTypes.map((type) => (
                                <option key={type.value} value={type.value}>
                                  {type.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}

                        <div className="space-y-1">
                          <label className="block text-sm font-medium">
                            Caption override
                          </label>
                          <textarea
                            value={target.caption}
                            onChange={(e) =>
                              updateTarget(account.id, {
                                caption: e.target.value,
                              })
                            }
                            rows={2}
                            placeholder="Leave empty to use the shared caption"
                            className="w-full rounded border border-border bg-surface px-3 py-2 text-sm"
                          />
                        </div>

                        {platform === "TIKTOK" && (
                          <TikTokOptions
                            postMode={account.tiktokPostMode ?? "INBOX"}
                            value={target.options}
                            onChange={(options) =>
                              updateTarget(account.id, {
                                options: { ...target.options, ...options },
                              })
                            }
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </section>

      {warnings.length > 0 && (
        <ul className="space-y-1">
          {warnings.map((warning) => (
            <li key={warning} className="text-sm text-error">
              {warning}
            </li>
          ))}
        </ul>
      )}

      {missingTikTokPrivacy && (
        <p className="text-sm text-error">
          Choose who can see your TikTok post — TikTok requires an explicit
          choice.
        </p>
      )}

      {error && <p className="text-sm text-error">{error}</p>}
      {fieldErrors.map((message) => (
        <p key={message} className="text-sm text-error">
          {message}
        </p>
      ))}

      <button
        onClick={() => void submit()}
        disabled={!canSubmit}
        className="rounded border border-border px-4 py-2 text-sm font-medium hover:bg-surface disabled:opacity-50"
      >
        {submitting ? "Scheduling…" : `Schedule to ${targets.length} account(s)`}
      </button>
    </div>
  );
}
