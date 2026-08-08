"use client";

/**
 * Draws the crop region over a media preview: the kept area stays bright, the
 * area the platform would discard is dimmed.
 *
 * Purely presentational — it computes nothing beyond calling into
 * `lib/media/aspect.ts`, and it never touches the file. For images the user can
 * act on what it shows by accepting the crop; for **video it is the whole
 * feature**, because OpenReply never re-encodes video and the overlay is the
 * only warning the user gets before the platform crops for them.
 *
 * Renders children untouched when there is nothing useful to say: no ratio
 * chosen, or dimensions the browser could not probe. A guessed overlay would be
 * worse than none — it would show a crop that is not the one that happens.
 */

import { cropOverlayPercent } from "@/lib/media/aspect";

interface AspectFrameProps {
  /** Source dimensions. Null when probing failed — the overlay is skipped. */
  widthPx: number | null;
  heightPx: number | null;
  /** Target ratio as width ÷ height. Null means "Original", so no overlay. */
  targetRatio: number | null;
  /** The preview itself — an <img> or <video>. */
  children: React.ReactNode;
  className?: string;
}

export default function AspectFrame({
  widthPx,
  heightPx,
  targetRatio,
  children,
  className = "",
}: AspectFrameProps) {
  const canDraw =
    targetRatio !== null && widthPx !== null && heightPx !== null && heightPx > 0;

  if (!canDraw) {
    return <div className={`relative ${className}`}>{children}</div>;
  }

  const { widthPercent, heightPercent } = cropOverlayPercent(
    widthPx,
    heightPx,
    targetRatio
  );

  // Nothing would be trimmed — an overlay here is visual noise implying a
  // change that is not happening.
  if (widthPercent >= 99.5 && heightPercent >= 99.5) {
    return <div className={`relative ${className}`}>{children}</div>;
  }

  return (
    // overflow-hidden is what clips the dimming shadow to the preview box.
    <div className={`relative overflow-hidden ${className}`}>
      {children}

      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 border border-white/80"
        style={{
          width: `${widthPercent}%`,
          height: `${heightPercent}%`,
          // One element dims everything outside itself, rather than four strips
          // that have to agree with each other about the gaps.
          boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.55)",
        }}
      />
    </div>
  );
}
