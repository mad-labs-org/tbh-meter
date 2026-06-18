import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Integration test of the PR4 read path: RunsSource WATCHES <dir>/logs/ and loads the structured
// records the converter produced, WITHOUT re-normalizing — over a REAL temp dir + the poll-driven
// watch (fake timers, like the ingest integration test). settings.ts imports electron, and the
// on-use staleness path lazy-imports the ingestor (which imports settings transitively), so mock
// electron's getPath to a temp userData. Then point the source at our own temp dir via setDir.

const userData = mkdtempSync(join(tmpdir(), "tbh-runs-src-ud-"));
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => userData },
}));

import { getRunsSource, RunsSource } from "../sources/runs-source.js";
import { convert, STRUCTURED_SCHEMA_VERSION } from "../converter/convert.js";
import { logsFileName, rawDir, ingestPending } from "../converter/ingest.js";
// The on-use staleness path lazy-imports this same module; the import registry is shared, so a
// spy installed on the statically-imported namespace also intercepts the dynamic import().
import * as ingestor from "../converter/ingest.js";
import type { RawRun } from "../../shared/raw-types.js";
import type { RunRecord } from "../../shared/run-types.js";

let dir: string;

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), "tbh-runs-src-"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(userData, { recursive: true, force: true });
});

function rawRun(overrides: Partial<RawRun> = {}): RawRun {
  return {
    raw_schema_version: 1,
    id: "sess-1:1",
    ts: 1_700_000_000,
    run: 1,
    run_outcome: "success",
    session_id: "sess-1",
    game_version: "1.00.10",
    duration: 92,
    stageKey: { ok: true, value: 30901 },
    act: { ok: true, value: 3 },
    stageNo: { ok: true, value: 9 },
    difficulty: { ok: true, value: 2 },
    total_mobs: { ok: true, value: 120 },
    mobs: { ok: true, value: 118 },
    total_damage: { ok: true, value: 4_500_000 },
    clear_time: { ok: true, value: 90 },
    gold_gained: { ok: true, value: 125_000 },
    gold_source: "live",
    xp_gained: { ok: true, value: 3_400_000 },
    xp_source: "live",
    drops: { ok: true, value: [] },
    heroes: { ok: true, value: [] },
    ...overrides,
  };
}

function logsPath(): string {
  return join(dir, "logs");
}

/** Write a structured record into logs/ exactly as the converter/ingestor would (atomic-rename is
 *  irrelevant here; we just need a valid logs/<name>.json). Returns the record written. */
function writeLog(record: RunRecord): RunRecord {
  mkdirSync(logsPath(), { recursive: true });
  writeFileSync(join(logsPath(), logsFileName(record)), JSON.stringify(record, null, 2), "utf-8");
  return record;
}

/** Convert a raw and write its structured log (the normal pipeline output). */
function writeConvertedLog(raw: RawRun): RunRecord {
  return writeLog(convert(raw));
}

function makeSource(): RunsSource {
  const s = new RunsSource();
  s.setDir(dir);
  s.start();
  return s;
}

