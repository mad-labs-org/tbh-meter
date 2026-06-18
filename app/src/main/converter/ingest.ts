// ingest — the converter's I/O shell (class Ingestor). Pure convert()/convertLegacy() decide
// WHAT a structured record is; the Ingestor decides WHEN to (re)produce one and writes it to `logs/`.
// It ingests new raw/<id>.json into logs/ (and migrates the legacy runs.jsonl); it is the only part
// of the converter that touches the disk. (It does NOT "reconcile"/recover lost runs — pure ingest.)
//
// The design's key simplification: NO converter_state file. The FILES are the state —
//   • a `raw/<id>.json` with no matching `logs/<id>.json`  => "convert this"
//   • a `logs/<id>.json` whose structuredSchemaVersion < current  => "re-convert this"
// so a crash mid-run self-heals on the next boot for free, and a converter bump re-runs everything
// (progress.md "Reconcile = só os arquivos"). Writes are atomic (tmp -> rename) and idempotent:
// running a pass twice yields the same logs/ and never double-writes an up-to-date file.
//
// Three triggers (progress.md "Conversor — Gatilhos"):
//   1. boot — readdir raw/ vs logs/, convert the missing/stale; migrate legacy runs.jsonl lines.
//   2. watch — a new raw/<id>.json appears -> convert it (run just finished).
//   3. on-use (PR4) — a logs/<id>.json read with an old version -> ingestOne re-converts from raw.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { join } from "node:path";
import type { AnyRawRun } from "../../shared/raw-types.js";
import type { RunRecord } from "../../shared/run-types.js";
import { convert, STRUCTURED_SCHEMA_VERSION } from "./convert.js";
import { convertLegacy } from "./legacy.js";

const POLL_INTERVAL_MS = 1_000;
// Coalesce fs.watch bursts on raw/ (tmp create + rename per finished run) into ONE trailing pass.
const WATCH_DEBOUNCE_MS = 150;

// --------------------------------------------------------------------------- //
// Per-file stat caches. The FILES stay the only STATE (the design's key
// simplification holds: nothing here decides differently than a cold pass — a
// fresh stat every pass validates each entry, so any external change is seen
// immediately and a new process rebuilds everything on boot). What the caches
// memoize is the PURE FACT a pass extracts from an unchanged file (its run `id`
// + structured version), because the pass used to readFileSync + JSON.parse
// EVERY raw/ and logs/ file at watch/poll rate — O(history) main-thread parse
// per finished run, the confirmed cause of "the meter got slow until I cleared
// the run history" (raws are the big ones: they carry runes/inventory/stash).
// `id: null` is a tombstone: parsing is deterministic, so an unreadable /
// foreign file stays skipped without re-parsing until its bytes change.
// Keyed per directory; pruned to the live listing every pass.
// --------------------------------------------------------------------------- //

interface LogFileFacts {
  mtimeMs: number;
  size: number;
  id: string | null;
  version: number | null;
}
interface RawFileFacts {
  mtimeMs: number;
  size: number;
  id: string | null;
}
const logFactsByDir = new Map<string, Map<string, LogFileFacts>>();
const rawFactsByDir = new Map<string, Map<string, RawFileFacts>>();
// runs.jsonl is FROZEN (the reader stopped writing it in Redesign 2), yet every pass re-parsed the
// whole file just to re-skip every line. Once a pass finds NOTHING left to migrate at the current
// converter version, later passes skip the re-parse while the file's (mtimeMs, size) stand.
// Trade-off (accepted): hand-deleting a single migrated log no longer resurrects it within ~1s —
// it comes back on the next boot pass (the documented self-heal trigger); the real clear path
// (clear run history) deletes runs.jsonl itself, which this fast path never bypasses.
const legacyCleanByDir = new Map<string, { mtimeMs: number; size: number; version: number }>();

function factsFor<T>(byDir: Map<string, Map<string, T>>, dir: string): Map<string, T> {
  let facts = byDir.get(dir);
  if (!facts) {
    facts = new Map();
    byDir.set(dir, facts);
  }
  return facts;
}

/** Drop cache entries whose file vanished from the listing (a clear / manual delete). */
function pruneFacts<T>(facts: Map<string, T>, live: ReadonlySet<string>): void {
  for (const name of facts.keys()) {
    if (!live.has(name)) facts.delete(name);
  }
}

export function rawDir(dataDir: string): string {
  return join(dataDir, "raw");
}

export function logsDir(dataDir: string): string {
  return join(dataDir, "logs");
}

function legacyRunsFile(dataDir: string): string {
  return join(dataDir, "runs.jsonl");
}

/** The logs filename for a structured record: sortable by time, unique by id, filesystem-safe.
 *  Deterministic from the record alone (same id+ts -> same name) so existence is the idempotency
 *  check. Mirrors logs-archive.ts's convention so the two never disagree on a file's name. */
