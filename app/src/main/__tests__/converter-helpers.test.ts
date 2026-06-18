import { describe, expect, it } from "vitest";
import { modeName, resolveStage, computeDps, computeRate, round } from "../converter/helpers.js";

describe("modeName — difficulty enum -> display label (mirrors reader EStageDifficulty)", () => {
  it("maps the four difficulties", () => {
    expect(modeName(0)).toBe("Normal");
    expect(modeName(1)).toBe("Nightmare");
    expect(modeName(2)).toBe("Hell");
    expect(modeName(3)).toBe("Torment");
  });

  it('returns "?" for null (stage unresolved)', () => {
    expect(modeName(null)).toBe("?");
  });

  it('returns "?" for an unknown enum value', () => {
    expect(modeName(99)).toBe("?");
  });
});

describe("resolveStage — act-stageNo trivial formatting", () => {
  it("formats act-stageNo", () => {
    expect(resolveStage(3, 9)).toBe("3-9");
    expect(resolveStage(1, 10)).toBe("1-10");
  });

  it('returns "?" when act is missing', () => {
    expect(resolveStage(null, 9)).toBe("?");
  });

  it('returns "?" when stageNo is missing', () => {
    expect(resolveStage(3, null)).toBe("?");
  });

  it("formats a 0 act (real value, not missing)", () => {
    expect(resolveStage(0, 1)).toBe("0-1");
  });
});

describe("computeDps — totalDamage / reference seconds", () => {
  it("uses clearTime as the reference when the run cleared", () => {
    expect(computeDps(4_500_000, 90, 92)).toBeCloseTo(50_000, 5);
  });

  it("falls back to duration when clearTime is 0 (fail/abandoned)", () => {
    expect(computeDps(1_000_000, 0, 50)).toBeCloseTo(20_000, 5);
  });

  it("floors the reference at 1s so a sub-second duration cannot explode", () => {
    expect(computeDps(5_000, 0, 0)).toBe(5_000);
    expect(computeDps(5_000, 0, 0.2)).toBe(5_000);
  });

  it("returns 0 for non-positive damage", () => {
    expect(computeDps(0, 90, 92)).toBe(0);
    expect(computeDps(-5, 90, 92)).toBe(0);
  });

  it("returns 0 for non-finite damage (never NaN/Infinity in the record)", () => {
    expect(computeDps(Number.NaN, 90, 92)).toBe(0);
    expect(computeDps(Number.POSITIVE_INFINITY, 90, 92)).toBe(0);
  });
});

describe("computeRate — gained / reference seconds (same reference as dps)", () => {
  it("computes gold/sec from clearTime", () => {
    expect(computeRate(125_000, 90, 92)).toBeCloseTo(1_388.8889, 3);
  });

  it("computes xp/sec from clearTime", () => {
    expect(computeRate(3_400_000, 90, 92)).toBeCloseTo(37_777.7778, 3);
  });

  it("falls back to duration when clearTime is 0", () => {
    expect(computeRate(1_000, 0, 10)).toBe(100);
  });

  it("returns 0 for non-positive or non-finite gained", () => {
    expect(computeRate(0, 90, 92)).toBe(0);
    expect(computeRate(-1, 90, 92)).toBe(0);
    expect(computeRate(Number.NaN, 90, 92)).toBe(0);
  });
});

describe("round", () => {
  it("rounds to 2 decimals by default", () => {
    expect(round(1_388.88889)).toBe(1_388.89);
    expect(round(37_777.77778)).toBe(37_777.78);
  });

  it("rounds to a custom precision", () => {
    expect(round(1.23456, 3)).toBe(1.235);
  });

  it("returns 0 for non-finite values", () => {
    expect(round(Number.NaN)).toBe(0);
    expect(round(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