describe("RunsSource — reads logs/ (the converter output), no re-normalization", () => {
  it("loads a structured log into listIndex + getById with the converter's derived values", () => {
    const rec = writeConvertedLog(rawRun());
    const src = makeSource();
    try {
      const idx = src.listIndex();
      expect(idx).toHaveLength(1);
      expect(idx[0].id).toBe("sess-1:1");
      // dps is the converter's derived value, READ from the log (4.5M / 90s = 50k), not recomputed.
      expect(idx[0].dps).toBe(rec.dps);
      expect(idx[0].dps).toBeCloseTo(50_000, 5);
      expect(src.getById("sess-1:1")?.quality).toBe("counted");
    } finally {
      src.stop();
    }
  });

  it("projects the converter quality + raw stageNo into the index (the data the PR6 filter reads)", () => {
    // The runs-list display filter (PR6) gates on RunIndexEntry.quality + stageNo without fetching
    // full records, so projectIndex MUST carry both end-to-end (raw -> convert -> logs/ -> index).
    writeConvertedLog(rawRun()); // stageNo 9, a clean counted run
    const src = makeSource();
    try {
      const e = src.listIndex()[0];
      expect(e.quality).toBe("counted");
      expect(e.stageNo).toBe(9);
    } finally {
      src.stop();
    }
  });

  it("carries a NON-counted verdict through projectIndex (a skipped sub-floor run -> index.quality)", () => {
    // The hide filter REMOVES runs by reading RunIndexEntry.quality. The counted branch is covered
    // above; this locks the non-counted branch of projectIndex's quality spread on the path the
    // filter actually consumes (listIndex), so narrowing the spread to e.g. only `counted` fails here.
    // A sub-floor (< COUNT_FLOOR_SEC) non-x-10 run is sealed "skipped" by the converter.
    writeConvertedLog(
      rawRun({
        id: "sess-1:2",
        run: 2,
        clear_time: { ok: true, value: 5 },
        duration: 5,
      }),
    );
    const src = makeSource();
    try {
      const e = src.listIndex()[0];
      expect(e.quality).toBe("skipped");
      expect(e.stageNo).toBe(9); // not x-10 -> the floor applies -> skipped
    } finally {
      src.stop();
    }
  });

  it("omits quality on a legacy-mirror log (so the filter treats an un-sealed run as visible)", () => {
    // A pre-converter mirror log has no quality; the index entry must leave it undefined (the filter
    // never hides a run merely because it predates the converter — see run-filter.passesRunFilter).
    mkdirSync(logsPath(), { recursive: true });
    writeFileSync(
      join(logsPath(), "1700000000_old-1.json"),
      JSON.stringify({ id: "old:1", ts: 1, sessionId: "old", run: 1, status: "success", stageNo: 5, heroes: [] }),
      "utf-8",
    );
    const src = makeSource();
    try {
      const e = src.listIndex()[0];
      expect(e.quality).toBeUndefined();
      expect(e.stageNo).toBe(5);
    } finally {
      src.stop();
    }
  });

  it("starts empty when logs/ does not exist yet", () => {
    const src = makeSource();
    try {
      expect(src.listIndex()).toEqual([]);
      expect(src.all()).toEqual([]);
    } finally {
      src.stop();
    }
  });

  it("picks up a NEW log on the next poll tick (a run just finished -> converter wrote logs/<id>)", () => {
    const src = makeSource();
    try {
      expect(src.listIndex()).toHaveLength(0);
      writeConvertedLog(rawRun({ id: "sess-1:2", run: 2, session_id: "sess-1" }));
      vi.advanceTimersByTime(1_000); // POLL_INTERVAL_MS — entry-count change detected
      expect(src.listIndex()).toHaveLength(1);
      expect(src.listIndex()[0].id).toBe("sess-1:2");
    } finally {
      src.stop();
    }
  });

  it("sorts newest-first (ts desc, then run desc)", () => {
    writeConvertedLog(rawRun({ id: "s:1", run: 1, session_id: "s", ts: 1_000 }));
    writeConvertedLog(rawRun({ id: "s:2", run: 2, session_id: "s", ts: 3_000 }));
    writeConvertedLog(rawRun({ id: "s:3", run: 3, session_id: "s", ts: 2_000 }));
    const src = makeSource();
    try {
      expect(src.listIndex().map((r) => r.id)).toEqual(["s:2", "s:3", "s:1"]);
    } finally {
      src.stop();
    }
  });

  it("does NOT recompute dps — it trusts the stored structured value", () => {
    // Hand-write a log whose stored dps disagrees with its damage/time; the source must keep it.
    const rec = { ...convert(rawRun()), dps: 7 };
    writeLog(rec);
    const src = makeSource();
    try {
      expect(src.getById("sess-1:1")?.dps).toBe(7);
    } finally {
      src.stop();
    }
  });
});

