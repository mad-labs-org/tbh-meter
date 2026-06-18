import { describe, it, expect } from "vitest";
import { stageThreat, difficultyPenalty, hasThreat, THREAT_ELEMENTS } from "./stage-threat";

// Real synced data (src/shared/data) is the fixture — same approach as blue-box-spots.
// Stage keys: <difficulty+1><act><stageNo 2d>; 3309 = 3-9 Hell ("Core of the Abyss"),
// the showcase stage with all four Hell Priests.

describe("stageThreat", () => {
  it("returns null for an unknown stage", () => {
    expect(stageThreat(999)).toBeNull();
    expect(stageThreat(null)).toBeNull();
    expect(stageThreat(undefined)).toBeNull();
  });

  it("3-9 Hell (3309): all four elements, each brought by its Hell Priest", () => {
    const info = stageThreat(3309)!;
    expect(info).not.toBeNull();
    expect(info.elements.map((e) => e.element)).toEqual(["Fire", "Cold", "Lightning", "Chaos"]);
    const chaos = info.elements.find((e) => e.element === "Chaos")!;
    expect(chaos.monsters.map((m) => m.name)).toContain("Chaos Hell Priest");
    expect(info.mode).toBe("Hell");
    expect(info.penalty).toBe(40);
  });

  it("3-9 Nightmare (2309): no Chaos (the Chaos Hell Priest only spawns from Hell)", () => {
    const info = stageThreat(2309)!;
    expect(info.elements.map((e) => e.element)).toEqual(["Fire", "Cold", "Lightning"]);
    expect(info.penalty).toBe(20);
  });

  it("1-1 Normal (1101): all-physical stage has no element badges and no penalty", () => {
    const info = stageThreat(1101)!;
    expect(info.elements).toEqual([]);
    expect(info.penalty).toBeNull();
    expect(hasThreat(info)).toBe(false);
  });

  it("flags the boss-slot monster", () => {
    // 1-5 Normal (1105): boss = Elite Orc (10043), a physical stage — use a stage whose
    // boss carries an element instead: 3-10 Hell (3310) boss Archon Morkar deals Chaos.
    const info = stageThreat(3310)!;
    const chaos = info.elements.find((e) => e.element === "Chaos");
    expect(chaos).toBeDefined();
    expect(chaos!.monsters.some((m) => m.boss)).toBe(true);
  });

  it("elements follow the canonical order and never include Physical", () => {
    for (const key of [1101, 2309, 3309, 4309, 3310]) {
      const info = stageThreat(key);
      if (!info) continue;
      const els = info.elements.map((e) => e.element);
      const sorted = THREAT_ELEMENTS.filter((e) => els.includes(e));
      expect(els).toEqual(sorted);
      expect(els).not.toContain("Physical");
    }
  });
});

describe("difficultyPenalty", () => {
  it("reads the -20/-40/-60 tiers from the buff data", () => {
    expect(difficultyPenalty("NIGHTMARE")).toBe(20);
    expect(difficultyPenalty("HELL")).toBe(40);
    expect(difficultyPenalty("TORMENT")).toBe(60);
  });

  it("Normal and unknown difficulties have no penalty", () => {
    expect(difficultyPenalty("NORMAL")).toBeNull();
    expect(difficultyPenalty(null)).toBeNull();
    expect(difficultyPenalty("WHATEVER")).toBeNull();
  });

  it("Torment penalty applies to a 4-x stage record too", () => {
    expect(stageThreat(4309)!.penalty).toBe(60);
  });
});
