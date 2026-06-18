import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveOutputDir } from "./settings.js";

// The meter keeps ONE folder (the visible meter folder under the user's home) with a logs/
// subfolder holding ONE structured JSON per run. Since the redesign (PR2/PR3) the reader writes
// raw/<id>.json and the CONVERTER (converter/ingest.ts) owns the logs/ writes — this module no
// longer mirrors runs.jsonl into logs/ (that write role is retired). PR4 makes the app READ from
// logs/. This module now provides only the shared directory helpers (dataDir/logsDir/rawDir) plus
// the raw/ + legacy-runs.jsonl clears (clearRawArchive/clearLegacyRuns) for "clear run history";
// the logs/ clear itself lives in RunsSource.clearFile() (which also reloads the in-memory list).

export function dataDir(): string {
  return resolveOutputDir();
}

export function logsDir(): string {
  return join(dataDir(), "logs");
}

export function rawDir(): string {
  return join(dataDir(), "raw");
}

/** Delete every .json in `dir` (best-effort; never crashes the app over a delete). */
function clearJsonDir(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // dir missing — nothing to clear
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      rmSync(join(dir, name));
    } catch {
      // best effort — never crash the app over a delete
    }
  }
}

/** Delete the reader's raw/<id>.json files. MUST run with the logs/ wipe on a history wipe: the
 *  Ingestor (converter/ingest.ts) treats any raw/ with no log as "convert this", so a raw left
 *  behind after a clear would be re-converted straight back into logs/ on the next boot/new-run pass
 *  — resurrecting a run the user cleared (the PR3 wiring made the Ingestor own logs/, so the wipe
 *  must reach the raw source too). */
export function clearRawArchive(): void {
  clearJsonDir(rawDir());
}

/** Best-effort rm a single path (never throws). */
function rmIfExists(path: string): void {
  try {
    rmSync(path);
  } catch {
    // best effort — already gone, or a transient error; never crash a prune over one file
  }
}

/** Filesystem-safe stem of a run id in a logs filename (`<ts>_<safeId>.json`). MUST mirror
 *  converter/ingest.logsFileName so the two never disagree on a file's name. */
function safeLogId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * Delete EVERY on-disk source for a BATCH of run ids in ONE directory pass, so pruned/cleared runs
 * can never be resurrected by the next ingest pass (the SAME resurrection logic clearAllRuns
 * guards). Batch-shaped on purpose (B1): the old per-id form re-read+parsed the whole logs/ dir per
 * id, so lowering a 3k cap to 500 meant ~2,500 full-directory parse passes inside a sync IPC handler
 * (multi-minute freeze). Here:
 *   - logs/ — ONE readdir; pre-filter candidates by the `_<safeId>.json` suffix (filename embeds
 *     `<ts>_<safeId>`, converter/ingest.logsFileName), then parse ONLY those candidates to CONFIRM
 *     the embedded id. The parse-confirm is mandatory — distinct ids can share a safeId (the regex
 *     maps several chars to '-'), so a filename match alone could delete the wrong run.
 *   - raw/<stem>.json — the converter's source; without removing it the Ingestor re-converts the
 *     orphaned raw straight back into logs/. Reader names raw `raw/<id-with-':'->'-'>.json`, so the
 *     stem mirrors runs-source.requestReconvert: `id.replace(/:/g,'-')`. (A v2 id has no ':', so the
 *     stem is just `<id>.json`; a phantom-deduped duplicate log shares the id, so its raw — if any —
 *     uses the same stem and is covered.)
 * The legacy runs.jsonl lines are handled by removeLegacyLines (caller passes the same id set).
 * Returns the number of ids for which at least one file was removed.
 */