export function logsFileName(record: Pick<RunRecord, "id" | "ts">): string {
  const safeId = record.id.replace(/[^A-Za-z0-9._-]/g, "-");
  return `${record.ts}_${safeId}.json`;
}

/** Write `record` to `logs/<name>.json` atomically (tmp + rename — os.rename is atomic on the same
 *  filesystem), so a concurrent reader of logs/ never sees a half-written file. Best-effort: a write
 *  failure is swallowed (never crash the app over a log write); the ingestor retries on the next boot. */
function writeStructured(dir: string, record: RunRecord): boolean {
  const path = join(dir, logsFileName(record));
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(record, null, 2), "utf-8");
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** Index logs/ by the structured record `id` -> { path, version }. Keyed by the id INSIDE each file
 *  (not the filename) so a raw and a legacy line for the same run map to the same slot regardless of
 *  how the file was named. Built once per ingest pass — from the per-file facts cache, so only
 *  files whose (mtimeMs, size) changed since the last pass are re-parsed (the converter's atomic
 *  tmp+rename always advances the mtime of a rewritten log). */
function indexLogs(dir: string): Map<string, { path: string; version: number | null }> {
  const out = new Map<string, { path: string; version: number | null }>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out; // logs dir missing — nothing indexed yet
  }
  const facts = factsFor(logFactsByDir, dir);
  const live = new Set<string>();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    live.add(name);
    const path = join(dir, name);
    let st: { mtimeMs: number; size: number };
    try {
      st = statSync(path);
    } catch {
      continue; // vanished between readdir and stat — treat as gone
    }
    let f = facts.get(name);
    if (!f || f.mtimeMs !== st.mtimeMs || f.size !== st.size) {
      // (Re)parse only a new/changed file. A corrupt log or a foreign JSON tombstones to id null
      // (skipped until its bytes change — it'll be overwritten if a raw still backs it).
      let id: string | null = null;
      let version: number | null = null;
      try {
        const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<RunRecord>;
        if (parsed && typeof parsed.id === "string") {
          id = parsed.id;
          version =
            typeof parsed.structuredSchemaVersion === "number" ? parsed.structuredSchemaVersion : null;
        }
      } catch {
        // corrupt log — tombstoned below
      }
      f = { mtimeMs: st.mtimeMs, size: st.size, id, version };
      facts.set(name, f);
    }
    // Same overwrite semantics as the cold pass: readdir order, later same-id file wins.
    if (f.id !== null) out.set(f.id, { path, version: f.version });
  }
  pruneFacts(facts, live);
  return out;
}

/** Parse one raw/<id>.json. null on read/parse failure or a non-object (defensive — a half-written
 *  file the atomic write should have prevented, or hand-corruption; the watcher just skips it). */
function readRaw(path: string): AnyRawRun | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as AnyRawRun;
  } catch {
    return null;
  }
}

/** Convert every raw/ file that has no up-to-date structured log. Returns the count written.
 *  `logs` is the pre-built id->log index (so a caller doing both raw + legacy ingest shares one
 *  index and sees raws win over legacy lines for the same id).
 *
 *  Perf: the pass used to parse EVERY raw on EVERY pass just to learn its `id` before skipping it
 *  (raws are the heaviest files — runes/inventory/stash). The facts cache keeps name -> id for
 *  unchanged (mtimeMs, size) files, so a steady-state pass is readdir + stats with ZERO parses;
 *  the full readRaw happens only for a new/changed file or when a conversion is actually due. */
function ingestNewRaws(
  rawPath: string,
  logsPath: string,
  logs: Map<string, { path: string; version: number | null }>,
): number {
  let names: string[];
  try {
    names = readdirSync(rawPath);
  } catch {
    return 0; // no raw/ dir yet — nothing to do
  }
  const facts = factsFor(rawFactsByDir, rawPath);
  const live = new Set<string>();
  let written = 0;
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".tmp.json") || name.endsWith(".json.tmp")) continue;
    live.add(name);
    const path = join(rawPath, name);
    let st: { mtimeMs: number; size: number };
    try {
      st = statSync(path);
    } catch {
      continue; // vanished between readdir and stat — treat as gone
    }
    let f = facts.get(name);
    // Parsed lazily: on a facts miss (new/changed file), and again iff a conversion is due.
    let raw: AnyRawRun | null = null;
    if (!f || f.mtimeMs !== st.mtimeMs || f.size !== st.size) {
      raw = readRaw(path);
      f = { mtimeMs: st.mtimeMs, size: st.size, id: raw && typeof raw.id === "string" ? raw.id : null };
      facts.set(name, f);
    }
    if (f.id === null) continue; // unreadable / not a raw — tombstoned until its bytes change
    const existing = logs.get(f.id);
    // Convert when there is no log, OR the log was produced by an older converter (staleness).
    if (existing && existing.version != null && existing.version >= STRUCTURED_SCHEMA_VERSION) continue;
    if (!raw) raw = readRaw(path); // facts came from cache — read the actual raw now
    if (!raw || typeof raw.id !== "string") continue;
    let record: RunRecord;
    try {
      record = convert(raw);
    } catch {
      continue; // defensive — a malformed-but-parseable raw is skipped, not fatal (mirrors migrateLegacyRuns)
    }
    if (writeStructured(logsPath, record)) {
      logs.set(record.id, { path: join(logsPath, logsFileName(record)), version: STRUCTURED_SCHEMA_VERSION });
      written++;
    }
  }
  pruneFacts(facts, live);
  return written;
}

