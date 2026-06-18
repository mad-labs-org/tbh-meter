import { describe, expect, it } from "vitest";
import { clampMaxRuns, selectRunsToPrune, MIN_MAX_RUNS, type PrunableRun } from "../prune.js";

describe("clampMaxRuns", () => {
  it("treats null / non-finite / non-positive as OFF (null)", () => {
    expect(clampMaxRuns(null)).toBeNull();
    expect(clampMaxRuns(undefined)).toBeNull();
    expect(clampMaxRuns(0)).toBeNull();
    expect(clampMaxRuns(-5)).toBeNull();
    expect(clampMaxRuns(Number.NaN)).toBeNull();
    expect(clampMaxRuns(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("floors a fractional cap to an integer", () => {
    expect(clampMaxRuns(500.9)).toBe(500);
  });

  it("raises a too-small cap to the floor (a fat-fingered 1 can't nuke history)", () => {
    expect(clampMaxRuns(1)).toBe(MIN_MAX_RUNS);
    expect(clampMaxRuns(MIN_MAX_RUNS)).toBe(MIN_MAX_RUNS);
    expect(clampMaxRuns(MIN_MAX_RUNS + 1)).toBe(MIN_MAX_RUNS + 1);
  });
});

function runs(...ids: [string, number][]): PrunableRun[] {
  return ids.map(([id, ts]) => ({ id, ts }));
}

describe("selectRunsToPrune", () => {
  const none = new Set<string>();

  it("returns [] when the cap is off (null)", () => {
    expect(selectRunsToPrune(runs(["a", 3], ["b", 2], ["c", 1]), null, none)).toEqual([]);
  });

  it("returns [] when the count is at or under the cap", () => {
    expect(selectRunsToPrune(runs(["a", 3], ["b", 2]), 2, none)).toEqual([]);
    expect(selectRunsToPrune(runs(["a", 3]), 2, none)).toEqual([]);
  });

  it("deletes the OLDEST surplus, oldest-first, keeping the newest `cap`", () => {
    // 5 runs, cap 2 -> keep the 2 newest (ts 5,4), delete ts 3,2,1 oldest-first.
    const list = runs(["e", 5], ["d", 4], ["c", 3], ["b", 2], ["a", 1]);
    expect(selectRunsToPrune(list, 2, none)).toEqual(["a", "b", "c"]);
  });

  it("never deletes a favorite and never counts it toward the cap", () => {
    // cap 2 non-favorites; favorites "d" and "b" are exempt + uncounted, so of the non-favs
    // {e:5, c:3, a:1} keep the 2 newest (e, c) and delete only a. d/b are untouched.
    const list = runs(["e", 5], ["d", 4], ["c", 3], ["b", 2], ["a", 1]);
    const favs = new Set(["d", "b"]);
    expect(selectRunsToPrune(list, 2, favs)).toEqual(["a"]);
  });

  it("can keep MORE than the cap when favorites exceed it (cap counts only non-favorites)", () => {
    // 4 favorites + 3 non-favorites, cap 1 -> delete the 2 oldest non-favorites, keep all favorites.
    const list = runs(
      ["f1", 7],
      ["f2", 6],
      ["f3", 5],
      ["f4", 4],
      ["n1", 3],
      ["n2", 2],
      ["n3", 1],
    );
    const favs = new Set(["f1", "f2", "f3", "f4"]);
    // non-favs newest-first: n1(3), n2(2), n3(1) — keep 1 (n1), delete n2,n3 oldest-first.
    expect(selectRunsToPrune(list, 1, favs)).toEqual(["n3", "n2"]);
  });

  it("is deterministic for equal timestamps (id tiebreak)", () => {
    const list = runs(["a", 5], ["b", 5], ["c", 5], ["d", 5]);
    // ts all equal; keep the 2 with the highest id (d, c), delete the lowest (a, b) oldest-first.
    expect(selectRunsToPrune(list, 2, none)).toEqual(["a", "b"]);
  });
});
