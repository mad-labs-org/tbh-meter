import { describe, expect, it } from "vitest";
import {
  resolveStageKey,
  resolveStageKeyFromIndex,
  calibrateStages,
  partyDpsFromIndex,
  collectMeasuredXp,
  buildStageBases,
  recoverHeroMultiplier,
  recoverAoeClearFactor,
  buildHeroCandidates,
  anchorTeamFromRun,
  CLEAR_TIME_CFG,
  AOE_FACTOR_RANGE,
} from "./planner-data";
import { expKeepFraction } from "../../../shared/exp-model.js";
import { stageEnemyHp, rankNextLevel, type StageClearStats, type StageHpInput } from "../../../shared/planner-model.js";
import { levelCurve } from "./game-data";
import type { RunIndexEntry } from "../../../shared/ipc-types.js";
import type { RunRecord } from "../../../shared/run-types.js";
import stagesData from "../../../shared/data/stages.json";
import monstersData from "../../../shared/data/monsters.json";

// ── bundled-data helpers (mirror the data layer's maxLifeOf so EHP round-trips exactly) ──
interface TestRawStage { key: number; stageLevel?: number; waveAmount?: number | null; waveMonsterAmount?: number | null; monsters?: { monster: string; weight: number | null }[]; bossMonsterKey?: number | null; bossMultipliers?: { hp?: number | null } | null; levelScaling?: { hp?: number | null } | null; }
const TEST_STAGES = stagesData as TestRawStage[];
const TEST_LIFE = new Map<number, number>();
for (const m of monstersData as { key: number; maxLife?: number }[]) if (typeof m.maxLife === "number") TEST_LIFE.set(m.key, m.maxLife);
const testStageByKey = new Map<number, TestRawStage>(TEST_STAGES.map((s) => [s.key, s]));
function testHpInput(key: number): StageHpInput {
  const s = testStageByKey.get(key)!;
  return {
    monsters: (s.monsters ?? []).map((m) => ({ monster: Number(m.monster), weight: m.weight })),
    levelScaling: s.levelScaling ?? null,
    waveAmount: s.waveAmount ?? null,
    waveMonsterAmount: s.waveMonsterAmount ?? null,
    bossMonsterKey: s.bossMonsterKey ?? null,
    bossMultipliers: s.bossMultipliers ?? null,
  };
}
const realHpByKey = (keys: number[]): Map<number, StageHpInput> => new Map(keys.map((k) => [k, testHpInput(k)]));
const stageEnemyHpFromKey = (key: number): number => stageEnemyHp(testHpInput(key), (k) => TEST_LIFE.get(k), 1);

// These tests pin the load-bearing review fix #2: the stage-key resolver must handle BOTH formats
// seen in the wild and NEVER fabricate a phantom key for a stage the bundled data doesn't cover.

describe("resolveStageKey — both real formats + the phantom-key guard (review fix #2)", () => {
  it("OLD format: stageKey is already the datamine key → fast-path direct hit", () => {
    expect(resolveStageKey({ stageKey: 4309, mode: "Torment", act: 3, stageNo: 9 })).toBe(4309);
  });

  it("NEW v2 format: internal stageKey misses → resolve via (mode→DIFFICULTY, act, stageNo)", () => {
    expect(resolveStageKey({ stageKey: 30901, mode: "Nightmare", act: 3, stageNo: 9 })).toBe(2309);
    expect(resolveStageKey({ stageKey: 10601, mode: "Torment", act: 1, stageNo: 6 })).toBe(4106);
  });

  it("Act-4/5 stage absent from the bundled L1–L95 Act-1–3 data → null (NOT a phantom key)", () => {
    expect(resolveStageKey({ stageKey: 40301, mode: "Torment", act: 4, stageNo: 3 })).toBeNull();
    expect(resolveStageKey({ stageKey: 50101, mode: "Torment", act: 5, stageNo: 1 })).toBeNull();
  });

  it("missing act/stageNo and an unknown stageKey → null", () => {
    expect(resolveStageKey({ stageKey: 999999, mode: "Torment", act: null, stageNo: null })).toBeNull();
  });
});

