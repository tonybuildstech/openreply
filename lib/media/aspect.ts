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

/**
 * Which way round a frame is.
 *
 * Named as the user sees it, not as the maths does: a ratio below 1 is
 * "vertical", above 1 is "horizontal". This is surfaced everywhere a ratio is
 * because "4:5" and "1.91:1" are only obvious to people who already know them,
 * and picking the wrong one is a crop that throws away the subject.
 */
export type Orientation = "VERTICAL" | "SQUARE" | "HORIZONTAL";

/** Ratios this close to 1 read as square to a human, so call them square. */
const SQUARE_TOLERANCE = 0.02;

export function orientationOf(ratio: number): Orientation {
  if (Math.abs(ratio - 1) <= SQUARE_TOLERANCE) return "SQUARE";
  return ratio < 1 ? "VERTICAL" : "HORIZONTAL";
}

export interface AspectPreset {
  id: string;
  label: string;
  /** width ÷ height. Null means "leave the file exactly as it is". */
  ratio: number | null;
  /** Null for "Original", whose orientation is whatever the file already is. */
  orientation: Orientation | null;
}

/**
 * Presets for Instagram feed posts and carousels.
 *
 * **9:16 is absent on purpose.** At 0.5625 it falls outside the documented
 * 0.8–1.91 range, so offering it here would produce a guaranteed container
 * ERROR. It is a Reels ratio, and lives in `REEL_PRESETS`.
 *
 * **3:4 is absent for the same reason, and it is the tempting one.** Instagram
 * added 3:4 as a native feed size in 2026 and moved the profile grid to it in
 * January, so it is genuinely the tallest shape the APP accepts. Meta's media
 * reference still says images "must be within a 4:5 to 1.91:1 range" (checked
 * 2026-08-08), and 0.75 is outside that. Adding it on the strength of the app
 * would be the carousel ceiling all over again: a limit we widened past the
 * docs, which then failed in the worker after every file had uploaded.
 *
 * `.dev/probe-ig-params.ts` probe 10 settles it with a real 3:4 image and no
 * publish. If it comes back FINISHED, add the preset here and lower `min` to
 * 0.75 in `lib/scheduler/constraints.ts` — those two and nothing else.
 */
export const FEED_PRESETS: readonly AspectPreset[] = [
  { id: "ORIGINAL", label: "Original", ratio: null, orientation: null },
  { id: "PORTRAIT", label: "Vertical 4:5", ratio: 0.8, orientation: "VERTICAL" },
  { id: "SQUARE", label: "Square 1:1", ratio: 1, orientation: "SQUARE" },
  {
    id: "LANDSCAPE",
    label: "Horizontal 1.91:1",
    ratio: 1.91,
    orientation: "HORIZONTAL",
  },
];

