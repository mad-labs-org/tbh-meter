// The RAW contract — what the reader (Python) writes per finished run into `raw/<id>.json`,
// and exactly what the converter (PR3) parses. One file per run; keys mirror the reader's
// `meter_windows.close_run` wire shape 1:1 (mixed casing — camel ids, snake metrics — is the
// reader's existing output; the converter normalises it into the structured `RunRecord`).
//
// Why the envelope: every DATA field comes from a memory read that CAN fail (game closed,
// address moved, class unresolved). Writing a bare `0`/`"?"` makes "couldn't read" look
// identical to a real zero — that ambiguity is what made the 1.00.10 `gold:0` bug permanent.
// So each observed field is wrapped in `Field<T>`; the converter unwraps it and records the
// failures in `issues` instead of silently trusting garbage. Structural metadata
// (raw_schema_version, id, ts, run, run_outcome, session) stays plain — if it's missing there
// is no record at all. Mirrors `reader/shared/envelope.py`.

/** Result/Either envelope for a single observed field. `ok:true` carries the read value
 *  (including a legitimate `null` or `0`); `ok:false` carries a short failure reason. */
export type Field<T> = { ok: true; value: T } | { ok: false; error: string };

/** The game outcome the reader observed (mirrors `close_run` `status`; renamed to
 *  `run_outcome` on the wire per the design). NOT enveloped — always known when a run closes. */
export type RunOutcome = "success" | "fail" | "abandoned";

/** Which fallback in the metric chain produced the value (only meaningful when the matching
 *  `*_gained` field is `ok:true`): `live` = real-time memory read, `save` = delayed save-file
 *  delta. The "couldn't read at all" case is expressed by `*_gained` being `ok:false`. */
export type MetricSource = "live" | "save";

/** A chest that dropped during the run (id-based: marks the drop, not the open). Snake_case keys
 *  mirror the reader's `R["drops"]` wire shape (the converter reads `box_key`/`monster_type`). */
export interface RawDrop {
  box_key: number;
  monster_type: number;
}

/** An item mod. `recipeId`/`statId` are the identity; `recipe`/`stat` are transitional labels
 *  the reader still emits (id-based contract: removing them is a future schema bump). */
export interface RawMod {
  recipeId: number | null;
  recipe: string;
  statId: number | null;
  stat: string;
  value: number | null;
  tier: number | null;
}

/** An equipped item. `itemKey` = type id; `uniqueId` = per-instance natural key. */
export interface RawItem {
  slot: string;
  slotId: number | null;
  grade: string;
  gradeId: number | null;
  itemKey: number | null;
  /** u64 per-instance natural key, emitted by the reader as a STRING (PR2: `str(uid)`) — lossless
   *  past 2^53, where a JSON number would mangle. (The app currently works around the number form
   *  in `normalizeItem`; v1 makes the lossless string the contract.) */
  uniqueId: string;
  level: number | null;
  mods: RawMod[];
}

/** A hero skill: `key` = skill/attribute key; `lv` = invested level (null when unknown). */
export interface RawSkill {
  key: number;
  lv: number | null;
}

/** One deployed hero, as read from the live party + save. Fields are plain (a hero present in
 *  the `heroes` array was read successfully); identity is `heroKey`/`classId` (the `class` hex
 *  string is a transitional label — the render layer resolves the localized name from the id). */
export interface RawHero {
  heroKey: number;
  classId: number | null;
  class: string;
  /** 0-based party slot (0/1/2 = the three visible slots). The reader emits it ONLY when the
   *  slot is known; absent/null = unknown (legacy raw or unresolved) — never synthesized here. */
  slot?: number | null;
  level: number | null;
  exp: number | null;
  items: RawItem[];
  skills: RawSkill[];
  skillLevels?: Record<string, number>;
  stats: Record<string, number>;
  exp_start?: number | null;
  exp_end?: number | null;
  xp_gained?: number | null;
  levelup?: boolean;
  died?: boolean;
  deaths?: number;
  revives?: number;
  killed_by?: number[];
}

/** A rune node from the account-wide rune tree (`PlayerSaveData.RUNES`). `key` matches
 *  `data/runes.json` (→ `statType`/`value` per level), so the wiki derives the effect from
 *  `key`+`level` — e.g. real drop chance (`DropChance*` runes) and the −1-wave correction
 *  (`WaveCountReduction`, key 1171). */
export interface RawRune {
  key: number;
  level: number;
}

/** An item in the per-run account snapshot (inventory/stash). Id-only BY DESIGN — unlike the
 *  equipped `RawItem` it carries NO transitional `slot`/`grade` string labels; the render layer
 *  resolves the localized name from `itemKey`. */
export interface RawSnapshotItem {
  itemKey: number | null;
  /** u64 per-instance natural key as a STRING (lossless past 2^53), same as `RawItem.uniqueId`. */
  uniqueId: string;
  slotId: number | null;
  gradeId: number | null;
  level: number | null;
  mods: RawMod[];
}

