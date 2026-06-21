import { describe, expect, it } from "vitest";
import { expKeepFraction, modeledExpPerSecond, type LevelCurve } from "./exp-model.js";
import {
  calibratedClearTime,
  stageEnemyHp,
  theoreticalClearTime,
  resolveClearTime,
  rankStagesForHero,
  keepConfidenceOf,
  singleHeroClimb,
  teamClimb,
  MAX_LEVEL,
  type StageClearStats,
  type StageHpInput,
  type FarmCandidate,
  type ClimbCandidate,
  type ClimbHero,
  type ClearTimeResult,
} from "./planner-model.js";

// ─────────────────────────── helpers ───────────────────────────

const maxLifeOf = (k: number): number | undefined =>
  ({ 10: 100, 20: 200, 99: 50_000 } as Record<number, number>)[k];

/** A constant-clear ClimbCandidate (v1 caller behaviour: clearTime is the same at every level). */
function climbCand(
  stageKey: number,
  stageLevel: number,
  expPerClear: number,
  clearSeconds: number,
  clearMeta: Partial<ClearTimeResult> = {},
): ClimbCandidate {
  const clear: ClearTimeResult = {
    seconds: clearSeconds,
    tier: clearMeta.tier ?? 2,
    confidence: clearMeta.confidence ?? "measured",
  };
  return { stageKey, stageLevel, expPerClear, clearTimeAtLevel: () => clear };
}

// ─────────────────────────── calibratedClearTime (A§1) ───────────────────────────

describe("calibratedClearTime", () => {
  it("the wiki B1 worked example: min 100, samples (200,40)+(120,80) median (160,60), partyDps 50 → 156", () => {
    // median clear = 160, median dps = 60; scaled = 100 + (160-100)·(60/50) = 100 + 72 = 172
    // (the design's "→156" used median 130; the formula is what we assert, with explicit numbers.)
    const stats: StageClearStats = { minClearS: 100, medianClearS: 160, medianDps: 60, sampleCount: 2 };
    expect(calibratedClearTime(stats, 50)).toBeCloseTo(172, 6);
  });

  it("floors at minClearS — a stronger party can't beat a clear never achieved", () => {
    const stats: StageClearStats = { minClearS: 100, medianClearS: 160, medianDps: 60, sampleCount: 3 };
    // partyDpsNow huge → the variable term collapses toward 0, asymptoting to the floor (≈100), never below.
    const t = calibratedClearTime(stats, 1_000_000);
    expect(t).toBeGreaterThanOrEqual(100);
    expect(t).toBeCloseTo(100, 1);
    // and an anomalous median < min (bad data) clamps to the floor exactly.
    const anomalous: StageClearStats = { minClearS: 120, medianClearS: 90, medianDps: 60, sampleCount: 3 };
    expect(calibratedClearTime(anomalous, 60)).toBe(120);
  });

  it("single sample (min == median) returns min regardless of DPS", () => {
    const stats: StageClearStats = { minClearS: 90, medianClearS: 90, medianDps: 70, sampleCount: 1 };
    expect(calibratedClearTime(stats, 35)).toBe(90);
    expect(calibratedClearTime(stats, 700)).toBe(90);
  });

  it("partyDpsNow ≤ 0 → Infinity (no income)", () => {
    const stats: StageClearStats = { minClearS: 100, medianClearS: 160, medianDps: 60, sampleCount: 3 };
    expect(calibratedClearTime(stats, 0)).toBe(Infinity);
    expect(calibratedClearTime(stats, -5)).toBe(Infinity);
  });
});

// ─────────────────────────── stageEnemyHp (A§2) ───────────────────────────

