// Pure derivation helpers shared by the converter (this PR) and the live overlay (PR5).
// Single source of every number/string the app DERIVES from the reader's raw observation —
// so a run record and the live snapshot compute dps/stage/mode the SAME way (one formula,
// no Python↔TS drift once PR5 lands). NO I/O, NO memory reads, NO catalog lookups: ids in,
// derived primitives out. Name resolution (hero/item/skill, localized) stays at render.

import type { RunStatus, RunQuality } from "../../shared/run-types.js";
import { COUNT_FLOOR_SEC, ACT_BOSS_STAGE_NO } from "../../shared/run-types.js";

// Re-export the system-rule constants so the converter (and its tests) keep importing them from
// here, while their single source of truth lives in shared/run-types.ts — shared because PR6's
// renderer-side duration filter must clamp to the SAME floor and the renderer can't import main.
export { COUNT_FLOOR_SEC, ACT_BOSS_STAGE_NO };

/** Difficulty enum int -> the display "mode" name. Mirrors the reader's EStageDifficulty
 *  (`config/offsets.py`: Normal=0, Nightmare=1, Hell=2, Torment=3) and DIFF_NAMES. The localized
 *  name is a TRANSITIONAL label the structured record still carries (the renderer reads
 *  `RunRecord.mode` today); resolving it from the id at render is a future schema bump
 *  (data-contract-id-based). `null`/unknown -> "?". */
const MODE_NAMES: Record<number, string> = {
  0: "Normal",
  1: "Nightmare",
  2: "Hell",
  3: "Torment",
};

export function modeName(difficulty: number | null): string {
  if (difficulty == null) return "?";
  return MODE_NAMES[difficulty] ?? "?";
}

/** Stage label "act-stageNo" (e.g. "3-9"). This is TRIVIAL display formatting of two raw
 *  numbers — NOT a catalog name — so it lives here, not at render. "?" for either side missing,
 *  so the UI never shows "null-null". */
export function resolveStage(act: number | null, stageNo: number | null): string {
  if (act == null || stageNo == null) return "?";
  return `${act}-${stageNo}`;
}

/** dps = totalDamage / reference-seconds. The reference is the OFFICIAL clear time when the run
 *  cleared (`clearTime > 0`), else the measured wall-clock `duration` (floored at 1s so a sub-second
 *  or zero duration can't divide-by-zero or explode). Mirrors the reader's old summary formula
 *  (`ref = clear_time if clear_time else max(measured, 1)`), now the app's single source. Returns
 *  0 for non-finite/negative damage (defensive — never NaN/Infinity into the record). */
export function computeDps(totalDamage: number, clearTime: number, duration: number): number {
  if (!Number.isFinite(totalDamage) || totalDamage <= 0) return 0;
  const ref = clearTime > 0 ? clearTime : Math.max(duration, 1);
  if (!Number.isFinite(ref) || ref <= 0) return 0;
  return totalDamage / ref;
}

/** A per-second rate (gold/sec, xp/sec) = gained / reference-seconds, same reference choice as
 *  computeDps so every rate on a run agrees. 0 for non-finite/negative input (a `gained` that
 *  came from a failed read is recorded as an issue and passed here as 0). */
export function computeRate(gained: number, clearTime: number, duration: number): number {
  if (!Number.isFinite(gained) || gained <= 0) return 0;
  const ref = clearTime > 0 ? clearTime : Math.max(duration, 1);
  if (!Number.isFinite(ref) || ref <= 0) return 0;
  return gained / ref;
}

/** Round to `digits` decimals (matches the fixtures' xpPerSec/goldPerSec precision). Defensive:
 *  a non-finite value rounds to 0 so it can't poison the record. */
export function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

// --------------------------------------------------------------------------- //
// Quality verdict — the SYSTEM rule (not a user setting) that decides whether a run counts.
// Shared by convert() (new raws) and convertLegacy() (migrated runs.jsonl) so both seal a run by
// the SAME rule. A non-tunable constant set, versioned with the converter output (the user-facing
// display filter lives in settings.ts, PR6 — never conflate the two).
// --------------------------------------------------------------------------- //

/** Minimum fraction of the official clear time the meter must have captured for a `success` to count:
 *  below this it joined too late and the totals are undercounts. MUST stay in sync with the reader's
 *  `meter_windows.PARTIAL_CAPTURE_MIN` (same number on both sides — see run-lifecycle). */
const PARTIAL_CAPTURE_MIN = 0.95;

/** PARTIAL capture: the meter joined a run already in progress, so its totals are under-counted.
 *  Ported verbatim from the reader's `_is_partial` (now the converter's spec, run-lifecycle): a
 *  `success` run is partial when it captured < 95% of the official clear time (guarded at
 *  clear_time >= 30 so a legitimately-short x-10 boss run is never mis-flagged) OR — the exception —
 *  a success with NON-POSITIVE damage, which is ALWAYS a lost capture (the game never clears a stage
 *  with no damage; covers the short x-10 case the first clause skips, #163). Note `<= 0`, not `== 0`.
 *  Only meaningful for `success`; fail/abandoned are never "partial". */
export function isPartial(
  status: RunStatus,
  clearTime: number,
  duration: number,
  totalDamage: number,
): boolean {
  if (status !== "success") return false;
  return (clearTime >= 30 && duration < clearTime * PARTIAL_CAPTURE_MIN) || totalDamage <= 0;
}

/** SKIP: the run is real but does not count — below the duration floor (and not x-10). The reader
 *  historically returned early (`_should_skip_run`); now it emits every run and the converter SEALS
 *  the verdict instead of hiding it (skip != vanish). `stageNo === 10` is the x-10 exemption. */
export function isSkipped(stageNo: number | null, clearTime: number, duration: number): boolean {
  if (stageNo === ACT_BOSS_STAGE_NO) return false;
  return Math.max(duration, clearTime > 0 ? clearTime : 0) < COUNT_FLOOR_SEC;
}

/** Seal the quality verdict by fixed precedence: degraded (a critical field was unreadable / the
 *  run is corrupt) > partial (under-counted capture) > skipped (below the floor, or not a clean
 *  success) > counted. A run is NEVER deleted by this — every verdict still yields a record the user
 *  sees, marked and filterable. `degraded` is passed in (the caller
 *  knows whether a critical read failed — an envelope error for new raws, or the gold:0+mode:"?"
 *  signature for migrated legacy runs). */
export function classifyQuality(args: {
  status: RunStatus;
  stageNo: number | null;
  clearTime: number;
  duration: number;
  totalDamage: number;
  degraded: boolean;
}): { quality: RunQuality; partial: boolean } {
  const partial = isPartial(args.status, args.clearTime, args.duration, args.totalDamage);
  let quality: RunQuality;
  if (args.degraded) {
    quality = "degraded";
  } else if (partial) {
    quality = "partial";
  } else if (args.status !== "success" || isSkipped(args.stageNo, args.clearTime, args.duration)) {
    quality = "skipped";
  } else {
    quality = "counted";
  }
  return { quality, partial };
}
