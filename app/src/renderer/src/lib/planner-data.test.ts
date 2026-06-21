import { describe, expect, it } from "vitest";
import {
  resolveStageKey,
  resolveStageKeyFromIndex,
  calibrateStages,
  partyDpsFromIndex,
  buildCandidates,
  anchorTeamFromRun,
  heroBonusPct,
  CLEAR_TIME_CFG,
} from "./planner-data";
import type { RunIndexEntry } from "../../../shared/ipc-types.js";
import type { RunRecord, RunHero } from "../../../shared/run-types.js";

// These tests pin the load-bearing review fix #2: the stage-key resolver must handle BOTH formats
// seen in the wild and NEVER fabricate a phantom key for a stage the bundled data doesn't cover.

describe("resolveStageKey — both real formats + the phantom-key guard (review fix #2)", () => {
  it("OLD format: stageKey is already the datamine key → fast-path direct hit", () => {
    // 1717799000-12345:* records carry stageKey 4309 which IS the datamine key (Torment Act-3-9, L95).
    expect(resolveStageKey({ stageKey: 4309, mode: "Torment", act: 3, stageNo: 9 })).toBe(4309);
  });

  it("NEW v2 format: internal stageKey misses → resolve via (mode→DIFFICULTY, act, stageNo)", () => {
    // stageKey 30901 is a game-internal id (NOT in stageMap). The run is Nightmare Act-3-9 → 2309 (L52),
    // and crucially NOT the Torment 4309 — difficulty must disambiguate.
    expect(resolveStageKey({ stageKey: 30901, mode: "Nightmare", act: 3, stageNo: 9 })).toBe(2309);
    // new-format Torment Act-1-6 (stageKey 10601 internal) → 4106
    expect(resolveStageKey({ stageKey: 10601, mode: "Torment", act: 1, stageNo: 6 })).toBe(4106);
  });

  it("Act-4/5 stage absent from the bundled L1–L95 Act-1–3 data → null (NOT a phantom key)", () => {
    // The naive diff*1000+act*100+stageNo would fabricate 4403 / 4501; we must return null and skip.
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
      idxEntry({ stage: "3-9", mode: "Torment", clearTime: 100, dps: 50 }), // 4309
      idxEntry({ stage: "3-9", mode: "Torment", clearTime: 120, dps: 60 }), // 4309
      idxEntry({ stage: "4-3", mode: "Torment", stageNo: 3, clearTime: 80, dps: 70 }), // Act4 → skipped
    ];
    const stats = calibrateStages(index);
    expect([...stats.keys()]).toEqual([4309]); // the Act-4 run is dropped, not phantom-mapped
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
      idxEntry({ clearTime: 42, dps: 99 }), // the only good one
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

// ── candidates from bundled data ───────────────────────────────────────────────────────────

describe("buildCandidates", () => {
  it("produces one candidate per bundled stage with a positive XP-per-clear, all over Act-1–3", () => {
    const cands = buildCandidates(new Map(), 100);
    expect(cands.length).toBeGreaterThan(100); // 120 bundled stages, all with positive exp
    // every candidate is a real datamine stage (stageLevel set, key present)
    for (const c of cands) {
      expect(c.expPerClear).toBeGreaterThan(0);
      expect(c.stageLevel).toBeGreaterThan(0);
    }
  });

  it("uses MEASURED clear-time (tier 2) for a calibrated stage, ESTIMATED (tier 3) otherwise", () => {
    const calib = new Map([[4309, { minClearS: 130, medianClearS: 136, medianDps: 100, sampleCount: 3 }]]);
    const cands = buildCandidates(calib, 100);
    const c4309 = cands.find((c) => c.stageKey === 4309)!;
    expect(c4309.clearOnce.tier).toBe(2);
    expect(c4309.clearOnce.confidence).toBe("measured");
    const other = cands.find((c) => c.stageKey !== 4309 && c.clearOnce.tier === 3)!;
    expect(other.clearOnce.confidence).toBe("estimated");
  });

  it("the T3 floor config flags estimates, not calibrated (Ship 1 default)", () => {
    expect(CLEAR_TIME_CFG.aoeFitFromRuns).toBe(false);
    const cands = buildCandidates(new Map(), 100);
    expect(cands.every((c) => c.clearOnce.confidence === "estimated" || c.clearOnce.confidence === "none")).toBe(true);
  });
});

// ── anchor team ────────────────────────────────────────────────────────────────────────────

function hero(over: Partial<RunHero>): RunHero {
  return { heroKey: 101, class: "Knight", classId: 1, level: 95, exp: 1000, items: [], skills: [], stats: {}, ...over };
}

describe("anchorTeamFromRun / heroBonusPct", () => {
  it("projects level + within-level exp; bonus 0 + bonusMissing when stat 47 absent (review fix #3)", () => {
    const run = { heroes: [hero({ level: 96, exp: 2500, stats: {} })] } as unknown as RunRecord;
    const team = anchorTeamFromRun(run);
    expect(team[0].level).toBe(96);
    expect(team[0].expIntoLevel).toBe(2500);
    expect(team[0].bonusPct).toBe(0);
    expect(team[0].bonusMissing).toBe(true);
  });

  it("reads stat 47 as the per-hero EXP bonus percent when present", () => {
    expect(heroBonusPct(hero({ stats: { "47": 8.7 } }))).toBe(8.7);
    expect(heroBonusPct(hero({ stats: {} }))).toBe(0);
    const run = { heroes: [hero({ stats: { "47": 12 } })] } as unknown as RunRecord;
    expect(anchorTeamFromRun(run)[0].bonusMissing).toBe(false);
  });

  it("a null run → empty team", () => {
    expect(anchorTeamFromRun(null)).toEqual([]);
  });
});