describe("RunsSource — defensive load (corrupt / old logs never break the watcher)", () => {
  it("skips an un-parseable log file, loading the good ones", () => {
    mkdirSync(logsPath(), { recursive: true });
    writeFileSync(join(logsPath(), "broken.json"), "{ not valid json", "utf-8");
    writeConvertedLog(rawRun());
    const src = makeSource();
    try {
      expect(src.listIndex()).toHaveLength(1);
      expect(src.getById("sess-1:1")).not.toBeNull();
    } finally {
      src.stop();
    }
  });

  it("skips a JSON file that is not a run record (no id)", () => {
    mkdirSync(logsPath(), { recursive: true });
    writeFileSync(join(logsPath(), "not-a-run.json"), JSON.stringify({ foo: "bar" }), "utf-8");
    const src = makeSource();
    try {
      expect(src.listIndex()).toEqual([]);
    } finally {
      src.stop();
    }
  });

  it("ignores .tmp files left mid atomic-write", () => {
    mkdirSync(logsPath(), { recursive: true });
    const rec = convert(rawRun());
    writeFileSync(join(logsPath(), `${logsFileName(rec)}.tmp`), JSON.stringify(rec), "utf-8");
    const src = makeSource();
    try {
      expect(src.listIndex()).toEqual([]);
    } finally {
      src.stop();
    }
  });

  it("loads a pre-PR3 legacy-mirror log lacking quality/issues/structuredSchemaVersion", () => {
    // The old logs-archive wrote a bare normalizeRecord dump. It must still load (defensively).
    const mirror = {
      id: "old:1",
      ts: 1_700_000_000,
      sessionId: "old",
      run: 1,
      status: "success",
      stage: "1-1",
      stageKey: 1001,
      mode: "Normal",
      goldGained: 0,
      schemaVersion: 11,
      heroes: [],
    };
    mkdirSync(logsPath(), { recursive: true });
    writeFileSync(join(logsPath(), "1700000000_old-1.json"), JSON.stringify(mirror), "utf-8");
    const src = makeSource();
    try {
      const r = src.getById("old:1");
      expect(r).not.toBeNull();
      expect(r?.quality).toBeUndefined(); // not sealed yet — no crash, just undefined
    } finally {
      src.stop();
    }
  });
});

describe("RunsSource — id-dedup + session-scoped content dedup on read", () => {
  it("collapses two logs sharing an id (a re-finalization) to the newest, by id", () => {
    // The same run written to two differently-named files (different ts) -> same id. Only one row.
    const base = convert(rawRun({ id: "s:1", run: 1, session_id: "s" }));
    writeLog({ ...base, ts: 2_000, dps: 111 });
    writeLog({ ...base, ts: 1_000, dps: 222 });
    const src = makeSource();
    try {
      const idx = src.listIndex();
      expect(idx).toHaveLength(1);
      expect(idx[0].id).toBe("s:1");
      expect(idx[0].dps).toBe(111); // the newest (ts 2000) won
    } finally {
      src.stop();
    }
  });

  it("collapses the two-reader phantom: identical content under DIFFERENT sessions", () => {
    // AV-respawn left two readers; each wrote the same run under its own session id.
    writeConvertedLog(rawRun({ id: "sA:1", run: 1, session_id: "sA", ts: 2_000 }));
    writeConvertedLog(rawRun({ id: "sB:1", run: 1, session_id: "sB", ts: 1_000 }));
    const src = makeSource();
    try {
      const idx = src.listIndex();
      expect(idx).toHaveLength(1); // phantom collapsed
      expect(idx[0].sessionId).toBe("sA"); // kept the newest
    } finally {
      src.stop();
    }
  });

  it("NEVER collapses a real farm: distinct same-session runs that look identical both survive", () => {
    // Two genuinely-distinct runs in ONE session with identical content (same stage/damage/gold).
    // Distinct ids (run 1 vs 2). Both MUST appear — zero false-hide of a grind.
    writeConvertedLog(rawRun({ id: "s:1", run: 1, session_id: "s", ts: 2_000 }));
    writeConvertedLog(rawRun({ id: "s:2", run: 2, session_id: "s", ts: 1_000 }));
    const src = makeSource();
    try {
      expect(src.listIndex().map((r) => r.id).sort()).toEqual(["s:1", "s:2"]);
    } finally {
      src.stop();
    }
  });
});

