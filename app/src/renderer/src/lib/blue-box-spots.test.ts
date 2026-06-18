import { describe, expect, it } from "vitest";
import { blueBoxSpotsForBox, formatDropRate } from "./game-data";

// Real blue-box keys from the synced data (the data sync runs in pretest):
//   920501 = Stage Boss Box Lv50 — drops across Nightmare + Hell
//   920051 = Stage Boss Box 5    — single mode (Normal), varying rate by stage
//   930101 = an ACT-boss box (NOT a blue box) — must be rejected

describe("formatDropRate (per-mille -> %)", () => {
  it("formats the game rate scale", () => {
    expect(formatDropRate(1000)).toBe("100%");
    expect(formatDropRate(150)).toBe("15%");
    expect(formatDropRate(80)).toBe("8%");
    expect(formatDropRate(25)).toBe("2.5%");
  });
});

describe("blueBoxSpotsForBox", () => {
  it("returns null for a missing / unknown box", () => {
    expect(blueBoxSpotsForBox(null)).toBeNull();
    expect(blueBoxSpotsForBox(undefined)).toBeNull();
    expect(blueBoxSpotsForBox(999999)).toBeNull();
  });

  it("returns null for an act-boss box (930xxx, not the blue box)", () => {
    expect(blueBoxSpotsForBox(930101)).toBeNull();
  });

  it("resolves a cross-mode blue box (SBB Lv50) ordered Normal→Torment, highest rate first", () => {
    const modes = blueBoxSpotsForBox(920501);
    expect(modes).not.toBeNull();
    expect(modes!.map((m) => m.mode)).toEqual(["Nightmare", "Hell"]);
    expect(modes![0].segments).toEqual([{ range: "3-5~3-9", rate: 150, pct: "15%" }]);
    expect(modes![1].segments).toEqual([{ range: "1-1~2-4", rate: 100, pct: "10%" }]);
  });

  it("groups a single-mode varying-rate blue box (Normal SBB 5) by rate, highest first", () => {
    const modes = blueBoxSpotsForBox(920051);
    expect(modes).not.toBeNull();
    expect(modes).toHaveLength(1);
    expect(modes![0].mode).toBe("Normal");
    expect(modes![0].segments).toEqual([
      { range: "1-4", rate: 1000, pct: "100%" },
      { range: "1-5~1-6", rate: 800, pct: "80%" },
      { range: "1-7", rate: 600, pct: "60%" },
    ]);
  });
});
