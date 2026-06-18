import type { RunIndexEntry } from "../../../shared/ipc-types.js";
import { COUNT_FLOOR_SEC, ACT_BOSS_STAGE_NO } from "../../../shared/run-types.js";

// Pure helpers for the runs-list DISPLAY filter (PR6) — layer 3 of the 3-layer status model
// (progress.md "Status & filtro"): a LOCAL user preference that never touches the leaderboard.
//   layer 1 (recorded)  = every run, sealed by the converter — not configurable;
//   layer 2 (counts)    = the structural floor enforced in the converter + backend — not here;
//   layer 3 (this file) = what the user chooses to SEE in their own app.
// Extracted from the React view (like run-columns.ts) so the logic is trivially testable without a
// DOM. The view owns rendering; these decide visibility from settings + the run's verdict.
//
// The 15s floor is a SYSTEM rule, so it is the converter's constant (COUNT_FLOOR_SEC in
// shared/run-types.ts), NOT a setting — the user's `minDurationSec` is a preference CLAMPED to it
// (never below). x-10 (ACT_BOSS_STAGE_NO) is exempt from the duration gate, mirroring the converter.

/**
 * Clamp a user-entered minimum-duration to the valid range:
 *   - null  -> null (the filter is OFF);
 *   - a finite number -> at least the system floor (COUNT_FLOOR_SEC); a smaller value (incl. a
 *     stale persisted one, or 0) is raised to the floor — the user can never filter BELOW the floor,
 *     since runs under it never count anyway;
 *   - a non-finite / negative number -> null (treat garbage as "off").
 * The Settings control feeds its raw input through this before persisting, so settings.json can
 * never hold an out-of-range minimum.
 */
export function clampMinDuration(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return Math.max(value, COUNT_FLOOR_SEC);
}

/** The run's effective length for the duration gate: the OFFICIAL clear time when it cleared, else
 *  the measured wall-clock — the same notion the converter's floor uses (helpers.isSkipped), so the
 *  display filter and the count rule agree on "how long was this run". */
function runSeconds(run: Pick<RunIndexEntry, "duration" | "clearTime">): number {
  return Math.max(run.duration, run.clearTime > 0 ? run.clearTime : 0);
}

/** Whether a single run passes the display filter given the user's settings.
 *  - QUALITY: when `hideNonCounted`, only a `counted` run passes. A run with no verdict (a
 *    legacy-mirror log from before the converter, `quality` undefined) has no quality to gate on,
 *    so it falls back to the PRE-PR6 default — hide it unless it was a `success`. That preserves the
 *    old `status === "success"` table behaviour for the brief window before the boot ingest
 *    re-converts the mirror log (which then seals fail/abandoned as `skipped`). When off, quality
 *    never filters.
 *  - DURATION: when `minDurationSec` is set, a run shorter than it (clamped to the floor) is hidden
 *    — UNLESS it is x-10 (stageNo === ACT_BOSS_STAGE_NO), which is always exempt. */
export function passesRunFilter(
  run: Pick<RunIndexEntry, "quality" | "status" | "duration" | "clearTime" | "stageNo">,
  settings: { hideNonCounted: boolean; minDurationSec: number | null },
): boolean {
  if (settings.hideNonCounted) {
    if (run.quality !== undefined) {
      if (run.quality !== "counted") return false;
    } else if (run.status !== "success") {
      // Un-sealed legacy-mirror log: no quality verdict yet → fall back to the old success-only gate.
      return false;
    }
  }
  const min = clampMinDuration(settings.minDurationSec);
  if (min !== null && run.stageNo !== ACT_BOSS_STAGE_NO && runSeconds(run) < min) {
    return false;
  }
  return true;
}

/** Apply the display filter to a list, preserving order. */
export function applyRunFilter<
  T extends Pick<RunIndexEntry, "quality" | "status" | "duration" | "clearTime" | "stageNo">,
>(runs: T[], settings: { hideNonCounted: boolean; minDurationSec: number | null }): T[] {
  return runs.filter((r) => passesRunFilter(r, settings));
}

/** How many runs flipping the "show ignored" toggle would actually REVEAL: runs the QUALITY gate
 *  hides but the DURATION gate does NOT. Counting purely on the verdict would over-promise — a run
 *  that is both quality-hidden AND shorter than the user's minimum stays hidden after the toggle
 *  flips (the duration gate still hides it), so it must not inflate this count (never promise N then
 *  reveal fewer). A run with no verdict (legacy-mirror) is gated by the success fallback in
 *  passesRunFilter, which this reuses for an exact match with what flipping reveals. */
export function countQualityHidden(
  runs: Pick<RunIndexEntry, "quality" | "status" | "duration" | "clearTime" | "stageNo">[],
  settings: { hideNonCounted: boolean; minDurationSec: number | null },
): number {
  if (!settings.hideNonCounted) return 0;
  return runs.filter(
    (r) =>
      !passesRunFilter(r, settings) &&
      passesRunFilter(r, { hideNonCounted: false, minDurationSec: settings.minDurationSec }),
  ).length;
}
