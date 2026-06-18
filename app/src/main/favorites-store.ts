// Favorite runs — a main-owned SIDECAR keyed by run id, NOT a field on the converter-sealed
// logs/<id>.json record (those are immutable: the converter writes them once and the read path
// never mutates them — runs-source app-normalization invariant). Mirrors the session-cuts.json /
// uploads.json pattern: a small JSON in the meter folder, read/written by main, exposed over IPC.
//
// A favorited run is EXEMPT from auto-clean (max-runs prune) AND from "clear all runs", so a user
// can pin the runs they care about and let everything else churn. The set is a list of run ids
// (the same `id` carried by RunIndexEntry / RunRecord — `ts` ms for v2, `session:run` for legacy).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveOutputDir } from "./settings.js";

/** Sidecar filename in the meter output dir (alongside session-cuts.json / uploads.json). */
export const FAVORITES_FILENAME = "favorites.json";

/** Bound the file so a runaway never grows settings/meter dir unboundedly. A user will pin a
 *  handful of runs, never thousands; the cap is a safety valve, not a product limit. */
export const MAX_FAVORITES = 2000;

// In-memory mirror so listIndex() projection (called on every reload) never hits the disk. Loaded
// once on init from the resolved dir; kept in sync on every toggle. Re-loaded when the dir changes.
let cache: Set<string> | null = null;
let cacheDir: string | null = null;

function favoritesPath(dir: string): string {
  return join(dir, FAVORITES_FILENAME);
}

/** Read the favorites set from disk. [] when absent/unreadable/malformed — never throws. */
function readFavorites(dir: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(favoritesPath(dir), "utf-8")) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string" && v !== ""));
  } catch {
    return new Set();
  }
}

/** Best-effort persist (never crash the app over a favorites write). The set is bounded at add time
 *  (toggleFavorite refuses past MAX_FAVORITES), so we persist it WHOLE — never silently `slice` the
 *  newest stars out of the file while the in-memory set keeps them (that diverged after a restart). */
function writeFavorites(dir: string, ids: Set<string>): void {
  try {
    writeFileSync(favoritesPath(dir), JSON.stringify([...ids]));
  } catch {
    // best effort
  }
}

/** Ensure the in-memory cache matches the currently-resolved output dir; reload on a dir change
 *  (e.g. the user pointed the meter at a different folder, or the RC vs stable variant). */
function ensureCache(): Set<string> {
  const dir = resolveOutputDir();
  if (cache === null || cacheDir !== dir) {
    cache = readFavorites(dir);
    cacheDir = dir;
  }
  return cache;
}

/** Drop the cache so the next read reloads from disk — called when the output dir is re-pointed. */
export function invalidateFavoritesCache(): void {
  cache = null;
  cacheDir = null;
}

/** The current favorite run-id set (a fresh copy so callers can't mutate the cache). */
export function getFavorites(): Set<string> {
  return new Set(ensureCache());
}

/** Whether a run id is favorited. */
export function isFavorite(id: string): boolean {
  return ensureCache().has(id);
}

/** Toggle a run's favorite flag; returns the NEW state (true = now favorited). No-op (returns the
 *  current state) for a non-string / empty id. At the MAX_FAVORITES cap an ADD is REFUSED — the
 *  function returns false (still not favorited) WITHOUT persisting, so the in-memory set and the
 *  file never diverge (the old silent `slice` dropped the newest star from disk only). The IPC
 *  handler returns this value, so the UI sees the click had no effect. Un-favoriting always works. */
export function toggleFavorite(id: unknown): boolean {
  if (typeof id !== "string" || id === "") return false;
  const favs = ensureCache();
  let now: boolean;
  if (favs.has(id)) {
    favs.delete(id);
    now = false;
  } else {
    if (favs.size >= MAX_FAVORITES) return false; // at the cap — refuse the add (no persist, no divergence)
    favs.add(id);
    now = true;
  }
  writeFavorites(resolveOutputDir(), favs);
  return now;
}

/** Drop favorite ids that no longer back a live run (a favorited run that was cleared by some other
 *  path). Called after a prune/clear so the sidecar never pins ids for runs that are gone. `liveIds`
 *  is the full set of run ids still on disk. Persists only when something changed. */
export function pruneFavorites(liveIds: ReadonlySet<string>): void {
  const favs = ensureCache();
  let changed = false;
  for (const id of favs) {
    if (!liveIds.has(id)) {
      favs.delete(id);
      changed = true;
    }
  }
  if (changed) writeFavorites(resolveOutputDir(), favs);
}