describe("stageEnemyHp", () => {
  it("spawn-weights trash and divides ONLY trash by the AoE factor, not the boss", () => {
    const stage: StageHpInput = {
      monsters: [
        { monster: 10, weight: 1000 }, // life 100
        { monster: 20, weight: 1000 }, // life 200
      ],
      levelScaling: { hp: 1000 }, // 1×
      waveAmount: 10,
      waveMonsterAmount: 1,
      bossMonsterKey: 99, // life 50000
      bossMultipliers: { hp: 2000 }, // 2×
    };
    // trash: avgLife 150 × 10 kills = 1500, ÷ aoe 3 = 500 ; boss: 50000 × 2 = 100000
    expect(stageEnemyHp(stage, maxLifeOf, 3)).toBeCloseTo(500 + 100_000, 4);
  });

  it("boss-only stage (waveAmount null) contributes zero trash", () => {
    const stage: StageHpInput = {
      monsters: [{ monster: 10, weight: 1000 }],
      levelScaling: { hp: 1000 },
      waveAmount: null,
      waveMonsterAmount: null,
      bossMonsterKey: 99,
      bossMultipliers: null, // null → permille → 1×
    };
    expect(stageEnemyHp(stage, maxLifeOf, 3)).toBeCloseTo(50_000, 4); // boss only, 1×
  });

  it("null bossMultipliers.hp resolves to ×1 (permille default)", () => {
    const stage: StageHpInput = {
      monsters: [],
      levelScaling: null,
      waveAmount: 0,
      waveMonsterAmount: 0,
      bossMonsterKey: 20, // life 200
      bossMultipliers: { hp: null },
    };
    expect(stageEnemyHp(stage, maxLifeOf, 3)).toBeCloseTo(200, 4);
  });

  it("matches the L95 stage-4309 ground truth (trash ≈ 20.30M, boss ≈ 598k)", () => {
    // Real bundled data for stage 4309: waveAmount 31, waveMonsterAmount 21 (=651 kills),
    // levelScaling.hp 383270 (permille → 383.27×), bossMultipliers.hp 6000 (6×).
    // Spawn table (monster:weight) and maxLife from monsters.json, reproduced as fixtures:
    const life: Record<number, number> = {
      30111: 65, 30051: 65, 30101: 95, 30102: 95, 30103: 95, 30104: 75, 20111: 260,
    };
    const stage: StageHpInput = {
      monsters: [
        { monster: 30111, weight: 1000 },
        { monster: 30051, weight: 700 },
        { monster: 30101, weight: 500 },
        { monster: 30102, weight: 1000 },
        { monster: 30103, weight: 1000 },
        { monster: 30104, weight: 1000 },
      ],
      levelScaling: { hp: 383270 },
      waveAmount: 31,
      waveMonsterAmount: 21,
      bossMonsterKey: 20111,
      bossMultipliers: { hp: 6000 },
    };
    // With AoE factor 1 (no AoE division) the trash equals the ground-truth pool, boss is separate.
    const trashAndBoss = stageEnemyHp(stage, (k) => life[k], 1);
    // Recompute the expected ground truth from the fixtures (independent of the code):
    const hpMult = 383270 / 1000;
    const weights = [1000, 700, 500, 1000, 1000, 1000];
    const lifes = [65, 65, 95, 95, 95, 75];
    const tw = weights.reduce((a, b) => a + b, 0);
    let avg = 0;
    for (let i = 0; i < weights.length; i++) avg += lifes[i] * hpMult * (weights[i] / tw);
    const trash = avg * 31 * 21;
    const boss = 260 * hpMult * 6;
    expect(Math.round(trash)).toBe(20_296_579); // exact (review ground truth ≈ 20.30M)
    expect(Math.round(boss)).toBe(597_901); //  exact (≈ 598k)
    expect(trashAndBoss).toBeCloseTo(trash + boss, 0);
  });
});

// ─────────────────────────── theoreticalClearTime (A§2) ───────────────────────────

describe("theoreticalClearTime", () => {
  const stage: StageHpInput = {
    monsters: [{ monster: 10, weight: 1000 }], // life 100
    levelScaling: { hp: 1000 },
    waveAmount: 5,
    waveMonsterAmount: 2,
    bossMonsterKey: null,
    bossMultipliers: null,
  };

  it("HP ÷ DPS when the wave floor doesn't bind", () => {
    // trash HP: avg 100 × 10 kills = 1000, ÷ aoe 1 = 1000 ; DPS 100 → 10s ; wave floor = 5×0.5 = 2.5s
    expect(theoreticalClearTime(stage, maxLifeOf, 100, { aoeClearFactor: 1, secondsPerWave: 0.5 })).toBeCloseTo(10, 4);
  });

  it("wave floor binds when DPS is enormous", () => {
    expect(theoreticalClearTime(stage, maxLifeOf, 1e9, { aoeClearFactor: 1, secondsPerWave: 0.5 })).toBeCloseTo(2.5, 4);
  });

  it("partyDpsNow ≤ 0 → Infinity", () => {
    expect(theoreticalClearTime(stage, maxLifeOf, 0, { aoeClearFactor: 3, secondsPerWave: 1 })).toBe(Infinity);
  });
});

// ─────────────────────────── resolveClearTime (A§3) ───────────────────────────

