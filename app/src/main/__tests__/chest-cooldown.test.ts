import { describe, expect, it } from "vitest";
import {
  observeDrop,
  applyDrop,
  clearCooldown,
  hideCooldown,
  appendLog,
  type SeenCounts,
} from "../chest-cooldown.js";
import {
  remainingMs,
  isReady,
  remainingFraction,
  DEFAULT_COOLDOWN_MS,
  type ChestCooldown,
} from "../../shared/cooldown-types.js";
import type { LiveSnapshot } from "../../shared/run-types.js";

// Concrete stages from data/stages.json, picked so observeDrop resolves a known box:
//   1101 (Normal 1-1) → box 920011 (Lv4);  1103 (Normal 1-3) → ALSO box 920011 (same level).
//   4309 (Torment 3-9) → box 920801;        4109 (Torment 1-9) → ALSO box 920801 (the #3 case).
//   3101 (Hell 1-1)   → box 920501 (Lv50);  1110 (Normal 1-10) → box 930101 (act-boss, NOT blue).
const BOX_920011 = 920011;
const BOX_920801 = 920801;

/** Minimal LiveSnapshot with a given stage + blue-chest (drops[1]) count. */
function snap(stageKey: number | null, blueCount: number | null): LiveSnapshot {
  return {
    runNumber: 1,
    stage: "Pasture",
    mode: "Normal",
    stageKey,
    mobs: 0,
    totalMobs: null,
    elapsedSec: 1,
    damage: 0,
    dps: 0,
    goldGain: null,
    xpGain: null,
    party: null,
    drops: blueCount == null ? null : [0, blueCount, 0],
    partyStats: null,
    partyProgress: null,
    approx: true,
  };
}

const event = (boxKey: number, dropAt: number, lastStageKey?: number): ChestCooldown => ({
  boxKey,
  dropAt,
  ...(lastStageKey != null ? { lastStageKey } : {}),
});

describe("observeDrop", () => {
  it("returns null when there's no stageKey or no numeric blue-chest count", () => {
    const seen: SeenCounts = new Map();
    expect(observeDrop(seen, snap(null, 1))).toBeNull();
    expect(observeDrop(seen, snap(1101, null))).toBeNull();
    expect(seen.size).toBe(0);
  });

  it("returns null for a stage whose box is not a blue box (act-boss x-10 → 930xxx)", () => {
    const seen: SeenCounts = new Map();
    expect(observeDrop(seen, snap(1110, 1))).toBeNull(); // 1110 drops a 930xxx act-boss box
    expect(seen.size).toBe(0);
  });

  it("seeds the baseline on first observation WITHOUT firing (no false drop on launch)", () => {
    const seen: SeenCounts = new Map();
    expect(observeDrop(seen, snap(1101, 3))).toEqual({ dropped: false, boxKey: BOX_920011, stageKey: 1101 });
    expect(seen.get(BOX_920011)).toBe(3); // keyed by BOX, not stage
  });

  it("fires on a rising edge, reporting the box + originating stage", () => {
    const seen: SeenCounts = new Map();
    observeDrop(seen, snap(4309, 0)); // seed
    expect(observeDrop(seen, snap(4309, 1))).toEqual({ dropped: true, boxKey: BOX_920801, stageKey: 4309 });
    expect(observeDrop(seen, snap(4309, 1))).toEqual({ dropped: false, boxKey: BOX_920801, stageKey: 4309 });
  });

  it("treats the SAME box on different stages as one cooldown (the #3 fix)", () => {
    const seen: SeenCounts = new Map();
    // Drop the Lv80 box on 3-9, then move to 1-9 (a new run resets the count) and drop again.
    observeDrop(seen, snap(4309, 0));
    expect(observeDrop(seen, snap(4309, 1))!.dropped).toBe(true); // dropped on 3-9
    expect(observeDrop(seen, snap(4109, 0))!.dropped).toBe(false); // new run on 1-9 → reset, no false drop
    const second = observeDrop(seen, snap(4109, 1))!;
    expect(second.dropped).toBe(true); // dropped on 1-9 → same Lv80 box
    expect(second.boxKey).toBe(BOX_920801);
    expect(seen.size).toBe(1); // ONE box tracked, not two stages
  });

  it("does not fire on a run reset (count drops), but the next rise from there does", () => {
    const seen: SeenCounts = new Map();
    observeDrop(seen, snap(4309, 0));
    expect(observeDrop(seen, snap(4309, 1))!.dropped).toBe(true);
    expect(observeDrop(seen, snap(4309, 0))!.dropped).toBe(false); // new run reset
    expect(observeDrop(seen, snap(4309, 1))!.dropped).toBe(true); // rise again -> real drop
  });

  it("keeps different boxes independent (a drop on box B is not a rise on box A)", () => {
    const seen: SeenCounts = new Map();
    observeDrop(seen, snap(1101, 1)); // seed box 920011 at 1
    observeDrop(seen, snap(3101, 0)); // seed box 920501 at 0
    expect(observeDrop(seen, snap(3101, 1))!.dropped).toBe(true); // box 920501 rises
    expect(observeDrop(seen, snap(1101, 1))!.dropped).toBe(false); // box 920011 unchanged
  });
});

