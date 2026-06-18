import { describe, expect, it } from "vitest";
import { convertLegacy } from "../converter/legacy.js";
import { STRUCTURED_SCHEMA_VERSION } from "../converter/convert.js";

// Legacy runs.jsonl records span eras (schema_version <= 11): PT keys/status (<=v5), EN (v6+),
// drops (v10+), deaths/revives (v11+). These fixtures exercise the migration branch — its whole job
// is to adopt them into the structured shape WITHOUT re-minting the external_id and WITHOUT deleting
// the bugged ones.

describe("convertLegacy — external_id preservation (the duplicate-upload guard)", () => {
  it("carries the original session_id:run id verbatim (never re-minted)", () => {
    const r = convertLegacy(
      { ts: 1_700_000_000, session_id: "1700000000-9999", run: 4, status: "success", stage: "2-5", stageKey: 2105, mode: "Normal", total_damage: 1_000_000, clear_time: 60, duration: 62, gold_gained: 50_000, schema_version: 11, heroes: [] },
      0,
    );
    expect(r.id).toBe("1700000000-9999:4");
    expect(r.sessionId).toBe("1700000000-9999");
    expect(r.run).toBe(4);
  });

  it("falls back to idx:N for a malformed record missing run (defensive, matches reader path)", () => {
    const r = convertLegacy({ ts: 1_700_000_000, session_id: "s", status: "success", heroes: [] }, 7);
    expect(r.id).toBe("idx:7");
  });
});

describe("convertLegacy — era field mapping (reuses normalizeRecord)", () => {
  it("maps EN v6 keys", () => {
    const r = convertLegacy(
      { ts: 1_700_000_000, session_id: "s", run: 1, status: "success", stage: "3-9", stageKey: 30901, mode: "Hell", total_damage: 4_500_000, clear_time: 90, duration: 92, gold_gained: 125_000, gold_source: "live", xp_gained: 3_400_000, xp_source: "live", schema_version: 6, heroes: [] },
      0,
    );
    expect(r.stage).toBe("3-9");
    expect(r.mode).toBe("Hell");
    expect(r.totalDamage).toBe(4_500_000);
    expect(r.goldGained).toBe(125_000);
    expect(r.schemaVersion).toBe(6);
  });

  it("maps legacy PT v5 keys/status (dano_total, gold_ganho, 'sucesso')", () => {
    const r = convertLegacy(
      { ts: 1_700_000_000, session_id: "s", run: 1, status: "sucesso", stage: "1-1", stageKey: 1001, mode: "Normal", dano_total: 800_000, clear_time: 40, medido: 41, gold_ganho: 12_000, schema_version: 5, heroes: [] },
      0,
    );
    expect(r.status).toBe("success");
    expect(r.totalDamage).toBe(800_000);
    expect(r.goldGained).toBe(12_000);
    expect(r.duration).toBe(41);
  });

  it("carries drops (v10) and run-level deaths/revives (v11)", () => {
    const r = convertLegacy(
      { ts: 1_700_000_000, session_id: "s", run: 1, status: "success", stage: "2-5", stageKey: 2105, mode: "Normal", total_damage: 1_000_000, clear_time: 60, duration: 62, gold_gained: 50_000, schema_version: 11, deaths: 2, revives: 1, drops: [{ box_key: 920011, monster_type: 1 }], heroes: [] },
      0,
    );
    expect(r.drops).toEqual([{ boxKey: 920011, monsterType: 1 }]);
    expect(r.deaths).toBe(2);
    expect(r.revives).toBe(1);
  });
});

describe("convertLegacy — era hero shapes flow through the legacy converter (v5..v11, non-empty heroes)", () => {
  // The migration's hero handling lives in normalizeRecord/normalizeHero (PT xp keys, skills shape
  // per era, skillLevels filter). These prove convertLegacy ADOPTS each era's hero shape end-to-end
  // — the earlier fixtures all passed heroes:[], so the legacy hero path was uncovered.

  it("v5 PT hero: exp_live_* / xp_gain_live xp keys + bare [number] skills", () => {
    const r = convertLegacy(
      {
        ts: 1, session_id: "s", run: 1, status: "sucesso", stage: "1-1", stageKey: 1001, mode: "Normal",
        dano_total: 800_000, clear_time: 40, medido: 41, gold_ganho: 12_000, schema_version: 5,
        heroes: [
          {
            heroKey: 1001, classId: 5, class: "0x5", level: 70, exp: 999,
            items: [], skills: [7001, 7002], stats: { "0": 1500 },
            exp_live_start: 1_200_000, exp_live_end: 1_234_567, xp_gain_live: 34_567,
          },
        ],
      },
      0,
    );
    expect(r.heroes).toHaveLength(1);
    const h = r.heroes[0];
    // bare [number] skills normalize to [{ key, lv: null }]
    expect(h.skills).toEqual([
      { key: 7001, lv: null },
      { key: 7002, lv: null },
    ]);
    // PT-era xp keys adopted
    expect(h.expStart).toBe(1_200_000);
    expect(h.expEnd).toBe(1_234_567);
    expect(h.xpGained).toBe(34_567);
  });

  it("v7 hero: skills as [{ key, lv }] carry the level through", () => {
    const r = convertLegacy(
      {
        ts: 1, session_id: "s", run: 1, status: "success", stage: "3-9", stageKey: 30901, mode: "Hell",
        total_damage: 4_500_000, clear_time: 90, duration: 92, gold_gained: 125_000, schema_version: 7,
        heroes: [
          { heroKey: 2002, classId: 1, class: "0x1", level: 80, exp: 1, items: [], skills: [{ key: 7001, lv: 5 }], stats: {} },
        ],
      },
      0,
    );
    expect(r.heroes[0].skills).toEqual([{ key: 7001, lv: 5 }]);
  });

  it("v8 hero: skillLevels invested tree, filtered to v>0", () => {
    const r = convertLegacy(
      {
        ts: 1, session_id: "s", run: 1, status: "success", stage: "3-9", stageKey: 30901, mode: "Hell",
        total_damage: 4_500_000, clear_time: 90, duration: 92, gold_gained: 125_000, schema_version: 8,
        heroes: [
          { heroKey: 3003, classId: 2, class: "0x2", level: 80, exp: 1, items: [], skills: [], stats: {}, skillLevels: { "7001": 5, "7002": 0 } },
        ],
      },
      0,
    );
    // the 0-level entry is dropped (invested tree shows only acquired levels)
    expect(r.heroes[0].skillLevels).toEqual({ "7001": 5 });
  });

  it("v10/v11 hero: per-hero killed_by survives (filtered to finite numbers)", () => {
    const r = convertLegacy(
      {
        ts: 1, session_id: "s", run: 1, status: "success", stage: "3-9", stageKey: 30901, mode: "Hell",
        total_damage: 4_500_000, clear_time: 90, duration: 92, gold_gained: 125_000, schema_version: 11,
        drops: [{ box_key: 920011, monster_type: 1 }],
        heroes: [
          { heroKey: 4004, classId: 3, class: "0x3", level: 80, exp: 1, items: [], skills: [], stats: {}, deaths: 1, revives: 0, killed_by: [30102, 30103] },
        ],
      },
      0,
    );
    expect(r.drops).toEqual([{ boxKey: 920011, monsterType: 1 }]); // v10 drops
    expect(r.heroes[0].killedBy).toEqual([30102, 30103]); // v11 per-hero survival
    expect(r.heroes[0].deaths).toBe(1);
  });
});

