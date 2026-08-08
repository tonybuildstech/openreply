"use client";

/**
 * The composer's media strip: previews in carousel order, reorderable, with a
 * per-image aspect-ratio choice.
 *
 * Reordering is native HTML5 drag events plus explicit ◀ ▶ buttons. No drag
 * library: for a ten-item strip the buttons are the accessible path anyway
 * (drag-and-drop is unusable by keyboard and awkward on touch), and once they
 * exist a dependency buys nothing.
 *
 * The ratio control is not decoration. Instagram REJECTS stills outside
 * 4:5–1.91:1 rather than cropping them, so an out-of-range image cannot be
 * published at all until it is cropped — the tile says so and the composer
 * refuses to submit until it is resolved.
 */

import { useState } from "react";
import AspectFrame from "@/components/scheduler/aspect-frame";
import {
  FEED_PRESETS,
  isWithinRange,
  ratioOf,
  suggestFixPreset,
  type AspectPreset,
  type AspectRange,
} from "@/lib/media/aspect";

export interface TrayItem {
  id: string;
  previewUrl: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: "IMAGE" | "VIDEO";
  widthPx: number | null;
  heightPx: number | null;
  /** Preset id from FEED_PRESETS; "ORIGINAL" means upload untouched. */
  ratioId: string;
  uploading: boolean;
  error: string | null;
}

interface MediaTrayProps {
  items: TrayItem[];
  /** Instagram's still range, from the API. Absent while constraints load. */
  imageRange?: AspectRange;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onRemove: (id: string) => void;
  onRatioChange: (id: string, preset: AspectPreset) => void;
  /** Applies one ratio to every image — carousels look best uniform. */
  onApplyRatioToAll: (preset: AspectPreset) => void;
}

/**
 * Why this item cannot be published as-is, or null.
 *
 * Only stills, only when a range is known, and only when the browser managed to
 * probe dimensions — an unprobed file is unknown, never invalid.
 */
export function itemBlocker(
  item: TrayItem,
  range?: AspectRange
): string | null {
  if (item.kind !== "IMAGE" || !range) return null;
  if (item.widthPx === null || item.heightPx === null) return null;
  if (item.ratioId !== "ORIGINAL") return null;

  return isWithinRange(ratioOf(item.widthPx, item.heightPx), range)
    ? null
    : "Instagram will reject this ratio — pick a crop below.";
}

function formatSize(bytes: number): string {
  return bytes >= 1024 ** 2
    ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function MediaTray({
  items,
  imageRange,
  onReorder,
  onRemove,
  onRatioChange,
  onApplyRatioToAll,
}: MediaTrayProps) {
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);

  const imageCount = items.filter((item) => item.kind === "IMAGE").length;
  const mixedRatios =
    imageCount > 1 &&
    new Set(items.filter((i) => i.kind === "IMAGE").map((i) => i.ratioId))
      .size > 1;

  return (
    <div className="space-y-3">
      <div className="flex gap-3 overflow-x-auto pb-2">
        {items.map((item, index) => {
          const preset =
            FEED_PRESETS.find((p) => p.id === item.ratioId) ?? FEED_PRESETS[0];
          const blocker = itemBlocker(item, imageRange);
          const suggestion =
            blocker && item.widthPx && item.heightPx && imageRange
              ? suggestFixPreset(item.widthPx, item.heightPx, imageRange)
              : null;

          return (
            <div
              key={item.id}
              draggable
              onDragStart={() => setDraggingIndex(index)}
              onDragEnd={() => setDraggingIndex(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (draggingIndex !== null && draggingIndex !== index) {
                  onReorder(draggingIndex, index);
                }
                setDraggingIndex(null);
              }}
              className={`w-52 shrink-0 rounded-lg border bg-background transition ${
                blocker
                  ? "border-error/50"
                  : draggingIndex === index
                    ? "border-foreground/40 opacity-60"
                    : "border-border"
              }`}
            >
              {/* Preview */}
              <AspectFrame
                widthPx={item.widthPx}
                heightPx={item.heightPx}
                targetRatio={preset.ratio}
                className="flex h-40 items-center justify-center rounded-t-lg bg-surface"
              >
                {item.kind === "IMAGE" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.previewUrl}
                    alt={item.filename}
                    className="max-h-40 max-w-full object-contain"
                  />
                ) : (
                  <video
                    src={item.previewUrl}
                    controls
                    muted
                    playsInline
                    className="max-h-40 max-w-full object-contain"
                  />
                )}
              </AspectFrame>

              <div className="space-y-2 p-2.5">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-surface px-1.5 py-0.5 text-xs font-medium text-muted">
                    {index + 1}
                  </span>
                  <p className="min-w-0 flex-1 truncate text-xs" title={item.filename}>
                    {item.filename}
                  </p>
                </div>

                <p className="text-xs text-muted">
                  {item.uploading ? "Uploading…" : formatSize(item.sizeBytes)}
                  {item.widthPx && item.heightPx
                    ? ` · ${item.widthPx}×${item.heightPx}`
                    : ""}
                </p>

                {/* Ratio choice — stills only; we never re-encode video. */}
                {item.kind === "IMAGE" && (
                  <div className="flex flex-wrap gap-1">
                    {FEED_PRESETS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => onRatioChange(item.id, option)}
                        className={`rounded border px-1.5 py-0.5 text-[11px] transition ${
                          option.id === item.ratioId
                            ? "border-foreground/30 bg-surface font-medium"
                            : "border-border text-muted hover:text-foreground"
                        }`}
                      >
                        {option.label.replace(/^(Square|Portrait|Landscape) /, "")}
                      </button>
                    ))}
                  </div>
                )}

                {blocker && (
                  <p className="text-[11px] text-error">
                    {blocker}
                    {suggestion && (
                      <>
                        {" "}
                        <button
                          type="button"
                          onClick={() => onRatioChange(item.id, suggestion)}
                          className="underline"
                        >
                          Crop to {suggestion.label}
                        </button>
                      </>
                    )}
                  </p>
                )}
                {item.error && (
                  <p className="text-[11px] text-error">{item.error}</p>
                )}

                <div className="flex items-center gap-1">
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
          {/* Undocumented but widely reported: Instagram renders every carousel
              item at the first item's ratio. Offered as an observation, not a
              rule — see Q15. */}
          <span>
            Your items have different ratios. Instagram usually shows a whole
            carousel at the first item&apos;s ratio.
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