/** The observed DATA fields — each enveloped because it comes from a memory read that CAN fail.
 *  Identical across raw schema versions; only the structural header (id/ts/session) differs, so
 *  v1 and v2 both extend this instead of duplicating the 14 fields. */
export interface RawObserved {
  stageKey: Field<number | null>;
  act: Field<number | null>;
  stageNo: Field<number | null>;
  /** Difficulty ENUM int (the localized "mode" name is resolved at render, not here). */
  difficulty: Field<number | null>;
  /** Total mobs for the stage (catalog-derived; carried so the converter need not read it). */
  total_mobs: Field<number | null>;
  /** Mobs killed this run. */
  mobs: Field<number>;
  total_damage: Field<number>;
  /** Official clear time in SECONDS (success runs; 0 / not-applicable otherwise). */
  clear_time: Field<number>;
  gold_gained: Field<number>;
  gold_source: MetricSource;
  xp_gained: Field<number>;
  xp_source: MetricSource;
  drops: Field<RawDrop[]>;
  heroes: Field<RawHero[]>;
}

/** The RAW record the reader wrote per finished run, schema **v1** (LEGACY). Identity is built from
 *  the reader's session + per-session counter (`id = "<session_id>:<run>"`, `ts` in SECONDS). Kept so
 *  the converter still parses pre-v2 raws; v2 (below) is what the reader emits going forward. The
 *  `run_num`-reset bug (id collision across reader restarts) lived in this scheme — see "Redesign 2". */
export interface RawRun extends RawObserved {
  /** Bumps ONLY when the reader's output SHAPE changes — never on a game re-seed/address shift. */
  raw_schema_version: 1;
  /** Canonical run identity, `"<session_id>:<run>"` — equals the upload `external_id` verbatim
   *  (migration preserves it so uploaded runs never re-dup). NOTE: the raw FILE is
   *  `raw/<session_id>-<run>.json` (`:` → `-`, invalid in Windows filenames). */
  id: string;
  /** Unix SECONDS when the run closed. */
  ts: number;
  /** Run sequence within the session (resets to 1 when a new session starts). */
  run: number;
  run_outcome: RunOutcome;
  /** Reader-minted session id (string). v1 only — v2 drops it (session is app-derived). */
  session_id: string;
  game_version: string;
  /** Measured wall-clock seconds (the reader always knows this — not a memory read). */
  duration: number;
}

/** The RAW record the reader writes per finished run, schema **v2** (Redesign 2). The run's IDENTITY
 *  is its own end-timestamp — NOT a session+counter — so it can't collide across reader restarts (the
 *  `run_num`-reset bug class is gone). No `session_id`, no `run`: the session is DERIVED by the app
 *  from the run timestamps (6h gap + manual cuts), never part of the id. */
export interface RawRunV2 extends RawObserved {
  raw_schema_version: 2;
  /** Canonical run identity = the run's end timestamp in MILLISECONDS, as a string (e.g.
   *  "1717800000123"). Unique per machine (stage-plays are sequential → no two share a ms); no
   *  session, no counter. Upload `external_id` = `<device-id>:<id>` (added app-side at upload). */
  id: string;
  /** Unix MILLISECONDS when the run closed (v1 was seconds). Also the basis of `id`. The UI shows
   *  seconds via a `toSeconds` helper — ms is stored only so the id is collision-proof. */
  ts: number;
  run_outcome: RunOutcome;
  game_version: string;
  /** Measured wall-clock SECONDS (a duration, not a timestamp — stays seconds; only `ts` is ms). */
  duration: number;

  // --- per-run account snapshot (enveloped; SAVE-sourced, written EVERY run since the snapshot PR) ---
  // ⚠ EXPERIMENTAL — the reader EMITS these, but the converter does NOT yet consume them: they never
  // reach `logs/`, the structured `RunRecord`, the leaderboard, or upload. Safe to READ straight from
  // raw; NOT yet validated end-to-end downstream (treat as best-effort vs the battle-tested fields
  // above). v2-ONLY (v1 is frozen legacy — no shipped v1 reader ever wrote them) and OPTIONAL only
  // because v2 raw written BEFORE the snapshot PR lacks them — a consumer must tolerate `undefined`
  // (a NEW raw always has them). Captured now (can't be back-filled) to unlock wiki features: real
  // drop chance (boxDrops base × `DropChance` rune) and the −1-wave correction.
  /** Account-wide rune tree at run close (`key`→`level`). */
  runes?: Field<RawRune[]>;
  /** Items in inventory slots at run close (SAVE snapshot, id-only). */
  inventory?: Field<RawSnapshotItem[]>;
  /** Items in stash slots at run close — separate from inventory. */
  stash?: Field<RawSnapshotItem[]>;
}

/** Either raw schema the converter may encounter; it dispatches on `raw_schema_version`. */
export type AnyRawRun = RawRun | RawRunV2;
