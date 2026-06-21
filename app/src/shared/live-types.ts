// The RAW LIVE contract — what the reader (Python) overwrites into `live.json` ~1×/s while a run is
// active, and exactly what `live-source.ts` parses then COOKS into a `LiveSnapshot`. Mirrors the
// reader's `meter_windows.build_live_record` wire shape 1:1 (mixed casing — camel ids, snake metrics
// — is the reader's existing convention, kept here).
//
// Why raw (not the old cooked meter_live.txt): the redesign makes the reader a DUMB sensor for BOTH
// flows — the per-run record AND the live overlay. It emits raw numbers/ids; the APP cooks dps/stage
// label/mode using the SAME shared helpers the converter uses for a finished run (computeDps /
// resolveStage / modeName), so the overlay and the run record agree by construction — one formula, no
// Python↔TS drift.
//
// Unlike `raw/<id>.json` (the audited per-run record), live is EPHEMERAL — overwritten every tick,
// nothing persists. So there is NO envelope here (a field that did not resolve is just `null`, which
// the overlay omits) and NO `run_outcome` (live is always the run IN PROGRESS; the outcome only exists
// at close, in the per-run raw). The envelope's job — telling "couldn't read" from "real 0" so garbage
// never becomes permanent — does not apply to a value that is gone on the next tick.

/** The RAW live snapshot the reader writes to `live.json` (overwritten ~1×/s), schema-tagged with the
 *  same `raw_schema_version` as the per-run raw (the two flows share the reader's output version). */
export interface RawLive {
  /** Same version line as the per-run raw — bumps only when the reader's OUTPUT shape changes. */
  raw_schema_version: number;
  /** The reader's LOCAL run counter for the overlay "run #N" line (resets each launch; NOT the run
   *  identity — that's the end-ts in the per-run raw — nor the session, which the app derives). */
  run: number;
  // --- raw stage ids (the app formats "3-9" and resolves the localized mode name) ---
  stageKey: number | null;
  act: number | null;
  stageNo: number | null;
  /** Difficulty ENUM int (NOT the localized mode name — that resolves in the app, like the record). */
  difficulty: number | null;
  // --- raw live counters ---
  mobs: number;
  total_mobs: number | null;
  /** Total HP-delta damage so far this run (raw; the app derives dps = damage_now / elapsed with the
   *  SAME computeDps the run record uses). */
  damage_now: number;
  /** Wall-clock seconds since the run started (raw; the dps reference + the overlay's timer). */
  elapsed: number;
  /** Live gold gained so far this run (metric chain live→save). `null` when neither resolved — the
   *  overlay simply omits the line (never a misleading 0). */
  gold_now: number | null;
  /** Live xp gained so far this run. `null` when unresolved (omitted by the overlay). */
  xp_now: number | null;
  /** Live deployed hero keys (for the overlay's party frame). Empty = no party deployed. */
  party: number[];
  /** Live chest-drop counts by EMonsterLogType index: [common(0), stageBoss(1), actBoss(2)]. */
  drops: number[];
  /** Live FINAL_STATS per deployed hero — `{heroKey: {statId: value}}` (ids are JSON strings).
   *  ADDITIVE (no schema bump): an older reader omits it; the app detects it by presence and the
   *  per-hero resistance tooltip simply doesn't render. Empty `{}` = no live party. */
  party_stats?: Record<string, Record<string, number>>;
  /** Live per-hero LEVELING snapshot — `{heroKey: {level, exp, gain}}` (heroKey is a JSON string;
   *  `exp` is within-level so the app's "remaining" is curve[level]−exp; `gain` is the run's
   *  accumulated xp, from which the app derives the live rate). ADDITIVE (no schema bump): an older
   *  reader omits it; the app detects it by presence and the time-to-level chip simply doesn't render.
   *  Empty `{}` = no live party. Powers the overlay's "time to next level". */
  party_progress?: Record<string, { level: number; exp: number; gain: number }>;
}
