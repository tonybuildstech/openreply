"use client";

/**
 * The composer's media strip: previews in carousel order, reorderable, with a
 * per-item aspect-ratio choice and a draggable crop.
 *
 * Reordering is native HTML5 drag events plus explicit ◀ ▶ buttons. No drag
 * library: for a twenty-item strip the buttons are the accessible path anyway
 * (drag-and-drop is unusable by keyboard and awkward on touch), and once they
 * exist a dependency buys nothing.
 *
 * The ratio control is not decoration. Instagram REJECTS stills outside
 * 4:5–1.91:1 rather than cropping them, so an out-of-range image cannot be
 * published at all until it is cropped — the tile says so and the composer
 * refuses to submit until it is resolved.
 *
 * Every ratio here is named by ORIENTATION first ("Vertical 4:5", not "4:5").
 * The bare figures only mean something to people who already know them, and the
 * cost of guessing wrong is a crop that discards the subject of the photo.
 */

import { useState } from "react";
import CropPreview from "@/components/scheduler/crop-preview";
import {
  CENTRED_FOCUS,
  FEED_PRESETS,
  describeRatio,
  isWithinRange,
  orientationOf,
  panAxis,
  ratioOf,
  suggestFixPreset,
  type AspectPreset,
  type AspectRange,
  type CropFocus,
  type Orientation,
} from "@/lib/media/aspect";
import type { MediaUserTag } from "@/components/scheduler/types";

export interface TrayItem {
  id: string;
  previewUrl: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: "IMAGE" | "VIDEO";
  /**
   * The ORIGINAL file's dimensions. Fixed for the life of the item.
   *
   * Kept separate from the output because the preview always shows the original
   * file — drawing the crop window needs the box the window sits in, and after
   * a crop the output dimensions are the window, not the box. Conflating the
   * two is what made the overlay vanish the instant a ratio was chosen.
   */
  sourceWidthPx: number | null;
  sourceHeightPx: number | null;
  /** What will actually be published. Equals the source until something is applied. */
  outputWidthPx: number | null;
  outputHeightPx: number | null;
  /** Preset id from FEED_PRESETS; "ORIGINAL" means no crop. */
  ratioId: string;
  /** Where the crop window sits within the source. */
  focus: CropFocus;
  /** Re-encoded at Instagram's width ceiling to get under the file-size cap. */
  compressed: boolean;
  /** People tagged in THIS item — Instagram tags per photo, not per post. */
  userTags: MediaUserTag[];
  uploading: boolean;
  /** The displayed crop has not been rendered to a file yet. */
  cropPending: boolean;
  error: string | null;
}

interface MediaTrayProps {
  items: TrayItem[];
  /** Instagram's still range, from the API. Absent while constraints load. */
  imageRange?: AspectRange;
  /** Instagram's still byte cap, from the API. */
  maxImageBytes?: number;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onRemove: (id: string) => void;
  onRatioChange: (id: string, preset: AspectPreset) => void;
  onFocusChange: (id: string, focus: CropFocus) => void;
  /** Re-encode at Instagram's own 1440px ceiling to get under the size cap. */
  onCompress: (id: string) => void;
  /** Open the tagging modal for this item. */
  onTagPeople: (id: string) => void;
  /** Applies one ratio to every image — carousels look best uniform. */
  onApplyRatioToAll: (preset: AspectPreset) => void;
}

/** A luggage-style tag, the conventional "tag someone" affordance. */
function TagIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" />
      <circle cx="7.5" cy="7.5" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

const ORIENTATION_WORD: Record<Orientation, string> = {
  VERTICAL: "vertical",
  SQUARE: "square",
  HORIZONTAL: "horizontal",
};

/**
 * Why this item cannot be published as-is, or null.
 *
 * Two separate rejections, kept apart because their fixes are different: an
 * aspect ratio outside the range needs a crop, and an oversized file needs
 * re-encoding. Reporting them as one "invalid image" would leave the user
 * guessing which button to press.
 *
 * Only stills, only when the relevant limit is known, and — for ratio — only
 * when the browser managed to probe dimensions. An unprobed file is unknown,
 * never invalid.
 */
export function itemBlocker(
  item: TrayItem,
  range?: AspectRange,
  maxImageBytes?: number
): { message: string; fix: "CROP" | "COMPRESS" } | null {
  if (item.kind !== "IMAGE") return null;

  if (maxImageBytes && item.sizeBytes > maxImageBytes) {
    return {
      message: `This file is ${formatSize(item.sizeBytes)}. Instagram's API caps photos at ${formatSize(maxImageBytes)}.`,
      fix: "COMPRESS",
    };
  }

  if (!range || item.ratioId !== "ORIGINAL") return null;
  if (item.sourceWidthPx === null || item.sourceHeightPx === null) return null;

  const ratio = ratioOf(item.sourceWidthPx, item.sourceHeightPx);
  if (isWithinRange(ratio, range)) return null;

  return {
    message: `This photo is ${describeRatio(item.sourceWidthPx, item.sourceHeightPx)} — too ${
      ratio < range.min ? "tall" : "wide"
    } for Instagram, which rejects anything outside 4:5 to 1.91:1.`,
    fix: "CROP",
  };
}

