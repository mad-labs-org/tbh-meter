import { describe, expect, it } from "vitest";
import { expKeepFraction, type LevelCurve } from "./exp-model.js";
import {
  calibratedClearTime,
  stageEnemyHp,
  theoreticalClearTime,
  resolveClearTime,
  keepConfidenceOf,
  singleHeroClimb,
  teamClimb,
  rankNextLevel,
  MAX_LEVEL,
  type StageClearStats,
  type StageHpInput,
  type ClimbCandidate,
  type ClimbHero,
  type ClearTimeResult,
  type CandidateSource,
} from "./planner-model.js";

// ─────────────────────────── helpers ───────────────────────────

const maxLifeOf = (k: number): number | undefined =>
  ({ 10: 100, 20: 200, 99: 50_000 } as Record<number, number>)[k];

/** A constant-clear ClimbCandidate with a CONSTANT per-clear XP (the simplest closure). v1 caller
 *  behaviour: clearTime + XP per clear are the same at every level. */
function climbCand(
  stageKey: number,
  stageLevel: number,
  expPerClear: number,
  clearSeconds: number,
  opts: { source?: CandidateSource } & Partial<ClearTimeResult> = {},
): ClimbCandidate {
  const clear: ClearTimeResult = {
    seconds: clearSeconds,
    tier: opts.tier ?? 2,
    confidence: opts.confidence ?? "measured",
  };
  return {
    stageKey,
    stageLevel,
    expPerClearAtLevel: () => expPerClear,
    clearTimeAtLevel: () => clear,
    source: opts.source ?? "measured",
  };
}

/** A modeled candidate whose per-clear XP scales with the keep penalty at the hero's level — exactly
 *  the OLD `modeledExpPerSecond × clearTime` (epc·keep(L)·(1+bonus/100)·acct). Lets the optimality
 *  gate exercise the same math the old model did, through the new closure surface. */
function modeledCand(
  stageKey: number,
  stageLevel: number,
  epc: number,
  clearSeconds: number,
  bonusPct: number,
  acct: number,
): ClimbCandidate {
  const clear: ClearTimeResult = { seconds: clearSeconds, tier: 2, confidence: "measured" };
  return {
    stageKey,
    stageLevel,
    expPerClearAtLevel: (L) => epc * expKeepFraction(L, stageLevel) * (1 + bonusPct / 100) * acct,
    clearTimeAtLevel: () => clear,
    source: "measured",
  };
}

/** Map a flat candidate list to the per-hero team map (same set for every hero — the simple case). */
function teamMap(heroKeys: number[], cands: ClimbCandidate[]): Map<number, ClimbCandidate[]> {
  return new Map(heroKeys.map((k) => [k, cands]));
}

// ─────────────────────────── calibratedClearTime (A§1) ───────────────────────────

describe("calibratedClearTime", () => {
  it("the wiki B1 worked example: min 100, samples (200,40)+(120,80) median (160,60), partyDps 50 → 172", () => {
    const stats: StageClearStats = { minClearS: 100, medianClearS: 160, medianDps: 60, sampleCount: 2 };
    expect(calibratedClearTime(stats, 50)).toBeCloseTo(172, 6);
  });

  it("floors at minClearS — a stronger party can't beat a clear never achieved", () => {
    const stats: StageClearStats = { minClearS: 100, medianClearS: 160, medianDps: 60, sampleCount: 3 };
    const t = calibratedClearTime(stats, 1_000_000);
    expect(t).toBeGreaterThanOrEqual(100);
    expect(t).toBeCloseTo(100, 1);
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
        { monster: 10, weight: 1000 },
        { monster: 20, weight: 1000 },
      ],
      levelScaling: { hp: 1000 },
      waveAmount: 10,
      waveMonsterAmount: 1,
      bossMonsterKey: 99,
      bossMultipliers: { hp: 2000 },
    };
    expect(stageEnemyHp(stage, maxLifeOf, 3)).toBeCloseTo(500 + 100_000, 4);
  });

  it("boss-only stage (waveAmount null) contributes zero trash", () => {
    const stage: StageHpInput = {
      monsters: [{ monster: 10, weight: 1000 }],
      levelScaling: { hp: 1000 },
      waveAmount: null,
      waveMonsterAmount: null,
      bossMonsterKey: 99,
      bossMultipliers: null,
    };
    expect(stageEnemyHp(stage, maxLifeOf, 3)).toBeCloseTo(50_000, 4);
  });

  it("null bossMultipliers.hp resolves to ×1 (permille default)", () => {
    const stage: StageHpInput = {
      monsters: [],
      levelScaling: null,
      waveAmount: 0,
      waveMonsterAmount: 0,
      bossMonsterKey: 20,
      bossMultipliers: { hp: null },
    };
    expect(stageEnemyHp(stage, maxLifeOf, 3)).toBeCloseTo(200, 4);
  });

  it("matches the L95 stage-4309 ground truth (trash ≈ 20.30M, boss ≈ 598k)", () => {
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
    const trashAndBoss = stageEnemyHp(stage, (k) => life[k], 1);
    const hpMult = 383270 / 1000;
    const weights = [1000, 700, 500, 1000, 1000, 1000];
    const lifes = [65, 65, 95, 95, 95, 75];
    const tw = weights.reduce((a, b) => a + b, 0);
    let avg = 0;
    for (let i = 0; i < weights.length; i++) avg += lifes[i] * hpMult * (weights[i] / tw);
    const trash = avg * 31 * 21;
    const boss = 260 * hpMult * 6;
    expect(Math.round(trash)).toBe(20_296_579);
    expect(Math.round(boss)).toBe(597_901);
    expect(trashAndBoss).toBeCloseTo(trash + boss, 0);
  });
});

