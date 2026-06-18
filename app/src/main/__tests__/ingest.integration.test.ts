import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestPending, ingestOne, logsDir, rawDir, logsFileName, Ingestor } from "../converter/ingest.js";
import { convert, STRUCTURED_SCHEMA_VERSION } from "../converter/convert.js";
import type { RawRun } from "../../shared/raw-types.js";
import type { RunRecord } from "../../shared/run-types.js";

// Integration test of the converter's I/O shell over a REAL temp dir — the point is to exercise the
// actual disk behaviour (atomic write, readdir-driven idempotency, crash recovery) rather than mock
// it. Pure convert()/convertLegacy() are unit-tested separately; here we prove WHEN logs/ gets
// (re)written and that running twice is a no-op.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tbh-ingest-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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

/** Write a raw/<id>.json the way the reader does (file stem = session_id-run, ':' -> '-'). */
function writeRaw(raw: RawRun): void {
  const rd = rawDir(dir);
  mkdirSync(rd, { recursive: true });
  const stem = `${raw.session_id}-${raw.run}`;
  writeFileSync(join(rd, `${stem}.json`), JSON.stringify(raw), "utf-8");
}

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

function readLogs(): RunRecord[] {
  const ld = logsDir(dir);
  let names: string[];
  try {
    names = readdirSync(ld).filter((n) => n.endsWith(".json") && !n.endsWith(".tmp"));
  } catch {
    return [];
  }
  return names.map((n) => JSON.parse(readFileSync(join(ld, n), "utf-8")) as RunRecord);
}

describe("ingestPending — raw -> logs pipeline", () => {
  it("converts a raw/<id>.json into a structured logs/ file", () => {
    writeRaw(rawRun());
    const counts = ingestPending(dir);
    expect(counts.raws).toBe(1);
    const logs = readLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].id).toBe("sess-1:1");
    expect(logs[0].dps).toBeCloseTo(50_000, 5);
    expect(logs[0].quality).toBe("counted");
    expect(logs[0].structuredSchemaVersion).toBe(STRUCTURED_SCHEMA_VERSION);
  });

  it("creates logs/ if it does not exist yet", () => {
    writeRaw(rawRun());
    ingestPending(dir);
    expect(statSync(logsDir(dir)).isDirectory()).toBe(true);
  });

  it("is idempotent — a second pass writes nothing and leaves the same logs/", () => {
    writeRaw(rawRun());
    const first = ingestPending(dir);
    expect(first.raws).toBe(1);
    const namesAfterFirst = readdirSync(logsDir(dir)).sort();

    const second = ingestPending(dir);
    expect(second.raws).toBe(0); // nothing to do — log already current
    expect(readdirSync(logsDir(dir)).sort()).toEqual(namesAfterFirst);
  });

  it("converts only the NEW raw on a later pass (incremental)", () => {
    writeRaw(rawRun({ id: "sess-1:1", run: 1 }));
    expect(ingestPending(dir).raws).toBe(1);

    writeRaw(rawRun({ id: "sess-1:2", run: 2 }));
    expect(ingestPending(dir).raws).toBe(1); // only the second run
    expect(readLogs()).toHaveLength(2);
  });

  it("re-converts a STALE log (structuredSchemaVersion < current)", () => {
    writeRaw(rawRun());
    // Seed a logs/ file as if an OLDER converter produced it (version 0).
    const stale: RunRecord = { ...convert(rawRun()), structuredSchemaVersion: 0 };
    mkdirSync(logsDir(dir), { recursive: true });
    writeFileSync(join(logsDir(dir), logsFileName(stale)), JSON.stringify(stale), "utf-8");

    const counts = ingestPending(dir);
    expect(counts.raws).toBe(1); // re-converted the stale one
    const logs = readLogs();
    expect(logs[0].structuredSchemaVersion).toBe(STRUCTURED_SCHEMA_VERSION);
  });

  it("skips a half-written/garbage raw file without crashing", () => {
    const rd = rawDir(dir);
    mkdirSync(rd, { recursive: true });
    writeFileSync(join(rd, "broken.json"), "{ not valid json", "utf-8");
    writeRaw(rawRun()); // one good one alongside
    expect(ingestPending(dir).raws).toBe(1);
    expect(readLogs()).toHaveLength(1);
  });

  it("ignores .tmp files left by an interrupted atomic write", () => {
    const rd = rawDir(dir);
    mkdirSync(rd, { recursive: true });
    writeFileSync(join(rd, "sess-1-1.json.tmp"), JSON.stringify(rawRun()), "utf-8");
    expect(ingestPending(dir).raws).toBe(0);
    expect(readLogs()).toHaveLength(0);
  });

  it("skips a parseable-but-malformed raw (ok envelope, non-array value) without stalling the pass", () => {
    // readRaw only validates the top-level shape, so a hand-edited raw whose heroes is
    // {ok:true,value:null} reaches convert() and throws at heroes.map. Without the try/catch in
    // ingestNewRaws that throw aborts the whole pass, silently dropping every raw listed after it.
    const rd = rawDir(dir);
    mkdirSync(rd, { recursive: true });
    const bad = { ...rawRun({ id: "bad:1", run: 1, session_id: "bad" }), heroes: { ok: true, value: null } } as unknown as RawRun;
    writeFileSync(join(rd, "bad-1.json"), JSON.stringify(bad), "utf-8");
    writeRaw(rawRun({ id: "sess-1:2", run: 2, session_id: "sess-1" })); // a good one alongside
    expect(ingestPending(dir).raws).toBe(1); // the bad one is skipped, the good one still converts
    expect(readLogs()).toHaveLength(1);
  });
});