describe("RunsSource — surfaces MIGRATED legacy runs (runs.jsonl -> ingest -> logs/ -> app read)", () => {
  // The migration's literal continuity guarantee (progress.md "Migração & continuidade"): a player's
  // existing runs.jsonl must be consumable by the PR4 read path, not just by a hand-rolled readLogs.
  // This threads the WHOLE seam: a legacy line -> ingestPending (convertLegacy -> logs/) -> RunsSource.
  function writeLegacyLine(record: Record<string, unknown>): void {
    const file = join(dir, "runs.jsonl");
    let prev = "";
    try {
      prev = readFileSync(file, "utf-8");
    } catch {
      prev = "";
    }
    writeFileSync(file, prev + JSON.stringify(record) + "\n", "utf-8");
  }

  it("loads a migrated legacy run (external_id preserved) and seals a bugged one as degraded", () => {
    // One good legacy run + one 1.00.10-bugged run (gold 0 + mode '?'). The migration must surface
    // BOTH (skip != vanish): the good one with its external_id intact, the bugged one sealed degraded.
    writeLegacyLine({ ts: 1_700_000_100, session_id: "1700000000-42", run: 5, status: "success", stage: "2-5", stageKey: 2105, mode: "Normal", total_damage: 1_000_000, clear_time: 60, duration: 62, gold_gained: 50_000, schema_version: 11, heroes: [] });
    writeLegacyLine({ ts: 1_700_000_000, session_id: "1700000000-7", run: 3, status: "success", stage: "?", stageKey: null, mode: "?", total_damage: 4_500_000, clear_time: 90, duration: 92, gold_gained: 0, schema_version: 11, heroes: [] });

    // Run the boot migration (what index.ts does via the Ingestor), THEN read through RunsSource.
    ingestPending(dir);

    const src = makeSource();
    try {
      const idx = src.listIndex();
      expect(idx.map((r) => r.id).sort()).toEqual(["1700000000-42:5", "1700000000-7:3"]);

      const good = src.getById("1700000000-42:5");
      expect(good).not.toBeNull();
      expect(good?.id).toBe("1700000000-42:5"); // external_id preserved verbatim (no re-mint)
      expect(good?.quality).toBe("counted");

      const bugged = src.getById("1700000000-7:3");
      expect(bugged?.quality).toBe("degraded"); // sealed honest, NOT deleted
      expect(bugged?.issues?.gold_gained).toContain("1.00.10");

      // The DISPLAY filter (PR6) reads RunIndexEntry.quality, so the non-counted verdict MUST also
      // survive projectIndex into the index entry — not just getById's full record. The degraded run
      // is the one that MUST be hidden-by-default, so guard its index quality precisely (a regression
      // that narrowed the quality spread would strip it here and silently break hideNonCounted).
      expect(idx.find((r) => r.id === "1700000000-7:3")?.quality).toBe("degraded");
      expect(idx.find((r) => r.id === "1700000000-42:5")?.quality).toBe("counted");
    } finally {
      src.stop();
    }
  });
});

