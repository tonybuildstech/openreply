import { describe, expect, it } from "vitest";
import {
  FEED_PRESETS,
  REEL_PRESETS,
  computeCoverCrop,
  cropOverlayPercent,
  describeRatio,
  isWithinRange,
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