describe("convertLegacy — derives rates/dps with the shared helpers (not the stored legacy values)", () => {
  it("re-derives dps from total_damage / clear_time even if a stale dps is stored", () => {
    const r = convertLegacy(
      { ts: 1, session_id: "s", run: 1, status: "success", stage: "3-9", stageKey: 30901, mode: "Hell", total_damage: 4_500_000, clear_time: 90, duration: 92, gold_gained: 125_000, dps: 999, gold_per_sec: 999, schema_version: 11, heroes: [] },
      0,
    );
    expect(r.dps).toBeCloseTo(50_000, 5);
    expect(r.goldPerSec).toBeCloseTo(1_388.89, 2);
  });
});

describe("convertLegacy — quality verdict & schema stamp", () => {
  it("seals a clean above-floor success as counted", () => {
    const r = convertLegacy(
      { ts: 1, session_id: "s", run: 1, status: "success", stage: "3-9", stageKey: 30901, mode: "Hell", total_damage: 4_500_000, clear_time: 90, duration: 92, gold_gained: 125_000, schema_version: 11, heroes: [] },
      0,
    );
    expect(r.quality).toBe("counted");
    expect(r.issues).toEqual({});
    expect(r.structuredSchemaVersion).toBe(STRUCTURED_SCHEMA_VERSION);
  });

  it("seals a sub-floor run as skipped (not deleted)", () => {
    const r = convertLegacy(
      { ts: 1, session_id: "s", run: 1, status: "success", stage: "2-5", stageKey: 2105, mode: "Normal", total_damage: 100_000, clear_time: 8, duration: 8, gold_gained: 1_000, schema_version: 11, heroes: [] },
      0,
    );
    expect(r.quality).toBe("skipped");
  });

  it("seals a fail run as skipped (real history, never counted)", () => {
    const r = convertLegacy(
      { ts: 1, session_id: "s", run: 1, status: "fail", stage: "2-5", stageKey: 2105, mode: "Normal", total_damage: 50_000, clear_time: 0, duration: 30, gold_gained: 500, schema_version: 11, heroes: [] },
      0,
    );
    expect(r.quality).toBe("skipped");
  });
});

describe("convertLegacy — the 1.00.10 bugged records (gold 0 + mode '?')", () => {
  it("seals a gold:0 + mode:'?' record as degraded with a reason (the bug fingerprint)", () => {
    const r = convertLegacy(
      { ts: 1, session_id: "s", run: 1, status: "success", stage: "?", stageKey: null, mode: "?", total_damage: 4_500_000, clear_time: 90, duration: 92, gold_gained: 0, schema_version: 11, heroes: [] },
      0,
    );
    expect(r.quality).toBe("degraded");
    expect(r.issues!.gold_gained).toContain("1.00.10");
    expect(r.issues!.stageKey).toBeDefined();
  });

  it("does NOT degrade a legitimately-0-gold run that still resolved its stage", () => {
    // gold 0 alone is NOT the bug — a real 0-gold run resolves its stage/mode. Only 0+"?" is.
    const r = convertLegacy(
      { ts: 1, session_id: "s", run: 1, status: "success", stage: "1-1", stageKey: 1001, mode: "Normal", total_damage: 500_000, clear_time: 30, duration: 31, gold_gained: 0, schema_version: 11, heroes: [] },
      0,
    );
    expect(r.quality).not.toBe("degraded");
    expect(r.issues).toEqual({});
  });

  it("degrades a record whose stageKey is missing even with gold > 0", () => {
    const r = convertLegacy(
      { ts: 1, session_id: "s", run: 1, status: "success", stage: "3-9", mode: "Hell", total_damage: 4_500_000, clear_time: 90, duration: 92, gold_gained: 125_000, schema_version: 11, heroes: [] },
      0,
    );
    expect(r.quality).toBe("degraded");
    expect(r.issues!.stageKey).toBe("legacy: stageKey missing");
  });
});