/** Reels are vertical; the feed range does not apply to them. */
export const REEL_PRESETS: readonly AspectPreset[] = [
  { id: "ORIGINAL", label: "Original", ratio: null, orientation: null },
  {
    id: "VERTICAL",
    label: "Vertical 9:16",
    ratio: 0.5625,
    orientation: "VERTICAL",
  },
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
 * Where the kept region sits, as a fraction of the source on each axis.
 *
 * `{ x: 0.5, y: 0.5 }` is the centre — the old behaviour, and still the
 * default. `x` is the horizontal centre of the crop window, so 0 pins it to the
 * left edge and 1 to the right; `y` likewise, top to bottom.
 *
 * Stored as a fraction rather than pixels so it survives the source changing
 * underneath it — the same focus means the same framing whether the composer is
 * previewing a 4000px original or Instagram is publishing the 1440px downscale.
 */
export interface CropFocus {
  x: number;
  y: number;
}

export const CENTRED_FOCUS: CropFocus = { x: 0.5, y: 0.5 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function clampFocus(focus: CropFocus): CropFocus {
  return { x: clamp(focus.x, 0, 1), y: clamp(focus.y, 0, 1) };
}

/**
 * The axis along which the crop can actually be moved.
 *
 * A cover crop only ever trims ONE axis: cropping a landscape photo to 4:5
 * keeps its full height and slides left/right, and there is no vertical freedom
 * to offer. Advertising a drag direction that does nothing is worse than
 * offering none, so the UI asks this before it decides what to say.
 */
export type PanAxis = "HORIZONTAL" | "VERTICAL" | "NONE";

export function panAxis(
  width: number,
  height: number,
  targetRatio: number
): PanAxis {
  const { sw, sh } = computeCoverCrop(width, height, targetRatio);
  if (sw < width) return "HORIZONTAL";
  if (sh < height) return "VERTICAL";
  return "NONE";
}

/**
 * Pull a focus point into the range where the crop window still fits.
 *
 * `computeCoverCrop` clamps the window anyway, so this changes no output — it
 * exists so the STORED focus never drifts outside the usable band. Without it a
 * drag past the edge keeps accumulating into a value that does nothing, and the
 * user has to drag back through the dead zone before the picture moves again.
 *
 * On a locked axis the usable band collapses to a point, and this returns
 * exactly the centre.
 */
export function clampFocusToCrop(
  width: number,
  height: number,
  targetRatio: number,
  focus: CropFocus
): CropFocus {
  const { sw, sh } = computeCoverCrop(width, height, targetRatio, CENTRED_FOCUS);
  const halfWidth = sw / (2 * width);
  const halfHeight = sh / (2 * height);

  return {
    x: clamp(focus.x, halfWidth, 1 - halfWidth),
    y: clamp(focus.y, halfHeight, 1 - halfHeight),
  };
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
 *
 * `focus` moves the kept region without changing its size. It defaults to
 * centred, which is what Instagram itself would do — so an untouched call is
 * exactly the crop the platform would have applied.
 */
export function computeCoverCrop(
  width: number,
  height: number,
  targetRatio: number,
  focus: CropFocus = CENTRED_FOCUS
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

  // Place the window so `focus` is its centre, then push it back inside the
  // source. Clamping after positioning is what lets the user drag to an edge
  // and stop there, rather than the window sliding off and sampling nothing.
  const { x, y } = clampFocus(focus);

  return {
    sx: clamp(Math.round(x * width - sw / 2), 0, width - sw),
    sy: clamp(Math.round(y * height - sh / 2), 0, height - sh),
    sw,
    sh,
  };
}

export interface CropOverlay {
  widthPercent: number;
  heightPercent: number;
  /** Offset of the window's top-left corner, also as a percentage. */
  leftPercent: number;
  topPercent: number;
}

/**
 * The crop region as percentages of the source, for drawing the overlay that
 * shows what would be kept.
 *
 * Percentages OF THE SOURCE, which only line up on screen if the element they
 * are applied to is the image's own box. Sizing that box by `aspect-ratio`
 * rather than letting `object-contain` letterbox inside a fixed frame is what
 * makes this honest — otherwise the overlay is drawn over the letterboxing too
 * and points at the wrong part of the picture.
 */
export function cropOverlayPercent(
  width: number,
  height: number,
  targetRatio: number,
  focus: CropFocus = CENTRED_FOCUS
): CropOverlay {
  const { sx, sy, sw, sh } = computeCoverCrop(width, height, targetRatio, focus);
  return {
    widthPercent: (sw / width) * 100,
    heightPercent: (sh / height) * 100,
    leftPercent: (sx / width) * 100,
    topPercent: (sy / height) * 100,
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

/**
 * The widest image Instagram will publish.
 *
 * Documented on the media reference alongside the 8 MB cap: max width "1440
 * (will be scaled down to the maximum if necessary)", min width "320 (will be
 * scaled up to the minimum if necessary)".
 *
 * This number is why the 8 MB limit is a solvable problem rather than a wall.
 * Instagram downscales anything wider to 1440 on its own, so re-encoding a
 * 6000px camera JPEG at 1440 discards only pixels the platform was going to
 * discard anyway — the published result is the same picture, and the file lands
 * far under 8 MB on the way.
 */
export const INSTAGRAM_MAX_WIDTH_PX = 1440;
export const INSTAGRAM_MIN_WIDTH_PX = 320;

/**
 * Scale `width`×`height` down to fit `maxWidth`, preserving the ratio.
 *
 * Returns the input untouched when it already fits — upscaling a small image to
 * hit a width budget would add bytes and no detail.
 *
 * **Rounds toward square, exactly like `computeCoverCrop`, and for the same
 * reason.** Downscaling re-quantises the height, and at 1440px that error is
 * roughly five times the margin a boundary crop has to spare: a valid 1.9098:1
 * crop rounded the wrong way comes out at 1.9124 and Instagram rejects it. The
 * crop being correct at full size is no protection if the resize undoes it.
 *
 * `targetRatio` defaults to the source's own ratio, which is the right default
 * for the uncropped path — an image already inside the range stays inside it.
 */
export function fitWithinWidth(
  width: number,
  height: number,
  maxWidth: number = INSTAGRAM_MAX_WIDTH_PX,
  targetRatio: number = ratioOf(width, height)
): { width: number; height: number } {
  if (width <= maxWidth) return { width, height };

  // Taller ⇒ smaller ratio. So a landscape target rounds height UP to stay
  // narrower than asked, and a portrait target rounds it DOWN to stay wider.
  const towardSquare = targetRatio >= 1 ? Math.ceil : Math.floor;

  return {
    width: maxWidth,
    height: Math.max(1, towardSquare((height * maxWidth) / width)),
  };
}
