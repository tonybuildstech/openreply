"use client";

/**
 * Composer — upload one or more files, schedule them to any number of accounts.
 *
 * Validation happens at selection time against each platform's real limits.
 * The rule from the brief still holds, with one deliberate exception: warn or
 * refuse, never *silently* re-encode. Cropping a photo does re-encode it, and
 * only ever after an explicit click — the "Original" default uploads the bytes
 * as they were.
 *
 * The exception exists because Instagram REJECTS stills outside 4:5–1.91:1
 * rather than cropping them, so for an out-of-range photo a crop is the only
 * route to publishing at all. Refusing to submit until it is resolved is what
 * keeps that failure here, in front of the user, instead of in the worker at
 * the scheduled minute.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import PlatformLogo, {
  AccountAvatar,
} from "@/components/scheduler/platform-logo";
import PlatformOptions from "@/components/scheduler/platform-options";
import MediaTray, {
  itemBlocker,
  type TrayItem,
} from "@/components/scheduler/media-tray";
import {
  PLATFORM_META,
  PLATFORM_ORDER,
  derivePostType,
  selectionBlocker,
  type PlatformKey,
} from "@/components/scheduler/platform-meta";
import { cropImageToRatio } from "@/lib/media/crop-image";
import { probeMedia } from "@/lib/media/probe";
import type { AspectPreset } from "@/lib/media/aspect";
import type {
  ComposerAccount,
  ComposerTarget,
  TargetOptions,
} from "@/components/scheduler/types";

/**
 * One picked file, from selection through to submission.
 *
 * `file` is the ORIGINAL the user chose and is kept for the whole session: a
 * ratio change re-crops from it, so switching 4:5 → 1:1 → 4:5 never compounds
 * JPEG loss the way re-cropping the previous crop would.
 */
interface ComposerMediaItem extends TrayItem {
  file: File;
  /** Null while the upload is in flight. */
  storageKey: string | null;
  /** Set once a crop has been applied, e.g. "4:5". */
  croppedToRatio: string | null;
}

interface PlatformConstraint {
  videoMimeTypes: string[];
  imageMimeTypes: string[];
  maxFileBytes?: number;
  maxImageBytes?: number;
  imageAspectRatioRange?: { min: number; max: number };
  carousel?: { minItems: number; maxItems: number; allowsVideo: boolean };
  minLeadTimeMinutes: number;
  maxLeadTimeDays: number;
  notes: string[];
}