describe("resolveStageKeyFromIndex — same resolution off the compact 'act-stageNo' code", () => {
  const entry = (stage: string, mode: string, stageNo: number | null): Pick<RunIndexEntry, "stage" | "mode" | "stageNo"> => ({ stage, mode, stageNo });

  it("resolves Torment 3-9 → 4309 (old realistic stage)", () => {
    expect(resolveStageKeyFromIndex(entry("3-9", "Torment", 9))).toBe(4309);
  });
  it("disambiguates by mode: Nightmare 3-9 → 2309, not 4309", () => {
    expect(resolveStageKeyFromIndex(entry("3-9", "Nightmare", 9))).toBe(2309);
  });
  it("Act-4 stage → null", () => {
    expect(resolveStageKeyFromIndex(entry("4-3", "Torment", 3))).toBeNull();
  });
  it("falls back to parsing stageNo from the code when the field is null", () => {
    expect(resolveStageKeyFromIndex(entry("1-6", "Torment", null))).toBe(4106);
  });
});

// ── calibration off the index ────────────────────────────────────────────────────────────────

function idxEntry(over: Partial<RunIndexEntry>): RunIndexEntry {
  return {
    id: "x",
    ts: 0,
    sessionId: "s",
    status: "success",
    quality: "counted",
    stage: "3-9",
    stageNo: 9,
    mode: "Torment",
    dps: 100,
    totalDamage: 0,
    goldGained: 0,
    xpGained: 0,
    xpPerSec: 0,
    goldPerSec: 0,
    mobs: 0,
    totalMobs: null,
    duration: 100,
    clearTime: 50,
    schemaVersion: 1,
    party: [],
    ...over,
  };
}

describe("calibrateStages", () => {
  it("groups counted clears by resolved datamine key; skips unresolvable (Act-4/5) runs", () => {
    const index: RunIndexEntry[] = [
      idxEntry({ stage: "3-9", mode: "Torment", clearTime: 100, dps: 50 }),
      idxEntry({ stage: "3-9", mode: "Torment", clearTime: 120, dps: 60 }),
      idxEntry({ stage: "4-3", mode: "Torment", stageNo: 3, clearTime: 80, dps: 70 }),
    ];
    const stats = calibrateStages(index);
    expect([...stats.keys()]).toEqual([4309]);
    const s = stats.get(4309)!;
    expect(s.sampleCount).toBe(2);
    expect(s.minClearS).toBe(100);
    expect(s.medianClearS).toBe(110);
    expect(s.medianDps).toBe(55);
  });

  it("excludes non-counted, non-success, and zero-time/zero-dps runs", () => {
    const index: RunIndexEntry[] = [
      idxEntry({ quality: "skipped" }),
      idxEntry({ status: "fail" }),
      idxEntry({ clearTime: 0 }),
      idxEntry({ dps: 0 }),
      idxEntry({ clearTime: 42, dps: 99 }),
    ];
    const stats = calibrateStages(index);
    expect(stats.get(4309)?.sampleCount).toBe(1);
  });

  it("treats a legacy run with no quality field as countable (counted-by-omission)", () => {
    const e = idxEntry({});
    delete (e as { quality?: unknown }).quality;
    expect(calibrateStages([e]).get(4309)?.sampleCount).toBe(1);
  });
});

describe("partyDpsFromIndex", () => {
  it("is the median DPS of recent counted runs; 0 on cold start", () => {
    expect(partyDpsFromIndex([])).toBe(0);
    expect(partyDpsFromIndex([idxEntry({ dps: 100 }), idxEntry({ dps: 300 }), idxEntry({ dps: 200 })])).toBe(200);
  });
});

// ── measured per-(hero, stage) XP ─────────────────────────────────────────────────────────────