/** Migrate the legacy runs.jsonl: each line whose id has no UP-TO-DATE log -> convertLegacy -> write.
 *  Mirrors ingestNewRaws's staleness guard (not a bare presence check): a log produced by an older
 *  converter is re-converted, so the pre-PR3 logs/ mirror — bare `JSON.stringify(normalizeRecord(...))`
 *  with NO structuredSchemaVersion (version null in the index) — is upgraded on an in-place prod
 *  upgrade and the 1.00.10 bugged runs finally get sealed `degraded` (without this they stayed as
 *  un-sealed mirror logs, defeating the migration). Safe for "raw wins": ingestNewRaws runs FIRST and
 *  stamps each raw-backed id to the CURRENT version, so a legacy line for the same run sees
 *  version >= current and is skipped (the raw's log is never clobbered). Idempotent: a second pass
 *  finds every freshly-written legacy log at the current version and writes nothing. Returns count. */
function migrateLegacyRuns(
  dataDir: string,
  logsPath: string,
  logs: Map<string, { path: string; version: number | null }>,
): number {
  const file = legacyRunsFile(dataDir);
  if (!existsSync(file)) return 0;
  // Frozen-file fast path: the reader stopped writing runs.jsonl in Redesign 2, so once a pass
  // found nothing left to migrate at the current converter version, re-parsing the whole file
  // every watch/poll pass is pure waste. The mark is validated by a fresh stat (an append or
  // ordinary replacement changes mtime/size and re-runs the full migration; only a
  // timestamp-preserving restore of a byte-identical file slips it, healing on the next boot)
  // and is only set by a pass with ZERO pending lines (see below), so a failed write keeps the
  // file "dirty".
  let st: { mtimeMs: number; size: number };
  try {
    st = statSync(file);
  } catch {
    return 0; // raced away between existsSync and stat — same outcome as missing
  }
  const clean = legacyCleanByDir.get(dataDir);
  if (
    clean &&
    clean.mtimeMs === st.mtimeMs &&
    clean.size === st.size &&
    clean.version === STRUCTURED_SCHEMA_VERSION
  ) {
    return 0;
  }
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return 0;
  }
  let written = 0;
  let pending = 0; // lines that NEEDED a write this pass (a failed write keeps the file dirty)
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // skip an un-parseable line, never throw
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    let record: RunRecord;
    try {
      record = convertLegacy(parsed as Record<string, unknown>, i);
    } catch {
      continue; // defensive — a record that fails migration is skipped, not fatal
    }
    // Skip only when an UP-TO-DATE log already backs this id (raw-derived, since ingestNewRaws ran
    // first, or a prior migration at the current version). A null-version pre-PR3 mirror log or a
    // stale one is re-converted so the migration's quality verdict (e.g. degraded) actually lands.
    const existing = logs.get(record.id);
    if (existing && existing.version != null && existing.version >= STRUCTURED_SCHEMA_VERSION) continue;
    pending++;
    if (writeStructured(logsPath, record)) {
      logs.set(record.id, { path: join(logsPath, logsFileName(record)), version: STRUCTURED_SCHEMA_VERSION });
      written++;
    }
  }
  // Nothing needed converting -> every line is already backed by a current log, so the next pass
  // over this exact file would be a no-op: remember that. (A pass that WROTE lines waits one more
  // pass — the follow-up re-derives the index from disk and marks clean only when it verifies.)
  if (pending === 0) {
    legacyCleanByDir.set(dataDir, { mtimeMs: st.mtimeMs, size: st.size, version: STRUCTURED_SCHEMA_VERSION });
  }
  return written;
}

/** One full ingest pass over a data dir: ensure logs/ exists, then convert missing/stale raws and
 *  migrate legacy lines. Returns counts (useful for logging/tests). Crash-safe + idempotent. */