/** Instagram's carousel ceiling, and the most any platform accepts. */
const MAX_ITEMS = 10;

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
  const [media, setMedia] = useState<ComposerMediaItem[]>([]);
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

  const accountById = useMemo(
    () => new Map(accounts.map((a) => [a.id, a])),
    [accounts]
  );

  /** Kinds in carousel order — what every post-type decision keys off. */
  const mediaKinds = useMemo(
    () => media.map((item) => item.kind),
    [media]
  );

  const instagramRange = constraints.INSTAGRAM?.imageAspectRatioRange;

  /** Items Instagram would reject outright until they are cropped. */
  const blockedItems = useMemo(
    () =>
      media
        .map((item) => itemBlocker(item, instagramRange))
        .filter((blocker): blocker is string => blocker !== null),
    [media, instagramRange]
  );


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

  // Object URLs are revoked when an item is removed and on unmount. Without
  // this a ten-photo session pins every original in memory for the life of the
  // page. Read through a ref so the cleanup sees the final list without
  // re-running (and revoking a live URL) on every change.
  const mediaRef = useRef<ComposerMediaItem[]>([]);
  useEffect(() => {
    mediaRef.current = media;
  }, [media]);
  useEffect(() => {
    return () => {
      for (const item of mediaRef.current) URL.revokeObjectURL(item.previewUrl);
    };
  }, []);

  /**
   * Send bytes to storage and return the key.
   *
   * Sent as a raw stream, not multipart: the server pipes it straight to disk
   * and never buffers the whole file.
   */
  async function uploadBlob(
    body: Blob,
    contentType: string,
    filename: string
  ): Promise<{ storageKey: string; sizeBytes: number }> {
    const res = await fetch("/api/media/upload", {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "x-filename": encodeURIComponent(filename),
      },
      body,
    });
    const payload = await res.json();
    if (!payload.success) throw new Error(payload.error ?? "Upload failed");

    return {
      storageKey: payload.data.mediaStorageKey,
      sizeBytes: payload.data.sizeBytes,
    };
  }

  function patchItem(id: string, patch: Partial<ComposerMediaItem>) {
    setMedia((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
  }

  /** Probe, then upload, each picked file — appended in the order chosen. */
  async function addFiles(files: File[]) {
    const room = MAX_ITEMS - media.length;
    if (room <= 0) return;

    const accepted = files.slice(0, room);
    if (accepted.length < files.length) {
      setError(`Instagram allows at most ${MAX_ITEMS} items in one post.`);
    }

    const staged: ComposerMediaItem[] = accepted.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      file,
      previewUrl: URL.createObjectURL(file),
      filename: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      kind: file.type.startsWith("image/") ? "IMAGE" : "VIDEO",
      widthPx: null,
      heightPx: null,
      storageKey: null,
      ratioId: "ORIGINAL",
      croppedToRatio: null,
      uploading: true,
      error: null,
    }));

    setMedia((current) => [...current, ...staged]);
    setUploading(true);

    for (const item of staged) {
      // Probed before upload so the tray can warn about ratio immediately,
      // rather than after a long transfer.
      const probe = await probeMedia(item.file);
      patchItem(item.id, {
        widthPx: probe.widthPx,
        heightPx: probe.heightPx,
      });

      try {
        const { storageKey, sizeBytes } = await uploadBlob(
          item.file,
          item.file.type,
          item.file.name
        );
        patchItem(item.id, { storageKey, sizeBytes, uploading: false });
      } catch (uploadError) {
        patchItem(item.id, {
          uploading: false,
          error:
            uploadError instanceof Error
              ? uploadError.message
              : "Upload failed",
        });
      }
    }

    setUploading(false);
  }

  /**
   * Apply (or undo) a crop.
   *
   * Re-crops from the ORIGINAL file every time, then uploads the result as a
   * new object. The previously uploaded key is left behind: nothing references
   * it, so it is never published, and the existing "Replace" flow already
   * orphans files the same way. Cleaning it up would mean a delete endpoint
   * that accepts a key from the client, which is a worse trade.
   */
  async function applyRatio(id: string, preset: AspectPreset) {
    const item = media.find((entry) => entry.id === id);
    if (!item || item.kind !== "IMAGE") return;

    patchItem(id, { ratioId: preset.id, uploading: true, error: null });

    try {
      if (preset.ratio === null) {
        // Back to the untouched original — the no-re-encode path.
        const { storageKey, sizeBytes } = await uploadBlob(
          item.file,
          item.file.type,
          item.file.name
        );
        patchItem(id, {
          storageKey,
          sizeBytes,
          croppedToRatio: null,
          widthPx: item.widthPx,
          heightPx: item.heightPx,
          uploading: false,
        });
        return;
      }

      const cropped = await cropImageToRatio(
        item.file,
        preset.ratio,
        preset.label
      );
      const { storageKey, sizeBytes } = await uploadBlob(
        cropped.blob,
        "image/jpeg",
        item.file.name.replace(/\.[^.]+$/, "") + ".jpg"
      );

      patchItem(id, {
        storageKey,
        sizeBytes,
        widthPx: cropped.widthPx,
        heightPx: cropped.heightPx,
        croppedToRatio: preset.id,
        uploading: false,
      });
    } catch (cropError) {
      patchItem(id, {
        ratioId: "ORIGINAL",
        uploading: false,
        error:
          cropError instanceof Error ? cropError.message : "Could not crop this image",
      });
    }
  }

  function removeItem(id: string) {
    setMedia((current) => {
      const target = current.find((item) => item.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  }

  function reorder(fromIndex: number, toIndex: number) {
    setMedia((current) => {
      if (toIndex < 0 || toIndex >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
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
            mediaType: derivePostType(account.platform, mediaKinds),
            caption: "",
            options: {},
          },
        ];
      });
      setExpanded((current) => (current === account.id ? null : account.id));
    },
    [mediaKinds]
  );

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

  /**
   * Client-side warnings for the platforms actually selected. The API
   * re-validates everything — this exists so the user finds out before
   * submitting, not after.
   */
  const warnings = useMemo(() => {
    if (media.length === 0 || targets.length === 0 || now === null) return [];
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

      // Only Instagram takes stills or more than one file. Said plainly here
      // rather than left to the API, because the alternative reads as a bug.
      const blocker = selectionBlocker(account.platform, mediaKinds);
      if (blocker) push(`${label}-selection`, blocker);

      for (const item of media) {
        const accepted =
          item.kind === "IMAGE"
            ? constraint.imageMimeTypes
            : constraint.videoMimeTypes;

        if (accepted.length > 0 && !accepted.includes(item.mimeType)) {
          push(
            `${label}-mime-${item.mimeType}`,
            `${label} does not accept ${item.mimeType} — it needs ${accepted.join(" or ")}.`
          );
        }

        const cap =
          item.kind === "IMAGE" ? constraint.maxImageBytes : constraint.maxFileBytes;
        if (cap && item.sizeBytes > cap) {
          push(
            `${label}-size-${item.kind}`,
            item.kind === "IMAGE"
              ? `${label} limits photos to ${Math.round(cap / 1024 ** 2)} MB.`
              : `${label} limits uploads to ${(cap / 1024 ** 3).toFixed(1)} GB.`
          );
        }
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
  }, [media, mediaKinds, targets, scheduledAt, constraints, accountById, now]);

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
    media.length > 0 &&
    // Every file has to be in storage before the API can be told about it.
    media.every((item) => item.storageKey !== null && !item.uploading) &&
    // An out-of-range still is a hard stop: Instagram rejects the container
    // rather than cropping, and that failure would land in the worker.
    blockedItems.length === 0 &&
    targets.length > 0 &&
    warnings.length === 0 &&
    !missingTikTokPrivacy &&
    !submitting;

  async function submit() {
    if (media.length === 0) return;
    setSubmitting(true);
    setError(null);
    setFieldErrors([]);

    const res = await fetch("/api/scheduler/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Array order IS carousel order. The server reads MIME type, size and
        // kind back from storage, so only the key, the browser-probed
        // dimensions and any crop we applied are sent.
        media: media.map((item) => ({
          storageKey: item.storageKey as string,
          ...(item.widthPx ? { widthPx: item.widthPx } : {}),
          ...(item.heightPx ? { heightPx: item.heightPx } : {}),
          ...(item.croppedToRatio
            ? { croppedToRatio: item.croppedToRatio }
            : {}),
        })),
        caption,
        scheduledAt: new Date(scheduledAt).toISOString(),
        targets: targets.map((target) => ({
          connectedAccountId: target.connectedAccountId,
          // Derived at submit rather than stored: adding a second photo turns
          // an Instagram photo post into a carousel, and a cached copy of the
          // post type would be the thing that goes stale.
          mediaType: derivePostType(
            accountById.get(target.connectedAccountId)!.platform,
            mediaKinds,
            target.mediaType
          ),
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
          Upload once, publish to as many accounts as you like. Your files go
          up untouched unless you choose to crop a photo — that is the only
          thing OpenReply ever re-encodes.
        </p>
      </header>

      {/* 1 — media */}
      <Card>
        <StepHeading step={1} title="Media" />

        {media.length > 0 && (
          <div className="mb-3">
            <MediaTray
              items={media}
              imageRange={instagramRange}
              onReorder={reorder}
              onRemove={removeItem}
              onRatioChange={(id, preset) => void applyRatio(id, preset)}
              onApplyRatioToAll={(preset) => {
                for (const item of media) {
                  if (item.kind === "IMAGE") void applyRatio(item.id, preset);
                }
              }}
            />
          </div>
        )}

        {media.length < MAX_ITEMS && (
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-background px-6 py-8 text-center transition hover:border-foreground/30">
            <span className="text-sm font-medium">
              {uploading
                ? "Uploading…"
                : media.length === 0
                  ? "Choose photos or a video"
                  : "Add another"}
            </span>
            <span className="text-xs text-muted">
              JPEG photos or MP4 / MOV / WebM video. Up to {MAX_ITEMS} items —
              two or more become an Instagram carousel.
            </span>
            <input
              type="file"
              multiple
              accept="image/jpeg,video/mp4,video/quicktime,video/webm"
              disabled={uploading}
              onChange={(event) => {
                const picked = Array.from(event.target.files ?? []);
                // Reset so re-picking the same file fires onChange again.
                event.target.value = "";
                if (picked.length > 0) void addFiles(picked);
              }}
              className="hidden"
            />
          </label>
        )}

        {media.length > 0 && (
          <p className="mt-3 text-xs text-muted">
            {mediaKinds.length > 1
              ? `${mediaKinds.length} items — drag to reorder, or use the arrows.`
              : "Drag in more files to build a carousel."}
          </p>
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
                      // Only Instagram takes stills or more than one file.
                      // Disabled with the reason rather than silently accepted
                      // and rejected later by the API.
                      const blocked = selectionBlocker(
                        account.platform,
                        mediaKinds
                      );

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
                              disabled={Boolean(blocked) && !selected}
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
                              {blocked ? (
                                <p className="text-xs text-warning">{blocked}</p>
                              ) : (
                                account.limitation && (
                                  <p className="truncate text-xs text-warning">
                                    {account.limitation}
                                  </p>
                                )
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
                              {/* Instagram's shape follows from the files, so
                                  it is reported rather than chosen — offering
                                  "Carousel" with one file selected would be a
                                  promise the API rejects. Facebook is a real
                                  choice: one video, two valid destinations. */}
                              {account.platform === "INSTAGRAM" ? (
                                <p className="text-sm text-muted">
                                  Posting as{" "}
                                  <span className="font-medium text-foreground">
                                    {meta.mediaTypes.find(
                                      (type) =>
                                        type.value ===
                                        derivePostType(
                                          account.platform,
                                          mediaKinds
                                        )
                                    )?.label ?? "Reel"}
                                  </span>
                                  {mediaKinds.length > 1 &&
                                    ` — ${mediaKinds.length} items in order`}
                                </p>
                              ) : (
                                meta.mediaTypes.length > 1 && (
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
                                )
                              )}

                              {/* Confirmed 2026-08-08: the Instagram Audio API
                                  is Facebook-Login-only AND Reels-only, so no
                                  audio can be attached on our flow at all.
                                  Saying so beats leaving the user hunting. */}
                              {account.platform === "INSTAGRAM" && (
                                <p className="text-xs text-muted">
                                  Instagram&apos;s API cannot add music. Bake the
                                  audio into your file, or add a track in the
                                  Instagram app after publishing.
                                </p>
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
        blockedItems.length > 0 ||
        missingTikTokPrivacy ||
        error ||
        fieldErrors.length > 0) && (
        <div className="space-y-2 rounded-xl border border-error/40 bg-error/5 px-4 py-3">
          {blockedItems.length > 0 && (
            <p className="text-sm text-error">
              {blockedItems.length === 1
                ? "One photo is outside the aspect ratio Instagram accepts."
                : `${blockedItems.length} photos are outside the aspect ratio Instagram accepts.`}{" "}
              Pick a crop on each, or remove them — Instagram rejects the post
              otherwise.
            </p>
          )}
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