describe("ingestPending — legacy runs.jsonl migration", () => {
  it("migrates a legacy line into logs/ preserving its external_id", () => {
    writeLegacyLine({ ts: 1_700_000_000, session_id: "1700000000-42", run: 5, status: "success", stage: "2-5", stageKey: 2105, mode: "Normal", total_damage: 1_000_000, clear_time: 60, duration: 62, gold_gained: 50_000, schema_version: 11, heroes: [] });
    const counts = ingestPending(dir);
    expect(counts.legacy).toBe(1);
    const logs = readLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].id).toBe("1700000000-42:5"); // external_id preserved verbatim
  });

  it("seals a bugged legacy record (gold 0 + mode '?') as degraded, never deleting it", () => {
    writeLegacyLine({ ts: 1, session_id: "s", run: 1, status: "success", stage: "?", stageKey: null, mode: "?", total_damage: 4_500_000, clear_time: 90, duration: 92, gold_gained: 0, schema_version: 11, heroes: [] });
    ingestPending(dir);
    const logs = readLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].quality).toBe("degraded");
  });

  it("is idempotent across raw + legacy — a second pass adds nothing", () => {
    writeRaw(rawRun({ id: "sess-1:1", run: 1 }));
    writeLegacyLine({ ts: 2, session_id: "old", run: 9, status: "success", stage: "1-1", stageKey: 1001, mode: "Normal", total_damage: 700_000, clear_time: 40, duration: 41, gold_gained: 9_000, schema_version: 11, heroes: [] });
    const first = ingestPending(dir);
    expect(first.raws).toBe(1);
    expect(first.legacy).toBe(1);
    expect(readLogs()).toHaveLength(2);

    const second = ingestPending(dir);
    expect(second.raws).toBe(0);
    expect(second.legacy).toBe(0);
    expect(readLogs()).toHaveLength(2);
  });

  it("a raw WINS over a legacy line for the same id (no duplicate; the raw is the live source)", () => {
    // Same session+run in both raw/ and runs.jsonl -> the same external_id.
    writeRaw(rawRun({ id: "dup-1:1", run: 1, session_id: "dup-1", gold_gained: { ok: true, value: 125_000 } }));
    writeLegacyLine({ ts: 1_700_000_000, session_id: "dup-1", run: 1, status: "success", stage: "3-9", stageKey: 30901, mode: "Hell", total_damage: 4_500_000, clear_time: 90, duration: 92, gold_gained: 50_000, schema_version: 11, heroes: [] });
    const counts = ingestPending(dir);
    expect(counts.raws).toBe(1);
    expect(counts.legacy).toBe(0); // legacy line skipped — a log already exists for dup-1:1
    const logs = readLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].goldGained).toBe(125_000); // the raw's value, not the legacy 50_000
  });

  it("skips an un-parseable legacy line, migrating the rest", () => {
    const file = join(dir, "runs.jsonl");
    writeFileSync(file, "{ broken\n" + JSON.stringify({ ts: 1, session_id: "s", run: 1, status: "success", stage: "1-1", stageKey: 1001, mode: "Normal", total_damage: 500_000, clear_time: 30, duration: 31, gold_gained: 1_000, schema_version: 11, heroes: [] }) + "\n", "utf-8");
    expect(ingestPending(dir).legacy).toBe(1);
  });

  it("handles a missing runs.jsonl (no legacy file) gracefully", () => {
    writeRaw(rawRun());
    const counts = ingestPending(dir);
    expect(counts.legacy).toBe(0);
    expect(counts.raws).toBe(1);
  });

  // The in-place prod upgrade path (the universal state of every existing user): the OLD
  // logs-archive already mirrored each runs.jsonl run into logs/ as a bare normalizeRecord dump
  // with NO structuredSchemaVersion. A bare-presence skip would leave those unsealed; the staleness
  // guard re-converts them so the 1.00.10 bugged runs finally get sealed `degraded`.
  it("re-seals a bugged run whose pre-PR3 mirror log has NO structuredSchemaVersion (in-place upgrade)", () => {
    const bugged = { ts: 1_700_000_000, session_id: "1700000000-7", run: 3, status: "success", stage: "?", stageKey: null, mode: "?", total_damage: 4_500_000, clear_time: 90, duration: 92, gold_gained: 0, schema_version: 11, heroes: [] };
    writeLegacyLine(bugged);
    // Seed the OLD archive's mirror: same filename convention (`${ts}_${safeId}.json`), but a bare
    // dump — no structuredSchemaVersion, no quality, no issues (version null in the index).
    const ld = logsDir(dir);
    mkdirSync(ld, { recursive: true });
    const mirror = { id: "1700000000-7:3", ts: 1_700_000_000, sessionId: "1700000000-7", run: 3, status: "success", stage: "?", stageKey: null, mode: "?", goldGained: 0, schemaVersion: 11 };
    writeFileSync(join(ld, "1700000000_1700000000-7-3.json"), JSON.stringify(mirror), "utf-8");

    const counts = ingestPending(dir);
    expect(counts.legacy).toBe(1); // the unversioned mirror was re-converted (not skipped on presence)
    const logs = readLogs();
    expect(logs).toHaveLength(1); // overwritten in place (same filename), not duplicated
    expect(logs[0].quality).toBe("degraded");
    expect(logs[0].structuredSchemaVersion).toBe(STRUCTURED_SCHEMA_VERSION);
    expect(logs[0].issues!.gold_gained).toContain("1.00.10");
  });

  it("does NOT re-migrate a legacy line already at the CURRENT structured version (idempotent on upgrade)", () => {
    // A prior PR3 pass already sealed this run -> its log carries the current version. A second
    // ingest must leave it (the staleness guard skips current logs, not just present ones).
    const line = { ts: 5, session_id: "s", run: 1, status: "success", stage: "1-1", stageKey: 1001, mode: "Normal", total_damage: 500_000, clear_time: 30, duration: 31, gold_gained: 1_000, schema_version: 11, heroes: [] };
    writeLegacyLine(line);
    expect(ingestPending(dir).legacy).toBe(1);
    expect(ingestPending(dir).legacy).toBe(0); // already current — skipped
    expect(readLogs()).toHaveLength(1);
  });
});