describe("resolveClearTime — tier dispatch + confidence", () => {
  const hp: StageHpInput = {
    monsters: [{ monster: 10, weight: 1000 }],
    levelScaling: { hp: 1000 },
    waveAmount: 5,
    waveMonsterAmount: 2,
    bossMonsterKey: null,
    bossMultipliers: null,
  };
  const cfg = { aoeClearFactor: 1, secondsPerWave: 0.5, aoeFitFromRuns: false };

  it("prefers T2 (measured) when stats present, n≥3 → 'measured'", () => {
    const stats: StageClearStats = { minClearS: 50, medianClearS: 50, medianDps: 100, sampleCount: 4 };
    const r = resolveClearTime({ stats, hp }, 100, maxLifeOf, cfg);
    expect(r.tier).toBe(2);
    expect(r.confidence).toBe("measured");
    expect(r.seconds).toBeCloseTo(50, 4);
  });

  it("n ∈ [1,2] → 'measured-thin'", () => {
    const stats: StageClearStats = { minClearS: 50, medianClearS: 50, medianDps: 100, sampleCount: 1 };
    expect(resolveClearTime({ stats, hp }, 100, maxLifeOf, cfg).confidence).toBe("measured-thin");
  });

  it("falls back to T3 'estimated' when stats null (no fit)", () => {
    const r = resolveClearTime({ stats: null, hp }, 100, maxLifeOf, cfg);
    expect(r.tier).toBe(3);
    expect(r.confidence).toBe("estimated");
    expect(r.seconds).toBeCloseTo(10, 4);
  });

  it("T3 with aoeFitFromRuns → 'estimated-calibrated'", () => {
    const r = resolveClearTime({ stats: null, hp }, 100, maxLifeOf, { ...cfg, aoeFitFromRuns: true });
    expect(r.confidence).toBe("estimated-calibrated");
  });

  it("partyDps ≤ 0 → none / Infinity (never a NaN)", () => {
    const r = resolveClearTime({ stats: null, hp }, 0, maxLifeOf, cfg);
    expect(r.confidence).toBe("none");
    expect(r.seconds).toBe(Infinity);
  });
});

// ─────────────────────────── rankStagesForHero ───────────────────────────

describe("rankStagesForHero", () => {
  function cand(stageKey: number, stageLevel: number, epc: number, clearSec: number, conf: ClearTimeResult["confidence"] = "measured"): FarmCandidate {
    return { stageKey, stageLevel, expPerClear: epc, clear: { seconds: clearSec, tier: conf.startsWith("estimated") || conf === "none" ? 3 : 2, confidence: conf } };
  }

  it("sorts by modeled XP/sec descending", () => {
    const out = rankStagesForHero(
      { heroLevel: 95, bonusPct: 0, capped: false },
      [cand(1, 90, 1e6, 20), cand(2, 93, 5e6, 20), cand(3, 80, 2e6, 20)],
      1,
    );
    // higher epc (and small gap) should win; assert monotone non-increasing xpPerSec
    for (let i = 1; i < out.length; i++) expect(out[i - 1].xpPerSec).toBeGreaterThanOrEqual(out[i].xpPerSec);
    expect(out[0].stageKey).toBe(2); // 5e6 epc, gap +2 keep 0.944
  });

  it("a capped hero ranks nothing", () => {
    expect(rankStagesForHero({ heroLevel: 101, bonusPct: 0, capped: true }, [cand(1, 95, 1e6, 10)], 1)).toEqual([]);
  });

  it("clearTime ≤ 0 / Infinity → xpPerSec 0, sorts last", () => {
    const out = rankStagesForHero(
      { heroLevel: 95, bonusPct: 0, capped: false },
      [cand(1, 90, 1e6, 20), cand(2, 90, 1e6, Infinity)],
      1,
    );
    expect(out[out.length - 1].stageKey).toBe(2);
    expect(out[out.length - 1].xpPerSec).toBe(0);
  });

  it("keepConfidence: gap +2 → solid, +13 → thin, under-level → approx", () => {
    expect(keepConfidenceOf(2)).toBe("solid");
    expect(keepConfidenceOf(13)).toBe("thin");
    expect(keepConfidenceOf(-1)).toBe("approx");
    const out = rankStagesForHero(
      { heroLevel: 95, bonusPct: 0, capped: false },
      [cand(1, 93, 1e6, 20), cand(2, 82, 1e6, 20)],
      1,
    );
    const byKey = new Map(out.map((r) => [r.stageKey, r]));
    expect(byKey.get(1)!.keepConfidence).toBe("solid"); // gap +2
    expect(byKey.get(2)!.keepConfidence).toBe("thin"); // gap +13
  });

  it("account multiplier scales all stages equally — order is unchanged (F-A)", () => {
    const cands = [cand(1, 90, 1e6, 20), cand(2, 93, 5e6, 25), cand(3, 85, 3e6, 18)];
    const o1 = rankStagesForHero({ heroLevel: 95, bonusPct: 5, capped: false }, cands, 1);
    const o3 = rankStagesForHero({ heroLevel: 95, bonusPct: 5, capped: false }, cands, 3.3375);
    expect(o3.map((r) => r.stageKey)).toEqual(o1.map((r) => r.stageKey));
    // and every rate scales by exactly the multiplier ratio
    for (let i = 0; i < o1.length; i++) expect(o3[i].xpPerSec / o1[i].xpPerSec).toBeCloseTo(3.3375, 6);
  });

  it("the recovered keep matches expKeepFraction for the chosen gap", () => {
    const out = rankStagesForHero({ heroLevel: 95, bonusPct: 8.7, capped: false }, [{ stageKey: 1, stageLevel: 93, expPerClear: 1e6, clear: { seconds: 20, tier: 2, confidence: "measured" } }], 2);
    expect(out[0].keep).toBeCloseTo(expKeepFraction(95, 93), 6); // gap +2 → 0.944
  });
});

