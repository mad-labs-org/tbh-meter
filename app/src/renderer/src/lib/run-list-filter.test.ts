import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTER,
  DEFAULT_SORT,
  isFilterActive,
  passesListFilter,
  filterAndSortRuns,
  distinctStages,
  distinctModes,
  type RunListFilter,
} from "./run-list-filter";
import type { RunIndexEntry } from "../../../shared/ipc-types.js";

// A run row carrying the fields the interactive filter + sort read. Sensible defaults; override
// per-test. ids are unique so the stable tiebreak is testable.
let counter = 0;
function run(overrides: Partial<RunIndexEntry> = {}): RunIndexEntry {
  counter += 1;
  return {
    id: overrides.id ?? `r${counter}`,
    ts: overrides.ts ?? counter,
    sessionId: "s1",
    status: overrides.status ?? "success",
    stage: overrides.stage ?? "1-1",
    stageNo: overrides.stageNo ?? 1,
    mode: overrides.mode ?? "Normal",
    dps: overrides.dps ?? 0,
    totalDamage: overrides.totalDamage ?? 0,
    goldGained: overrides.goldGained ?? 0,
    xpGained: overrides.xpGained ?? 0,
    xpPerSec: overrides.xpPerSec ?? 0,
    goldPerSec: overrides.goldPerSec ?? 0,
    mobs: 0,
    totalMobs: null,
    duration: overrides.duration ?? 0,
    clearTime: overrides.clearTime ?? 0,
    schemaVersion: 11,
    party: [],
    ...(overrides.favorite !== undefined ? { favorite: overrides.favorite } : {}),
  };
}

describe("isFilterActive", () => {
  it("false for the empty filter, true once any facet is set", () => {
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(isFilterActive({ ...EMPTY_FILTER, stage: "3-9" })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, mode: "Hell" })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, status: "fail" })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, favoritesOnly: true })).toBe(true);
  });
});

describe("passesListFilter", () => {
  it("empty filter passes everything", () => {
    expect(passesListFilter(run(), EMPTY_FILTER)).toBe(true);
  });

  it("filters by stage / mode / status (exact match)", () => {
    const r = run({ stage: "3-9", mode: "Hell", status: "fail" });
    expect(passesListFilter(r, { ...EMPTY_FILTER, stage: "3-9" })).toBe(true);
    expect(passesListFilter(r, { ...EMPTY_FILTER, stage: "1-1" })).toBe(false);
    expect(passesListFilter(r, { ...EMPTY_FILTER, mode: "Hell" })).toBe(true);
    expect(passesListFilter(r, { ...EMPTY_FILTER, mode: "Normal" })).toBe(false);
    expect(passesListFilter(r, { ...EMPTY_FILTER, status: "fail" })).toBe(true);
    expect(passesListFilter(r, { ...EMPTY_FILTER, status: "success" })).toBe(false);
  });

  it("favorites-only keeps only favorited runs", () => {
    const fav: RunListFilter = { ...EMPTY_FILTER, favoritesOnly: true };
    expect(passesListFilter(run({ favorite: true }), fav)).toBe(true);
    expect(passesListFilter(run({ favorite: false }), fav)).toBe(false);
    expect(passesListFilter(run(), fav)).toBe(false); // no flag = not favorited
  });

  it("combines facets with AND", () => {
    const f: RunListFilter = { stage: "3-9", mode: "Hell", status: "success", favoritesOnly: true };
    expect(
      passesListFilter(
        run({ stage: "3-9", mode: "Hell", status: "success", favorite: true }),
        f,
      ),
    ).toBe(true);
    expect(
      passesListFilter(run({ stage: "3-9", mode: "Hell", status: "success", favorite: false }), f),
    ).toBe(false);
  });
});

describe("filterAndSortRuns", () => {
  it("sorts by a metric desc (the 'where did I earn the most' view)", () => {
    const list = [
      run({ id: "low", goldGained: 10 }),
      run({ id: "high", goldGained: 100 }),
      run({ id: "mid", goldGained: 50 }),
    ];
    const out = filterAndSortRuns(list, EMPTY_FILTER, { key: "goldGained", dir: "desc" });
    expect(out.map((r) => r.id)).toEqual(["high", "mid", "low"]);
  });

  it("sorts ascending too", () => {
    const list = [run({ id: "a", dps: 3 }), run({ id: "b", dps: 1 }), run({ id: "c", dps: 2 })];
    const out = filterAndSortRuns(list, EMPTY_FILTER, { key: "dps", dir: "asc" });
    expect(out.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("default sort = newest-first by date", () => {
    const list = [run({ id: "old", ts: 1 }), run({ id: "new", ts: 3 }), run({ id: "mid", ts: 2 })];
    const out = filterAndSortRuns(list, EMPTY_FILTER, DEFAULT_SORT);
    expect(out.map((r) => r.id)).toEqual(["new", "mid", "old"]);
  });

  it("is stable on metric ties (id ascending tiebreak)", () => {
    const list = [run({ id: "c", xpGained: 5 }), run({ id: "a", xpGained: 5 }), run({ id: "b", xpGained: 5 })];
    const out = filterAndSortRuns(list, EMPTY_FILTER, { key: "xpGained", dir: "desc" });
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("filters before sorting and never mutates the input", () => {
    const list = [
      run({ id: "x", stage: "3-9", goldGained: 1 }),
      run({ id: "y", stage: "1-1", goldGained: 9 }),
      run({ id: "z", stage: "3-9", goldGained: 5 }),
    ];
    const snapshot = list.map((r) => r.id);
    const out = filterAndSortRuns(list, { ...EMPTY_FILTER, stage: "3-9" }, { key: "goldGained", dir: "desc" });
    expect(out.map((r) => r.id)).toEqual(["z", "x"]);
    expect(list.map((r) => r.id)).toEqual(snapshot); // input order untouched
  });
});

describe("distinctStages / distinctModes", () => {
  it("returns distinct values in first-seen order, skipping unknown '?'", () => {
    const list = [
      run({ stage: "3-9", mode: "Hell" }),
      run({ stage: "3-9", mode: "Normal" }),
      run({ stage: "1-1", mode: "Hell" }),
      run({ stage: "?", mode: "?" }),
    ];
    expect(distinctStages(list)).toEqual(["3-9", "1-1"]);
    expect(distinctModes(list)).toEqual(["Hell", "Normal"]);
  });
});
