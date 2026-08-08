import { describe, expect, it } from "vitest";
import {
  CENTRED_FOCUS,
  FEED_PRESETS,
  INSTAGRAM_MAX_WIDTH_PX,
  REEL_PRESETS,
  clampFocusToCrop,
  computeCoverCrop,
  cropOverlayPercent,
  describeRatio,
  fitWithinWidth,
  isWithinRange,
  orientationOf,
  panAxis,
  ratioOf,
  suggestFixPreset,
} from "../lib/media/aspect";

/** Instagram's documented feed range: 4:5 to 1.91:1. */
const FEED_RANGE = { min: 0.8, max: 1.91 };

describe("computeCoverCrop", () => {
  it("trims the sides of a source wider than the target", () => {
    // 1920×1080 (1.78) down to 1:1 → keep full height, take a 1080-wide slice.
    const crop = computeCoverCrop(1920, 1080, 1);

    expect(crop).toEqual({ sx: 420, sy: 0, sw: 1080, sh: 1080 });
  });

  it("trims the top and bottom of a source taller than the target", () => {
    // 1080×1920 (0.5625) down to 4:5 → keep full width, take a 1350-tall slice.
    const crop = computeCoverCrop(1080, 1920, 0.8);

    expect(crop).toEqual({ sx: 0, sy: 285, sw: 1080, sh: 1350 });
  });

  it("changes nothing when the source already matches", () => {
    expect(computeCoverCrop(1080, 1350, 0.8)).toEqual({
      sx: 0,
      sy: 0,
      sw: 1080,
      sh: 1350,
    });
  });

  it("centres the kept region", () => {
    const { sx, sw } = computeCoverCrop(2000, 1000, 1);

    // Equal trim either side.
    expect(sx).toBe(500);
    expect(2000 - sx - sw).toBe(500);
  });

  it("never reads outside the source, whatever the rounding", () => {
    // Awkward sizes where width/targetRatio does not land on a whole pixel.
    const sizes: Array<[number, number]> = [
      [1001, 999],
      [333, 1000],
      [1919, 1079],
      [7, 3],
    ];

    for (const [w, h] of sizes) {
      for (const target of [1, 0.8, 1.91, 0.5625]) {
        const { sx, sy, sw, sh } = computeCoverCrop(w, h, target);

        expect(sx).toBeGreaterThanOrEqual(0);
        expect(sy).toBeGreaterThanOrEqual(0);
        expect(sx + sw).toBeLessThanOrEqual(w);
        expect(sy + sh).toBeLessThanOrEqual(h);
        expect(sw).toBeGreaterThan(0);
        expect(sh).toBeGreaterThan(0);
      }
    }
  });

  it("produces a region at (near enough) the requested ratio", () => {
    for (const target of [1, 0.8, 1.91, 0.5625]) {
      const { sw, sh } = computeCoverCrop(1920, 1080, target);
      // Whole-pixel rounding, so exactness is not available — but a visible
      // drift would mean Instagram rejects a crop we told the user was valid.
      expect(Math.abs(sw / sh - target)).toBeLessThan(0.01);
    }
  });

  it("keeps a crop of an out-of-range image inside the accepted range", () => {
    // The point of the whole feature: a 9:16 still cropped to a feed preset
    // must actually become publishable.
    for (const preset of FEED_PRESETS) {
      if (preset.ratio === null) continue;
      const { sw, sh } = computeCoverCrop(1080, 1920, preset.ratio);

      expect(isWithinRange(ratioOf(sw, sh), FEED_RANGE)).toBe(true);
    }
  });

  /**
   * Whole pixels cannot hit most ratios exactly, and the DIRECTION of that
   * error decides whether the crop publishes — Instagram's presets are the
   * boundaries of its own accepted range, so erring outward is rejected.
   *
   * The original implementation used Math.round and produced 1080×565 for this
   * case: 1.9115, wider than the 1.91 it claimed, rejected by Instagram as the
   * very crop offered to fix an out-of-range image.
   */
  it("never rounds a crop outside the ratio it was asked for", () => {
    for (let width = 200; width <= 4000; width += 37) {
      for (let height = 200; height <= 4000; height += 53) {
        for (const preset of FEED_PRESETS) {
          if (preset.ratio === null) continue;

          const { sw, sh } = computeCoverCrop(width, height, preset.ratio);
          const result = ratioOf(sw, sh);

          // Landscape must not come out wider; portrait must not come out
          // narrower. Both are "no further from square than requested".
          if (preset.ratio >= 1) {
            expect(result).toBeLessThanOrEqual(preset.ratio);
          } else {
            expect(result).toBeGreaterThanOrEqual(preset.ratio);
          }

          expect(isWithinRange(result, FEED_RANGE)).toBe(true);
        }
      }
    }
  });

  it("regression: 1080×1920 to 1.91:1 stays inside 1.91", () => {
    const { sw, sh } = computeCoverCrop(1080, 1920, 1.91);

    expect(ratioOf(sw, sh)).toBeLessThanOrEqual(1.91);
    expect(sh).toBe(566); // 565 is the Math.round answer, and it is wrong
  });
});

