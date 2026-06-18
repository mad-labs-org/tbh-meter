// Thin facade over the RunsSource singleton. Since PR4 the app READS the converted structured
// records under `logs/` (produced once by the converter/Ingestor, PR3) — there is no per-file
// userData storage or pruning, and no re-normalization on read.
import type { RunRecord } from "../shared/run-types.js";
import type { RunIndexEntry } from "../shared/ipc-types.js";
import { getRunsSource, type RunsSource } from "./sources/runs-source.js";
import {
  clearRawArchive,
  clearLegacyRuns,
  deleteRunFiles,
  removeLegacyLines,
} from "./logs-archive.js";
import { getFavorites, pruneFavorites } from "./favorites-store.js";
import { getSettings } from "./settings.js";
import { clampMaxRuns, selectRunsToPrune } from "./prune.js";

export function runsSource(): RunsSource {
  return getRunsSource();
}

export function listRuns(): RunIndexEntry[] {
  return getRunsSource().listIndex();
}

export function getRun(id: string): RunRecord | null {
  return getRunsSource().getById(id);
}

/** Local-only wipe of EVERY local run source EXCEPT favorited runs, so a cleared run can never be
 *  resurrected by the next ingest pass (favorites are kept on purpose — Feature 3):
 *   - logs/ (RunsSource.clearFile / per-id deleteRunFiles) — the app's read source;
 *   - raw/ — else the Ingestor re-converts each orphaned raw back into logs/;
 *   - runs.jsonl — else the Ingestor re-migrates each legacy line back into logs/.
 *  uploads.json (the share/dedup record) is kept — leaderboard entries live on the server, and the
 *  dedup index must survive so re-finished runs don't re-upload.
 *
 *  No favorites → the fast bulk wipe (preserves the legacy-clean fast path in the Ingestor). With
 *  favorites → delete every NON-favorited run id by hand and keep the favorites' files intact. */
export function clearAllRuns(): boolean {
  const favorites = getFavorites();
  if (favorites.size === 0) {
    // Fast path (unchanged): wipe all three sources wholesale.
    const ok = getRunsSource().clearFile();
    clearRawArchive();
    clearLegacyRuns();
    return ok;
  }
  // Favorites present: delete only the non-favorited runs, sparing the starred ones' logs/raw.
  const all = getRunsSource().all();
  const deletedIds = new Set(all.filter((r) => !favorites.has(r.id)).map((r) => r.id));
  deleteRunFiles(deletedIds); // ONE directory pass for the whole set (B1)
  // Blank the matching legacy-mirror lines in place so the Ingestor can't re-migrate a deleted run.
  removeLegacyLines(deletedIds);
  // Reload so the UI reflects the deletions immediately, then drop any favorite ids whose run is
  // somehow gone (defensive — favorites were spared, so normally none).
  getRunsSource().reloadNow();
  pruneFavorites(new Set(getRunsSource().all().map((r) => r.id)));
  return true;
}

/**
 * Auto-clean (Feature 2): if a max-runs cap is set, delete the OLDEST non-favorited runs until at
 * most `cap` non-favorited runs remain. Favorited runs are never deleted and never counted (see
 * prune.ts for the documented cap semantic). Best-effort + idempotent: under the cap → no-op.
 * Triggers a reload so the runs list updates. Returns the number of runs deleted.
 */
export function pruneToMaxRuns(): number {
  const cap = clampMaxRuns(getSettings().maxRuns);
  if (cap == null) return 0;
  const all = getRunsSource().all();
  const ids = selectRunsToPrune(
    all.map((r) => ({ id: r.id, ts: r.ts })),
    cap,
    getFavorites(),
  );
  if (ids.length === 0) return 0;
  const idSet = new Set(ids);
  deleteRunFiles(idSet); // ONE directory pass for the whole set (B1)
  removeLegacyLines(idSet);
  getRunsSource().reloadNow();
  return ids.length;
}