export function formatSize(bytes: number): string {
  return bytes >= 1024 ** 2
    ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The ratio an item will actually publish at, or null if it cannot be known. */
function effectiveRatio(item: TrayItem): number | null {
  const preset = FEED_PRESETS.find((p) => p.id === item.ratioId);
  if (preset?.ratio != null) return preset.ratio;
  if (item.sourceWidthPx && item.sourceHeightPx) {
    return ratioOf(item.sourceWidthPx, item.sourceHeightPx);
  }
  return null;
}

export default function MediaTray({
  items,
  imageRange,
  maxImageBytes,
  onReorder,
  onRemove,
  onRatioChange,
  onFocusChange,
  onCompress,
  onTagPeople,
  onApplyRatioToAll,
}: MediaTrayProps) {
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);

  /**
   * Documented on Meta's content-publishing guide, not folklore: "Carousel
   * images are all cropped based on the first image in the carousel, with the
   * default being a 1:1 aspect ratio." So item 1 decides the shape of the whole
   * post, and every later item is measured against it.
   */
  const carouselRatio = items.length > 1 ? effectiveRatio(items[0]) : null;

  const imageItems = items.filter((item) => item.kind === "IMAGE");
  const mixedRatios =
    imageItems.length > 1 &&
    new Set(imageItems.map((item) => item.ratioId)).size > 1;

  return (
    <div className="space-y-3">
      <div className="flex gap-3 overflow-x-auto pb-2">
        {items.map((item, index) => {
          const preset =
            FEED_PRESETS.find((p) => p.id === item.ratioId) ?? FEED_PRESETS[0];
          const blocker = itemBlocker(item, imageRange, maxImageBytes);
          const suggestion =
            blocker?.fix === "CROP" && item.sourceWidthPx && item.sourceHeightPx && imageRange
              ? suggestFixPreset(item.sourceWidthPx, item.sourceHeightPx, imageRange)
              : null;

          /*
           * Video is never re-encoded, so the only thing we can do for a clip is
           * show what the carousel's first item will make Instagram cut off it.
           * That is the whole reason the overlay exists on the video path.
           */
          const overlayRatio =
            item.kind === "IMAGE"
              ? preset.ratio
              : index > 0
                ? carouselRatio
                : null;

          const axis =
            item.kind === "IMAGE" &&
            preset.ratio !== null &&
            item.sourceWidthPx &&
            item.sourceHeightPx
              ? panAxis(item.sourceWidthPx, item.sourceHeightPx, preset.ratio)
              : "NONE";

          const moved =
            item.focus.x !== CENTRED_FOCUS.x || item.focus.y !== CENTRED_FOCUS.y;

          return (
            <div
              key={item.id}
              // Drop target only. The DRAG starts from the header strip below,
              // because the preview underneath it is itself draggable now — a
              // tile that is draggable everywhere would turn "move the crop"
              // into "reorder the carousel" depending on which handler won.
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (draggingIndex !== null && draggingIndex !== index) {
                  onReorder(draggingIndex, index);
                }
                setDraggingIndex(null);
              }}
              className={`w-60 shrink-0 rounded-lg border bg-background transition ${
                blocker
                  ? "border-error/50"
                  : draggingIndex === index
                    ? "border-foreground/40 opacity-60"
                    : "border-border"
              }`}
            >
              <div className="flex h-44 items-center justify-center rounded-t-lg bg-surface">
                <CropPreview
                  src={item.previewUrl}
                  alt={item.filename}
                  kind={item.kind}
                  widthPx={item.sourceWidthPx}
                  heightPx={item.sourceHeightPx}
                  targetRatio={overlayRatio}
                  focus={item.focus}
                  onFocusChange={(focus) => onFocusChange(item.id, focus)}
                />
              </div>

              <div className="space-y-2 p-2.5">
                {/* The reorder handle. Explicit, so it cannot be confused with
                    dragging the crop inside the preview above it. */}
                <div
                  draggable
                  onDragStart={() => setDraggingIndex(index)}
                  onDragEnd={() => setDraggingIndex(null)}
                  title="Drag to reorder"
                  className="flex cursor-grab items-center gap-2 active:cursor-grabbing"
                >
                  <span className="rounded bg-surface px-1.5 py-0.5 text-xs font-medium text-muted">
                    {index + 1}
                  </span>
                  <p className="min-w-0 flex-1 truncate text-xs">
                    {item.filename}
                  </p>
                  <span aria-hidden="true" className="text-xs text-muted">
                    ⠿
                  </span>
                </div>

                <p className="text-xs text-muted">
                  {item.uploading ? "Working…" : formatSize(item.sizeBytes)}
                  {item.outputWidthPx && item.outputHeightPx ? (
                    <>
                      {" · "}
                      {item.outputWidthPx}×{item.outputHeightPx}
                      {" · "}
                      {
                        ORIENTATION_WORD[
                          orientationOf(
                            ratioOf(item.outputWidthPx, item.outputHeightPx)
                          )
                        ]
                      }
                    </>
                  ) : null}
                </p>

                {/* Ratio choice — stills only; we never re-encode video. */}
                {item.kind === "IMAGE" && (
                  <div className="flex flex-wrap gap-1">
                    {FEED_PRESETS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => onRatioChange(item.id, option)}
                        title={
                          option.ratio !== null
                            ? `Crop to ${option.label}`
                            : item.compressed
                              ? "Keep the original shape, still resized to fit"
                              : "Upload the file exactly as it is"
                        }
                        className={`rounded border px-1.5 py-0.5 text-[11px] transition ${
                          option.id === item.ratioId
                            ? "border-foreground/30 bg-surface font-medium"
                            : "border-border text-muted hover:text-foreground"
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                )}

                {/*
                  Which way the crop can move, said explicitly. A cover crop only
                  ever frees ONE axis — a landscape photo cropped to 4:5 keeps
                  its full height and slides sideways — so naming the wrong
                  direction sends the user hunting for movement that cannot
                  happen.
                */}
                {axis !== "NONE" && (
                  <div className="flex items-center gap-2">
                    <p className="flex-1 text-[11px] text-muted">
                      Drag the bright box{" "}
                      {axis === "HORIZONTAL" ? "left or right" : "up or down"} to
                      choose what stays.
                    </p>
                    {moved && (
                      <button
                        type="button"
                        onClick={() => onFocusChange(item.id, CENTRED_FOCUS)}
                        className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted transition hover:text-foreground"
                      >
                        Centre
                      </button>
                    )}
                  </div>
                )}

                {item.compressed && !item.uploading && (
                  <p className="text-[11px] text-muted">
                    Resized to Instagram&apos;s own 1440px ceiling to fit its
                    file-size cap.
                  </p>
                )}

                {item.kind === "VIDEO" && overlayRatio !== null && (
                  <p className="text-[11px] text-warning">
                    Instagram will crop this clip to match item 1. OpenReply
                    never re-encodes video, so trim it in an editor if that is
                    wrong.
                  </p>
                )}

                {blocker && (
                  <p className="text-[11px] text-error">
                    {blocker.message}{" "}
                    {blocker.fix === "COMPRESS" ? (
                      <button
                        type="button"
                        onClick={() => onCompress(item.id)}
                        className="underline"
                      >
                        Resize it to fit
                      </button>
                    ) : (
                      suggestion && (
                        <button
                          type="button"
                          onClick={() => onRatioChange(item.id, suggestion)}
                          className="underline"
                        >
                          Crop to {suggestion.label}
                        </button>
                      )
                    )}
                  </p>
                )}
                {item.error && (
                  <p className="text-[11px] text-error">{item.error}</p>
                )}

                <div className="flex items-center gap-1">
                  {/* Tagging is per item because Instagram tags a person in a
                      specific photo — the post-level list this replaces could
                      never say which photo someone was in. */}
                  <button
                    type="button"
                    onClick={() => onTagPeople(item.id)}
                    title={
                      item.userTags.length > 0
                        ? `Tagged: ${item.userTags.map((tag) => `@${tag.username}`).join(", ")}`
                        : "Tag people in this item"
                    }
                    aria-label={`Tag people in ${item.filename}`}
                    className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs transition ${
                      item.userTags.length > 0
                        ? "border-foreground/30 bg-surface font-medium"
                        : "border-border text-muted hover:text-foreground"
                    }`}
                  >
                    <TagIcon />
                    {item.userTags.length > 0 && item.userTags.length}
                  </button>

                  <button
                    type="button"
                    onClick={() => onReorder(index, index - 1)}
                    disabled={index === 0}
                    aria-label={`Move ${item.filename} earlier`}
                    className="rounded border border-border px-1.5 py-0.5 text-xs text-muted transition hover:text-foreground disabled:opacity-30"
                  >
                    ◀
                  </button>
                  <button
                    type="button"
                    onClick={() => onReorder(index, index + 1)}
                    disabled={index === items.length - 1}
                    aria-label={`Move ${item.filename} later`}
                    className="rounded border border-border px-1.5 py-0.5 text-xs text-muted transition hover:text-foreground disabled:opacity-30"
                  >
                    ▶
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove(item.id)}
                    aria-label={`Remove ${item.filename}`}
                    className="ml-auto rounded border border-border px-1.5 py-0.5 text-xs text-muted transition hover:text-error"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {mixedRatios && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted">
          {/* Meta's own words: "Carousel images are all cropped based on the
              first image in the carousel." Documented, so stated as a fact. */}
          <span>
            Your items have different shapes. Instagram crops the whole carousel
            to match item 1.
          </span>
          {FEED_PRESETS.filter((p) => p.ratio !== null).map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => onApplyRatioToAll(option)}
              className="rounded border border-border px-2 py-0.5 transition hover:text-foreground"
            >
              Make all {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