describe("RunsSource — on-use staleness triggers a re-convert from raw", () => {
  // The re-convert is driven by a real dynamic import() (a microtask), NOT a timer — so these tests
  // use REAL timers and a microtask flush. The poll interval is irrelevant: we force the post-convert
  // reload by toggling the dir (a synchronous reload), keeping the test deterministic.
  beforeEach(() => {
    vi.useRealTimers();
  });

  /** Let the fire-and-forget `import("../converter/ingest.js").then(ingestOne)` settle. A
   *  couple of macrotask turns covers the dynamic import + the sync ingestOne inside its .then. */
  const flushReconvert = () => new Promise((r) => setTimeout(r, 20));

  it("re-converts a log whose structuredSchemaVersion is older, then serves the fresh one", async () => {
    // Write the raw (so ingestOne can re-convert it) AND a STALE log (version 0) for the same run.
    const raw = rawRun({ id: "stale-1:1", run: 1, session_id: "stale-1" });
    mkdirSync(rawDir(dir), { recursive: true });
    writeFileSync(join(rawDir(dir), "stale-1-1.json"), JSON.stringify(raw), "utf-8");
    const stale: RunRecord = { ...convert(raw), structuredSchemaVersion: 0 };
    writeLog(stale);

    const src = makeSource();
    try {
      // The initial load serves the stale record AND fires a fire-and-forget re-convert.
      expect(src.getById("stale-1:1")?.structuredSchemaVersion).toBe(0);

      await flushReconvert(); // dynamic import + ingestOne rewrites the log at the current version
      // Force the post-convert reload (toggle the dir -> synchronous reload of the now-fresh log).
      src.setDir(null);
      src.setDir(dir);
      expect(src.getById("stale-1:1")?.structuredSchemaVersion).toBe(STRUCTURED_SCHEMA_VERSION);
    } finally {
      src.stop();
    }
  });

  it("does NOT re-convert a current-version log (no churn)", async () => {
    const raw = rawRun({ id: "fresh-1:1", run: 1, session_id: "fresh-1" });
    mkdirSync(rawDir(dir), { recursive: true });
    writeFileSync(join(rawDir(dir), "fresh-1-1.json"), JSON.stringify(raw), "utf-8");
    // A current log must never trigger the lazy ingest/re-convert: the version is already current.
    writeConvertedLog(raw);
    const src = makeSource();
    try {
      const before = src.getById("fresh-1:1")?.structuredSchemaVersion;
      await flushReconvert();
      expect(src.getById("fresh-1:1")?.structuredSchemaVersion).toBe(before);
      expect(before).toBe(STRUCTURED_SCHEMA_VERSION);
    } finally {
      src.stop();
    }
  });

  it("fires the re-convert at most ONCE for a permanently-stale log (no per-reload converter churn)", async () => {
    // The dangerous case the staleRequested guard exists for: a STALE log whose backing raw is GONE.
    // ingestOne can't heal it (returns null, never bumps the version), so the log stays stale on
    // EVERY reload — without the fire-once guard each reload would re-fire the dynamic import +
    // ingestOne forever (per-poll churn). Use FAKE timers + advanceTimersByTimeAsync (flushes the
    // poll tick AND the dynamic import()'s microtasks) so several reloads run deterministically.
    vi.useFakeTimers();
    const spy = vi.spyOn(ingestor, "ingestOne");
    const stale: RunRecord = { ...convert(rawRun({ id: "gone-1:1", run: 1, session_id: "gone-1" })), structuredSchemaVersion: 0 };
    writeLog(stale); // NOTE: no raw/ for gone-1:1 -> ingestOne will return null, never healing it

    const src = makeSource();
    try {
      await vi.advanceTimersByTimeAsync(0); // load #1 (start's reload) fires the (futile) re-convert
      // Force more reloads WITHOUT clearing staleRequested: add unrelated current logs so the poll's
      // entry-count change re-runs reload() (the stale log is re-read each time, but already requested).
      writeConvertedLog(rawRun({ id: "other:1", run: 1, session_id: "other", ts: 100 }));
      await vi.advanceTimersByTimeAsync(1_000); // poll tick -> reload #2
      writeConvertedLog(rawRun({ id: "other:2", run: 2, session_id: "other", ts: 200 }));
      await vi.advanceTimersByTimeAsync(1_000); // poll tick -> reload #3

      // The stale log was re-read on every reload, but the re-convert fired exactly once.
      expect(spy.mock.calls.filter((c) => c[1] === "gone-1-1.json")).toHaveLength(1);
    } finally {
      src.stop();
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("setDir resets staleRequested — the same stale id can be re-requested after a dir change", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(ingestor, "ingestOne");
    const stale: RunRecord = { ...convert(rawRun({ id: "gone-2:1", run: 1, session_id: "gone-2" })), structuredSchemaVersion: 0 };
    writeLog(stale); // again: no backing raw, so the log stays stale across reloads

    const src = makeSource();
    try {
      await vi.advanceTimersByTimeAsync(0); // load #1 fires the re-convert once
      expect(spy.mock.calls.filter((c) => c[1] === "gone-2-1.json")).toHaveLength(1);

      // A dir change (setDir) clears staleRequested -> re-pointing at the same dir re-arms the request.
      src.setDir(null);
      src.setDir(dir); // synchronous reload #2 -> staleRequested was cleared, so it fires AGAIN
      await vi.advanceTimersByTimeAsync(0);
      expect(spy.mock.calls.filter((c) => c[1] === "gone-2-1.json")).toHaveLength(2);
    } finally {
      src.stop();
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("RunsSource — clearFile wipes logs/ and empties the list", () => {
  it("deletes every logs/<id>.json and reloads to empty", () => {
    writeConvertedLog(rawRun({ id: "s:1", run: 1, session_id: "s" }));
    writeConvertedLog(rawRun({ id: "s:2", run: 2, session_id: "s" }));
    const src = makeSource();
    try {
      expect(src.listIndex()).toHaveLength(2);
      expect(src.clearFile()).toBe(true);
      expect(src.listIndex()).toEqual([]);
      // the files are gone on disk too
      expect(readdirSync(logsPath()).filter((n) => n.endsWith(".json"))).toEqual([]);
    } finally {
      src.stop();
    }
  });

  it("returns false when there is no dir set", () => {
    const s = new RunsSource();
    expect(s.clearFile()).toBe(false);
  });
});

// --------------------------------------------------------------------------- //
// Incremental reload cache: reload stats every file each pass but re-PARSES only
// new/changed ones. These pin the cache's correctness edges — invalidation on an
// in-place rewrite, PRISTINE session derivation across cached reloads, and prune
// on delete — all driven through the deterministic poll path (entry-count change).
// --------------------------------------------------------------------------- //
describe("RunsSource — incremental reload cache", () => {
  /** Force a poll-driven reload: a new (content-distinct) log changes the entry count, which is the
   *  poll's change signal. The cached, untouched files must be served from the warm cache. */
  function pollReload(extraSession: string): void {
    writeConvertedLog(
      rawRun({
        id: `${extraSession}:1`,
        run: 1,
        session_id: extraSession,
        ts: 1,
        total_damage: { ok: true, value: 777 }, // content-distinct: never collides with a fixture sig
      }),
    );
    vi.advanceTimersByTime(1_000); // POLL_INTERVAL_MS
  }

  it("serves the NEW content of a log rewritten IN PLACE (same filename) on the next reload", () => {
    // A re-finalization / re-convert REPLACES logs/<name>.json under the SAME name; the cache must
    // invalidate on (mtime, size). dps 111 vs 222 keeps the byte length EQUAL on purpose — the
    // mtime alone must carry the invalidation (pushed +5s, immune to coarse filesystem clocks).
    const rec = convert(rawRun({ id: "s:1", run: 1, session_id: "s" }));
    writeLog({ ...rec, dps: 111 });
    const src = makeSource();
    try {
      expect(src.getById("s:1")?.dps).toBe(111);
      writeLog({ ...rec, dps: 222 });
      const file = join(logsPath(), logsFileName(rec));
      const bumped = new Date(statSync(file).mtimeMs + 5_000);
      utimesSync(file, bumped, bumped);
      pollReload("other");
      expect(src.getById("s:1")?.dps).toBe(222);
    } finally {
      src.stop();
    }
  });

  it("keeps DERIVED sessions stable across cached reloads — a real farm is never collapsed", () => {
    // Two v2 runs (sessionId "" ON DISK) with IDENTICAL content, >6h apart -> each derives its own
    // session per reload. The session-scoped dedup is only safe while every v2 run still carries the
    // on-disk "" at dedup time (fresh-parse semantics): if the cache ever leaked a previous reload's
    // DERIVED sessionId back in, the next reload would see identical content under two DIFFERENT
    // sessions and the cross-session phantom collapse would false-hide a real run.
    writeLog(v2Log("1700000000000", 1_700_000_000_000));
    writeLog(v2Log("1700026000000", 1_700_026_000_000)); // ~7.2h later -> its own derived session
    const src = makeSource();
    try {
      const first = src.listIndex();
      expect(first.map((r) => r.id)).toContain("1700000000000");
      expect(first.map((r) => r.id)).toContain("1700026000000");
      // Derived labels = the ts of each group's first run (deriveSessions contract).
      expect(first.find((r) => r.id === "1700000000000")?.sessionId).toBe("1700000000000");
      expect(first.find((r) => r.id === "1700026000000")?.sessionId).toBe("1700026000000");

      pollReload("warm"); // warm reload: both v2 files unchanged -> served from the cache

      const second = src.listIndex();
      expect(second.map((r) => r.id)).toContain("1700000000000"); // both SURVIVE (no collapse)
      expect(second.map((r) => r.id)).toContain("1700026000000");
      expect(second.find((r) => r.id === "1700000000000")?.sessionId).toBe("1700000000000");
      expect(second.find((r) => r.id === "1700026000000")?.sessionId).toBe("1700026000000");
    } finally {
      src.stop();
    }
  });

  it("prunes a DELETED log on the next reload — never resurrected from the cache", () => {
    const keep = writeConvertedLog(rawRun({ id: "s:1", run: 1, session_id: "s", ts: 2_000 }));
    const gone = writeConvertedLog(rawRun({ id: "s:2", run: 2, session_id: "s", ts: 1_000 }));
    const src = makeSource();
    try {
      expect(src.listIndex()).toHaveLength(2);
      rmSync(join(logsPath(), logsFileName(gone)));
      vi.advanceTimersByTime(1_000); // poll sees the entry-count change -> warm reload
      expect(src.listIndex().map((r) => r.id)).toEqual([keep.id]);
    } finally {
      src.stop();
    }
  });
});

/** A raw-v2-style structured log: sessionId "" ON DISK (the app derives the session from run
 *  timestamps on every reload), ts in MILLISECONDS. Content fields are identical across calls on
 *  purpose — the pristine-cache test above needs two content-identical runs. */
function v2Log(id: string, tsMs: number): RunRecord {
  return {
    id,
    ts: tsMs,
    sessionId: "",
    schemaVersion: 12,
    gameVersion: "1.00.10",
    run: 1,
    status: "success",
    stage: "3-9",
    act: 3,
    stageNo: 9,
    stageKey: 30901,
    mode: "Hell",
    mobs: 118,
    totalMobs: 120,
    totalDamage: 4_500_000,
    dps: 50_000,
    clearTime: 90,
    duration: 92,
    goldGained: 125_000,
    goldSource: "live",
    xpGained: 3_400_000,
    xpSource: "live",
    xpPerSec: 0,
    goldPerSec: 0,
    partial: false,
    waveNow: null,
    waveTotal: null,
    heroes: [],
    quality: "counted",
    structuredSchemaVersion: STRUCTURED_SCHEMA_VERSION,
  };
}

describe("getRunsSource singleton", () => {
  it("returns a stable instance", () => {
    expect(getRunsSource()).toBe(getRunsSource());
  });
});