// The per-file caches memoize FACTS about unchanged files (validated by a fresh stat every pass) —
// these pin the edges where the disk DID change and the caches must see it.
describe("ingestPending — per-file caches stay truthful (stat-validated every pass)", () => {
  it("picks up a legacy line APPENDED after a clean pass (the frozen-file fast path sees the change)", () => {
    writeLegacyLine({ ts: 2, session_id: "old", run: 1, status: "success", stage: "1-1", stageKey: 1001, mode: "Normal", total_damage: 700_000, clear_time: 40, duration: 41, gold_gained: 9_000, schema_version: 11, heroes: [] });
    expect(ingestPending(dir).legacy).toBe(1);
    expect(ingestPending(dir).legacy).toBe(0); // clean pass -> fast path armed
    // Append another line: the size/mtime change must disarm the fast path; ONLY the new line migrates.
    writeLegacyLine({ ts: 3, session_id: "old", run: 2, status: "success", stage: "1-2", stageKey: 1002, mode: "Normal", total_damage: 800_000, clear_time: 42, duration: 43, gold_gained: 9_500, schema_version: 11, heroes: [] });
    expect(ingestPending(dir).legacy).toBe(1);
    expect(readLogs()).toHaveLength(2);
  });

  it("re-converts from raw when a CURRENT log is downgraded IN PLACE (logs facts re-stat)", () => {
    writeRaw(rawRun());
    expect(ingestPending(dir).raws).toBe(1);
    expect(ingestPending(dir).raws).toBe(0); // warm caches: a steady-state pass converts nothing
    // Downgrade the log in place (what an older converter's file looks like) and push the mtime
    // forward so the invalidation never depends on filesystem clock granularity.
    const ld = logsDir(dir);
    const name = readdirSync(ld).find((n) => n.endsWith(".json"))!;
    const rec = JSON.parse(readFileSync(join(ld, name), "utf-8")) as RunRecord;
    writeFileSync(join(ld, name), JSON.stringify({ ...rec, structuredSchemaVersion: 0 }), "utf-8");
    const bumped = new Date(statSync(join(ld, name)).mtimeMs + 5_000);
    utimesSync(join(ld, name), bumped, bumped);
    expect(ingestPending(dir).raws).toBe(1); // the stat saw the change -> stale version -> re-converted
    expect(readLogs()[0].structuredSchemaVersion).toBe(STRUCTURED_SCHEMA_VERSION);
  });
});