describe("collectMeasuredXp", () => {
  it("groups per-hero xpGained by resolved stage key, only for counted clears with positive XP", () => {
    const index: RunIndexEntry[] = [
      idxEntry({
        stage: "3-9",
        mode: "Torment",
        clearTime: 174,
        dps: 166_000,
        party: [
          { heroKey: 301, class: "Priest", level: 84, xpGained: 19_460_000 },
          { heroKey: 101, class: "Knight", level: 80, xpGained: 12_000_000 },
        ],
      }),
      // a non-counted run is ignored entirely
      idxEntry({ quality: "skipped", party: [{ heroKey: 301, class: "Priest", level: 84, xpGained: 9 }] }),
      // an Act-4 stage doesn't resolve → skipped
      idxEntry({ stage: "4-3", mode: "Torment", stageNo: 3, party: [{ heroKey: 301, class: "Priest", level: 84, xpGained: 5 }] }),
    ];
    const m = collectMeasuredXp(index);
    expect([...m.keys()]).toEqual([4309]);
    const priest = m.get(4309)!.get(301)!;
    expect(priest).toHaveLength(1);
    expect(priest[0]).toEqual({ xpGained: 19_460_000, level: 84 });
    expect(m.get(4309)!.get(101)![0].xpGained).toBe(12_000_000);
  });

  it("drops party entries without a positive xpGained (older records that didn't persist it)", () => {
    const index: RunIndexEntry[] = [
      idxEntry({ party: [{ heroKey: 301, class: "Priest", level: 84 }] }), // no xpGained
      idxEntry({ party: [{ heroKey: 301, class: "Priest", level: 84, xpGained: 0 }] }), // zero
    ];
    const m = collectMeasuredXp(index);
    expect(m.get(4309)?.get(301)).toBeUndefined();
  });
});

// ── stage bases (shared) + per-hero candidates ───────────────────────────────────────────────

describe("buildStageBases", () => {
  it("produces one base per bundled stage with positive XP, over Act-1–3", () => {
    const bases = buildStageBases(new Map(), 100);
    expect(bases.length).toBeGreaterThan(100); // ~120 bundled stages
    for (const b of bases) {
      expect(b.base).toBeGreaterThan(0);
      expect(b.stageLevel).toBeGreaterThan(0);
    }
  });

  it("uses MEASURED clear-time (tier 2) for a calibrated stage, ESTIMATED (tier 3) otherwise", () => {
    const calib = new Map([[4309, { minClearS: 130, medianClearS: 136, medianDps: 100, sampleCount: 3 }]]);
    const bases = buildStageBases(calib, 100);
    const b4309 = bases.find((b) => b.stageKey === 4309)!;
    expect(b4309.clear.tier).toBe(2);
    expect(b4309.clear.confidence).toBe("measured");
    const other = bases.find((b) => b.stageKey !== 4309 && b.clear.tier === 3)!;
    expect(other.clear.confidence).toBe("estimated");
  });

  it("the seed/fallback config is the unbiased prior (factor 1, not the old 3) and untagged", () => {
    expect(CLEAR_TIME_CFG.aoeClearFactor).toBe(1);
    expect(CLEAR_TIME_CFG.aoeFitFromRuns).toBe(false);
  });
});

// ── AoE clear-factor calibration (the measured-first T3 de-bias) ──────────────────────────────

