// Canonical RAW v2 example (Redesign 2) — the run's identity is its own end-ts in MILLISECONDS, with
// NO session_id and NO run counter (the run_num-reset bug class is gone). The contract anchor for the
// reader (PR2, must emit this shape) and the converter (PR3, must parse it). Being a typed const,
// `tsc --noEmit` fails if it ever drifts from `RawRunV2` — that IS the PR1 contract test.
import type { RawRunV2 } from "../raw-types.js";

export const RAW_V2_EXAMPLE: RawRunV2 = {
  raw_schema_version: 2,
  id: "1717800000123", // = ts (ms) as a string; unique per machine, no session/counter
  ts: 1717800000123, // Unix MILLISECONDS (v1 was seconds); UI shows seconds via toSeconds
  run_outcome: "success",
  game_version: "1.00.11",
  duration: 92, // SECONDS — a duration, not a timestamp; only `ts` went to ms

  stageKey: { ok: true, value: 30901 },
  act: { ok: true, value: 3 },
  stageNo: { ok: true, value: 9 },
  difficulty: { ok: true, value: 2 },
  total_mobs: { ok: true, value: 120 },
  mobs: { ok: true, value: 118 },
  total_damage: { ok: true, value: 4500000 },
  clear_time: { ok: true, value: 90 }, // seconds
  gold_gained: { ok: true, value: 125000 },
  gold_source: "live",
  xp_gained: { ok: true, value: 3400000 },
  xp_source: "live",
  drops: { ok: true, value: [{ box_key: 1, monster_type: 2 }] },
  heroes: {
    ok: true,
    value: [
      {
        heroKey: 1001,
        classId: 5,
        class: "0x5",
        level: 80,
        exp: 1234567,
        items: [
          {
            slot: "weapon",
            slotId: 0,
            grade: "legendary",
            gradeId: 4,
            itemKey: 50012,
            uniqueId: "1099511627776123", // u64 as a lossless string
            level: 20,
            mods: [{ recipeId: 11, recipe: "atk", statId: 3, stat: "ATK", value: 1500, tier: 3 }],
          },
        ],
        skills: [{ key: 7001, lv: 5 }],
        skillLevels: { "7001": 5 },
        stats: { "0": 1500, "1": 320 },
        exp_start: 1200000,
        exp_end: 1234567,
        xp_gained: 34567,
        levelup: false,
        deaths: 0,
        revives: 0,
      },
    ],
  },

  // Per-run account snapshot (EXPERIMENTAL: emitted by the reader, NOT yet consumed by the converter).
  // Always present in v2 raw written since the snapshot PR; absent in older v2 raw (hence optional
  // in RawRunV2). v1 never had it (frozen legacy).
  runes: {
    ok: true,
    value: [
      { key: 101, level: 5 },
      { key: 1171, level: 1 },
    ],
  },
  inventory: {
    ok: true,
    value: [
      { itemKey: 302171, uniqueId: "501734348921861373", slotId: 1, gradeId: 4, level: 80, mods: [] },
    ],
  },
  stash: {
    ok: true,
    value: [
      {
        itemKey: 315171,
        uniqueId: "501734348895521012",
        slotId: 1,
        gradeId: 4,
        level: 80,
        mods: [{ recipeId: 1, recipe: "atk", statId: 24, stat: "PhysDmg%", value: 700, tier: 6 }],
      },
    ],
  },
};