// ─────────────────────────── theoreticalClearTime (A§2) ───────────────────────────

describe("theoreticalClearTime", () => {
  const stage: StageHpInput = {
    monsters: [{ monster: 10, weight: 1000 }],
    levelScaling: { hp: 1000 },
    waveAmount: 5,
    waveMonsterAmount: 2,
    bossMonsterKey: null,
    bossMultipliers: null,
  };

  it("HP ÷ DPS when the wave floor doesn't bind", () => {
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

describe("keepConfidenceOf", () => {
  it("gap +2 → solid, +13 → thin, under-level → approx", () => {
    expect(keepConfidenceOf(2)).toBe("solid");
    expect(keepConfidenceOf(13)).toBe("thin");
    expect(keepConfidenceOf(-1)).toBe("approx");
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
    const curve = flatCurve(1000, 80, 95);
    const candidates: ClimbCandidate[] = [
      modeledCand(1, 80, 5e5, 10, 0, 1), // small gap good early, deep gap (low keep) later
      modeledCand(2, 90, 5e6, 10, 0, 1),
    ];
    const hero: ClimbHero = { heroKey: 7, level: 88, expIntoLevel: 0 };
    const plan = singleHeroClimb(hero, 95, candidates, curve, { excludeUnderLevel: true });
    expect(plan.status).toBe("ok");
    expect(plan.bands[0].fromLevel).toBe(88);
    expect(plan.bands[plan.bands.length - 1].toLevel).toBe(95);
    for (let i = 1; i < plan.bands.length; i++) expect(plan.bands[i].fromLevel).toBe(plan.bands[i - 1].toLevel);
    const sumBands = plan.bands.reduce((a, b) => a + b.seconds, 0);
    expect(plan.totalSeconds).toBeCloseTo(sumBands, 6);
  });

  it("each band carries the picked stage's source", () => {
    const curve = flatCurve(1000, 88, 92);
    // Both stages are at/below the hero's whole range (L88→92), so excludeUnderLevel keeps both. The
    // measured stage has the far bigger per-clear XP → it's the argmax at every level.
    const measured = modeledCand(1, 85, 9e6, 10, 0, 1);
    const estimated: ClimbCandidate = { ...modeledCand(2, 80, 1e5, 10, 0, 1), source: "estimated" };
    const plan = singleHeroClimb({ heroKey: 1, level: 88, expIntoLevel: 0 }, 92, [measured, estimated], curve, {
      excludeUnderLevel: true,
    });
    expect(plan.status).toBe("ok");
    expect(plan.bands.length).toBeGreaterThan(0);
    expect(plan.bands.every((b) => b.source === "measured")).toBe(true);
  });

  it("is EXACTLY optimal vs a brute-force DP over 5,000 random in-region instances (real keep)", () => {
    // Brute DP uses the candidate's OWN closures (expPerClearAtLevel / clearTimeAtLevel), the exact
    // surface the scheduler consumes — proving the per-level argmin is globally optimal.
    function bruteOptimal(
      start: number,
      target: number,
      cands: ClimbCandidate[],
      curve: LevelCurve,
      expInto: number,
    ): number | null {
      const levels: number[] = [];
      for (let L = start; L < target; L++) levels.push(L);
      const n = cands.length;
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
          const s = cands[si];
          if (s.stageLevel > L) {
            ok = false;
            break;
          }
          const need = curve[L];
          const ct = s.clearTimeAtLevel(L).seconds;
          const xpc = s.expPerClearAtLevel(L);
          const r = ct > 0 && xpc > 0 ? xpc / ct : 0;
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
    let seed = 0x12345678;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let t = 0; t < 5000; t++) {
      const start = 80 + Math.floor(rnd() * 6);
      const target = Math.min(MAX_LEVEL, start + 1 + Math.floor(rnd() * 4));
      const nst = 1 + Math.floor(rnd() * 4);
      const bonus = rnd() * 20;
      const acct = 1 + rnd() * 2.5;
      const candidates: ClimbCandidate[] = [];
      for (let i = 0; i < nst; i++) {
        candidates.push(
          modeledCand(i + 1, start - Math.floor(rnd() * 18), 1e6 * (1 + rnd() * 5), 5 + rnd() * 20, bonus, acct),
        );
      }
      const curve: Record<number, number> = {};
      for (let L = start; L < target; L++) curve[L] = 1e8 * (1 + rnd());
      const expInto = rnd() * curve[start];

      const plan = singleHeroClimb({ heroKey: 1, level: start, expIntoLevel: expInto }, target, candidates, curve, {
        excludeUnderLevel: true,
      });
      const brute = bruteOptimal(start, target, candidates, curve, expInto);
      if (plan.status !== "ok") {
        expect(brute).toBeNull();
        continue;
      }
      expect(brute).not.toBeNull();
      checked++;
      const dev = Math.abs(plan.totalSeconds / brute! - 1);
      if (dev > maxDev) maxDev = dev;
      if (dev > 1e-9) mismatches++;
    }
    expect(checked).toBeGreaterThan(1000);
    expect(mismatches).toBe(0);
    expect(maxDev).toBeLessThan(1e-9);
  });

  it("target ≤ current → already-at-target, empty bands, 0s (E6/E2)", () => {
    const curve = flatCurve(1000, 80, 95);
    const plan = singleHeroClimb({ heroKey: 1, level: 90, expIntoLevel: 0 }, 90, [climbCand(1, 85, 1e6, 10)], curve, {
      excludeUnderLevel: true,
    });
    expect(plan.status).toBe("already-at-target");
    expect(plan.bands).toEqual([]);
    expect(plan.totalSeconds).toBe(0);
  });

  it("hitting the cap before target → capped (E1)", () => {
    const gappy: LevelCurve = { 96: 1000, 97: 1000, /* 98 missing */ 99: 1000 };
    const plan = singleHeroClimb({ heroKey: 1, level: 96, expIntoLevel: 0 }, 100, [climbCand(1, 95, 1e6, 10)], gappy, {
      excludeUnderLevel: true,
    });
    expect(plan.status).toBe("capped");
    expect(plan.bands).toEqual([]);
  });

  it("MAX_LEVEL is 101; target is clamped to it and a hero at 101 is already-at-target", () => {
    expect(MAX_LEVEL).toBe(101);
    const curve: LevelCurve = { 99: 1000, 100: 1000 };
    const plan = singleHeroClimb({ heroKey: 1, level: 101, expIntoLevel: 0 }, 101, [climbCand(1, 95, 1e6, 10)], curve, {
      excludeUnderLevel: true,
    });
    expect(plan.status).toBe("already-at-target");
    const ok = singleHeroClimb({ heroKey: 1, level: 99, expIntoLevel: 0 }, 105, [climbCand(1, 95, 1e6, 10)], curve, {
      excludeUnderLevel: true,
    });
    expect(ok.status).toBe("ok");
    expect(ok.bands[ok.bands.length - 1].toLevel).toBe(101);
  });

  it("no farmable stage at a level → no-farmable-stage (E3)", () => {
    const curve = flatCurve(1000, 90, 95);
    // The only stage is ESTIMATED and above the hero (L95 vs L90) → excluded by E4 (no unvalidated
    // under-level projection), leaving nothing to farm. (A measured under-level stage would be KEPT.)
    const onlyEstimatedUnder = { ...climbCand(1, 95, 1e6, 10), source: "estimated" as const };
    const plan = singleHeroClimb({ heroKey: 1, level: 90, expIntoLevel: 0 }, 93, [onlyEstimatedUnder], curve, {
      excludeUnderLevel: true,
    });
    expect(plan.status).toBe("no-farmable-stage");
  });

  it("excludeUnderLevel:false permits an under-level stage (E4 flag path)", () => {
    const curve = flatCurve(1000, 90, 95);
    const plan = singleHeroClimb({ heroKey: 1, level: 90, expIntoLevel: 0 }, 93, [climbCand(1, 95, 1e6, 10)], curve, {
      excludeUnderLevel: false,
    });
    expect(plan.status).toBe("ok");
    expect(plan.bands[0].keepConfidence).toBe("approx"); // gap −5
  });

  it("KEEPS a measured under-level stage even with excludeUnderLevel ON (Full-Climb path of the fix)", () => {
    // The under-leveling fix at the CLIMB engine (not just rankNextLevel): a hero L90 whose only
    // farmed stage is MEASURED at L95 (under by 5) must still get a plan — the player demonstrably
    // farms it. Without the fix this returned "no-farmable-stage" (the bug Orphias hit, climb path).
    const curve = flatCurve(1000, 90, 95);
    const measuredUnder = climbCand(1, 95, 1e6, 10); // climbCand defaults source: "measured"
    const plan = singleHeroClimb({ heroKey: 1, level: 90, expIntoLevel: 0 }, 92, [measuredUnder], curve, {
      excludeUnderLevel: true,
    });
    expect(plan.status).toBe("ok");
    expect(plan.bands).toHaveLength(1);
    expect(plan.bands[0].source).toBe("measured");
    expect(plan.bands[0].keepConfidence).toBe("approx"); // gap −5 still surfaced
  });

  it("mid-level start consumes the within-level remainder for the FIRST level only (E8)", () => {
    const curve = flatCurve(1000, 90, 95);
    const cand = climbCand(1, 88, 1e6, 1); // constant per-clear XP + constant clear → constant rate
    const full = singleHeroClimb({ heroKey: 1, level: 90, expIntoLevel: 0 }, 92, [cand], curve, {
      excludeUnderLevel: true,
    });
    const partial = singleHeroClimb({ heroKey: 1, level: 90, expIntoLevel: 400 }, 92, [cand], curve, {
      excludeUnderLevel: true,
    });
    const rate = 1e6 / 1; // expPerClear / clearSeconds
    expect(full.totalSeconds - partial.totalSeconds).toBeCloseTo(400 / rate, 4);
  });

  it("a band inherits the WORST clear/keep/source confidence of its levels", () => {
    const curve = flatCurve(1000, 90, 93);
    let call = 0;
    const cand: ClimbCandidate = {
      stageKey: 1,
      stageLevel: 88,
      expPerClearAtLevel: () => 1e6,
      clearTimeAtLevel: () => {
        call++;
        return { seconds: 1, tier: call === 1 ? 2 : 3, confidence: call === 1 ? "measured" : "estimated" };
      },
      source: "measured",
    };
    const plan = singleHeroClimb({ heroKey: 1, level: 90, expIntoLevel: 0 }, 92, [cand], curve, {
      excludeUnderLevel: true,
    });
    expect(plan.bands).toHaveLength(1);
    expect(plan.bands[0].clearConfidence).toBe("estimated"); // worst of {measured, estimated}
  });
});

// ─────────────────────────── measured projection + μ round-trip ───────────────────────────

describe("measured-XP projection (the rework's core math)", () => {
  // A measured candidate built the way the data layer does: effBase = measuredXpc / keep(Lm);
  // expPerClearAtLevel(L) = effBase · keep(L). Here we assert the two load-bearing properties.
  function measuredCand(stageLevel: number, measuredXpc: number, anchorLevel: number, clearSec: number): ClimbCandidate {
    const effBase = measuredXpc / expKeepFraction(anchorLevel, stageLevel);
    return {
      stageKey: 1,
      stageLevel,
      expPerClearAtLevel: (L) => effBase * expKeepFraction(L, stageLevel),
      clearTimeAtLevel: () => ({ seconds: clearSec, tier: 2, confidence: "measured" }),
      source: "measured",
    };
  }

  it("reproduces the measured per-clear XP exactly at the anchor level Lm", () => {
    const measuredXpc = 19_460_000; // the real Priest L84 clear of a stage
    const stageLevel = 80;
    const Lm = 84;
    const cand = measuredCand(stageLevel, measuredXpc, Lm, 174);
    expect(cand.expPerClearAtLevel(Lm)).toBeCloseTo(measuredXpc, 0);
  });

  it("scales by the keep ratio off the anchor level (validated over-level direction)", () => {
    const measuredXpc = 1_000_000;
    const stageLevel = 80;
    const Lm = 84;
    const cand = measuredCand(stageLevel, measuredXpc, Lm, 100);
    const Lother = 88;
    const expected = measuredXpc * (expKeepFraction(Lother, stageLevel) / expKeepFraction(Lm, stageLevel));
    expect(cand.expPerClearAtLevel(Lother)).toBeCloseTo(expected, 4);
    // deeper over-level (bigger gap) keeps LESS → less XP per clear
    expect(cand.expPerClearAtLevel(Lother)).toBeLessThan(cand.expPerClearAtLevel(Lm));
  });

  it("μ round-trip: recover muH from a farmed stage, plug it back, reproduce the measured rate", () => {
    // The data layer recovers muH = measuredXpc / (base · keep(Lm)); an estimated candidate then
    // uses base · keep(L) · muH. At L = Lm this must reproduce the measured per-clear (and thus rate).
    const base = 500_000; // datamine stageClearExp
    const stageLevel = 86;
    const Lm = 90;
    const keepLm = expKeepFraction(Lm, stageLevel);
    const measuredXpc = base * keepLm * 2.75; // pretend the true effective multiplier is 2.75
    const muH = measuredXpc / (base * keepLm); // the recovery formula
    expect(muH).toBeCloseTo(2.75, 9);

    const clearSec = 120;
    const estimated: ClimbCandidate = {
      stageKey: 2,
      stageLevel,
      expPerClearAtLevel: (L) => base * expKeepFraction(L, stageLevel) * muH,
      clearTimeAtLevel: () => ({ seconds: clearSec, tier: 3, confidence: "estimated" }),
      source: "estimated",
    };
    // rate at Lm from the recovered model == measured rate (measuredXpc / clearSec)
    const modeledRate = estimated.expPerClearAtLevel(Lm) / clearSec;
    expect(modeledRate).toBeCloseTo(measuredXpc / clearSec, 4);
  });
});

// ─────────────────────────── rankNextLevel ───────────────────────────

describe("rankNextLevel", () => {
  const curve: LevelCurve = (() => {
    const c: Record<number, number> = {};
    for (let L = 80; L <= 101; L++) c[L] = 1000;
    return c;
  })();

  it("sorts ascending by time and tags source; the 3-9 vs 3-7 answer", () => {
    const hero: ClimbHero = { heroKey: 1, level: 90, expIntoLevel: 0 };
    const cands: ClimbCandidate[] = [
      climbCand(39, 90, 4e6, 14, { source: "measured" }), // fastest (most XP/clear)
      climbCand(37, 86, 2.5e6, 14, { source: "measured" }),
      { ...climbCand(41, 88, 1e6, 14), source: "estimated" }, // slowest
    ];
    const ranked = rankNextLevel(hero, cands, curve, { excludeUnderLevel: true });
    expect(ranked.map((r) => r.stageKey)).toEqual([39, 37, 41]);
    for (let i = 1; i < ranked.length; i++) expect(ranked[i].seconds).toBeGreaterThanOrEqual(ranked[i - 1].seconds);
    expect(ranked.find((r) => r.stageKey === 39)!.source).toBe("measured");
    expect(ranked.find((r) => r.stageKey === 41)!.source).toBe("estimated");
  });

  it("uses only the within-level remainder (expIntoLevel) for the seconds", () => {
    const cand = climbCand(1, 88, 1e6, 1); // rate = 1e6 / 1 = 1e6 xp/s
    const fresh = rankNextLevel({ heroKey: 1, level: 90, expIntoLevel: 0 }, [cand], curve)[0];
    const partial = rankNextLevel({ heroKey: 1, level: 90, expIntoLevel: 400 }, [cand], curve)[0];
    expect(fresh.seconds).toBeCloseTo(1000 / 1e6, 9); // full level need / rate
    expect(partial.seconds).toBeCloseTo((1000 - 400) / 1e6, 9);
  });

  it("a capped hero ranks nothing", () => {
    const capCurve: LevelCurve = { 99: 1000, 100: 1000 }; // no key 101
    expect(rankNextLevel({ heroKey: 1, level: 101, expIntoLevel: 0 }, [climbCand(1, 95, 1e6, 10)], capCurve)).toEqual([]);
  });

  it("excludeUnderLevel drops ESTIMATED under-level stages but always KEEPS measured ones", () => {
    // The under-level exclusion exists to stay out of the UNVALIDATED under-level keep formula when
    // PROJECTING XP — so it applies to estimated stages only. A measured stage carries the player's
    // REAL farmed XP, so it is eligible even above the hero's level (the under-leveling fix: a player
    // who farms a higher stage for more XP must still see it ranked).
    const hero: ClimbHero = { heroKey: 1, level: 90, expIntoLevel: 0 };
    const overEstimated = { ...climbCand(1, 95, 1e6, 10), source: "estimated" as const };
    const overMeasured = climbCand(2, 95, 1e6, 10); // climbCand defaults source: "measured"
    // Estimated above the hero → dropped (no unvalidated under-level projection).
    expect(rankNextLevel(hero, [overEstimated], curve, { excludeUnderLevel: true })).toEqual([]);
    // Measured above the hero → KEPT even with the flag on (it's the player's real farmed stage).
    const keptMeasured = rankNextLevel(hero, [overMeasured], curve, { excludeUnderLevel: true });
    expect(keptMeasured).toHaveLength(1);
    expect(keptMeasured[0].keepConfidence).toBe("approx"); // gap −5 → still flagged approx
    // Flag off → both kept regardless of source.
    expect(rankNextLevel(hero, [overEstimated], curve, { excludeUnderLevel: false })).toHaveLength(1);
  });

  it("excludes stages with no income (Infinity clear time)", () => {
    const hero: ClimbHero = { heroKey: 1, level: 90, expIntoLevel: 0 };
    const dead: ClimbCandidate = {
      stageKey: 9,
      stageLevel: 88,
      expPerClearAtLevel: () => 1e6,
      clearTimeAtLevel: () => ({ seconds: Infinity, tier: 3, confidence: "none" }),
      source: "estimated",
    };
    const live = climbCand(1, 88, 1e6, 10);
    const ranked = rankNextLevel(hero, [dead, live], curve);
    expect(ranked.map((r) => r.stageKey)).toEqual([1]);
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
      { heroKey: 10, level: 90, expIntoLevel: 0 },
      { heroKey: 20, level: 88, expIntoLevel: 0 },
    ];
    const byHero = teamMap([10, 20], candidates);
    const plan = teamClimb(party, 94, byHero, curve, { excludeUnderLevel: true });
    expect(plan.status).toBe("ok");
    const finishes = Object.values(plan.perHeroFinishSeconds);
    expect(plan.totalSeconds).toBeCloseTo(Math.max(...finishes), 6);
    for (const h of party) {
      const solo = singleHeroClimb(h, 94, candidates, curve, { excludeUnderLevel: true });
      const teamSolo = plan.perHero.find((p) => p.heroKey === h.heroKey)!;
      expect(teamSolo.totalSeconds).toBeCloseTo(solo.totalSeconds, 6);
      expect(teamSolo.bands.map((b) => [b.fromLevel, b.toLevel, b.stageKey])).toEqual(
        solo.bands.map((b) => [b.fromLevel, b.toLevel, b.stageKey]),
      );
    }
  });

  it("honours PER-HERO candidate XP (different measured XP per hero on the same stage)", () => {
    // Same stage set + clear-time, but hero 20 earns 4× the XP hero 10 does on the one stage.
    const curve = flat(1000);
    const mk = (epc: number): ClimbCandidate => climbCand(1, 88, epc, 10);
    const byHero = new Map<number, ClimbCandidate[]>([
      [10, [mk(1e6)]],
      [20, [mk(4e6)]], // 4× the rate → finishes far sooner
    ]);
    const party: ClimbHero[] = [
      { heroKey: 10, level: 90, expIntoLevel: 0 },
      { heroKey: 20, level: 90, expIntoLevel: 0 },
    ];
    const plan = teamClimb(party, 93, byHero, curve, { excludeUnderLevel: true });
    expect(plan.status).toBe("ok");
    // hero 20 (faster) finishes before hero 10; hero 10 gates.
    expect(plan.perHeroFinishSeconds[20]).toBeLessThan(plan.perHeroFinishSeconds[10]);
    expect(plan.gatedByHeroKey).toBe(10);
    // per-hero solo plans differ in total time by the 4× rate ratio.
    const solo10 = plan.perHero.find((p) => p.heroKey === 10)!;
    const solo20 = plan.perHero.find((p) => p.heroKey === 20)!;
    expect(solo10.totalSeconds / solo20.totalSeconds).toBeCloseTo(4, 6);
  });

  it("a capped hero is 'done' (finish 0) and never gates the makespan (E1)", () => {
    const curve = flat(1000);
    const candidates: ClimbCandidate[] = [climbCand(1, 90, 5e6, 10)];
    const party: ClimbHero[] = [
      { heroKey: 10, level: 101, expIntoLevel: 0 },
      { heroKey: 20, level: 95, expIntoLevel: 0 },
    ];
    const byHero = teamMap([10, 20], candidates);
    const plan = teamClimb(party, 98, byHero, curve, { excludeUnderLevel: true });
    expect(plan.status).toBe("ok");
    expect(plan.perHeroFinishSeconds[10]).toBe(0);
    expect(plan.gatedByHeroKey).toBe(20);
    const solo = singleHeroClimb(party[1], 98, candidates, curve, { excludeUnderLevel: true });
    expect(plan.totalSeconds).toBeCloseTo(solo.totalSeconds, 6);
  });

  it("a fully-maxed team → already-at-target", () => {
    const curve = flat(1000);
    const party: ClimbHero[] = [
      { heroKey: 10, level: 101, expIntoLevel: 0 },
      { heroKey: 20, level: 101, expIntoLevel: 0 },
    ];
    const plan = teamClimb(party, 101, teamMap([10, 20], [climbCand(1, 95, 1e6, 10)]), curve, {
      excludeUnderLevel: true,
    });
    expect(plan.status).toBe("already-at-target");
    expect(plan.totalSeconds).toBe(0);
    expect(plan.gatedByHeroKey).toBeNull();
  });

  it("no-farmable-stage propagates when no stage feeds every climbing hero", () => {
    const curve = flat(1000);
    // The only stage is ESTIMATED and above both heroes (L95 vs L90) → excluded by E4 for everyone.
    const onlyEstimatedUnder = { ...climbCand(1, 95, 1e6, 10), source: "estimated" as const };
    const plan = teamClimb(
      [
        { heroKey: 10, level: 90, expIntoLevel: 0 },
        { heroKey: 20, level: 90, expIntoLevel: 0 },
      ],
      93,
      teamMap([10, 20], [onlyEstimatedUnder]),
      curve,
      { excludeUnderLevel: true },
    );
    expect(plan.status).toBe("no-farmable-stage");
  });

  it("KEEPS a measured under-level stage for the whole team (Orphias's L62-on-L66 case, team path)", () => {
    // Both heroes farmed the under-level stage together (deployed as a team → both MEASURED), so it
    // stays eligible for the team. Without the fix the team saw "no farmed stages" too.
    const curve = flat(1000);
    const party: ClimbHero[] = [
      { heroKey: 10, level: 90, expIntoLevel: 0 },
      { heroKey: 20, level: 90, expIntoLevel: 0 },
    ];
    const plan = teamClimb(party, 92, teamMap([10, 20], [climbCand(1, 95, 1e6, 10)]), curve, {
      excludeUnderLevel: true,
    });
    expect(plan.status).toBe("ok");
    expect(plan.bands.length).toBeGreaterThan(0);
    expect(plan.bands[0].source).toBe("measured");
  });

  it("the team under-level rule is PER-HERO: a stage measured by one hero but estimated by another is dropped", () => {
    // Stage L95 above both L90 heroes. Hero 10 has it MEASURED (eligible); hero 20 only ESTIMATED
    // (its under-level keep projection is unvalidated → dropped). A team stage must feed EVERY hero,
    // so the team has no farmable stage. Pins that the loop consults each hero's OWN source
    // (PerHeroRates.sourceOf) — using the shared candidate's source would wrongly keep it for hero 20.
    const curve = flat(1000);
    const party: ClimbHero[] = [
      { heroKey: 10, level: 90, expIntoLevel: 0 },
      { heroKey: 20, level: 90, expIntoLevel: 0 },
    ];
    const byHero = new Map<number, ClimbCandidate[]>([
      [10, [climbCand(1, 95, 1e6, 10)]], // measured (default)
      [20, [{ ...climbCand(1, 95, 1e6, 10), source: "estimated" as const }]],
    ]);
    const plan = teamClimb(party, 92, byHero, curve, { excludeUnderLevel: true });
    expect(plan.status).toBe("no-farmable-stage");
  });

  // ---- The review's keep-cliff counterexample (issue #1): rollout is the DEFAULT and closes it. ----
  describe("greedy-minnorm vs the keep-cliff counterexample (review issue #1)", () => {
    const curve: LevelCurve = (() => {
      const c: Record<number, number> = {};
      for (let L = 90; L <= 101; L++) c[L] = 100;
      return c;
    })();
    // Per-hero candidate sets fold the bonus (as a multiplier) + account mult into expPerClearAtLevel,
    // matching the old modeledExpPerSecond×clearTime. Hero 0: ×(1.076·2.202); hero 1: ×(1.479·2.202).
    const acct = 2.202;
    const candsFor = (bonusPct: number): ClimbCandidate[] => [
      modeledCand(92, 92, 60.8, 12.2, bonusPct, acct),
      modeledCand(86, 86, 164.3, 16.5, bonusPct, acct),
    ];
    const byHero = new Map<number, ClimbCandidate[]>([
      [0, candsFor(7.6)],
      [1, candsFor(47.9)],
    ]);
    const party: ClimbHero[] = [
      { heroKey: 0, level: 95, expIntoLevel: 16.0 },
      { heroKey: 1, level: 93, expIntoLevel: 49.2 },
    ];
    const target = 98;

    function rateOf(cand: ClimbCandidate, level: number): number {
      const ct = cand.clearTimeAtLevel(level).seconds;
      const xpc = cand.expPerClearAtLevel(level);
      return ct > 0 && xpc > 0 ? xpc / ct : 0;
    }

    // Independent exact brute-force makespan DP, using each hero's OWN candidate array.
    function bruteMakespan(): number {
      const sharedKeys = [92, 86];
      function rec(st: { level: number; into: number; key: number }[], elapsed: number, finish: (number | null)[]): number {
        if (!st.some((s) => s.level < target)) return Math.max(...finish.map((f) => f ?? 0));
        let best = Infinity;
        for (const stageKey of sharedKeys) {
          const nd = st.map((s, i) => ({ ...s, i })).filter((s) => s.level < target);
          let dt = Infinity;
          for (const s of nd) {
            const cand = byHero.get(s.key)!.find((c) => c.stageKey === stageKey)!;
            const r = rateOf(cand, s.level);
            if (r > 0) dt = Math.min(dt, (curve[s.level] - s.into) / r);
          }
          if (!Number.isFinite(dt)) continue;
          const ns = st.map((s) => ({ ...s }));
          const nf = [...finish];
          for (const s of nd) {
            const cand = byHero.get(s.key)!.find((c) => c.stageKey === stageKey)!;
            const r = rateOf(cand, s.level);
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
      return rec(party.map((p) => ({ level: p.level, into: p.expIntoLevel, key: p.heroKey })), 0, [null, null]);
    }

    it("bare minnorm (rollout:false) is materially worse than optimal here (≈3.85%)", () => {
      const opt = bruteMakespan();
      const bare = teamClimb(party, target, byHero, curve, { excludeUnderLevel: true, rollout: false });
      expect(bare.status).toBe("ok");
      expect(bare.totalSeconds / opt).toBeGreaterThan(1.02);
    });

    it("rollout (the DEFAULT) closes the gap to optimal", () => {
      const opt = bruteMakespan();
      const def = teamClimb(party, target, byHero, curve, { excludeUnderLevel: true });
      expect(def.status).toBe("ok");
      expect(def.totalSeconds / opt).toBeCloseTo(1, 3);
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

    function rateOf(cand: ClimbCandidate, level: number): number {
      const ct = cand.clearTimeAtLevel(level).seconds;
      const xpc = cand.expPerClearAtLevel(level);
      return ct > 0 && xpc > 0 ? xpc / ct : 0;
    }

    function bruteMakespan(party: ClimbHero[], cands: ClimbCandidate[]): number {
      function rec(st: { level: number; into: number }[], elapsed: number, finish: (number | null)[]): number {
        if (!st.some((s) => s.level < target)) return Math.max(...finish.map((f) => f ?? 0));
        let best = Infinity;
        for (const c of cands) {
          const nd = st.map((s, i) => ({ ...s, i })).filter((s) => s.level < target && c.stageLevel <= s.level);
          if (nd.length < st.filter((s) => s.level < target).length) continue;
          let dt = Infinity;
          for (const s of nd) {
            const r = rateOf(c, s.level);
            if (r > 0) dt = Math.min(dt, (curve[s.level] - s.into) / r);
          }
          if (!Number.isFinite(dt)) continue;
          const ns = st.map((s) => ({ ...s }));
          const nf = [...finish];
          for (const s of nd) {
            const r = rateOf(c, s.level);
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
      const party: ClimbHero[] = [];
      for (let h = 0; h < 2; h++) party.push({ heroKey: h, level: 92 + Math.floor(rnd() * 3), expIntoLevel: rnd() * 100 });
      const nst = 2 + Math.floor(rnd() * 2);
      const cands: ClimbCandidate[] = [];
      const bonus = rnd() * 40;
      const acct = 1 + rnd() * 2.5;
      for (let i = 0; i < nst; i++) {
        cands.push(modeledCand(80 + i, 84 + Math.floor(rnd() * 8), 1e5 * (1 + rnd() * 4), 8 + rnd() * 15, bonus, acct));
      }
      const opt = bruteMakespan(party, cands);
      if (!Number.isFinite(opt)) continue;
      const plan = teamClimb(party, target, teamMap([0, 1], cands), curve, { excludeUnderLevel: true });
      if (plan.status !== "ok") continue;
      checked++;
      const ratio = plan.totalSeconds / opt;
      if (ratio > worst) worst = ratio;
    }
    expect(checked).toBeGreaterThan(50);
    expect(worst).toBeLessThan(1.01);
  });

  it("team bands track the gating hero, carry a source, and never emit NaN/Infinity", () => {
    const curve = flat(1000);
    const candidates: ClimbCandidate[] = [climbCand(1, 88, 2e6, 10), climbCand(2, 92, 5e6, 10)];
    const plan = teamClimb(
      [
        { heroKey: 10, level: 90, expIntoLevel: 0 },
        { heroKey: 20, level: 89, expIntoLevel: 0 },
      ],
      94,
      teamMap([10, 20], candidates),
      curve,
      { excludeUnderLevel: true },
    );
    expect(plan.status).toBe("ok");
    for (const b of plan.bands) {
      expect(Number.isFinite(b.seconds)).toBe(true);
      expect(b.toLevel).toBeGreaterThan(b.fromLevel);
      expect(typeof b.gatingHeroKey).toBe("number");
      expect([10, 20]).toContain(b.gatingHeroKey);
      expect(["measured", "estimated"]).toContain(b.source);
    }
    expect(Number.isFinite(plan.totalSeconds)).toBe(true);
  });
});
