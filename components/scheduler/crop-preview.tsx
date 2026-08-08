"use client";

/**
 * The media preview with its crop window drawn on top — and, for images,
 * draggable.
 *
 * ── The bug this replaces ────────────────────────────────────────────────────
 *
 * The previous version drew the overlay inside a FIXED frame while the picture
 * sat inside it under `object-contain`. Those are two different boxes: a
 * portrait photo in a 208×160 frame renders about 90px wide, so an overlay
 * sized as a percentage of the frame was drawn across the letterboxing and
 * pointed at the wrong part of the picture. It was worst exactly where it
 * mattered most — the further from the frame's ratio the photo was, the more
 * the overlay lied, and out-of-range photos are the ones that need cropping.
 *
 * The fix is structural rather than arithmetic: the wrapper is `inline-block`,
 * so it shrink-wraps the media element and IS the media's box. Percentages of
 * the wrapper are then percentages of the picture, by construction, and there
 * is no second box left to disagree with.
 *
 * ── Why video gets an overlay but no drag ────────────────────────────────────
 *
 * OpenReply never re-encodes video, so for a clip the overlay is a warning, not
 * a control: this is the part the platform will cut, and the only way to change
 * it is to edit the file. Making it draggable would promise an edit we do not
 * perform.
 */

import { useRef, useState } from "react";
import {
  CENTRED_FOCUS,
  clampFocusToCrop,
  cropOverlayPercent,
  panAxis,
  type CropFocus,
} from "@/lib/media/aspect";

interface CropPreviewProps {
  src: string;
  alt: string;
  kind: "IMAGE" | "VIDEO";
  /** Source dimensions. Null when probing failed — the overlay is skipped. */
  widthPx: number | null;
  heightPx: number | null;
  /** Target ratio as width ÷ height. Null means "Original", so no overlay. */
  targetRatio: number | null;
  focus?: CropFocus;
  /** Omit to render read-only. Video always renders read-only. */
  onFocusChange?: (focus: CropFocus) => void;
  /** Tailwind max-height class for the media element, e.g. "max-h-44". */
  maxHeightClass?: string;
}

/** One arrow-key press, as a fraction of the source. */
const KEY_STEP = 0.02;

export default function CropPreview({
  src,
  alt,
  kind,
  widthPx,
  heightPx,
  targetRatio,
  focus = CENTRED_FOCUS,
  onFocusChange,
  maxHeightClass = "max-h-44",
}: CropPreviewProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  /**
   * Where the pointer went down, and the focus it went down on.
   *
   * The crop follows the hand by a DELTA from these, rather than jumping so its
   * centre lands under the pointer. Jump-to-pointer is easier to write and
   * wrong to use: grabbing the picture to nudge it a few pixels would fling the
   * framing across the photo before the first move event.
   */
  const dragStart = useRef<{ x: number; y: number; focus: CropFocus } | null>(
    null
  );

  const canDraw =
    targetRatio !== null &&
    widthPx !== null &&
    heightPx !== null &&
    widthPx > 0 &&
    heightPx > 0;

  const axis = canDraw ? panAxis(widthPx, heightPx, targetRatio) : "NONE";
  // Video is warn-only, and an axis with no freedom has nothing to move.
  const interactive =
    canDraw && kind === "IMAGE" && Boolean(onFocusChange) && axis !== "NONE";

  const media =
    kind === "IMAGE" ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={alt}
        draggable={false}
        className={`block ${maxHeightClass} max-w-full select-none`}
      />
    ) : (
      <video
        src={src}
        controls
        muted
        playsInline
        className={`block ${maxHeightClass} max-w-full`}
      />
    );

  if (!canDraw) {
    return (
      <div className="flex items-center justify-center">
        <div className="relative inline-block">{media}</div>
      </div>
    );
  }

  const overlay = cropOverlayPercent(widthPx, heightPx, targetRatio, focus);

  // Nothing is being trimmed, so an overlay would imply a change that is not
  // happening. The ratio pill already says which preset is selected.
  const trimsNothing =
    overlay.widthPercent >= 99.5 && overlay.heightPercent >= 99.5;

  /** Move the crop by however far the pointer has travelled since it went down. */
  function dragTo(clientX: number, clientY: number) {
    const start = dragStart.current;
    const box = boxRef.current?.getBoundingClientRect();
    if (!start || !box || box.width === 0 || box.height === 0) return;

    // Only the free axis moves. Writing the locked one back unchanged keeps a
    // diagonal drag from quietly disturbing a value the user cannot see.
    nudgeFrom(start.focus, {
      x: axis === "HORIZONTAL" ? (clientX - start.x) / box.width : 0,
      y: axis === "VERTICAL" ? (clientY - start.y) / box.height : 0,
    });
  }

  function nudgeFrom(base: CropFocus, delta: { x: number; y: number }) {
    if (!interactive || !onFocusChange) return;
    onFocusChange(
      clampFocusToCrop(
        widthPx as number,
        heightPx as number,
        targetRatio as number,
        { x: base.x + delta.x, y: base.y + delta.y }
      )
    );
  }

  return (
    <div className="flex items-center justify-center">
      <div
        ref={boxRef}
        // overflow-hidden clips the dimming shadow to the picture's own box.
        className={`relative inline-block overflow-hidden ${
          interactive ? (dragging ? "cursor-grabbing" : "cursor-grab") : ""
        }`}
        onPointerDown={
          interactive
            ? (event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                dragStart.current = {
                  x: event.clientX,
                  y: event.clientY,
                  focus,
                };
                setDragging(true);
              }
            : undefined
        }
        onPointerMove={
          interactive
            ? (event) => {
                if (dragging) dragTo(event.clientX, event.clientY);
              }
            : undefined
        }
        onPointerUp={
          interactive
            ? (event) => {
                event.currentTarget.releasePointerCapture(event.pointerId);
                dragStart.current = null;
                setDragging(false);
              }
            : undefined
        }
        onPointerCancel={
          interactive
            ? () => {
                dragStart.current = null;
                setDragging(false);
              }
            : undefined
        }
      >
        {media}

        {!trimsNothing && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute border-2 border-white/90"
            style={{
              left: `${overlay.leftPercent}%`,
              top: `${overlay.topPercent}%`,
              width: `${overlay.widthPercent}%`,
              height: `${overlay.heightPercent}%`,
              // One element dims everything outside itself, rather than four
              // strips that have to agree with each other about the gaps.
              boxShadow: `0 0 0 9999px rgba(0, 0, 0, ${dragging ? 0.35 : 0.55})`,
            }}
          />
        )}

        {/*
          The keyboard path. Drag-and-drop is unreachable without a pointer, and
          this is the only way to frame a crop for anyone using one.
        */}
        {interactive && (
          <button
            type="button"
            aria-label={
              axis === "HORIZONTAL"
                ? `Move the crop of ${alt} left or right with the arrow keys`
                : `Move the crop of ${alt} up or down with the arrow keys`
            }
            onKeyDown={(event) => {
              const step: Record<string, [number, number]> = {
                ArrowLeft: [-KEY_STEP, 0],
                ArrowRight: [KEY_STEP, 0],
                ArrowUp: [0, -KEY_STEP],
                ArrowDown: [0, KEY_STEP],
              };
              const delta = step[event.key];
              if (!delta) return;
              event.preventDefault();
              nudgeFrom(focus, { x: delta[0], y: delta[1] });
            }}
            className="absolute inset-0 h-full w-full cursor-[inherit] opacity-0 focus:opacity-100 focus:outline-2 focus:-outline-offset-2 focus:outline-white"
          />
        )}
      </div>
    </div>
  );
}