describe("ingestPending — crash recovery", () => {
  it("recovers raws that have no log yet after an interrupted run (the boot self-heal)", () => {
    // Simulate: reader wrote 3 raws, the app crashed before converting any.
    writeRaw(rawRun({ id: "s:1", run: 1 }));
    writeRaw(rawRun({ id: "s:2", run: 2 }));
    writeRaw(rawRun({ id: "s:3", run: 3 }));
    // Boot ingest picks up all three.
    expect(ingestPending(dir).raws).toBe(3);
    expect(readLogs()).toHaveLength(3);
  });

  it("an atomic write leaves no .tmp behind on success", () => {
    writeRaw(rawRun());
    ingestPending(dir);
    const leftover = readdirSync(logsDir(dir)).filter((n) => n.endsWith(".tmp"));
    expect(leftover).toEqual([]);
  });
});

describe("ingestOne — single-file re-convert (PR4 on-use staleness)", () => {
  it("re-converts a single raw by filename and returns the fresh record", () => {
    writeRaw(rawRun());
    const record = ingestOne(dir, "sess-1-1.json");
    expect(record).not.toBeNull();
    expect(record!.id).toBe("sess-1:1");
    expect(readLogs()).toHaveLength(1);
  });

  it("returns null for a missing raw file", () => {
    expect(ingestOne(dir, "does-not-exist.json")).toBeNull();
  });

  it("returns null for a parseable-but-malformed raw (convert throws -> skip, not crash)", () => {
    const rd = rawDir(dir);
    mkdirSync(rd, { recursive: true });
    const bad = { ...rawRun(), heroes: { ok: true, value: null } } as unknown as RawRun;
    writeFileSync(join(rd, "sess-1-1.json"), JSON.stringify(bad), "utf-8");
    expect(ingestOne(dir, "sess-1-1.json")).toBeNull();
  });
});

// The live wiring index.ts actually runs: getIngestor().setDir(dir).start(). Drive it with fake
// timers and assert via on-disk logs/ — the deterministic path is the POLL (entry-count change
// detection), not fs.watch (which fires off a libuv thread and won't flush under fake timers).
describe("Ingestor — boot pass + poll-driven watch (the index.ts wiring)", () => {
  let rec: Ingestor;

  beforeEach(() => {
    vi.useFakeTimers();
    rec = new Ingestor();
  });

  afterEach(() => {
    rec.stop();
    vi.useRealTimers();
  });

  it("boot pass: start() with a raw present converts it immediately", () => {
    writeRaw(rawRun({ id: "sess-1:1", run: 1 }));
    rec.setDir(dir);
    rec.start(); // runs a boot ingest synchronously
    expect(readLogs()).toHaveLength(1);
    expect(readLogs()[0].id).toBe("sess-1:1");
  });

  it("poll: a NEW raw appearing after start is converted on the next poll tick", () => {
    writeRaw(rawRun({ id: "sess-1:1", run: 1 }));
    rec.setDir(dir);
    rec.start();
    expect(readLogs()).toHaveLength(1);

    // A second run finishes -> a new raw file. The poll detects the entry-count change and ingests.
    writeRaw(rawRun({ id: "sess-1:2", run: 2 }));
    vi.advanceTimersByTime(1_000); // POLL_INTERVAL_MS
    expect(readLogs()).toHaveLength(2);
  });

  it("setDir while started re-runs the boot pass against the new dir", () => {
    rec.start(); // no dir yet -> nothing
    expect(readLogs()).toEqual([]);
    writeRaw(rawRun({ id: "sess-1:1", run: 1 }));
    rec.setDir(dir); // points at a dir with a raw already present -> immediate pass
    expect(readLogs()).toHaveLength(1);
  });

  it("stop() halts the poll — a raw written after stop is NOT converted", () => {
    rec.setDir(dir);
    rec.start();
    rec.stop();
    writeRaw(rawRun({ id: "sess-1:9", run: 9 }));
    vi.advanceTimersByTime(5_000); // several poll intervals — but the interval was cleared
    expect(readLogs()).toEqual([]);
  });
});
