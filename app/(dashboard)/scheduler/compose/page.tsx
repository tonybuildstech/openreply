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
import { prepareImage } from "@/lib/media/crop-image";
import { probeMedia } from "@/lib/media/probe";
import {
  CENTRED_FOCUS,
  FEED_PRESETS,
  TIKTOK_MAX_WIDTH_PX,
  type AspectPreset,
  type CropFocus,
} from "@/lib/media/aspect";
import TagPeopleModal from "@/components/scheduler/tag-people-modal";
import { MAX_TAGS_PER_ITEM } from "@/lib/scheduler/media-input";
// The same minute-to-minute rule the API validates with, so the composer and
// the server cannot disagree about how far away a chosen minute is.
import { leadTimeMinutes } from "@/lib/scheduler/constraints";
import {
  CAROUSEL_MAX_ITEMS,
  TIKTOK_PHOTO_MAX_ITEMS,
} from "@/lib/scheduler/types";
import type {
  ComposerAccount,
  ComposerTarget,
  MediaUserTag,
  TargetOptions,
} from "@/components/scheduler/types";

/**
 * One picked file, from selection through to submission.
 *
 * `file` is the ORIGINAL the user chose and is kept for the whole session:
 * every crop re-renders from it, so switching 4:5 → 1:1 → 4:5, or nudging the
 * crop twenty times while dragging, never compounds JPEG loss the way
 * re-cropping the previous crop would.
 */
interface ComposerMediaItem extends TrayItem {
  file: File;
  /** Null while the upload is in flight. */
  storageKey: string | null;
  /** Set once a crop has been applied, e.g. "PORTRAIT". */
  croppedToRatio: string | null;
}

/**
 * How long to wait after the last crop change before re-rendering the file.
 *
 * Dragging the crop fires on every pointer move; without this each one would
 * decode, re-encode and upload the whole photo. Long enough to coalesce a drag,
 * short enough that a single click on a ratio still feels immediate.
 */
const CROP_DEBOUNCE_MS = 250;

