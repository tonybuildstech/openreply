"use client";

/**
 * Composer — upload one video, schedule it to any number of accounts.
 *
 * Validation happens at selection time against each platform's real limits.
 * The rule from the brief holds: warn or refuse, never silently re-encode.
 * Nothing in OpenReply touches the file.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import PlatformLogo, {
  AccountAvatar,
} from "@/components/scheduler/platform-logo";
import PlatformOptions from "@/components/scheduler/platform-options";
import {
  PLATFORM_META,
  PLATFORM_ORDER,
  type PlatformKey,
} from "@/components/scheduler/platform-meta";
import type {
  ComposerAccount,
  ComposerTarget,
  TargetOptions,
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

function StepHeading({ step, title }: { step: number; title: string }) {
  return (
    <div className="mb-4 flex items-center gap-3">
      <span className="flex h-6 w-6 items-center justify-center rounded-full border border-border text-xs font-semibold text-muted">
        {step}
      </span>
      <h2 className="text-base font-semibold">{title}</h2>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      {children}
    </section>
  );
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
  const [expanded, setExpanded] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);

  // Wall-clock time held as state rather than read during render: lead-time
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

  const toggleTarget = useCallback((account: ComposerAccount) => {
    setTargets((current) => {
      const existing = current.find((t) => t.connectedAccountId === account.id);
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
    setExpanded((current) => (current === account.id ? null : account.id));
  }, []);

  function updateTarget(id: string, patch: Partial<ComposerTarget>) {
    setTargets((current) =>
      current.map((t) => (t.connectedAccountId === id ? { ...t, ...patch } : t))
    );
  }

  function updateOptions(id: string, patch: Partial<TargetOptions>) {
    setTargets((current) =>
      current.map((t) =>
        t.connectedAccountId === id
          ? { ...t, options: { ...t.options, ...patch } }
          : t
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

      const push = (key: string, message: string) => {
        if (seen.has(key)) return;
        seen.add(key);
        list.push(message);
      };

      if (!constraint.mimeTypes.includes(media.mimeType)) {
        push(
          `${label}-mime`,
          `${label} does not accept ${media.mimeType} — it needs ${constraint.mimeTypes.join(" or ")}.`
        );
      }

      if (constraint.maxFileBytes && media.sizeBytes > constraint.maxFileBytes) {
        push(
          `${label}-size`,
          `${label} limits uploads to ${(constraint.maxFileBytes / 1024 ** 3).toFixed(1)} GB.`
        );
      }

      if (minutesAhead < constraint.minLeadTimeMinutes) {
        push(
          `${label}-soon`,
          `${label} needs at least ${constraint.minLeadTimeMinutes} minutes of lead time.`
        );
      }

      if (minutesAhead > constraint.maxLeadTimeDays * 24 * 60) {
        push(
          `${label}-far`,
          `${label} accepts schedules up to ${constraint.maxLeadTimeDays} days ahead.`
        );
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
      !target.options.privacyLevel
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
        (payload.data?.errors ?? []).map((e: { error: string }) => e.error)
      );
      return;
    }

    router.push("/scheduler");
  }

  const activeAccounts = accounts.filter((a) => a.status === "ACTIVE");

  return (
    <div className="max-w-4xl space-y-5 pb-12">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Schedule a post</h1>
        <p className="text-sm text-muted">
          Upload once, publish to as many accounts as you like. Your original
          file is uploaded untouched — OpenReply never re-encodes it.
        </p>
      </header>

      {/* 1 — media */}
      <Card>
        <StepHeading step={1} title="Video" />
        {media ? (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-background px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {media.filename
                  ? decodeURIComponent(media.filename)
                  : "Uploaded video"}
              </p>
              <p className="mt-0.5 text-xs text-muted">
                {(media.sizeBytes / 1024 ** 2).toFixed(1)} MB · {media.mimeType}
              </p>
            </div>
            <button
              onClick={() => setMedia(null)}
              className="shrink-0 rounded-md px-2 py-1 text-xs text-muted transition hover:bg-surface hover:text-foreground"
            >
              Replace
            </button>
          </div>
        ) : (
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-background px-6 py-10 text-center transition hover:border-foreground/30">
            <span className="text-sm font-medium">
              {uploading ? "Uploading…" : "Choose a video"}
            </span>
            <span className="text-xs text-muted">
              MP4, MOV or WebM. Uploaded exactly as-is.
            </span>
            <input
              type="file"
              accept="video/mp4,video/quicktime,video/webm"
              disabled={uploading}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
              className="hidden"
            />
          </label>
        )}
      </Card>

      {/* 2 — caption */}
      <Card>
        <StepHeading step={2} title="Caption" />
        <textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          rows={4}
          placeholder="Shared caption. You can override it per account below."
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted focus:border-foreground/30 focus:outline-none"
        />
      </Card>

      {/* 3 — time */}
      <Card>
        <StepHeading step={3} title="When" />
        <input
          type="datetime-local"
          value={scheduledAt}
          onChange={(e) => setScheduledAt(e.target.value)}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-foreground/30 focus:outline-none"
        />
        <p className="mt-2 text-xs text-muted">
          Your local time ({Intl.DateTimeFormat().resolvedOptions().timeZone}).
        </p>
      </Card>

      {/* 4 — targets */}
      <Card>
        <StepHeading step={4} title="Where" />

        {activeAccounts.length === 0 ? (
          <p className="rounded-lg border border-border bg-background px-4 py-6 text-center text-sm text-muted">
            No accounts are connected yet.{" "}
            <Link href="/connections" className="underline">
              Connect one
            </Link>
            .
          </p>
        ) : (
          <div className="space-y-5">
            {PLATFORM_ORDER.map((platform: PlatformKey) => {
              const platformAccounts = activeAccounts.filter(
                (a) => a.platform === platform
              );
              if (platformAccounts.length === 0) return null;
              const meta = PLATFORM_META[platform];

              return (
                <div key={platform} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <PlatformLogo platform={platform} className="h-4 w-4" />
                    <p className="text-sm font-medium">{meta.label}</p>
                    <span className="text-xs text-muted">
                      {meta.scheduling === "native"
                        ? "platform-scheduled"
                        : "worker-published"}
                    </span>
                  </div>

                  <div className="space-y-2">
                    {platformAccounts.map((account) => {
                      const target = targets.find(
                        (t) => t.connectedAccountId === account.id
                      );
                      const selected = Boolean(target);
                      const isOpen = expanded === account.id;

                      return (
                        <div
                          key={account.id}
                          className={`overflow-hidden rounded-lg border transition ${
                            selected
                              ? "border-foreground/25 bg-background"
                              : "border-border bg-background/40"
                          }`}
                        >
                          <div className="flex items-center gap-3 px-3 py-3">
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={() => toggleTarget(account)}
                              aria-label={`Post to ${account.displayName}`}
                            />
                            <AccountAvatar
                              platform={account.platform}
                              avatarUrl={account.avatarUrl}
                              displayName={account.displayName}
                              size="sm"
                            />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium">
                                {account.displayName}
                              </p>
                              {account.limitation && (
                                <p className="truncate text-xs text-warning">
                                  {account.limitation}
                                </p>
                              )}
                            </div>

                            {selected && (
                              <button
                                onClick={() =>
                                  setExpanded(isOpen ? null : account.id)
                                }
                                className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs text-muted transition hover:text-foreground"
                              >
                                {isOpen ? "Hide options" : "Options"}
                              </button>
                            )}
                          </div>

                          {selected && target && isOpen && (
                            <div className="space-y-4 border-t border-border px-4 py-4">
                              {meta.mediaTypes.length > 1 && (
                                <div className="space-y-1.5">
                                  <span className="block text-sm font-medium">
                                    Post as
                                  </span>
                                  <div className="flex gap-2">
                                    {meta.mediaTypes.map((type) => (
                                      <button
                                        key={type.value}
                                        onClick={() =>
                                          updateTarget(account.id, {
                                            mediaType: type.value,
                                          })
                                        }
                                        className={`rounded-md border px-3 py-1.5 text-sm transition ${
                                          target.mediaType === type.value
                                            ? "border-foreground/30 bg-surface font-medium"
                                            : "border-border text-muted hover:text-foreground"
                                        }`}
                                      >
                                        {type.label}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              )}

                              <label className="block space-y-1.5">
                                <span className="block text-sm font-medium">
                                  Caption override
                                </span>
                                <textarea
                                  value={target.caption}
                                  onChange={(e) =>
                                    updateTarget(account.id, {
                                      caption: e.target.value,
                                    })
                                  }
                                  rows={2}
                                  placeholder="Leave empty to use the shared caption"
                                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted focus:border-foreground/30 focus:outline-none"
                                />
                              </label>

                              <PlatformOptions
                                platform={account.platform}
                                mediaType={target.mediaType}
                                value={target.options}
                                tiktokPostMode={account.tiktokPostMode}
                                onChange={(patch) =>
                                  updateOptions(account.id, patch)
                                }
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {(warnings.length > 0 ||
        missingTikTokPrivacy ||
        error ||
        fieldErrors.length > 0) && (
        <div className="space-y-2 rounded-xl border border-error/40 bg-error/5 px-4 py-3">
          {warnings.map((warning) => (
            <p key={warning} className="text-sm text-error">
              {warning}
            </p>
          ))}
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
        </div>
      )}

      <div className="flex items-center gap-4">
        <button
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="rounded-lg border border-border bg-surface px-5 py-2.5 text-sm font-medium transition hover:bg-background disabled:opacity-50"
        >
          {submitting
            ? "Scheduling…"
            : `Schedule to ${targets.length} account${targets.length === 1 ? "" : "s"}`}
        </button>
        <Link href="/scheduler" className="text-sm text-muted hover:underline">
          Cancel
        </Link>
      </div>
    </div>
  );
}
