import { describe, expect, it } from "vitest";
import { mapGear, mapSkillLevels } from "../ingest-map.js";
import type { RunItem, RunMod, RunSkill } from "../../shared/run-types.js";

const SKILL_ATTR = { "10101": 101003, "10201": 101004 };

// One unambiguous bucket + one multi-option bucket (same material, two roll options)
// + one two-material collision disambiguated by the rolled value.
const SOCKET_MAP = {
  DECORATION: {
    WEAPON: {
      FireDamagePercent: { "3": [[112001, 0, 300, 400]] },
      AttackDamage: {
        "1": [
          [140001, 0, 1, 6],
          [140001, 1, 50, 200],
        ],
      },
    },
    ACCESSORY: {
      AttackDamage: {
        "2": [
          [111001, 0, 1, 2],
          [113001, 0, 3, 6],
        ],
      },
    },
  },
  ENGRAVING: {
    ARMOR: { MaxHp: { "*": [[120001, 0, 10, 30]] } },
  },
  INSCRIPTION: {},
} as Parameters<typeof mapGear>[1];

function skill(key: number, lv: number | null): RunSkill {
  return { key, lv };
}

function mod(recipe: string, stat: string, tier: number | null, value: number | null): RunMod {
  return { recipeId: null, recipe, statId: null, stat, value, tier };
}

function item(slot: string, itemKey: number | null, mods: RunMod[] = []): RunItem {
  return { slot, slotId: null, grade: "RARE", gradeId: 2, itemKey, uniqueId: "1", level: 1, mods };
}

describe("mapSkillLevels", () => {
  it("maps skillKey -> attributeKey and drops unknown/unleveled skills", () => {
    const out = mapSkillLevels(
      [skill(10101, 3), skill(10201, null), skill(99999, 5), skill(10101, 0)],
      SKILL_ATTR,
    );
    expect(out).toEqual({ "101003": 3 });
  });

  it("returns undefined when nothing maps", () => {
    expect(mapSkillLevels([], SKILL_ATTR)).toBeUndefined();
    expect(mapSkillLevels([skill(10201, null)], SKILL_ATTR)).toBeUndefined();
  });
});

describe("mapGear", () => {
  it("maps items per slot with resolved socket materials", () => {
    const out = mapGear(
      [
        item("MAIN_WEAPON", 30001, [mod("DECORATION", "FireDamagePercent", 3, 350)]),
        item("ARMOR", 40001, [mod("ENGRAVING", "MaxHp", 9, 20)]),
      ],
      SOCKET_MAP,
    );
    expect(out).toEqual({
      MAIN_WEAPON: {
        itemKey: 30001,
        decorations: [112001],
        engravings: [],
        inscriptions: [],
      },
      ARMOR: {
        itemKey: 40001,
        decorations: [],
        engravings: [120001], // "*" tier bucket matches any tier
        inscriptions: [],
      },
    });
  });

  it("records effectChoices when the rolled value matches a non-first option", () => {
    const out = mapGear(
      [item("MAIN_WEAPON", 30001, [mod("DECORATION", "AttackDamage", 1, 120)])],
      SOCKET_MAP,
    );
    expect(out?.MAIN_WEAPON.decorations).toEqual([140001]);
    expect(out?.MAIN_WEAPON.effectChoices).toEqual({ "decorations:0": 1 });
  });

  it("disambiguates colliding materials by the rolled value", () => {
    const out = mapGear(
      [item("RING", 50001, [mod("DECORATION", "AttackDamage", 2, 5)])],
      SOCKET_MAP,
    );
    expect(out?.RING.decorations).toEqual([113001]);
    expect(out?.RING.effectChoices).toBeUndefined();
  });

  it("keeps unresolved socket mods as null entries and drops non-socket recipes", () => {
    const out = mapGear(
      [
        item("MAIN_WEAPON", 30001, [
          mod("DECORATION", "UnknownStat", 1, 10),
          mod("ALCHEMY", "AttackDamage", 1, 10),
        ]),
      ],
      SOCKET_MAP,
    );
    expect(out?.MAIN_WEAPON.decorations).toEqual([null]);
    expect(out?.MAIN_WEAPON.engravings).toEqual([]);
  });

  it("skips unknown slots and empty items, returning undefined when nothing maps", () => {
    expect(mapGear([], SOCKET_MAP)).toBeUndefined();
    expect(mapGear([item("?", 30001), item("MAIN_WEAPON", null)], SOCKET_MAP)).toBeUndefined();
  });
});

describe("generated maps (sync-data output)", () => {
  it("resolves a real Ruby decoration through the bundled socket map", () => {
    // Ruby (112001): DECORATION, WEAPON pool = FireDamagePercent T3, roll 300..400.
    const out = mapGear([
      item("MAIN_WEAPON", 30001, [mod("DECORATION", "FireDamagePercent", 3, 360)]),
    ]);
    expect(out?.MAIN_WEAPON.decorations).toEqual([112001]);
  });

  it("resolves an equipped skill through the bundled skill map", () => {
    const out = mapSkillLevels([skill(10101, 4)]);
    expect(out).toEqual({ "101003": 4 });
  });
});