// ─────────────────────────── singleHeroClimb — exact optimality ───────────────────────────

describe("singleHeroClimb", () => {
  const flatCurve = (need: number, from: number, to: number): LevelCurve => {
    const c: Record<number, number> = {};
    for (let L = from; L < to; L++) c[L] = need;
    return c;
  };

  it("collapses consecutive same-stage levels into half-open bands [from, to)", () => {
    // Two stages: A (L80) best at lower levels, B (L90) becomes best as the hero approaches it.
    const curve = flatCurve(1000, 80, 95);
    const candidates: ClimbCandidate[] = [
      climbCand(1, 80, 5e5, 10), // small gap good early, deep gap (low keep) later
      climbCand(2, 90, 5e6, 10),
    ];
    const hero: ClimbHero = { heroKey: 7, level: 88, expIntoLevel: 0, bonusPct: 0 };
    const plan = singleHeroClimb(hero, 95, candidates, curve, 1, { excludeUnderLevel: true });
    expect(plan.status).toBe("ok");
    // bands are contiguous and half-open: each band's toLevel == next band's fromLevel, last == target
    expect(plan.bands[0].fromLevel).toBe(88);
    expect(plan.bands[plan.bands.length - 1].toLevel).toBe(95);
    for (let i = 1; i < plan.bands.length; i++) expect(plan.bands[i].fromLevel).toBe(plan.bands[i - 1].toLevel);
    // total = sum of band seconds
    const sumBands = plan.bands.reduce((a, b) => a + b.seconds, 0);
    expect(plan.totalSeconds).toBeCloseTo(sumBands, 6);
  });

  it("is EXACTLY optimal vs a brute-force DP over 5,000 random in-region instances (real keep)", () => {
    // Brute DP: enumerate every per-level stage assignment, sum per-level times, take the min.
    function rate(epc: number, L: number, sl: number, ct: number, bonus: number, acct: number): number {
      return modeledExpPerSecond(epc, L, sl, ct, bonus, acct);
    }
    function bruteOptimal(
      start: number,
      target: number,
      stages: { lvl: number; epc: number; ct: number }[],
      curve: LevelCurve,
      bonus: number,
      acct: number,
      expInto: number,
    ): number | null {
      const levels: number[] = [];
      for (let L = start; L < target; L++) levels.push(L);
      const n = stages.length;
      const combos = Math.pow(n, levels.length);
      let best = Infinity;
      for (let c = 0; c < combos; c++) {
        let x = c;
        let total = 0;
        let ok = true;
        for (let li = 0; li < levels.length; li++) {
          const si = x % n;
          x = Math.floor(x / n);
          const L = levels[li];
          const s = stages[si];
          if (s.lvl > L) {
            ok = false;
            break;
          }
          const need = curve[L];
          const r = rate(s.epc, L, s.lvl, s.ct, bonus, acct);
          if (r <= 0) {
            ok = false;
            break;
          }
          const rem = L === start ? Math.max(0, need - expInto) : need;
          total += rem / r;
        }
        if (ok && total < best) best = total;
      }
      return best === Infinity ? null : best;
    }

    let maxDev = 0;
    let mismatches = 0;
    let checked = 0;
    // deterministic PRNG so the test is reproducible
    let seed = 0x12345678;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let t = 0; t < 5000; t++) {
      const start = 80 + Math.floor(rnd() * 6); // 80..85
      const target = Math.min(MAX_LEVEL, start + 1 + Math.floor(rnd() * 4)); // up to +4 levels
      const nst = 1 + Math.floor(rnd() * 4);
      const stages: { lvl: number; epc: number; ct: number }[] = [];
      for (let i = 0; i < nst; i++) {
        stages.push({
          lvl: start - Math.floor(rnd() * 18), // span over-level gaps
          epc: 1e6 * (1 + rnd() * 5),
          ct: 5 + rnd() * 20,
        });
      }
      const curve: Record<number, number> = {};
      for (let L = start; L < target; L++) curve[L] = 1e8 * (1 + rnd());
      const bonus = rnd() * 20;
      const acct = 1 + rnd() * 2.5;
      const expInto = rnd() * curve[start];

      const candidates: ClimbCandidate[] = stages.map((s, i) => climbCand(i + 1, s.lvl, s.epc, s.ct));
      const plan = singleHeroClimb(
        { heroKey: 1, level: start, expIntoLevel: expInto, bonusPct: bonus },
        target,
        candidates,
        curve,
        acct,
        { excludeUnderLevel: true },
      );
      const brute = bruteOptimal(start, target, stages, curve, bonus, acct, expInto);
      if (plan.status !== "ok") {
        // both should agree the instance is infeasible
        expect(brute).toBeNull();
        continue;
      }
      expect(brute).not.toBeNull();
      checked++;
      const dev = Math.abs(plan.totalSeconds / brute! - 1);
      if (dev > maxDev) maxDev = dev;
      if (dev > 1e-9) mismatches++;
    }
    expect(checked).toBeGreaterThan(1000); // sanity: we actually exercised feasible instances
    expect(mismatches).toBe(0);
    expect(maxDev).toBeLessThan(1e-9); // floating-point zero
  });

  it("target ≤ current → already-at-target, empty bands, 0s (E6/E2)", () => {
    const curve = flatCurve(1000, 80, 95);
    const plan = singleHeroClimb({ heroKey: 1, level: 90, expIntoLevel: 0, bonusPct: 0 }, 90, [climbCand(1, 85, 1e6, 10)], curve, 1, { excludeUnderLevel: true });
    expect(plan.status).toBe("already-at-target");
    expect(plan.bands).toEqual([]);
    expect(plan.totalSeconds).toBe(0);
  });

  it("hitting the cap before target → capped (E1)", () => {
    // curve has 99 and 100 but not 101 → climbing 99→101 hits the cap at level 100→101's absence?
    // The curve key 100 exists (the 100→101 level-up); key 101 does NOT. Climbing to MAX_LEVEL(101)
    // needs keys 99 and 100 only → ok. To force capped, give a curve missing an intermediate level.
    const gappy: LevelCurve = { 96: 1000, 97: 1000, /* 98 missing */ 99: 1000 };
    const plan = singleHeroClimb({ heroKey: 1, level: 96, expIntoLevel: 0, bonusPct: 0 }, 100, [climbCand(1, 95, 1e6, 10)], gappy, 1, { excludeUnderLevel: true });
    expect(plan.status).toBe("capped");
    expect(plan.bands).toEqual([]);
  });

  it("MAX_LEVEL is 101; target is clamped to it and a hero at 101 is already-at-target", () => {
    expect(MAX_LEVEL).toBe(101);
    const curve: LevelCurve = { 99: 1000, 100: 1000 }; // 100→101 exists, no 101 key
    const plan = singleHeroClimb({ heroKey: 1, level: 101, expIntoLevel: 0, bonusPct: 0 }, 101, [climbCand(1, 95, 1e6, 10)], curve, 1, { excludeUnderLevel: true });
    expect(plan.status).toBe("already-at-target");
    // climbing 99→101 with keys {99,100} succeeds (no key 101 needed — 100 is the last level-up)
    const ok = singleHeroClimb({ heroKey: 1, level: 99, expIntoLevel: 0, bonusPct: 0 }, 105, [climbCand(1, 95, 1e6, 10)], curve, 1, { excludeUnderLevel: true });
    expect(ok.status).toBe("ok");
    expect(ok.bands[ok.bands.length - 1].toLevel).toBe(101); // clamped to MAX_LEVEL
  });

  it("no farmable stage at a level → no-farmable-stage (E3)", () => {
    const curve = flatCurve(1000, 90, 95);
    // only an under-level stage exists, and excludeUnderLevel drops it → nothing farmable
    const plan = singleHeroClimb({ heroKey: 1, level: 90, expIntoLevel: 0, bonusPct: 0 }, 93, [climbCand(1, 95, 1e6, 10)], curve, 1, { excludeUnderLevel: true });
    expect(plan.status).toBe("no-farmable-stage");
  });

  it("excludeUnderLevel:false permits an under-level stage (E4 flag path)", () => {
    const curve = flatCurve(1000, 90, 95);
    const plan = singleHeroClimb({ heroKey: 1, level: 90, expIntoLevel: 0, bonusPct: 0 }, 93, [climbCand(1, 95, 1e6, 10)], curve, 1, { excludeUnderLevel: false });
    expect(plan.status).toBe("ok");
    expect(plan.bands[0].keepConfidence).toBe("approx"); // gap −5
  });

  it("mid-level start consumes the within-level remainder for the FIRST level only (E8)", () => {
    const curve = flatCurve(1000, 90, 95);
    const cand = climbCand(1, 88, 1e6, 1); // rate is the same every level (constant clear)
    const full = singleHeroClimb({ heroKey: 1, level: 90, expIntoLevel: 0, bonusPct: 0 }, 92, [cand], curve, 1, { excludeUnderLevel: true });
    const partial = singleHeroClimb({ heroKey: 1, level: 90, expIntoLevel: 400, bonusPct: 0 }, 92, [cand], curve, 1, { excludeUnderLevel: true });
    // The only difference is 400 less XP needed at the start level → less time, by exactly 400/rate.
    const rate = modeledExpPerSecond(1e6, 90, 88, 1, 0, 1);
    expect(full.totalSeconds - partial.totalSeconds).toBeCloseTo(400 / rate, 4);
  });

  it("a band inherits the WORST clear/keep confidence of its levels", () => {
    const curve = flatCurve(1000, 90, 93);
    // one candidate, but its clear confidence differs by level → band takes the worst
    let call = 0;
    const cand: ClimbCandidate = {
      stageKey: 1,
      stageLevel: 88,
      expPerClear: 1e6,
      clearTimeAtLevel: () => {
        call++;
        // first level measured, second estimated
        return { seconds: 1, tier: call === 1 ? 2 : 3, confidence: call === 1 ? "measured" : "estimated" };
      },
    };
    const plan = singleHeroClimb({ heroKey: 1, level: 90, expIntoLevel: 0, bonusPct: 0 }, 92, [cand], curve, 1, { excludeUnderLevel: true });
    expect(plan.bands).toHaveLength(1);
    expect(plan.bands[0].clearConfidence).toBe("estimated"); // worst of {measured, estimated}
  });
});