describe("recoverAoeClearFactor", () => {
  const dps = 160000;
  const spw = CLEAR_TIME_CFG.secondsPerWave;
  // Real bundled stage 4106 (Torment 1-6) — the module's maxLifeOf resolves its EHP, so a clearTime
  // we synthesize from EHP@1/(dps·F) round-trips back to F exactly.
  const ehp4106 = stageEnemyHpFromKey(4106);
  const waveFloor4106 = (testHpInput(4106).waveAmount ?? 0) * spw;
  const clearForFactor = (F: number): number => ehp4106 / (dps * F) + waveFloor4106;

  it("(a) round-trip: a clearTime implying factor F recovers ≈ F", () => {
    for (const F of [0.8, 1.0, 1.31]) {
      const ct = clearForFactor(F);
      const stats: StageClearStats = { minClearS: ct, medianClearS: ct, medianDps: dps, sampleCount: 3 };
      const recovered = recoverAoeClearFactor(new Map([[4106, stats]]), dps, realHpByKey([4106]), spw);
      expect(recovered).toBeCloseTo(F, 4);
    }
  });

  it("(a') a fitted estimate matches the HP-bound part of the synthetic clear that produced it", () => {
    // The inverter attributes the wave floor to play-out time (per spec: dpsTime = clear − waveFloor),
    // and theoreticalClearTime is max(dpsTime, waveFloor) with dpsTime dominant here. So the T3
    // estimate of the same stage reproduces the HP-bound part (clear − waveFloor), not the floor too.
    const ct = clearForFactor(1.0); // = dpsTime + waveFloor
    const stats: StageClearStats = { minClearS: ct, medianClearS: ct, medianDps: dps, sampleCount: 3 };
    const factor = recoverAoeClearFactor(new Map([[4106, stats]]), dps, realHpByKey([4106]), spw);
    expect(factor).toBeCloseTo(1.0, 4);
    const cfg = { aoeClearFactor: factor, secondsPerWave: spw, aoeFitFromRuns: true };
    const bases = buildStageBases(new Map(), dps, cfg);
    const est = bases.find((b) => b.stageKey === 4106)!;
    expect(est.clear.tier).toBe(3);
    expect(est.clear.seconds).toBeCloseTo(ct - waveFloor4106, 0); // the HP-bound dpsTime
  });

  it("(b) falls back to 1.0 with zero farmed stages (NOT the old 3)", () => {
    expect(recoverAoeClearFactor(new Map(), dps, new Map(), spw)).toBe(1.0);
    // also when dps is unknown
    const stats: StageClearStats = { minClearS: 80, medianClearS: 85, medianDps: dps, sampleCount: 3 };
    expect(recoverAoeClearFactor(new Map([[4106, stats]]), 0, realHpByKey([4106]), spw)).toBe(1.0);
    // and when the farmed stage isn't in the bundled data (no EHP to invert) → fallback
    expect(recoverAoeClearFactor(new Map([[99999, stats]]), dps, new Map(), spw)).toBe(1.0);
  });

  it("(c) clamps an outlier factor to AOE_FACTOR_RANGE", () => {
    const hpByKey = realHpByKey([4106]);
    // near-instant clear at a tiny DPS → huge implied factor → clamp to max
    const tiny: StageClearStats = { minClearS: 1, medianClearS: 1, medianDps: 5000, sampleCount: 3 };
    expect(recoverAoeClearFactor(new Map([[4106, tiny]]), 5000, hpByKey, spw)).toBe(AOE_FACTOR_RANGE.max);
    // a stall (enormous clear) → tiny implied factor → clamp to min
    const stall: StageClearStats = { minClearS: 1e7, medianClearS: 1e7, medianDps: 5000, sampleCount: 3 };
    expect(recoverAoeClearFactor(new Map([[4106, stall]]), 5000, hpByKey, spw)).toBe(AOE_FACTOR_RANGE.min);
  });

  it("(d) the recovered factor makes a measured stage and a same-EHP estimated stage rank consistently", () => {
    // Two REAL bundled stages with similar enemy-HP and stage level: one farmed (measured T2), one
    // not (estimated T3 with the FITTED factor). With the old hardcoded 3 the estimated stage's clear
    // was ~3× too fast and it jumped ahead; with the fitted factor the two clear-times are comparable.
    const dps = 160000;
    // Farmed stage 4107 (Torment 1-7, L84); unfarmed sibling 4108 (Torment 1-8, L84) — same level.
    const hpByKey = realHpByKey([4107, 4108]);
    const ehp4107 = stageEnemyHpFromKey(4107);
    // A physically-consistent farmed clear: clearTime ≈ EHP@1/dps (factor ≈ 1, no AoE triple-count).
    const clear = ehp4107 / dps + (hpByKey.get(4107)!.waveAmount ?? 0) * CLEAR_TIME_CFG.secondsPerWave;
    const calibration = new Map<number, StageClearStats>([
      [4107, { minClearS: clear, medianClearS: clear, medianDps: dps, sampleCount: 3 }],
    ]);
    const factor = recoverAoeClearFactor(calibration, dps, hpByKey, CLEAR_TIME_CFG.secondsPerWave);
    // The fitted factor is near 1 (unbiased), nowhere near the old 3.
    expect(factor).toBeGreaterThan(0.6);
    expect(factor).toBeLessThan(1.6);

    // Now build bases with the fitted cfg and compare the two stages' clear-times.
    const cfg = { aoeClearFactor: factor, secondsPerWave: CLEAR_TIME_CFG.secondsPerWave, aoeFitFromRuns: true };
    const bases = buildStageBases(calibration, dps, cfg);
    const farmed = bases.find((b) => b.stageKey === 4107)!; // T2 (measured)
    const unfarmed = bases.find((b) => b.stageKey === 4108)!; // T3 (estimated-calibrated)
    expect(farmed.clear.tier).toBe(2);
    expect(unfarmed.clear.tier).toBe(3);
    expect(unfarmed.clear.confidence).toBe("estimated-calibrated");
    // The estimated clear is NOT dramatically faster than the measured one (same level, similar EHP):
    // ratio stays within ~2×, where the old factor-3 made it ~3× faster. (Stages differ slightly in
    // EHP so we bound generously; the point is the 3× bias is gone.)
    const ratio = unfarmed.clear.seconds / farmed.clear.seconds;
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2.0);
  });
});