/**
 * The guard against the bug this step was written to prevent: the pre-research
 * plan had 9:16 in the feed preset list. At 0.5625 it is outside Instagram's
 * documented range, so every feed post or carousel using it would have been a
 * guaranteed container ERROR at publish time.
 */
describe("preset ranges", () => {
  it("offers no feed preset outside Instagram's accepted range", () => {
    for (const preset of FEED_PRESETS) {
      if (preset.ratio === null) continue;
      expect(isWithinRange(preset.ratio, FEED_RANGE)).toBe(true);
    }
  });

  it("does not offer 9:16 as a feed ratio", () => {
    expect(FEED_PRESETS.map((p) => p.ratio)).not.toContain(0.5625);
  });

  /**
   * 3:4 is the tempting one. Instagram's app took it as a native feed size in
   * 2026 and the profile grid moved to it, but Meta's publishing reference
   * still documents 4:5 as the tallest the API accepts. Adding it on the
   * strength of the app is the carousel ceiling all over again — a limit
   * widened past the docs that then failed in the worker with every file
   * already uploaded. Probe 10 settles it; until then this stands guard.
   */
  it("does not offer 3:4 while the documented range still starts at 4:5", () => {
    const offers34 = FEED_PRESETS.some(
      (preset) => preset.ratio !== null && Math.abs(preset.ratio - 0.75) < 0.001
    );

    expect(offers34).toBe(FEED_RANGE.min <= 0.75);
  });

  it("does offer 9:16 for Reels, where the feed range does not apply", () => {
    expect(REEL_PRESETS.map((p) => p.ratio)).toContain(0.5625);
  });

  it("lets both lists leave the file untouched", () => {
    for (const presets of [FEED_PRESETS, REEL_PRESETS]) {
      expect(presets.some((p) => p.ratio === null)).toBe(true);
      // "Original" is first, so it is the default selection.
      expect(presets[0].ratio).toBeNull();
    }
  });
});

describe("suggestFixPreset", () => {
  it("suggests nothing for an image that already fits", () => {
    for (const [w, h] of [
      [1080, 1080],
      [1080, 1350],
      [1920, 1080],
      [1910, 1000],
    ]) {
      expect(suggestFixPreset(w, h, FEED_RANGE)).toBeNull();
    }
  });

  it("offers 4:5 for a too-tall still, not 1.91:1", () => {
    // The least-destructive valid crop of a 9:16 image is the tallest one
    // available. Suggesting the widest would throw away most of the picture.
    expect(suggestFixPreset(1080, 1920, FEED_RANGE)?.id).toBe("PORTRAIT");
  });

  it("offers 1.91:1 for a too-wide still", () => {
    expect(suggestFixPreset(3000, 1000, FEED_RANGE)?.id).toBe("LANDSCAPE");
  });

  it("never suggests a preset that is itself out of range", () => {
    const suggestion = suggestFixPreset(1080, 1920, FEED_RANGE);

    expect(suggestion?.ratio).not.toBeNull();
    expect(isWithinRange(suggestion!.ratio!, FEED_RANGE)).toBe(true);
  });

  it("returns null when no preset in the list is publishable", () => {
    // Reel presets against the feed range: 9:16 does not qualify, and
    // "Original" is not a crop. Nothing to suggest.
    expect(suggestFixPreset(1080, 1920, FEED_RANGE, REEL_PRESETS)).toBeNull();
  });
});

