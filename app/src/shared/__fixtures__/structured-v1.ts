// Canonical STRUCTURED v1 example — what the converter (PR3) produces from `raw-v1.ts`. Numbers are
// DERIVED here (dps = total_damage / clear_time, rates = gained / ref) and the verdict is sealed
// (`quality`, `issues`); the run `id` is carried verbatim from the raw (external_id continuity, so
// migrated/uploaded runs never duplicate). Typed const → `tsc --noEmit` enforces the shape.
import type { RunRecord } from "../run-types.js";

export const STRUCTURED_V1_EXAMPLE: RunRecord = {
  id: "1717799000-12345:7",
  ts: 1717800000,
  // Reader-owned session id, passed THROUGH by the converter verbatim (the reader is the session
  // authority — see progress.md "Identidade & sessão", which corrected the original "converter
  // mints session_id" idea). `id === sessionId:run` holds because both come from the raw unchanged.
  sessionId: "1717799000-12345",
  schemaVersion: 1, // the RAW/reader schema version this was converted from
  structuredSchemaVersion: 1, // the converter's own output version
  gameVersion: "1.00.10",
  run: 7,
  status: "success", // game outcome (from raw run_outcome)
  quality: "counted", // converter verdict
  stage: "3-9",
  act: 3,
  stageNo: 9,
  stageKey: 30901,
  mode: "Hell", // from difficulty enum 2 (reader EStageDifficulty: Normal=0/Nightmare=1/Hell=2/Torment=3)
  mobs: 118,
  totalMobs: 120,
  totalDamage: 4500000,
  dps: 50000, // 4500000 / 90
  clearTime: 90,
  duration: 92,
  goldGained: 125000,
  goldSource: "live",
  xpGained: 3400000,
  xpSource: "live",
  xpPerSec: 37777.78, // 3400000 / 90
  goldPerSec: 1388.89, // 125000 / 90
  partial: false,
  drops: [{ boxKey: 1, monsterType: 2 }],
  deaths: 0,
  revives: 0,
  issues: {},
  heroes: [
    {
      heroKey: 1001,
      class: "0x5",
      classId: 5,
      level: 80,
      exp: 1234567,
      items: [
        {
          slot: "weapon",
          slotId: 0,
          grade: "legendary",
          gradeId: 4,
          itemKey: 50012,
          uniqueId: "1099511627776123",
          level: 20,
          mods: [{ recipeId: 11, recipe: "atk", statId: 3, stat: "ATK", value: 1500, tier: 3 }],
        },
      ],
      skills: [{ key: 7001, lv: 5 }],
      skillLevels: { "7001": 5 },
      stats: { "0": 1500, "1": 320 },
      expStart: 1200000,
      expEnd: 1234567,
      xpGained: 34567,
      levelup: false,
      deaths: 0,
      revives: 0,
    },
  ],
};