describe("applyDrop", () => {
  it("adds newest first", () => {
    const out = applyDrop([event(BOX_920011, 100)], event(BOX_920801, 200));
    expect(out.map((c) => c.boxKey)).toEqual([BOX_920801, BOX_920011]);
  });

  it("refreshes (replaces + moves to front) an existing box rather than stacking", () => {
    const out = applyDrop([event(BOX_920801, 200), event(BOX_920011, 100)], event(BOX_920011, 300));
    expect(out.map((c) => c.boxKey)).toEqual([BOX_920011, BOX_920801]);
    expect(out.find((c) => c.boxKey === BOX_920011)?.dropAt).toBe(300);
    expect(out.filter((c) => c.boxKey === BOX_920011)).toHaveLength(1);
  });
});

describe("clearCooldown", () => {
  it("removes the active line for a box and leaves the rest", () => {
    const out = clearCooldown([event(BOX_920801, 200), event(BOX_920011, 100)], BOX_920011);
    expect(out.map((c) => c.boxKey)).toEqual([BOX_920801]);
  });

  it("is a no-op for an unknown boxKey", () => {
    const active = [event(BOX_920801, 200)];
    expect(clearCooldown(active, 999999)).toEqual(active);
  });
});

describe("hideCooldown", () => {
  it("flags the entry hidden (overlay X) without removing it; others untouched", () => {
    const out = hideCooldown([event(BOX_920801, 200), event(BOX_920011, 100)], BOX_920011);
    expect(out).toHaveLength(2); // not deleted
    expect(out.find((c) => c.boxKey === BOX_920011)?.hidden).toBe(true);
    expect(out.find((c) => c.boxKey === BOX_920801)?.hidden).toBeUndefined();
  });

  it("a re-drop (applyDrop) replaces a hidden entry with an un-hidden one", () => {
    const hidden = hideCooldown([event(BOX_920011, 100)], BOX_920011);
    const out = applyDrop(hidden, event(BOX_920011, 300));
    expect(out).toHaveLength(1);
    expect(out[0].hidden).toBeUndefined(); // back in the overlay
    expect(out[0].dropAt).toBe(300);
  });
});

describe("appendLog", () => {
  it("prepends newest and caps at the limit (oldest dropped)", () => {
    let log: ChestCooldown[] = [];
    for (let i = 0; i < 5; i++) log = appendLog(log, event(920000 + i, i), 3);
    expect(log.map((c) => c.boxKey)).toEqual([920004, 920003, 920002]); // newest 3 kept
  });
});

describe("time math (shared, from a persisted dropAt)", () => {
  it("computes remaining, ready and fraction anchored to dropAt (default duration)", () => {
    const dropAt = 1_000_000;
    const cd = event(BOX_920801, dropAt);
    expect(remainingMs(cd, dropAt)).toBe(DEFAULT_COOLDOWN_MS);
    expect(remainingMs(cd, dropAt + DEFAULT_COOLDOWN_MS / 2)).toBe(DEFAULT_COOLDOWN_MS / 2);
    expect(remainingFraction(cd, dropAt + DEFAULT_COOLDOWN_MS / 2)).toBeCloseTo(0.5);
    expect(isReady(cd, dropAt + DEFAULT_COOLDOWN_MS / 2)).toBe(false);
    expect(remainingMs(cd, dropAt + DEFAULT_COOLDOWN_MS)).toBe(0);
    expect(remainingMs(cd, dropAt + DEFAULT_COOLDOWN_MS + 999)).toBe(0);
    expect(isReady(cd, dropAt + DEFAULT_COOLDOWN_MS)).toBe(true);
    expect(remainingFraction(cd, dropAt + DEFAULT_COOLDOWN_MS)).toBe(0);
  });

  it("honours a custom cooldown duration (the user setting)", () => {
    const dropAt = 1_000_000;
    const cd = event(BOX_920801, dropAt);
    const tenMin = 10 * 60 * 1000;
    expect(remainingMs(cd, dropAt, tenMin)).toBe(tenMin);
    expect(isReady(cd, dropAt + tenMin, tenMin)).toBe(true);
    expect(remainingFraction(cd, dropAt + tenMin / 4, tenMin)).toBeCloseTo(0.75);
  });
});