describe("moving the crop", () => {
  it("centres by default, matching what Instagram itself would do", () => {
    // The whole focal-point feature has to be a no-op until someone drags.
    expect(computeCoverCrop(1920, 1080, 1)).toEqual(
      computeCoverCrop(1920, 1080, 1, CENTRED_FOCUS)
    );
  });

  it("slides the window along the free axis without resizing it", () => {
    const centred = computeCoverCrop(1920, 1080, 1);
    const left = computeCoverCrop(1920, 1080, 1, { x: 0.2, y: 0.5 });

    expect(left.sx).toBeLessThan(centred.sx);
    // Moving the crop must never change WHAT SHAPE it is — that would silently
    // undo the ratio the user picked.
    expect(left.sw).toBe(centred.sw);
    expect(left.sh).toBe(centred.sh);
  });

  it("pins to the edge rather than sampling outside the source", () => {
    for (const focus of [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: -5, y: 12 },
    ]) {
      const { sx, sy, sw, sh } = computeCoverCrop(1920, 1080, 0.8, focus);

      expect(sx).toBeGreaterThanOrEqual(0);
      expect(sy).toBeGreaterThanOrEqual(0);
      expect(sx + sw).toBeLessThanOrEqual(1920);
      expect(sy + sh).toBeLessThanOrEqual(1080);
    }
  });

  it("ignores the axis that has no freedom", () => {
    // 1920×1080 to 4:5 keeps the full height, so vertical focus does nothing.
    const a = computeCoverCrop(1920, 1080, 0.8, { x: 0.5, y: 0 });
    const b = computeCoverCrop(1920, 1080, 0.8, { x: 0.5, y: 1 });

    expect(a).toEqual(b);
  });

  it("names the axis the user can actually drag", () => {
    // Landscape source, portrait crop: full height kept, slides sideways.
    expect(panAxis(1920, 1080, 0.8)).toBe("HORIZONTAL");
    // Portrait source, landscape crop: full width kept, slides up and down.
    expect(panAxis(1080, 1920, 1.91)).toBe("VERTICAL");
    // Already the right shape: nothing to move, so nothing to advertise.
    expect(panAxis(1080, 1080, 1)).toBe("NONE");
  });
});

describe("clampFocusToCrop", () => {
  it("collapses to the centre on a locked axis", () => {
    // 1920×1080 to 4:5 keeps the full height, so y has exactly one legal value.
    const clamped = clampFocusToCrop(1920, 1080, 0.8, { x: 0.5, y: 0.9 });

    expect(clamped.y).toBeCloseTo(0.5, 10);
  });

  it("keeps the focus where the window still fits", () => {
    const clamped = clampFocusToCrop(1920, 1080, 1, { x: 0, y: 0.5 });
    const { sw } = computeCoverCrop(1920, 1080, 1);

    // Half the window's width in from the left edge, and no further.
    expect(clamped.x).toBeCloseTo(sw / (2 * 1920), 10);
  });

  it("leaves a focus that is already legal alone", () => {
    expect(clampFocusToCrop(1920, 1080, 1, { x: 0.45, y: 0.5 })).toEqual({
      x: 0.45,
      y: 0.5,
    });
  });
});

describe("cropOverlayPercent", () => {
  it("reports full width and a trimmed height for a tall source", () => {
    const overlay = cropOverlayPercent(1080, 1920, 0.8);

    expect(overlay.widthPercent).toBe(100);
    expect(overlay.heightPercent).toBeCloseTo(70.3, 1);
  });

  it("reports 100% on both axes when nothing would be cropped", () => {
    const overlay = cropOverlayPercent(1080, 1080, 1);

    expect(overlay.widthPercent).toBe(100);
    expect(overlay.heightPercent).toBe(100);
  });

  it("reports where the window sits, not just how big it is", () => {
    // Without a position the overlay can only ever be drawn centred, which is
    // wrong the moment the user moves the crop.
    const centred = cropOverlayPercent(1920, 1080, 1);
    const left = cropOverlayPercent(1920, 1080, 1, { x: 0.2, y: 0.5 });

    expect(centred.topPercent).toBe(0);
    expect(left.leftPercent).toBeLessThan(centred.leftPercent);
    expect(left.widthPercent).toBe(centred.widthPercent);
  });

  it("keeps the window inside the box it is drawn on", () => {
    for (const focus of [{ x: 0, y: 0 }, { x: 1, y: 1 }]) {
      const o = cropOverlayPercent(1080, 1920, 1.91, focus);

      expect(o.leftPercent).toBeGreaterThanOrEqual(0);
      expect(o.topPercent).toBeGreaterThanOrEqual(0);
      expect(o.leftPercent + o.widthPercent).toBeLessThanOrEqual(100.001);
      expect(o.topPercent + o.heightPercent).toBeLessThanOrEqual(100.001);
    }
  });
});

