// Canonical RAW v1 example — a clean, fully-readable successful run. The contract anchor for the
// reader (PR2, must emit this shape) and the converter (PR3, must parse it). Being a typed const,
// `tsc --noEmit` fails if it ever drifts from `RawRun` — that IS the PR1 contract test.
import type { RawRun } from "../raw-types.js";

export const RAW_V1_EXAMPLE: RawRun = {
  raw_schema_version: 1,
  id: "1717799000-12345:7",
  ts: 1717800000,
  run: 7,
  run_outcome: "success",
  session_id: "1717799000-12345", // reader-minted (persistent); external_id = session_id:run
  game_version: "1.00.10",
  duration: 92,

  stageKey: { ok: true, value: 30901 },
  act: { ok: true, value: 3 },
  stageNo: { ok: true, value: 9 },
  difficulty: { ok: true, value: 2 },
  total_mobs: { ok: true, value: 120 },
  mobs: { ok: true, value: 118 },
  total_damage: { ok: true, value: 4500000 },
  clear_time: { ok: true, value: 90 },
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
            uniqueId: "1099511627776123", // u64 as a lossless string (PR2 emits str(uid))
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
};
