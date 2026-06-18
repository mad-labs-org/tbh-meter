import { describe, expect, it } from "vitest";
import type { ChestCooldown } from "../../../shared/cooldown-types.js";
import { formatRemaining, buildTrackerEntries } from "./cooldown";
import {
  bossBoxForStage,
  bossBoxRate,
  boxBestStage,
  blueBoxes,
  chestLevel,
  formatDropRate,
  stagesByBox,
  stageDifficulty,
} from "./game-data";

describe("formatRemaining", () => {
  it("formats remaining ms as m:ss", () => {
    expect(formatRemaining(12 * 60 * 1000)).toBe("12:00");
    expect(formatRemaining(7 * 60 * 1000 + 18 * 1000)).toBe("7:18");
    expect(formatRemaining(65_000)).toBe("1:05");
    expect(formatRemaining(0)).toBe("0:00");
  });

  it("rounds a partial second UP (so it never shows a second early)", () => {
    expect(formatRemaining(7_300)).toBe("0:08");
    expect(formatRemaining(59_001)).toBe("1:00");
  });
});

// These run against the real synced stages.json / items-min.json, so they also guard the
// data contract (the cooldown card depends on bossDrop + the "Stage Boss Box N" naming).
describe("game-data derivation (Normal Pasture = stageKey 1101, blue box 920011)", () => {
  it("derives the blue-chest box, level and difficulty from a stageKey", () => {
    expect(bossBoxForStage(1101)).toBe(920011);
    expect(chestLevel(920011)).toBe(4); // "Stage Boss Box 4"
    expect(stageDifficulty(1101)).toBe("Normal");
  });

  it("maps a box to the stages that drop it (incl. the stage itself)", () => {
    const stages = stagesByBox(920011);
    expect(stages).toContain(1101);
    expect(stages.length).toBeGreaterThan(0);
  });

  it("returns null level/box for an unmapped key (graceful fallback)", () => {
    expect(chestLevel(999999)).toBeNull();
    expect(bossBoxForStage(999999)).toBeNull();
    expect(stageDifficulty(999999)).toBeNull();
  });
});

describe("blueBoxes (the route picker's universe)", () => {
  it("lists the distinct blue boxes, sorted by level (Lv4 first, Lv80 last)", () => {
    const boxes = blueBoxes();
    expect(boxes.length).toBeGreaterThan(1);
    expect(boxes[0]).toEqual({ boxKey: 920011, level: 4 });
    expect(boxes[boxes.length - 1]).toEqual({ boxKey: 920801, level: 80 });
    // strictly ascending by level
    const levels = boxes.map((b) => b.level ?? 0);
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
  });
});

describe("blue-chest drop rate + best farm spot (base, per-mille)", () => {
  it("formats per-mille as percent", () => {
    expect(formatDropRate(1000)).toBe("100%");
    expect(formatDropRate(150)).toBe("15%");
    expect(formatDropRate(25)).toBe("2.5%");
    expect(formatDropRate(8)).toBe("0.8%");
  });

  it("reads a stage's blue-chest base rate (Normal Pasture 1101 = 100%)", () => {
    expect(bossBoxRate(1101)).toBe(1000);
    expect(bossBoxRate(999999)).toBeNull();
  });

  it("finds a box's best (max-rate) farm spot — box 920051 peaks at Normal 1-4 (100%)", () => {
    expect(boxBestStage(920051)).toBe(1104); // Normal 1-4
    expect(boxBestStage(999999)).toBeNull();
  });
});

describe("buildTrackerEntries (route ∪ active cooldowns)", () => {
  const cd = (boxKey: number, dropAt = 1000): ChestCooldown => ({ boxKey, dropAt });

  it("shows pinned boxes as placeholders (cd=null) alongside active cooldowns", () => {
    const entries = buildTrackerEntries([cd(920011)], [920801]);
    const byBox = new Map(entries.map((e) => [e.boxKey, e.cd]));
    expect(entries).toHaveLength(2);
    expect(byBox.get(920011)).not.toBeNull(); // active cooldown
    expect(byBox.get(920801)).toBeNull(); // route placeholder
  });

  it("a pinned box that is on cooldown shows its real cooldown, not a duplicate placeholder", () => {
    const entries = buildTrackerEntries([cd(920801, 5000)], [920801]);
    expect(entries).toHaveLength(1);
    expect(entries[0].boxKey).toBe(920801);
    expect(entries[0].cd?.dropAt).toBe(5000);
  });

  it("is empty when there are no cooldowns and no route", () => {
    expect(buildTrackerEntries([], [])).toEqual([]);
  });
});