describe("orientation", () => {
  it("names ratios the way a person would", () => {
    expect(orientationOf(0.8)).toBe("VERTICAL");
    expect(orientationOf(1)).toBe("SQUARE");
    expect(orientationOf(1.91)).toBe("HORIZONTAL");
  });

  it("calls near-square near-square", () => {
    // 1080×1079 is not worth calling "horizontal" to a user.
    expect(orientationOf(ratioOf(1080, 1079))).toBe("SQUARE");
  });

  it("labels every preset with the orientation its ratio actually has", () => {
    // The label is what the user picks from. A preset saying "Vertical" while
    // cropping to a landscape ratio would be a trap, not a typo.
    for (const preset of [...FEED_PRESETS, ...REEL_PRESETS]) {
      if (preset.ratio === null) {
        expect(preset.orientation).toBeNull();
        continue;
      }
      expect(preset.orientation).toBe(orientationOf(preset.ratio));
      expect(preset.label.toLowerCase()).toContain(
        (preset.orientation as string).toLowerCase()
      );
    }
  });

  it("offers a vertical and a horizontal feed crop, not just square", () => {
    const offered = new Set(FEED_PRESETS.map((p) => p.orientation));

    expect(offered).toContain("VERTICAL");
    expect(offered).toContain("HORIZONTAL");
  });
});

describe("fitWithinWidth", () => {
  it("leaves an image that already fits completely alone", () => {
    expect(fitWithinWidth(1080, 1350)).toEqual({ width: 1080, height: 1350 });
  });

  it("scales down to the platform ceiling", () => {
    expect(fitWithinWidth(4320, 5400)).toEqual({
      width: INSTAGRAM_MAX_WIDTH_PX,
      height: 1800,
    });
  });

  it("never upscales a small image to hit the budget", () => {
    // Adding pixels adds bytes and no detail.
    expect(fitWithinWidth(320, 400)).toEqual({ width: 320, height: 400 });
  });

  /**
   * The bug this exists to prevent, and the reason the rounding is directional.
   *
   * A crop can be correct at full size and rejected after the resize: at 1440px
   * a half-pixel of height rounding moves the ratio by ~0.0013, while a
   * boundary crop such as 1.9098:1 has only ~0.0003 of margin. Rounding the
   * wrong way turns the very crop we offered as the fix back into a container
   * ERROR — at the scheduled minute, in the worker.
   */
  it("never rounds a downscaled crop outside the ratio it was cropped to", () => {
    for (let width = 1500; width <= 6000; width += 61) {
      for (let height = 1500; height <= 6000; height += 71) {
        for (const preset of FEED_PRESETS) {
          if (preset.ratio === null) continue;

          const crop = computeCoverCrop(width, height, preset.ratio);
          const out = fitWithinWidth(
            crop.sw,
            crop.sh,
            INSTAGRAM_MAX_WIDTH_PX,
            preset.ratio
          );

          expect(out.width).toBeLessThanOrEqual(INSTAGRAM_MAX_WIDTH_PX);
          expect(isWithinRange(ratioOf(out.width, out.height), FEED_RANGE)).toBe(
            true
          );
        }
      }
    }
  });

  it("keeps an uncropped image inside the range when it is downscaled", () => {
    // The compress-only path passes no target ratio, so the source's own ratio
    // is what must survive the resize — including one sitting on the boundary.
    for (const [w, h] of [
      [3820, 2000], // exactly 1.91:1
      [2000, 2500], // exactly 4:5
      [5000, 5000],
    ]) {
      const out = fitWithinWidth(w, h);

      expect(isWithinRange(ratioOf(w, h), FEED_RANGE)).toBe(true);
      expect(isWithinRange(ratioOf(out.width, out.height), FEED_RANGE)).toBe(
        true
      );
    }
  });
});

describe("describeRatio", () => {
  it("names the ratios a user recognises", () => {
    expect(describeRatio(1080, 1080)).toBe("1:1");
    expect(describeRatio(1080, 1350)).toBe("4:5");
    expect(describeRatio(1080, 1920)).toBe("9:16");
    expect(describeRatio(1920, 1080)).toBe("16:9");
  });

  it("falls back to pixel dimensions rather than an unrounded float", () => {
    expect(describeRatio(1234, 567)).toBe("1234×567");
  });
});