export function deleteRunFiles(ids: ReadonlySet<string>): number {
  if (ids.size === 0) return 0;
  // Candidate logs filename suffixes -> the id that produced them. safeId is not injective, so two
  // ids could map to one suffix; we still parse-confirm each candidate file's embedded id below.
  const suffixToIds = new Map<string, Set<string>>();
  for (const id of ids) {
    const suffix = `_${safeLogId(id)}.json`;
    let set = suffixToIds.get(suffix);
    if (!set) {
      set = new Set();
      suffixToIds.set(suffix, set);
    }
    set.add(id);
  }
  const removedIds = new Set<string>();

  // logs/: ONE readdir, then parse only the suffix-matching candidates to confirm the embedded id.
  const logs = logsDir();
  let names: string[] = [];
  try {
    names = readdirSync(logs);
  } catch {
    // logs dir missing — nothing to delete there
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    // Cheap pre-filter: the `<ts>` stem never contains '_', so the filename's FIRST '_' starts the
    // exact `_<safeId>.json` tail (safeId itself may contain '_') — one Map.get, no per-id scan.
    const sep = name.indexOf("_");
    if (sep < 0) continue;
    const candidates = suffixToIds.get(name.slice(sep));
    if (!candidates) continue;
    const path = join(logs, name);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as { id?: unknown };
      // Parse-confirm: only delete when the file's EMBEDDED id is actually in the target set (guards
      // a safeId collision — a different run whose id sanitizes to the same suffix).
      if (parsed && typeof parsed.id === "string" && candidates.has(parsed.id)) {
        rmIfExists(path);
        removedIds.add(parsed.id);
      }
    } catch {
      // unreadable/corrupt — skip (a corrupt file isn't a target run)
    }
  }

  // raw/: deterministic stem per id (no scan needed). Remove so the Ingestor can't re-convert it.
  const raw = rawDir();
  for (const id of ids) {
    const rawPath = join(raw, `${id.replace(/:/g, "-")}.json`);
    if (existsSync(rawPath)) {
      rmIfExists(rawPath);
      removedIds.add(id);
    }
  }
  return removedIds.size;
}

/**
 * Blank out (NOT remove) the legacy runs.jsonl lines whose run id is in `deletedIds`, so a
 * pruned/cleared legacy-mirror run can't be re-migrated from runs.jsonl on the next boot.
 *
 * B2 — preserve line indices: convertLegacy derives the id of a RUN-LESS line from its LINE INDEX
 * (`idx:<lineIndex>`, converter/legacy.ts → runs-source.normalizeRecord). DROPPING a line would
 * shift every later id-less line's index → its identity changes → it re-migrates as a DUPLICATE
 * run. So we REPLACE a removed line with an empty string in place (both the migrator and our matcher
 * already skip blank lines), keeping every surviving line at its original index. We resolve the id
 * the SAME way the converter does, INCLUDING the `idx:<i>` form for run-less lines — so a pruned
 * `idx:N` run is blanked too (the old "keep id===null lines" path resurrected those outright).
 *
 * Best-effort + idempotent: a file with no matching lines is left untouched. No-op when `deletedIds`
 * is empty or the file is absent (the common v2-only case — favorites/prune touch raw+logs, the
 * frozen runs.jsonl is migration-only).
 */
export function removeLegacyLines(deletedIds: ReadonlySet<string>): void {
  if (deletedIds.size === 0) return;
  const path = join(dataDir(), "runs.jsonl");
  if (!existsSync(path)) return;
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  const lines = text.split(/\r?\n/);
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue; // already blank/comment — leave as-is
    let id: string;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : "";
      const hasRun = typeof parsed.run === "number" && Number.isFinite(parsed.run);
      // EXACT mirror of normalizeRecord's id derivation (runs-source.ts): run -> session:run,
      // otherwise the index-based `idx:<i>` (which is what the migrator will reproduce).
      id = hasRun ? `${sessionId !== "" ? sessionId : "noSession"}:${parsed.run as number}` : `idx:${i}`;
    } catch {
      continue; // un-parseable — keep it (don't blank data we can't identify)
    }
    if (deletedIds.has(id)) {
      lines[i] = ""; // blank in place: preserves every later line's index (so idx: ids are stable)
      changed = true;
    }
  }
  if (!changed) return;
  try {
    writeFileSync(path, lines.join("\n"));
  } catch {
    // best effort — a failed rewrite leaves the (still-correct) original; next boot retries
  }
}

/** Truncate the legacy `runs.jsonl`. ALSO required on a history wipe: the Ingestor MIGRATES any
 *  legacy line that has no up-to-date log into logs/, so a runs.jsonl left intact after the logs/ +
 *  raw/ wipe would re-migrate every cleared run on the next boot — the SAME resurrection the raw/
 *  wipe guards, via the legacy path (runs.jsonl is normally kept as a one-time-migrated backup, but
 *  an explicit user "clear history" wipes every local source). Best-effort. */
export function clearLegacyRuns(): void {
  const path = join(dataDir(), "runs.jsonl");
  if (!existsSync(path)) return;
  try {
    writeFileSync(path, "");
  } catch {
    // best effort — never crash the app over a clear
  }
}