describe("recoverHeroMultiplier", () => {
  it("recovers muH = measuredXpc / (base · keep(Lm)) from a farmed stage", () => {
    const bases = buildStageBases(new Map(), 100);
    const b = bases.find((x) => x.stageKey === 4309)!;
    const stageLevel = b.stageLevel;
    const Lm = stageLevel + 4; // over-level (validated keep)
    const trueMu = 2.75;
    const measuredXpc = b.base * expKeepFraction(Lm, stageLevel) * trueMu;
    const measured = new Map([[4309, new Map([[301, [{ xpGained: measuredXpc, level: Lm }]]])]]);
    const mu = recoverHeroMultiplier(301, bases, measured);
    expect(mu).toBeCloseTo(trueMu, 6);
  });

  it("falls back to 1.0 when the hero has no farmed stage", () => {
    const bases = buildStageBases(new Map(), 100);
    expect(recoverHeroMultiplier(999, bases, new Map())).toBe(1.0);
  });

  it("medians across multiple farmed stages", () => {
    const bases = buildStageBases(new Map(), 100);
    const pick = bases.filter((b) => b.stageLevel <= 90).slice(0, 3);
    const measured = new Map<number, Map<number, { xpGained: number; level: number }[]>>();
    const mus = [2.0, 3.0, 4.0];
    pick.forEach((b, i) => {
      const Lm = b.stageLevel + 5;
      const xpc = b.base * expKeepFraction(Lm, b.stageLevel) * mus[i];
      measured.set(b.stageKey, new Map([[301, [{ xpGained: xpc, level: Lm }]]]));
    });
    const mu = recoverHeroMultiplier(301, bases, measured);
    expect(mu).toBeCloseTo(3.0, 6); // median of {2,3,4}
  });
});