interface PlatformConstraint {
  videoMimeTypes: string[];
  imageMimeTypes: string[];
  maxFileBytes?: number;
  maxImageBytes?: number;
  imageAspectRatioRange?: { min: number; max: number };
  carousel?: { minItems: number; maxItems: number; allowsVideo: boolean };
  maxCaptionChars?: number;
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
  /** Media item whose tagging modal is open, if any. */
  const [taggingId, setTaggingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Rendering TikTok's narrower copies — can take a while for 35 photos. */
  const [preparingTikTok, setPreparingTikTok] = useState(false);
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
  const instagramMaxImageBytes = constraints.INSTAGRAM?.maxImageBytes;

  /** The platforms currently ticked, deduplicated — several accounts can share one. */
  const selectedPlatforms = useMemo(() => {
    const set = new Set<PlatformKey>();
    for (const target of targets) {
      const account = accountById.get(target.connectedAccountId);
      if (account) set.add(account.platform);
    }
    return [...set];
  }, [targets, accountById]);

  /**
   * How many files the current selection allows.
   *
   * There is no composer-wide ceiling any more: Instagram caps a carousel at
   * 10 and TikTok a photo post at 35. The effective limit is the SMALLEST of
   * the platforms actually ticked — and before anything is ticked it is the
   * largest any of them would take, so a TikTok-only post can reach 35 without
   * having to pick the account first.
   *
   * Read from the constraints the API sends rather than hardcoded here; the
   * constants are only the fallback for the first render, before
   * /api/scheduler/accounts has answered.
   */
  const maxItems = useMemo(() => {
    const ceilingFor = (platform: PlatformKey) => {
      if (platform === "INSTAGRAM") {
        return constraints.INSTAGRAM?.carousel?.maxItems ?? CAROUSEL_MAX_ITEMS;
      }
      if (platform === "TIKTOK") {
        // Only the PHOTO post type is multi-item; a video target caps at 1, and
        // `selectionBlocker` explains that separately rather than silently
        // shrinking the tray to one slot.
        return mediaKinds.length > 0 && mediaKinds.every((k) => k === "IMAGE")
          ? (constraints.TIKTOK?.carousel?.maxItems ?? TIKTOK_PHOTO_MAX_ITEMS)
          : Number.POSITIVE_INFINITY;
      }
      return Number.POSITIVE_INFINITY;
    };

    const ceilings = selectedPlatforms.map(ceilingFor);
    if (ceilings.length === 0) {
      return Math.max(
        constraints.INSTAGRAM?.carousel?.maxItems ?? CAROUSEL_MAX_ITEMS,
        constraints.TIKTOK?.carousel?.maxItems ?? TIKTOK_PHOTO_MAX_ITEMS
      );
    }

    const limit = Math.min(...ceilings);
    return Number.isFinite(limit) ? limit : CAROUSEL_MAX_ITEMS;
  }, [selectedPlatforms, constraints, mediaKinds]);

  /** Which ticked platform is imposing `maxItems`, for an honest message. */
  const capOwner = useMemo(() => {
    if (selectedPlatforms.includes("INSTAGRAM") && maxItems === CAROUSEL_MAX_ITEMS) {
      return "Instagram";
    }
    if (selectedPlatforms.includes("TIKTOK")) return "TikTok";
    return null;
  }, [selectedPlatforms, maxItems]);

  /**
   * Files loaded beyond what the current selection allows.
   *
   * Blocks submission rather than truncating. Ticking Instagram with 35 photos
   * loaded has to say which ones must go — quietly publishing the first 10
   * would be exactly the kind of silent damage the rest of this composer
   * refuses to do.
   */
  const overCap = media.length > maxItems ? media.length - maxItems : 0;

  /** Items Instagram would reject outright until they are cropped or resized. */
  const blockedItems = useMemo(
    () =>
      media
        .map((item) =>
          itemBlocker(item, instagramRange, instagramMaxImageBytes)
        )
        .filter((blocker) => blocker !== null),
    [media, instagramRange, instagramMaxImageBytes]
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
    const room = maxItems - media.length;
    if (room <= 0) return;

    const accepted = files.slice(0, room);
    if (accepted.length < files.length) {
      setError(
        capOwner
          ? `${capOwner} allows at most ${maxItems} items in one post.`
          : `A post takes at most ${maxItems} items.`
      );
    }

    const staged: ComposerMediaItem[] = accepted.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      file,
      previewUrl: URL.createObjectURL(file),
      filename: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      kind: file.type.startsWith("image/") ? "IMAGE" : "VIDEO",
      sourceWidthPx: null,
      sourceHeightPx: null,
      outputWidthPx: null,
      outputHeightPx: null,
      storageKey: null,
      ratioId: "ORIGINAL",
      focus: CENTRED_FOCUS,
      userTags: [],
      croppedToRatio: null,
      compressed: false,
      uploading: true,
      cropPending: false,
      error: null,
    }));

    setMedia((current) => [...current, ...staged]);
    setUploading(true);

    for (const item of staged) {
      // Probed before upload so the tray can warn about ratio immediately,
      // rather than after a long transfer.
      const probe = await probeMedia(item.file);
      patchItem(item.id, {
        sourceWidthPx: probe.widthPx,
        sourceHeightPx: probe.heightPx,
        // Nothing has been applied yet, so what publishes IS the source.
        outputWidthPx: probe.widthPx,
        outputHeightPx: probe.heightPx,
      });

      // Claimed even though nothing has been cropped yet: the user can pick a
      // ratio while this transfer is still running, and the crop that starts
      // from that click must be able to overrule this result.
      const stale = claimWrite(item.id);

      try {
        const { storageKey, sizeBytes } = await uploadBlob(
          item.file,
          item.file.type,
          item.file.name
        );
        if (stale()) continue;
        patchItem(item.id, { storageKey, sizeBytes, uploading: false });
      } catch (uploadError) {
        if (stale()) continue;
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
   * Writes in flight, per item.
   *
   * **Every asynchronous path that sets `storageKey` must claim a generation
   * here first.** Two of them exist and they can overlap: the initial upload of
   * the file the user picked, and a crop re-render. Whichever finishes LAST
   * wins the field, and that is not necessarily the one the user asked for.
   *
   * That is not hypothetical — it is the bug behind "apply 4:5 to all applies
   * visually but not to the post". `addFiles` uploads the picked files one at a
   * time, so clicking the button while later ones are still in flight starts a
   * crop for an item whose original upload has not landed yet. The crop
   * finishes first, then the original upload overwrites `storageKey` with the
   * uncropped file. The tile still shows the crop, because `ratioId` was never
   * touched, and `cropPending` is already false, so submit is enabled and sends
   * the wrong key. Only the items still uploading at click time are affected,
   * which is why it looked like the button worked for some photos.
   */
  const writeSeq = useRef(new Map<string, number>());
  const cropTimers = useRef(new Map<string, number>());

  /**
   * Take ownership of this item's file. Returns a check for "superseded".
   *
   * Call before starting the work, check before writing the result.
   */
  function claimWrite(id: string): () => boolean {
    const seq = (writeSeq.current.get(id) ?? 0) + 1;
    writeSeq.current.set(id, seq);
    return () => writeSeq.current.get(id) !== seq;
  }

  useEffect(() => {
    const timers = cropTimers.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
    };
  }, []);

  /**
   * Produce the file this item should publish, and upload it.
   *
   * Always renders from the ORIGINAL file, then uploads the result as a new
   * object. The previously uploaded key is left behind: nothing references it,
   * so it is never published, and the existing "Replace" flow already orphans
   * files the same way. Cleaning it up would mean a delete endpoint that
   * accepts a key from the client, which is a worse trade.
   */
  async function renderAndUpload(
    item: ComposerMediaItem,
    next: { ratioId: string; focus: CropFocus; compress: boolean }
  ) {
    const { id, file } = item;
    const stale = claimWrite(id);

    const preset =
      FEED_PRESETS.find((option) => option.id === next.ratioId) ??
      FEED_PRESETS[0];

    patchItem(id, { uploading: true, error: null });

    try {
      // "Original" with no compression is the one path that re-encodes
      // nothing — the bytes the user chose are the bytes that go up.
      if (preset.ratio === null && !next.compress) {
        const { storageKey, sizeBytes } = await uploadBlob(
          file,
          file.type,
          file.name
        );
        if (stale()) return;
        patchItem(id, {
          storageKey,
          sizeBytes,
          croppedToRatio: null,
          compressed: false,
          outputWidthPx: item.sourceWidthPx,
          outputHeightPx: item.sourceHeightPx,
          uploading: false,
          cropPending: false,
        });
        return;
      }

      const rendered = await prepareImage(file, {
        targetRatio: preset.ratio,
        focus: next.focus,
        ratioLabel: preset.label,
        // Instagram scales anything wider down to 1440 itself, so producing it
        // here costs no visible quality and is what brings an oversized photo
        // under the 8 MB cap.
        maxBytes: instagramMaxImageBytes,
      });
      if (stale()) return;

      const { storageKey, sizeBytes } = await uploadBlob(
        rendered.blob,
        "image/jpeg",
        file.name.replace(/\.[^.]+$/, "") + ".jpg"
      );
      if (stale()) return;

      patchItem(id, {
        storageKey,
        sizeBytes,
        outputWidthPx: rendered.widthPx,
        outputHeightPx: rendered.heightPx,
        croppedToRatio: preset.ratio === null ? null : preset.id,
        compressed: next.compress,
        uploading: false,
        cropPending: false,
      });
    } catch (renderError) {
      if (stale()) return;
      patchItem(id, {
        ratioId: "ORIGINAL",
        uploading: false,
        cropPending: false,
        error:
          renderError instanceof Error
            ? renderError.message
            : "Could not crop this image",
      });
    }
  }

  /**
   * Renders run one at a time, through this chain.
   *
   * "Make all" fires a render for every photo at once, and each one holds a
   * decoded bitmap plus a canvas of the same size. Ten 4000×5000 photos is
   * roughly 1.6 GB of live pixels — enough that `toBlob` starts returning null
   * or the tab is killed. The failures land in the catch, which reverts
   * `ratioId`, so the visible result is a button that worked for some photos
   * and quietly not for others.
   *
   * Serialising costs about a second per photo and makes it deterministic.
   */
  const renderChain = useRef<Promise<void>>(Promise.resolve());

  /** Coalesce a burst of crop changes into one render, then queue it. */
  function scheduleRender(
    item: ComposerMediaItem,
    next: { ratioId: string; focus: CropFocus; compress: boolean }
  ) {
    const existing = cropTimers.current.get(item.id);
    if (existing !== undefined) window.clearTimeout(existing);

    cropTimers.current.set(
      item.id,
      window.setTimeout(() => {
        cropTimers.current.delete(item.id);
        renderChain.current = renderChain.current
          // One photo failing must not stall every photo behind it.
          .catch(() => {})
          .then(() => renderAndUpload(item, next));
      }, CROP_DEBOUNCE_MS)
    );
  }

  /** Switch this image to a different aspect ratio, re-centring the crop. */
  function applyRatio(id: string, preset: AspectPreset) {
    const item = media.find((entry) => entry.id === id);
    if (!item || item.kind !== "IMAGE") return;

    // A new shape keeps nothing of the old framing, so the previous focus is
    // meaningless against it — start from the centre, as Instagram would.
    patchItem(id, {
      ratioId: preset.id,
      focus: CENTRED_FOCUS,
      cropPending: true,
      error: null,
    });
    scheduleRender(item, {
      ratioId: preset.id,
      focus: CENTRED_FOCUS,
      compress: item.compressed && preset.ratio === null,
    });
  }

  /** Move the crop window. Updates the overlay now, the file shortly after. */
  function applyFocus(id: string, focus: CropFocus) {
    const item = media.find((entry) => entry.id === id);
    if (!item || item.kind !== "IMAGE" || item.ratioId === "ORIGINAL") return;

    patchItem(id, { focus, cropPending: true });
    scheduleRender(item, {
      ratioId: item.ratioId,
      focus,
      compress: item.compressed,
    });
  }

  /**
   * Re-encode an oversized photo at Instagram's own width ceiling.
   *
   * Explicit rather than automatic: this is a re-encode, and the composer's
   * promise is that nothing is re-encoded without a click.
   */
  function compressItem(id: string) {
    const item = media.find((entry) => entry.id === id);
    if (!item || item.kind !== "IMAGE") return;

    patchItem(id, { cropPending: true, error: null });
    scheduleRender(item, {
      ratioId: item.ratioId,
      focus: item.focus,
      compress: true,
    });
  }

  /**
   * Tags are metadata, not pixels — saving them re-renders nothing and
   * re-uploads nothing. They travel with the media row at submit.
   */
  function saveTags(id: string, tags: MediaUserTag[]) {
    patchItem(id, { userTags: tags });
    setTaggingId(null);
  }

  function removeItem(id: string) {
    // Cancel any pending render, and claim the write so an in-flight upload
    // cannot resurrect a removed item's state.
    const timer = cropTimers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    cropTimers.current.delete(id);
    claimWrite(id);

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
   * The strictest lead time the ticked platforms impose, and the first whole
   * minute that satisfies it.
   *
   * Exists because the refusal is otherwise a dead end. The time is step 3 and
   * the accounts are step 4, so a legal choice is made BEFORE the check that
   * judges it can run at all — and the minute spent picking accounts is the
   * very thing that can push it out of range. Offering the fix costs one line
   * of UI; leaving the user to work out which minute we would accept does not.
   */
  const earliestAllowed = useMemo(() => {
    if (targets.length === 0 || now === null) return null;

    let minutes = 0;
    for (const target of targets) {
      const account = accountById.get(target.connectedAccountId);
      const constraint = account ? constraints[account.platform] : undefined;
      if (constraint) {
        minutes = Math.max(minutes, constraint.minLeadTimeMinutes);
      }
    }
    if (minutes === 0) return null;

    // Rounded UP to the next whole minute. Rounding down would hand back a
    // minute that reads as legal here and is refused seconds later.
    const at = new Date(Math.ceil((now + minutes * 60_000) / 60_000) * 60_000);
    return { minutes, at, value: toLocalInputValue(at) };
  }, [targets, accountById, constraints, now]);

  /**
   * Client-side warnings for the platforms actually selected. The API
   * re-validates everything — this exists so the user finds out before
   * submitting, not after.
   */
  const warnings = useMemo(() => {
    if (media.length === 0 || targets.length === 0 || now === null) return [];
    const when = new Date(scheduledAt);
    // Whole minutes, matching the control the time was picked with — see
    // `leadTimeMinutes`. NaN while a half-typed date sits in the field, which
    // compares false against every limit and so warns about nothing.
    const minutesAhead = leadTimeMinutes(when, new Date(now));
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

        // Video only. An oversized PHOTO is already reported per-tile by
        // `itemBlocker`, with a button that fixes it — repeating it here would
        // put the same problem on screen twice, once without the remedy.
        if (
          item.kind === "VIDEO" &&
          constraint.maxFileBytes &&
          item.sizeBytes > constraint.maxFileBytes
        ) {
          push(
            `${label}-size-VIDEO`,
            `${label} limits uploads to ${(constraint.maxFileBytes / 1024 ** 3).toFixed(1)} GB.`
          );
        }
      }

      // Per platform, not per request: the same caption is fine for Instagram
      // and too long for TikTok, so the shared field cannot carry one limit.
      const effectiveCaption = target.caption || caption;
      if (
        constraint.maxCaptionChars &&
        effectiveCaption.length > constraint.maxCaptionChars
      ) {
        push(
          `${label}-caption`,
          `${label} caps the caption at ${constraint.maxCaptionChars} characters — yours is ${effectiveCaption.length}.`
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
  }, [
    media,
    mediaKinds,
    targets,
    caption,
    scheduledAt,
    constraints,
    accountById,
    now,
  ]);

  /** The chosen minute sits inside the strictest ticked platform's floor. */
  const scheduleTooSoon =
    earliestAllowed !== null &&
    now !== null &&
    leadTimeMinutes(new Date(scheduledAt), new Date(now)) <
      earliestAllowed.minutes;

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
    // Every file has to be in storage before the API can be told about it, and
    // `cropPending` covers the gap a debounce opens: the overlay already shows
    // the new framing while the file on disk is still the old one.
    media.every(
      (item) =>
        item.storageKey !== null && !item.uploading && !item.cropPending
    ) &&
    // An out-of-range still is a hard stop: Instagram rejects the container
    // rather than cropping, and that failure would land in the worker.
    blockedItems.length === 0 &&
    // Over the cap the ticked platforms allow. Refused rather than truncated —
    // the user decides which files go, not us.
    overCap === 0 &&
    targets.length > 0 &&
    warnings.length === 0 &&
    !missingTikTokPrivacy &&
    !submitting;

  /**
   * The TikTok copy of the current photo set, or null when none is needed.
   *
   * TikTok caps stills at 1080px where Instagram takes 1440, and the answer to
   * that is NOT to publish a worse picture to Instagram. So each photo that is
   * too wide is re-rendered from the ORIGINAL file at TikTok's ceiling — same
   * crop, same focus, so the two renditions are the same picture — uploaded as
   * a separate object, and handed to the TikTok target alone.
   *
   * Returns null when every photo already fits, which is the common case for
   * anything shot vertically. Then both targets share one file and nothing is
   * re-encoded at all.
   *
   * Runs at submit rather than on every crop change: a 35-photo set would
   * otherwise re-render twice for each nudge of the crop handle.
   */
  async function buildTikTokMedia(): Promise<
    Array<Record<string, unknown>> | null
  > {
    const needsCopy = media.some(
      (item) =>
        item.kind === "IMAGE" &&
        (item.outputWidthPx ?? 0) > TIKTOK_MAX_WIDTH_PX
    );
    if (!needsCopy) return null;

    const tiktokMaxImageBytes = constraints.TIKTOK?.maxImageBytes;
    const prepared: Array<Record<string, unknown>> = [];

    for (const item of media) {
      // Already inside TikTok's ceiling: reuse the exact same object rather
      // than re-encoding it to the same size for no gain.
      if (
        item.kind !== "IMAGE" ||
        (item.outputWidthPx ?? 0) <= TIKTOK_MAX_WIDTH_PX
      ) {
        prepared.push({
          storageKey: item.storageKey as string,
          ...(item.outputWidthPx ? { widthPx: item.outputWidthPx } : {}),
          ...(item.outputHeightPx ? { heightPx: item.outputHeightPx } : {}),
          ...(item.croppedToRatio
            ? { croppedToRatio: item.croppedToRatio }
            : {}),
        });
        continue;
      }

      const preset =
        FEED_PRESETS.find((option) => option.id === item.ratioId) ??
        FEED_PRESETS[0];

      const rendered = await prepareImage(item.file, {
        targetRatio: preset.ratio,
        // The same framing the user chose for Instagram. `CropFocus` is stored
        // as fractions precisely so it survives the change of output size.
        focus: item.focus,
        ratioLabel: preset.label,
        maxWidthPx: TIKTOK_MAX_WIDTH_PX,
        maxBytes: tiktokMaxImageBytes,
      });

      const { storageKey } = await uploadBlob(
        rendered.blob,
        "image/jpeg",
        item.file.name.replace(/\.[^.]+$/, "") + "-tiktok.jpg"
      );

      prepared.push({
        storageKey,
        widthPx: rendered.widthPx,
        heightPx: rendered.heightPx,
        ...(item.croppedToRatio ? { croppedToRatio: item.croppedToRatio } : {}),
      });
    }

    return prepared;
  }

  async function submit() {
    if (media.length === 0) return;
    setSubmitting(true);
    setError(null);
    setFieldErrors([]);

    // Only built when a TikTok photo target is actually selected — deriving
    // copies nobody asked for would double the upload for no reason.
    const wantsTikTokPhotos = targets.some((target) => {
      const account = accountById.get(target.connectedAccountId);
      return (
        account?.platform === "TIKTOK" &&
        derivePostType("TIKTOK", mediaKinds) === "TIKTOK_PHOTO"
      );
    });

    let tiktokMedia: Array<Record<string, unknown>> | null = null;
    if (wantsTikTokPhotos) {
      setPreparingTikTok(true);
      try {
        tiktokMedia = await buildTikTokMedia();
      } catch (renderError) {
        setPreparingTikTok(false);
        setSubmitting(false);
        setError(
          renderError instanceof Error
            ? `Could not prepare the TikTok copies: ${renderError.message}`
            : "Could not prepare the TikTok copies"
        );
        return;
      }
      setPreparingTikTok(false);
    }

    const res = await fetch("/api/scheduler/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Array order IS carousel order. The server reads MIME type, size and
        // kind back from storage, so only the key, the browser-probed
        // dimensions and any crop we applied are sent.
        media: media.map((item) => ({
          storageKey: item.storageKey as string,
          // The dimensions of what will PUBLISH, not of what was picked — after
          // a crop or a resize those are different numbers, and the row should
          // describe the file the worker is going to send.
          ...(item.outputWidthPx ? { widthPx: item.outputWidthPx } : {}),
          ...(item.outputHeightPx ? { heightPx: item.outputHeightPx } : {}),
          ...(item.croppedToRatio
            ? { croppedToRatio: item.croppedToRatio }
            : {}),
          // Per item: Instagram tags a person in a specific photo, and the
          // carousel child container is what carries the tag.
          ...(item.userTags.length > 0 ? { userTags: item.userTags } : {}),
        })),
        caption,
        scheduledAt: new Date(scheduledAt).toISOString(),
        targets: targets.map((target) => {
          const platform = accountById.get(
            target.connectedAccountId
          )!.platform;
          // Derived at submit rather than stored: adding a second photo turns
          // an Instagram photo post into a carousel, and a cached copy of the
          // post type would be the thing that goes stale.
          const mediaType = derivePostType(platform, mediaKinds, target.mediaType);

          return {
            connectedAccountId: target.connectedAccountId,
            mediaType,
            caption: target.caption || undefined,
            platformOptions: target.options,
            // TikTok's own, narrower renditions. Omitted entirely when the
            // shared files already fit, so the usual single-upload path is
            // untouched.
            ...(mediaType === "TIKTOK_PHOTO" && tiktokMedia
              ? { media: tiktokMedia }
              : {}),
          };
        }),
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

  const taggingItem = media.find((item) => item.id === taggingId) ?? null;

  return (
    <div className="max-w-4xl space-y-5 pb-12">
      {/*
        Keyed by item so opening a different tile remounts the modal, which is
        what seeds its draft from that item's tags. An effect syncing the draft
        would fight the user's own edits.
      */}
      {taggingItem && (
        <TagPeopleModal
          key={taggingItem.id}
          open
          previewUrl={taggingItem.previewUrl}
          filename={taggingItem.filename}
          kind={taggingItem.kind}
          position={media.indexOf(taggingItem) + 1}
          maxTags={MAX_TAGS_PER_ITEM}
          tags={taggingItem.userTags}
          onSave={(tags) => saveTags(taggingItem.id, tags)}
          onClose={() => setTaggingId(null)}
        />
      )}

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
              maxImageBytes={instagramMaxImageBytes}
              onReorder={reorder}
              onRemove={removeItem}
              onRatioChange={applyRatio}
              onFocusChange={applyFocus}
              onCompress={compressItem}
              onTagPeople={setTaggingId}
              onApplyRatioToAll={(preset) => {
                for (const item of media) {
                  if (item.kind === "IMAGE") applyRatio(item.id, preset);
                }
              }}
            />
          </div>
        )}

        {media.length < maxItems && (
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-background px-6 py-8 text-center transition hover:border-foreground/30">
            <span className="text-sm font-medium">
              {uploading
                ? "Uploading…"
                : media.length === 0
                  ? "Choose photos or a video"
                  : "Add another"}
            </span>
            <span className="text-xs text-muted">
              JPEG photos or MP4 / MOV / WebM video. {media.length} of{" "}
              {maxItems}
              {capOwner ? ` — ${capOwner}'s limit` : ""}. Two or more photos
              become a carousel.
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

        {/* Renders are queued one at a time, so "Make all" finishes over a few
            seconds. Saying how many are left is what stops it reading as
            "applied to some and not others". */}
        {media.some((item) => item.cropPending || item.uploading) && (
          <p className="mt-3 text-xs text-muted">
            Preparing{" "}
            {media.filter((item) => item.cropPending || item.uploading).length}{" "}
            of {media.length} — the files finish one at a time.
          </p>
        )}

        {media.length > 0 && (
          <p className="mt-3 text-xs text-muted">
            {mediaKinds.length > 1
              ? `${mediaKinds.length} items — drag a tile by its name row to reorder, or use the arrows. Drag inside a preview to move its crop.`
              : "Add more files to build a carousel."}
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
        {scheduleTooSoon && earliestAllowed && (
          <button
            type="button"
            onClick={() => setScheduledAt(earliestAllowed.value)}
            className="mt-3 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:border-foreground/30"
          >
            Too soon — use{" "}
            {earliestAllowed.at.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}
            , the earliest every selected account allows
          </button>
        )}
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
                                // Derived, not the stored value: adding a second
                                // photo turns an Instagram photo post into a
                                // carousel, and the options panel decides what
                                // to show from this. The stored copy goes stale
                                // exactly when the available options change.
                                mediaType={derivePostType(
                                  account.platform,
                                  mediaKinds,
                                  target.mediaType
                                )}
                                value={target.options}
                                photoCount={media.length}
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
                ? "One photo cannot be published as it is."
                : `${blockedItems.length} photos cannot be published as they are.`}{" "}
              {blockedItems.some((blocker) => blocker.fix === "CROP") &&
                "Instagram rejects a photo outside 4:5 to 1.91:1 rather than cropping it. "}
              {blockedItems.some((blocker) => blocker.fix === "COMPRESS") &&
                "Instagram's API caps photos well below what the app allows. "}
              Use the fix offered on each tile, or remove them.
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
          {overCap > 0 && (
            <p className="text-sm text-error">
              {capOwner ?? "This selection"} takes at most {maxItems} items, and
              you have {media.length}. Remove {overCap}
              {overCap === 1 ? " item" : " items"} — or untick{" "}
              {capOwner ?? "that platform"} and post the rest on its own.
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
          {preparingTikTok
            ? "Preparing TikTok copies…"
            : submitting
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