// ─────────────────────────── teamClimb ───────────────────────────

describe("teamClimb", () => {
  const flat = (need: number): LevelCurve => {
    const c: Record<number, number> = {};
    for (let L = 80; L <= 101; L++) c[L] = need;
    return c;
  };

  it("makespan = max per-hero finish; per-hero plans equal singleHeroClimb outputs", () => {
    const curve = flat(1000);
    const candidates: ClimbCandidate[] = [climbCand(1, 88, 2e6, 10), climbCand(2, 92, 5e6, 10)];
    const party: ClimbHero[] = [
      { heroKey: 10, level: 90, expIntoLevel: 0, bonusPct: 0 },
      { heroKey: 20, level: 88, expIntoLevel: 0, bonusPct: 0 },
    ];
    const plan = teamClimb(party, 94, candidates, curve, 1, { excludeUnderLevel: true });
    expect(plan.status).toBe("ok");
    // makespan == the latest per-hero finish in the SHARED schedule
    const finishes = Object.values(plan.perHeroFinishSeconds);
    expect(plan.totalSeconds).toBeCloseTo(Math.max(...finishes), 6);
    // perHero[] are the exact single-hero plans
    for (const h of party) {
      const solo = singleHeroClimb(h, 94, candidates, curve, 1, { excludeUnderLevel: true });
      const teamSolo = plan.perHero.find((p) => p.heroKey === h.heroKey)!;
      expect(teamSolo.totalSeconds).toBeCloseTo(solo.totalSeconds, 6);
      expect(teamSolo.bands.map((b) => [b.fromLevel, b.toLevel, b.stageKey])).toEqual(
        solo.bands.map((b) => [b.fromLevel, b.toLevel, b.stageKey]),
      );
    }
  });

  it("a capped hero is 'done' (finish 0) and never gates the makespan (E1)", () => {
    const curve = flat(1000);
    const candidates: ClimbCandidate[] = [climbCand(1, 90, 5e6, 10)];
    const party: ClimbHero[] = [
      { heroKey: 10, level: 101, expIntoLevel: 0, bonusPct: 0 }, // capped/maxed
      { heroKey: 20, level: 95, expIntoLevel: 0, bonusPct: 0 }, // the only climber
    ];
    const plan = teamClimb(party, 98, candidates, curve, 1, { excludeUnderLevel: true });
    expect(plan.status).toBe("ok");
    expect(plan.perHeroFinishSeconds[10]).toBe(0); // capped → done at t=0
    expect(plan.gatedByHeroKey).toBe(20); // the climber gates
    // makespan equals the climber's own solo time (the capped hero contributes nothing)
    const solo = singleHeroClimb(party[1], 98, candidates, curve, 1, { excludeUnderLevel: true });
    expect(plan.totalSeconds).toBeCloseTo(solo.totalSeconds, 6);
  });

  it("a fully-maxed team → already-at-target", () => {
    const curve = flat(1000);
    const party: ClimbHero[] = [
      { heroKey: 10, level: 101, expIntoLevel: 0, bonusPct: 0 },
      { heroKey: 20, level: 101, expIntoLevel: 0, bonusPct: 0 },
    ];
    const plan = teamClimb(party, 101, [climbCand(1, 95, 1e6, 10)], curve, 1, { excludeUnderLevel: true });
    expect(plan.status).toBe("already-at-target");
    expect(plan.totalSeconds).toBe(0);
    expect(plan.gatedByHeroKey).toBeNull();
  });

  it("no-farmable-stage propagates when no stage feeds every climbing hero", () => {
    const curve = flat(1000);
    // only an under-level stage; excludeUnderLevel drops it for the lower hero → infeasible
    const plan = teamClimb(
      [
        { heroKey: 10, level: 90, expIntoLevel: 0, bonusPct: 0 },
        { heroKey: 20, level: 90, expIntoLevel: 0, bonusPct: 0 },
      ],
      93,
      [climbCand(1, 95, 1e6, 10)],
      curve,
      1,
      { excludeUnderLevel: true },
    );
    expect(plan.status).toBe("no-farmable-stage");
  });

  // ---- The review's keep-cliff counterexample (issue #1): rollout is the DEFAULT and closes it. ----
  describe("greedy-minnorm vs the keep-cliff counterexample (review issue #1)", () => {
    // Heroes [95,93]→98, flat need 100, expInto [16, 49.2]. Stage A (L92, epc 60.8, ct 12.2),
    // stage B (L86, epc 164.3, ct 16.5). Bonuses as PERCENT so (1+pct/100) = the review's mult:
    //   1.076 → 7.6% ; 1.479 → 47.9%. Account multiplier 2.202.
    const curve: LevelCurve = (() => {
      const c: Record<number, number> = {};
      for (let L = 90; L <= 101; L++) c[L] = 100;
      return c;
    })();
    const candidates: ClimbCandidate[] = [
      climbCand(92, 92, 60.8, 12.2),
      climbCand(86, 86, 164.3, 16.5),
    ];
    const party: ClimbHero[] = [
      { heroKey: 0, level: 95, expIntoLevel: 16.0, bonusPct: 7.6 },
      { heroKey: 1, level: 93, expIntoLevel: 49.2, bonusPct: 47.9 },
    ];
    const acct = 2.202;
    const target = 98;

    // Independent exact brute-force makespan DP (enumerate the stage farmed each segment).
    function bruteMakespan(): number {
      function rec(
        st: { level: number; into: number }[],
        elapsed: number,
        finish: (number | null)[],
      ): number {
        if (!st.some((s) => s.level < target)) return Math.max(...finish.map((f) => f ?? 0));
        let best = Infinity;
        for (const c of candidates) {
          const nd = st.map((s, i) => ({ ...s, i })).filter((s) => s.level < target);
          let dt = Infinity;
          for (const s of nd) {
            const r = modeledExpPerSecond(c.expPerClear, s.level, c.stageLevel, c.clearTimeAtLevel(s.level).seconds, party[s.i].bonusPct, acct);
            if (r > 0) dt = Math.min(dt, (curve[s.level] - s.into) / r);
          }
          if (!Number.isFinite(dt)) continue;
          const ns = st.map((s) => ({ ...s }));
          const nf = [...finish];
          for (const s of nd) {
            const r = modeledExpPerSecond(c.expPerClear, s.level, c.stageLevel, c.clearTimeAtLevel(s.level).seconds, party[s.i].bonusPct, acct);
            ns[s.i].into += r * dt;
            while (ns[s.i].level < target && ns[s.i].into >= curve[ns[s.i].level]) {
              ns[s.i].into -= curve[ns[s.i].level];
              ns[s.i].level += 1;
            }
            if (ns[s.i].level >= target && nf[s.i] == null) nf[s.i] = elapsed + dt;
          }
          best = Math.min(best, rec(ns, elapsed + dt, nf));
        }
        return best;
      }
      return rec(party.map((p) => ({ level: p.level, into: p.expIntoLevel })), 0, [null, null]);
    }

    it("bare minnorm (rollout:false) is materially worse than optimal here (≈3.85%)", () => {
      const opt = bruteMakespan();
      const bare = teamClimb(party, target, candidates, curve, acct, { excludeUnderLevel: true, rollout: false });
      expect(bare.status).toBe("ok");
      const ratio = bare.totalSeconds / opt;
      expect(ratio).toBeGreaterThan(1.02); // demonstrably off (the review measured ~1.0385)
    });

    it("rollout (the DEFAULT) closes the gap to optimal", () => {
      const opt = bruteMakespan();
      const def = teamClimb(party, target, candidates, curve, acct, { excludeUnderLevel: true }); // rollout defaults true
      expect(def.status).toBe("ok");
      expect(def.totalSeconds / opt).toBeCloseTo(1, 3); // within 0.1% of optimal
    });
  });

  it("matches the exact makespan DP across random in-region team instances (rollout default)", () => {
    let seed = 0xabcdef;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const target = 96;
    const curve: Record<number, number> = {};
    for (let L = 88; L <= 101; L++) curve[L] = 100;

    function bruteMakespan(party: ClimbHero[], cands: ClimbCandidate[], acct: number): number {
      function rec(st: { level: number; into: number }[], elapsed: number, finish: (number | null)[]): number {
        if (!st.some((s) => s.level < target)) return Math.max(...finish.map((f) => f ?? 0));
        let best = Infinity;
        for (const c of cands) {
          const nd = st.map((s, i) => ({ ...s, i })).filter((s) => s.level < target && c.stageLevel <= s.level);
          if (nd.length < st.filter((s) => s.level < target).length) continue; // under-level excluded for someone
          let dt = Infinity;
          for (const s of nd) {
            const r = modeledExpPerSecond(c.expPerClear, s.level, c.stageLevel, c.clearTimeAtLevel(s.level).seconds, party[s.i].bonusPct, acct);
            if (r > 0) dt = Math.min(dt, (curve[s.level] - s.into) / r);
          }
          if (!Number.isFinite(dt)) continue;
          const ns = st.map((s) => ({ ...s }));
          const nf = [...finish];
          for (const s of nd) {
            const r = modeledExpPerSecond(c.expPerClear, s.level, c.stageLevel, c.clearTimeAtLevel(s.level).seconds, party[s.i].bonusPct, acct);
            ns[s.i].into += r * dt;
            while (ns[s.i].level < target && ns[s.i].into >= curve[ns[s.i].level]) {
              ns[s.i].into -= curve[ns[s.i].level];
              ns[s.i].level += 1;
            }
            if (ns[s.i].level >= target && nf[s.i] == null) nf[s.i] = elapsed + dt;
          }
          best = Math.min(best, rec(ns, elapsed + dt, nf));
        }
        return best === Infinity ? Infinity : best;
      }
      return rec(party.map((p) => ({ level: p.level, into: p.expIntoLevel })), 0, [null, null]);
    }

    let worst = 1;
    let checked = 0;
    for (let t = 0; t < 200; t++) {
      const nHeroes = 2;
      const party: ClimbHero[] = [];
      for (let h = 0; h < nHeroes; h++) {
        party.push({ heroKey: h, level: 92 + Math.floor(rnd() * 3), expIntoLevel: rnd() * 100, bonusPct: rnd() * 40 });
      }
      const nst = 2 + Math.floor(rnd() * 2);
      const cands: ClimbCandidate[] = [];
      for (let i = 0; i < nst; i++) {
        cands.push(climbCand(80 + i, 84 + Math.floor(rnd() * 8), 1e5 * (1 + rnd() * 4), 8 + rnd() * 15));
      }
      const acct = 1 + rnd() * 2.5;
      const opt = bruteMakespan(party, cands, acct);
      if (!Number.isFinite(opt)) continue;
      const plan = teamClimb(party, target, cands, curve, acct, { excludeUnderLevel: true });
      if (plan.status !== "ok") continue;
      checked++;
      const ratio = plan.totalSeconds / opt;
      if (ratio > worst) worst = ratio;
    }
    expect(checked).toBeGreaterThan(50);
    // With rollout the makespan is at/near optimal; allow a hair for ties/discretization.
    expect(worst).toBeLessThan(1.01);
  });

  it("team bands track the gating hero and never emit NaN/Infinity", () => {
    const curve = flat(1000);
    const candidates: ClimbCandidate[] = [climbCand(1, 88, 2e6, 10), climbCand(2, 92, 5e6, 10)];
    const plan = teamClimb(
      [
        { heroKey: 10, level: 90, expIntoLevel: 0, bonusPct: 0 },
        { heroKey: 20, level: 89, expIntoLevel: 0, bonusPct: 5 },
      ],
      94,
      candidates,
      curve,
      1,
      { excludeUnderLevel: true },
    );
    expect(plan.status).toBe("ok");
    for (const b of plan.bands) {
      expect(Number.isFinite(b.seconds)).toBe(true);
      expect(b.toLevel).toBeGreaterThan(b.fromLevel);
      expect(typeof b.gatingHeroKey).toBe("number");
      expect([10, 20]).toContain(b.gatingHeroKey);
    }
    expect(Number.isFinite(plan.totalSeconds)).toBe(true);
  });
});
