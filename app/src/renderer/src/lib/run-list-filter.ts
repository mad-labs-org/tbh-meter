import type { RunIndexEntry } from "../../../shared/ipc-types.js";
import type { RunStatus } from "../../../shared/run-types.js";

// Pure logic for the runs-list INTERACTIVE filter bar + sort (Feature 4). This is layer-4 of the
// status model: an ad-hoc, LOCAL, NON-persisted view the user drives from a popover — distinct from
// the layer-3 display PREFERENCES in run-filter.ts (hide-non-counted / min-duration), which still
// apply FIRST and are unchanged. The view passes the already-display-filtered list through these.
//
// The user's ask (Discord): "filter the logs by stage when I click the divisions, and find the
// phases where I earned the most EXP/Gold/dealt the most damage/had the most DPS". So we offer:
//   - faceted filters: stage, mode, status/quality, favorites-only;
//   - sort by any metric column (xp / gold / dps / damage / duration / clear-time / date), so the
//     user can rank runs and see where a metric peaked (the "find where I earned most" ask).
// Extracted from the React view (house pattern, like run-filter.ts / run-columns.ts) so the rules
// are unit-tested without a DOM; the view only renders + holds the state.

/** The interactive filter state. Empty/null fields mean "no constraint". Held as LOCAL UI state in
 *  the view (not persisted) — a transient lens over the list, reset on its own control. */
export interface RunListFilter {
  /** Exact stage label (RunIndexEntry.stage, e.g. "3-9"); null = any stage. */
  stage: string | null;
  /** Exact mode/difficulty (RunIndexEntry.mode, e.g. "Normal"); null = any mode. */
  mode: string | null;
  /** Run status (success / fail / abandoned); null = any status. */
  status: RunStatus | null;
  /** When true, only favorited runs pass (Feature 3). */
  favoritesOnly: boolean;
}

/** The metrics the list can sort by. Keys mirror RunIndexEntry numeric fields + `date` (ts). */
export type SortKey =
  | "date"
  | "xpGained"
  | "goldGained"
  | "dps"
  | "totalDamage"
  | "xpPerSec"
  | "goldPerSec"
  | "duration"
  | "clearTime";

export type SortDir = "asc" | "desc";

export interface RunSort {
  key: SortKey;
  dir: SortDir;
}

/** The default sort = newest-first by date (the list's historical behaviour). */
export const DEFAULT_SORT: RunSort = { key: "date", dir: "desc" };

/** An empty filter (the default lens — everything passes). */
export const EMPTY_FILTER: RunListFilter = {
  stage: null,
  mode: null,
  status: null,
  favoritesOnly: false,
};

/** True when no constraint is active (used to hide the "clear filters" affordance / count badge). */
export function isFilterActive(f: RunListFilter): boolean {
  return f.stage !== null || f.mode !== null || f.status !== null || f.favoritesOnly;
}

/** Whether a single run passes the interactive filter. */
export function passesListFilter(run: RunIndexEntry, f: RunListFilter): boolean {
  if (f.stage !== null && run.stage !== f.stage) return false;
  if (f.mode !== null && run.mode !== f.mode) return false;
  if (f.status !== null && run.status !== f.status) return false;
  if (f.favoritesOnly && !run.favorite) return false;
  return true;
}

/** The numeric value a SortKey reads off a run (`date` -> ts). Always a finite number. */
function sortValue(run: RunIndexEntry, key: SortKey): number {
  const v = key === "date" ? run.ts : run[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Filter + sort a run list (pure; returns a new array, never mutates the input). Sort is stable on
 * ties via the run id, so equal-metric runs keep a deterministic order across re-renders. `desc`
 * (the default for every metric) puts the biggest value first — exactly the "where did I earn the
 * most EXP/Gold/DPS" view the user asked for.
 */
export function filterAndSortRuns(
  runs: RunIndexEntry[],
  filter: RunListFilter,
  sort: RunSort,
): RunIndexEntry[] {
  const filtered = runs.filter((r) => passesListFilter(r, filter));
  const factor = sort.dir === "desc" ? -1 : 1;
  return filtered.sort((a, b) => {
    const diff = sortValue(a, sort.key) - sortValue(b, sort.key);
    if (diff !== 0) return factor * diff;
    // Stable tiebreak: id ascending (deterministic regardless of sort dir).
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The distinct stage labels present in the list, in first-seen order (newest-first input → newest
 *  stage first). Feeds the stage filter dropdown so it only offers stages the user actually ran. */
export function distinctStages(runs: RunIndexEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of runs) {
    if (r.stage && r.stage !== "?" && !seen.has(r.stage)) {
      seen.add(r.stage);
      out.push(r.stage);
    }
  }
  return out;
}

/** The distinct modes/difficulties present in the list, in first-seen order. */
export function distinctModes(runs: RunIndexEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of runs) {
    if (r.mode && r.mode !== "?" && !seen.has(r.mode)) {
      seen.add(r.mode);
      out.push(r.mode);
    }
  }
  return out;
}
