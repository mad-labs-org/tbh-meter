import { describe, expect, it } from "vitest";
import {
  expKeepFraction,
  stageClearExp,
  expToNextLevel,
  measuredExpPerSecond,
  modeledExpPerSecond,
  timeToNextLevel,
  timeToLevel,
  type LevelCurve,
  type StageExpInput,
} from "./exp-model.js";

describe("expKeepFraction — over-level (MEASURED curve, E2)", () => {
  // The measured anchors — reproduced EXACTLY (the table IS the curve); interpolated between.
  const anchors: ReadonlyArray<readonly [gap: number, keep: number]> = [
    [2, 0.944], [4, 0.854], [6, 0.705], [8, 0.506], [9, 0.4], [12, 0.259], [14, 0.192], [18, 0.112], [22, 0.068],
  ];

  it("reproduces the measured anchors exactly", () => {
    for (const [gap, k] of anchors) {
      expect(expKeepFraction(91, 91 - gap)).toBeCloseTo(k, 5);
    }
  });

  it("interpolates between anchors (gap +10 = midpoint of +9 and +11)", () => {
    expect(expKeepFraction(91, 81)).toBeCloseTo((0.4 + 0.293) / 2, 5);
  });

  it("is gap-only (same gap → same keep, any base level)", () => {
    expect(expKeepFraction(50, 42)).toBeCloseTo(expKeepFraction(91, 83), 6); // both gap +8
  });

  it("matches the REAL Sorcerer run3 (gap +2, +8.7% accessory) vs the same-run Knight", () => {
    // E2: in run3 the Knight gained 17,057,822 (= that clear's base×accountMult, gap 0).
    // Sorc (gap +2, accessory ×1.087) over the SAME run = base × keep(+2) × 1.087.
    const knightSameRun = 17_057_822;
    const sorc = knightSameRun * expKeepFraction(93, 91) * 1.087;
    expect(Math.abs(sorc / 17_497_600 - 1)).toBeLessThan(0.005); // within 0.5% of the real Sorc run3
  });

  it("is non-increasing in gap, always in (0, 1)", () => {
    let prev = 1.0001;
    for (let gap = 1; gap <= 40; gap++) {
      const k = expKeepFraction(91, 91 - gap);
      expect(k).toBeLessThanOrEqual(prev); // strictly decreasing up to the last anchor, then flat
      expect(k).toBeGreaterThan(0);
      prev = k;
    }
  });
});

describe("expKeepFraction — under-level (formula, UNVALIDATED)", () => {
  it("full EXP at or just below the stage level", () => {
    expect(expKeepFraction(91, 91)).toBe(1); // gap 0
    expect(expKeepFraction(91, 92)).toBe(1); // 1 under
    expect(expKeepFraction(25, 30)).toBe(1); // 5 under, inside the band
  });

  it("under-level is far gentler than over-level at the same gap", () => {
    expect(expKeepFraction(91, 99)).toBeGreaterThan(expKeepFraction(99, 91)); // gap 8 both ways
  });
});

describe("stageClearExp", () => {
  const re = (k: number): number | undefined => ({ 10: 10, 20: 15, 99: 100 })[k];

  it("scales base monster exp by the stage-level multiplier × kills", () => {
    const stage: StageExpInput = {
      monsters: [{ monster: 10, weight: 1000 }],
      levelScaling: { exp: 100 }, // 0.1×
      waveAmount: 10,
      waveMonsterAmount: 1,
      bossMonsterKey: null,
    };
    expect(stageClearExp(stage, re)).toBeCloseTo(10, 4); // 10 kills × (10 × 0.1)
  });

  it("adds the boss with its own exp multiplier", () => {
    const stage: StageExpInput = {
      monsters: [{ monster: 10, weight: 1000 }],
      levelScaling: { exp: 100 },
      waveAmount: 10,
      waveMonsterAmount: 1,
      bossMonsterKey: 99,
      bossMultipliers: { exp: 3000 }, // 3×
    };
    expect(stageClearExp(stage, re)).toBeCloseTo(10 + 100 * 0.1 * 3, 4); // 10 + 30
  });

  it("spawn-weights the monster pool", () => {
    const stage: StageExpInput = {
      monsters: [
        { monster: 10, weight: 1000 },
        { monster: 20, weight: 1000 },
      ],
      levelScaling: { exp: 100 },
      waveAmount: 10,
      waveMonsterAmount: 1,
      bossMonsterKey: null,
    };
    expect(stageClearExp(stage, re)).toBeCloseTo(((10 + 15) / 2) * 0.1 * 10, 4); // 12.5
  });
});

describe("level curve & time-to-level", () => {
  const curve: LevelCurve = { 30: 300, 31: 400, 32: 500 };

  it("expToNextLevel returns the curve value, null when capped", () => {
    expect(expToNextLevel(30, curve)).toBe(300);
    expect(expToNextLevel(99, curve)).toBeNull();
  });

  it("timeToNextLevel divides remaining EXP by the rate", () => {
    expect(timeToNextLevel(30, 100, 10, curve)).toBeCloseTo(20, 4); // (300-100)/10
    expect(timeToNextLevel(30, 100, 0, curve)).toBe(Infinity); // no income
    expect(timeToNextLevel(99, 0, 10, curve)).toBeNull(); // capped
  });

  it("timeToLevel sums the current remainder + full intermediate levels", () => {
    expect(timeToLevel(30, 100, 32, () => 10, curve)).toBeCloseTo((300 - 100) / 10 + 400 / 10, 4); // 60
    expect(timeToLevel(30, 0, 30, () => 10, curve)).toBe(0); // already there
    expect(timeToLevel(30, 0, 95, () => 10, curve)).toBeNull(); // hits a capped/unknown level
  });

  it("modeledExpPerSecond folds in the penalty, hero bonus, and account multiplier", () => {
    const k = expKeepFraction(30, 22); // measured gap +8 ≈ 0.506
    // composition: epc × keep × (1+bonusPct/100) × accountXpMultiplier ÷ clearTime
    expect(modeledExpPerSecond(1000, 30, 22, 10, 100, 2)).toBeCloseTo((1000 * k * 2 * 2) / 10, 4);
  });

  it("matches the REAL Knight run on 4301 (base × account multiplier)", () => {
    // E2 ground truth: Knight lv91 on stageLevel-91 (gap 0, keep=1, no hero bonus), 1 clear = 17,736,256.
    // datamine base expPerClear(4301)=5,314,181; account XP multiplier (all runes) = 3.3375.
    const perClear = modeledExpPerSecond(5_314_181, 91, 91, 1, 0, 3.3375); // clearTime=1 → value = per clear
    expect(perClear).toBeCloseTo(17_736_256, -3); // within ~1000
  });
});

describe("measuredExpPerSecond — the live, zero-model rate", () => {
  it("divides cumulative gain by elapsed seconds", () => {
    expect(measuredExpPerSecond(60_000, 30)).toBeCloseTo(2_000, 5);
  });

  it("returns 0 when no time has elapsed yet (no rate)", () => {
    expect(measuredExpPerSecond(60_000, 0)).toBe(0);
    expect(measuredExpPerSecond(60_000, -1)).toBe(0);
  });

  it("feeds timeToNextLevel as the measured-rate path", () => {
    // need 5000 (curve), 1000 into the level, measured 100 xp/s → (5000-1000)/100 = 40s.
    const curve: LevelCurve = { 50: 5000 };
    const rate = measuredExpPerSecond(700, 7); // 100/s
    expect(timeToNextLevel(50, 1000, rate, curve)).toBeCloseTo(40, 5);
  });
});
