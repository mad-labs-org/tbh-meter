// Auto-clean prune — PURE selection logic for the max-runs cap (no I/O). The impure caller
// (runs-store.pruneToMaxRuns) feeds in the live run index + the favorite set and deletes whatever
// this returns. Kept separate so the cap/favorite/oldest-first rules are unit-tested in isolation.
//
// Cap SEMANTICS (documented choice): the cap counts ONLY non-favorited runs. Favorited runs are
// NEVER deleted and never count toward the cap, so a user who pins 600 runs and sets a cap of 500
// keeps all 600 favorites PLUS up to 500 non-favorites. This is the simpler, consistent rule —
// "keep my newest N ordinary runs, plus everything I starred" — and it can never delete a favorite.

// clampMaxRuns + MIN_MAX_RUNS live in shared/ipc-types so the renderer's Settings control and this
// main-process selector use ONE definition (re-exported here for the existing import sites).
export { clampMaxRuns, MIN_MAX_RUNS } from "../shared/ipc-types.js";

/** A run as the prune selector needs to see it: its identity + age. Newest-first is NOT assumed —
 *  the selector sorts by `ts` itself, so it is robust to whatever order the caller passes. */
export interface PrunableRun {
  id: string;
  ts: number;
}

/**
 * Select the run ids to DELETE so that at most `cap` non-favorited runs remain, deleting the
 * OLDEST non-favorited runs first. Favorited runs are always kept and never counted.
 *
 *  - cap null  -> [] (unlimited).
 *  - favorites (id in `favorites`) are filtered out of the candidate set entirely.
 *  - of the non-favorited runs, keep the `cap` NEWEST (by ts desc, id as a stable tiebreaker) and
 *    return the rest (the oldest) as the delete set.
 *
 * Pure + deterministic: same inputs -> same delete set, in oldest-first order.
 */
export function selectRunsToPrune(
  runs: PrunableRun[],
  cap: number | null,
  favorites: ReadonlySet<string>,
): string[] {
  if (cap == null) return [];
  const nonFav = runs.filter((r) => !favorites.has(r.id));
  if (nonFav.length <= cap) return [];
  // Newest-first so slicing off the tail drops the oldest. ts desc; id desc as a stable tiebreaker.
  const sorted = [...nonFav].sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  // Everything past the cap is the oldest surplus → delete. Return oldest-first (ascending ts).
  return sorted
    .slice(cap)
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => r.id);
}