describe("buildHeroCandidates", () => {
  const bases = buildStageBases(new Map(), 100);
  const target = bases.find((b) => b.stageLevel >= 80 && b.stageLevel <= 90)!;

  it("a farmed stage is 'measured' and reproduces the measured per-clear at the anchor level", () => {
    const stageLevel = target.stageLevel;
    const Lm = stageLevel + 4;
    const measuredXpc = 5_000_000;
    const measured = new Map([[target.stageKey, new Map([[301, [{ xpGained: measuredXpc, level: Lm }]]])]]);
    const cands = buildHeroCandidates(301, bases, measured, 1.0);
    const c = cands.find((x) => x.stageKey === target.stageKey)!;
    expect(c.source).toBe("measured");
    expect(c.expPerClearAtLevel(Lm)).toBeCloseTo(measuredXpc, 0); // exact at Lm
    // off-Lm scales by the keep ratio
    const expectedAt = measuredXpc * (expKeepFraction(stageLevel + 8, stageLevel) / expKeepFraction(Lm, stageLevel));
    expect(c.expPerClearAtLevel(stageLevel + 8)).toBeCloseTo(expectedAt, 4);
  });

  it("an unfarmed stage is 'estimated' = base · keep(L) · muH", () => {
    const cands = buildHeroCandidates(301, bases, new Map(), 2.5);
    const c = cands.find((x) => x.stageKey === target.stageKey)!;
    expect(c.source).toBe("estimated");
    const L = target.stageLevel + 3;
    expect(c.expPerClearAtLevel(L)).toBeCloseTo(target.base * expKeepFraction(L, target.stageLevel) * 2.5, 4);
  });

  it("every emitted per-clear closure is finite and ≥ 0 across the level span", () => {
    const cands = buildHeroCandidates(301, bases, new Map(), 1.7);
    for (const c of cands) {
      for (let L = 1; L <= 101; L++) {
        const v = c.expPerClearAtLevel(L);
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("a farmed stage with a non-positive measured XP falls back to estimated", () => {
    const measured = new Map([[target.stageKey, new Map([[301, [{ xpGained: 0, level: 90 }]]])]]);
    const cands = buildHeroCandidates(301, bases, measured, 1.3);
    const c = cands.find((x) => x.stageKey === target.stageKey)!;
    expect(c.source).toBe("estimated");
  });
});

// ── Practical-mode under-leveling regression (the Orphias report) ────────────────────────────
// A team that UNDER-LEVELS — farms a stage ABOVE their level for more XP (an optimal, common
// strategy) — must still see that real farmed stage in Practical mode. Before the fix the
// under-level exclusion (meant only for the UNVALIDATED under-level keep PROJECTION of estimated
// stages) also dropped the measured stage, so Practical showed "No farmed stages for this hero yet"
// despite many runs there. HELL 2-6 = datamine key 3206 (stageLevel 66); the reported team was L62.
describe("Practical mode + under-leveling (regression)", () => {
  it("a MEASURED stage above the hero's level survives the Practical filter + Next-Level rank", () => {
    const hellTwoSix = resolveStageKeyFromIndex({ stage: "2-6", mode: "Hell", stageNo: 6 });
    expect(hellTwoSix).toBe(3206); // sanity: bundled data covers HELL 2-6 (stageLevel 66)

    const heroKey = 201; // Ranger, as in the report; the whole team was L62 on a L66 stage
    const index: RunIndexEntry[] = [
      idxEntry({
        stage: "2-6",
        mode: "Hell",
        stageNo: 6,
        clearTime: 228,
        dps: 26_130,
        party: [{ heroKey, class: "Ranger", level: 62, xpGained: 8_160_000 }],
      }),
    ];

    const calibration = calibrateStages(index);
    const measured = collectMeasuredXp(index);
    const bases = buildStageBases(calibration, partyDpsFromIndex(index));
    const muH = recoverHeroMultiplier(heroKey, bases, measured);
    const cands = buildHeroCandidates(heroKey, bases, measured, muH);

    // The farmed stage is MEASURED and sits 4 levels ABOVE the hero (L66 vs L62).
    const farmed = cands.find((c) => c.stageKey === 3206)!;
    expect(farmed.source).toBe("measured");
    expect(farmed.stageLevel).toBe(66);

    // Practical = measured-only candidates; Next Level evaluates at the hero's current level.
    const practical = cands.filter((c) => c.source === "measured");
    const ranked = rankNextLevel({ heroKey, level: 62, expIntoLevel: 0 }, practical, levelCurve, {
      excludeUnderLevel: true,
    });

    // The fix: the real farmed stage IS ranked (no "No farmed stages for this hero yet").
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].stageKey).toBe(3206);
  });
});

// ── anchor team ────────────────────────────────────────────────────────────────────────────

describe("anchorTeamFromRun", () => {
  it("projects level + within-level exp", () => {
    const run = {
      heroes: [{ heroKey: 101, class: "Knight", classId: 1, level: 96, exp: 2500, items: [], skills: [], stats: {} }],
    } as unknown as RunRecord;
    const team = anchorTeamFromRun(run);
    expect(team[0]).toEqual({ heroKey: 101, class: "Knight", level: 96, expIntoLevel: 2500 });
  });

  it("defaults expIntoLevel to 0 when exp is missing", () => {
    const run = {
      heroes: [{ heroKey: 201, class: "Sorcerer", classId: 2, level: 80, items: [], skills: [], stats: {} }],
    } as unknown as RunRecord;
    expect(anchorTeamFromRun(run)[0].expIntoLevel).toBe(0);
  });

  it("a null run → empty team", () => {
    expect(anchorTeamFromRun(null)).toEqual([]);
  });
});
