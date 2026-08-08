/**
 * Aspect-ratio maths for the composer.
 *
 * Deliberately DOM-free so it can be unit-tested and reused server-side —
 * `lib/scheduler/constraints.ts` imports `describeRatio` from here rather than
 * keeping a second copy. The browser-only parts live in `probe.ts` (reading
 * dimensions off a File) and `crop-image.ts` (the canvas work).
 *
 * **Ratios are width ÷ height throughout.** 4:5 is 0.8, 1.91:1 is 1.91, 9:16 is
 * 0.5625. Mixing the convention is the easiest way to produce a crop that is
 * correct-looking and exactly wrong, so nothing here accepts a height:width
 * value.
 *
 * Why this exists at all: Instagram **rejects** stills outside 4:5–1.91:1
 * rather than cropping them (research 2026-08-08). So a ratio choice is not a
 * nicety — for an out-of-range image it is the only way to publish, and without
 * it the failure lands in the worker at the scheduled minute.
 */

export interface AspectPreset {
  id: string;
  label: string;
  /** width ÷ height. Null means "leave the file exactly as it is". */
  ratio: number | null;
}

/**
 * Presets for Instagram feed posts and carousels.
 *
 * **9:16 is absent on purpose.** At 0.5625 it falls outside the documented
 * 0.8–1.91 range, so offering it here would produce a guaranteed container
 * ERROR. It is a Reels ratio, and lives in `REEL_PRESETS`.
 */
export const FEED_PRESETS: readonly AspectPreset[] = [
  { id: "ORIGINAL", label: "Original", ratio: null },
  { id: "SQUARE", label: "Square 1:1", ratio: 1 },
  { id: "PORTRAIT", label: "Portrait 4:5", ratio: 0.8 },
  { id: "LANDSCAPE", label: "Landscape 1.91:1", ratio: 1.91 },
];

/** Reels are vertical; the feed range does not apply to them. */
export const REEL_PRESETS: readonly AspectPreset[] = [
  { id: "ORIGINAL", label: "Original", ratio: null },
  { id: "VERTICAL", label: "Vertical 9:16", ratio: 0.5625 },
];

export interface AspectRange {
  min: number;
  max: number;
}

export function ratioOf(width: number, height: number): number {
  return width / height;
}

export function isWithinRange(ratio: number, range: AspectRange): boolean {
  return ratio >= range.min && ratio <= range.max;
}

/**
 * A human label for a ratio, so an error says "9:16" rather than
 * "0.5625000000000001". Falls back to the raw pixel dimensions when the ratio
 * matches nothing recognisable — more useful to a user than an unrounded float.
 */
export function describeRatio(width: number, height: number): string {
  const ratio = ratioOf(width, height);
  const named: ReadonlyArray<readonly [string, number]> = [
    ["1:1", 1],
    ["4:5", 0.8],
    ["1.91:1", 1.91],
    ["9:16", 0.5625],
    ["16:9", 1.7778],
    ["3:4", 0.75],
    ["4:3", 1.3333],
    ["2:3", 0.6667],
    ["3:2", 1.5],
  ];

  for (const [label, value] of named) {
    if (Math.abs(ratio - value) < 0.01) return label;
  }
  return `${width}×${height}`;
}

export interface CropRect {
  /** Source-pixel offsets and size of the region to keep. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * The largest centred region of a `width`×`height` source that has
 * `targetRatio` — the "cover" crop, the same framing Instagram itself applies
 * when it decides to crop.
 *
 * **Rounding is biased toward square, never away from it.** Whole pixels cannot
 * hit most ratios exactly, and the direction of that error decides whether the
 * crop publishes. Instagram's presets ARE the boundaries of its accepted range,
 * so a 1.91:1 crop that rounds to 1.9115 is rejected — by the very crop we
 * offered as the fix. Cropping 1080×1920 to 1.91:1 is exactly that case:
 * `round(1080 / 1.91)` is 565, and 1080÷565 = 1.9115.
 *
 * So the result always lands between 1:1 and the target, which keeps it inside
 * any range containing both — and Instagram's 0.8–1.91 contains 1:1.
 *
 * Everything is clamped inside the source too: a canvas `drawImage` reading one
 * pixel past the edge yields a transparent strip that survives into the JPEG as
 * a black line.
 */
export function computeCoverCrop(
  width: number,
  height: number,
  targetRatio: number
): CropRect {
  const sourceRatio = ratioOf(width, height);
  // Landscape targets must not come out WIDER than asked; portrait targets must
  // not come out NARROWER. Both mean "err toward square".
  const towardSquare = targetRatio >= 1 ? Math.floor : Math.ceil;
  const awayFromSquare = targetRatio >= 1 ? Math.ceil : Math.floor;

  let sw: number;
  let sh: number;

  if (sourceRatio > targetRatio) {
    // Source is wider than the target: keep full height, trim the sides.
    // Narrowing sw lowers the ratio, so sw takes the toward-square rounding.
    sh = height;
    sw = towardSquare(height * targetRatio);
  } else {
    // Source is taller (or already exact): keep full width, trim top and
    // bottom. Growing sh lowers the ratio, so sh takes the opposite rounding.
    sw = width;
    sh = awayFromSquare(width / targetRatio);
  }

  // Clamp last. Rounding can push a dimension one pixel past the edge; landing
  // back on the source's own ratio is still on the safe side of the target,
  // because that is the side we were already approaching from.
  sw = Math.min(Math.max(1, sw), width);
  sh = Math.min(Math.max(1, sh), height);

  return {
    sx: Math.max(0, Math.round((width - sw) / 2)),
    sy: Math.max(0, Math.round((height - sh) / 2)),
    sw,
    sh,
  };
}

/**
 * The crop region as percentages of the displayed media box, for drawing the
 * overlay that shows what would be kept.
 */
export function cropOverlayPercent(
  width: number,
  height: number,
  targetRatio: number
): { widthPercent: number; heightPercent: number } {
  const { sw, sh } = computeCoverCrop(width, height, targetRatio);
  return {
    widthPercent: (sw / width) * 100,
    heightPercent: (sh / height) * 100,
  };
}

/**
 * The preset an out-of-range image must be cropped to before it can publish.
 *
 * Returns null when the image already fits — nothing needs to change, and the
 * composer should leave "Original" selected rather than nudging a crop nobody
 * asked for.
 *
 * For an image that does NOT fit, this picks the valid preset closest to the
 * source's own framing, so the suggestion trims as little as possible: a tall
 * 9:16 still is offered 4:5, not 1.91:1.
 */
export function suggestFixPreset(
  width: number,
  height: number,
  range: AspectRange,
  presets: readonly AspectPreset[] = FEED_PRESETS
): AspectPreset | null {
  const ratio = ratioOf(width, height);
  if (isWithinRange(ratio, range)) return null;

  // Only presets that are themselves publishable are worth suggesting.
  const usable = presets.filter(
    (preset) => preset.ratio !== null && isWithinRange(preset.ratio, range)
  );
  if (usable.length === 0) return null;

  // Clamp the source ratio into the accepted band, then pick the nearest
  // preset to that — which is the least-destructive crop available.
  const clamped = Math.min(Math.max(ratio, range.min), range.max);

  return usable.reduce((best, preset) =>
    Math.abs((preset.ratio as number) - clamped) <
    Math.abs((best.ratio as number) - clamped)
      ? preset
      : best
  );
}