export function ingestPending(dataDir: string): { raws: number; legacy: number } {
  const logsPath = logsDir(dataDir);
  try {
    mkdirSync(logsPath, { recursive: true });
  } catch {
    return { raws: 0, legacy: 0 }; // can't make logs/ — bail (sources tolerate a missing dir)
  }
  const logs = indexLogs(logsPath);
  const raws = ingestNewRaws(rawDir(dataDir), logsPath, logs);
  // Legacy AFTER raws, sharing the same index, so a raw for a run always wins over its legacy line.
  const legacy = migrateLegacyRuns(dataDir, logsPath, logs);
  return { raws, legacy };
}

/** Re-convert a single raw/<id> file unconditionally (the PR4 "on-use staleness" trigger: a log was
 *  read with an old version). Returns the fresh record, or null if the raw is unreadable. */
export function ingestOne(dataDir: string, rawFileName: string): RunRecord | null {
  const raw = readRaw(join(rawDir(dataDir), rawFileName));
  if (!raw || typeof raw.id !== "string") return null;
  let record: RunRecord;
  try {
    record = convert(raw);
  } catch {
    return null; // defensive — a malformed-but-parseable raw yields no record (mirrors migrateLegacyRuns)
  }
  try {
    mkdirSync(logsDir(dataDir), { recursive: true });
  } catch {
    return record; // return the record even if we can't persist it
  }
  writeStructured(logsDir(dataDir), record);
  return record;
}

// --------------------------------------------------------------------------- //
// Ingestor — boot pass + watch raw/ for new runs. Mirrors RunsSource's watch+poll belt-and-braces
// (fs.watch is unreliable across atomic-rename/SMB, so we also poll). One per data dir; restartable.
// --------------------------------------------------------------------------- //

export class Ingestor {
  private dir: string | null = null;
  private watcher: FSWatcher | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private lastRawCount = -1;
  private started = false;
  // Trailing-edge debounce for fs.watch-driven passes (the poll path stays direct: it is already
  // 1s-gated and the tests drive it deterministically with fake timers).
  private watchDebounce: ReturnType<typeof setTimeout> | null = null;

  setDir(dir: string | null): void {
    if (dir === this.dir) return;
    // Drop the OLD dir's facts so an abandoned output dir never pins its maps for the process
    // lifetime (the new dir starts cold and rebuilds from disk, exactly like a boot).
    if (this.dir) {
      logFactsByDir.delete(logsDir(this.dir));
      rawFactsByDir.delete(rawDir(this.dir));
      legacyCleanByDir.delete(this.dir);
    }
    this.dir = dir;
    if (this.started) {
      this.rewatch();
      this.runPass();
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.runPass(); // boot ingest (raws + legacy migration)
    this.rewatch();
  }

  stop(): void {
    this.started = false;
    this.clearWatch();
    this.lastRawCount = -1;
  }

  /** Run an ingest pass; best-effort (never throws into the watcher/boot). */
  private runPass(): void {
    if (!this.dir) return;
    try {
      ingestPending(this.dir);
    } catch {
      // best effort — an ingest failure must never crash the app; next tick retries
    }
  }

  private clearWatch(): void {
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // ignore
      }
      this.watcher = null;
    }
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce);
      this.watchDebounce = null;
    }
  }

  /** Coalesce a burst of fs.watch events (tmp create + rename per written raw) into ONE pass. */
  private schedulePass(): void {
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    this.watchDebounce = setTimeout(() => {
      this.watchDebounce = null;
      this.runPass();
    }, WATCH_DEBOUNCE_MS);
  }

  private rewatch(): void {
    this.clearWatch();
    if (!this.dir) return;
    const raw = rawDir(this.dir);

    try {
      if (existsSync(raw)) {
        // A new raw file (a run finished) -> ingest. fs.watch fires on dir entries changing.
        this.watcher = watch(raw, () => this.schedulePass());
      }
    } catch {
      this.watcher = null;
    }

    // Poll fallback: raw/ may not exist yet at boot, and fs.watch misses atomic-rename / SMB writes.
    // Cheap change-detection by entry count (a new run = a new file) re-attaches the watcher + ingests.
    this.poll = setInterval(() => {
      if (!this.dir) return;
      const r = rawDir(this.dir);
      try {
        if (!existsSync(r)) return;
        const count = readdirSync(r).filter((n) => n.endsWith(".json") && !n.endsWith(".tmp")).length;
        if (count !== this.lastRawCount) {
          this.lastRawCount = count;
          if (!this.watcher) {
            try {
              this.watcher = watch(r, () => this.schedulePass());
            } catch {
              this.watcher = null;
            }
          }
          this.runPass();
        }
      } catch {
        // ignore transient errors (e.g. dir replaced mid-read)
      }
    }, POLL_INTERVAL_MS);
  }
}

let singleton: Ingestor | null = null;

export function getIngestor(): Ingestor {
  if (!singleton) singleton = new Ingestor();
  return singleton;
}
