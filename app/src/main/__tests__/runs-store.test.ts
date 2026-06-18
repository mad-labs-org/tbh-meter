import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// clearAllRuns wipes the data dir, which logs-archive resolves via settings.resolveOutputDir() ->
// dataDir(). settings.ts imports electron, so mock getPath to a temp dir, then point the output dir
// at our own temp `dataDir` via updateSettings({ outputDir }). The reader's raw/ MUST be wiped too:
// since PR3 the Ingestor converts any raw with no log back into logs/, so a raw left after a clear
// would resurrect a cleared run on the next boot (the regression this test guards).

const userData = mkdtempSync(join(tmpdir(), "tbh-runs-store-ud-"));
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => userData },
}));

import { clearAllRuns, pruneToMaxRuns } from "../runs-store.js";
import { updateSettings } from "../settings.js";
import { getRunsSource } from "../sources/runs-source.js";
import { toggleFavorite, invalidateFavoritesCache } from "../favorites-store.js";
import { deleteRunFiles, removeLegacyLines } from "../logs-archive.js";
import { ingestPending, rawDir, logsDir } from "../converter/ingest.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tbh-runs-store-"));
  updateSettings({ outputDir: dir }); // dataDir() now resolves here
  invalidateFavoritesCache(); // favorites.json lives in `dir` — drop any cache from a prior temp dir
  getRunsSource().setDir(dir);
});

afterEach(() => {
  getRunsSource().stop();
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(userData, { recursive: true, force: true });
});

function jsonNames(d: string): string[] {
  try {
    return readdirSync(d).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
}

function seedRun(): void {
  // A legacy line in runs.jsonl (what the app still reads in PR3)...
  const line = { ts: 1, session_id: "s", run: 1, status: "success", stage: "1-1", stageKey: 1001, mode: "Normal", total_damage: 500_000, clear_time: 30, duration: 31, gold_gained: 1_000, schema_version: 11, heroes: [] };
  writeFileSync(join(dir, "runs.jsonl"), JSON.stringify(line) + "\n", "utf-8");
  // ...a reader raw/ for it...
  const rd = rawDir(dir);
  mkdirSync(rd, { recursive: true });
  const raw = { raw_schema_version: 1, id: "s:1", ts: 1, run: 1, run_outcome: "success", session_id: "s", game_version: "1.00.10", duration: 31, stageKey: { ok: true, value: 1001 }, act: { ok: true, value: 1 }, stageNo: { ok: true, value: 1 }, difficulty: { ok: true, value: 0 }, total_mobs: { ok: true, value: 10 }, mobs: { ok: true, value: 10 }, total_damage: { ok: true, value: 500_000 }, clear_time: { ok: true, value: 30 }, gold_gained: { ok: true, value: 1_000 }, gold_source: "live", xp_gained: { ok: true, value: 100 }, xp_source: "live", drops: { ok: true, value: [] }, heroes: { ok: true, value: [] } };
  writeFileSync(join(rd, "s-1.json"), JSON.stringify(raw), "utf-8");
  // ...and a structured log/ for it (as the Ingestor would have produced).
  ingestPending(dir);
}

describe("clearAllRuns", () => {
  it("wipes runs.jsonl, logs/ AND raw/ (raw must go or the Ingestor resurrects it)", () => {
    seedRun();
    expect(jsonNames(rawDir(dir)).length).toBe(1);
    expect(jsonNames(logsDir(dir)).length).toBe(1);

    expect(clearAllRuns()).toBe(true);

    expect(jsonNames(rawDir(dir))).toEqual([]); // the fix: raw/ is wiped too
    expect(jsonNames(logsDir(dir))).toEqual([]);
  });

  it("a cleared run is NOT resurrected by the next ingest pass (the PR3 landmine, fixed)", () => {
    seedRun();
    clearAllRuns();
    // Boot ingest after the clear: with raw/ wiped there is nothing to convert.
    ingestPending(dir);
    expect(jsonNames(logsDir(dir))).toEqual([]); // stays empty — no resurrection
  });

  it("spares favorited runs and deletes the rest (Feature 3)", () => {
    // Three v2 runs; favorite the middle one. clearAllRuns must keep only it.
    seedV2Run(1000);
    seedV2Run(2000);
    seedV2Run(3000);
    getRunsSource().reloadNow();
    expect(getRunsSource().all().length).toBe(3);

    toggleFavorite("2000");
    getRunsSource().reloadNow();

    expect(clearAllRuns()).toBe(true);

    const remaining = getRunsSource().all().map((r) => r.id);
    expect(remaining).toEqual(["2000"]);
    // The favorite's raw + log survive; the others' files are gone (no resurrection on re-ingest).
    ingestPending(dir);
    getRunsSource().reloadNow();
    expect(getRunsSource().all().map((r) => r.id)).toEqual(["2000"]);
  });
});

describe("pruneToMaxRuns (Feature 2)", () => {
  it("deletes the oldest non-favorited runs down to the cap, sparing favorites", () => {
    // 12 runs (ts 1000..12000). cap = MIN_MAX_RUNS (10, the lowest a user can set). Favorite the
    // OLDEST (1000) so it survives despite being oldest AND is not counted toward the cap.
    const all: number[] = [];
    for (let i = 1; i <= 12; i++) all.push(i * 1000);
    for (const ts of all) seedV2Run(ts);
    getRunsSource().reloadNow();
    toggleFavorite("1000");
    updateSettings({ maxRuns: 10 });

    const deleted = pruneToMaxRuns();
    // non-favs = the 11 runs 2000..12000; keep the 10 newest (3000..12000), delete only 2000.
    expect(deleted).toBe(1);
    const ids = getRunsSource().all().map((r) => Number(r.id)).sort((a, b) => a - b);
    expect(ids).not.toContain(2000); // oldest non-fav pruned
    expect(ids).toContain(1000); // favorite kept despite being oldest
    expect(ids.length).toBe(11); // 1 favorite + 10 capped non-favorites
    // No resurrection: the pruned run's raw + legacy line are gone too.
    ingestPending(dir);
    getRunsSource().reloadNow();
    expect(getRunsSource().all().map((r) => Number(r.id))).not.toContain(2000);
  });

  it("is a no-op under the cap and when the cap is off", () => {
    seedV2Run(1000);
    seedV2Run(2000);
    getRunsSource().reloadNow();
    updateSettings({ maxRuns: 100 });
    expect(pruneToMaxRuns()).toBe(0);
    updateSettings({ maxRuns: null });
    expect(pruneToMaxRuns()).toBe(0);
    expect(getRunsSource().all().length).toBe(2);
  });
});

describe("deleteRunFiles (batch + safeId-collision guard, B1)", () => {
  it("deletes only the files whose EMBEDDED id is in the set — a safeId collision is NOT deleted", () => {
    const logs = logsDir(dir);
    mkdirSync(logs, { recursive: true });
    // Two ids that SANITIZE to the same filename suffix (':' and '|' both map to '-'): only the
    // exact target must be deleted, never its collision twin.
    writeFileSync(join(logs, "1_a-1.json"), JSON.stringify({ id: "a:1", ts: 1 }), "utf-8");
    writeFileSync(join(logs, "2_a-1.json"), JSON.stringify({ id: "a|1", ts: 2 }), "utf-8");

    const removed = deleteRunFiles(new Set(["a:1"]));
    expect(removed).toBe(1);
    const left = jsonNames(logs);
    expect(left).toContain("2_a-1.json"); // the collision twin survives (different embedded id)
    expect(left).not.toContain("1_a-1.json");
  });

  it("removes the matching raw/<stem>.json for each id (orphan that would resurrect)", () => {
    const rd = rawDir(dir);
    mkdirSync(rd, { recursive: true });
    writeFileSync(join(rd, "9000.json"), JSON.stringify({ id: "9000", ts: 9000 }), "utf-8");
    writeFileSync(join(rd, "s-7.json"), JSON.stringify({ id: "s:7", ts: 7 }), "utf-8"); // ':' -> '-'

    deleteRunFiles(new Set(["9000", "s:7"]));
    expect(jsonNames(rd)).toEqual([]);
  });
});

describe("removeLegacyLines (index preservation + idx: blanking, B2)", () => {
  it("blanks a removed line IN PLACE so a later id-less line keeps its idx: identity", () => {
    // Line 0 = a run-bearing line (id s:1); line 1 = a RUN-LESS line (id derives from index → idx:1).
    const l0 = JSON.stringify({ ts: 1, session_id: "s", run: 1, status: "success", heroes: [] });
    const l1 = JSON.stringify({ ts: 2, status: "success", stage: "1-1", heroes: [] }); // no run → idx:1
    writeFileSync(join(dir, "runs.jsonl"), `${l0}\n${l1}\n`, "utf-8");

    removeLegacyLines(new Set(["s:1"]));

    const out = readFileSync(join(dir, "runs.jsonl"), "utf-8").split("\n");
    expect(out[0]).toBe(""); // dropped line BLANKED, not omitted
    expect(out[1]).toBe(l1); // the id-less line stays at index 1 → its idx:1 identity is preserved
  });

  it("blanks a pruned idx:N run so it does NOT resurrect (the keep-id-null bug, fixed)", () => {
    const l0 = JSON.stringify({ ts: 5, status: "success", stage: "1-1", heroes: [] }); // idx:0
    writeFileSync(join(dir, "runs.jsonl"), `${l0}\n`, "utf-8");

    removeLegacyLines(new Set(["idx:0"]));

    const out = readFileSync(join(dir, "runs.jsonl"), "utf-8").split("\n");
    expect(out[0]).toBe(""); // the idx:0 run's line is blanked → migrator skips it → no resurrection
  });

  it("leaves an un-parseable / non-target line untouched", () => {
    writeFileSync(join(dir, "runs.jsonl"), "not json\n" + JSON.stringify({ ts: 1, session_id: "s", run: 1 }) + "\n", "utf-8");
    removeLegacyLines(new Set(["s:9"])); // no match
    const out = readFileSync(join(dir, "runs.jsonl"), "utf-8").split("\n");
    expect(out[0]).toBe("not json");
  });
});

function seedV2Run(ts: number): void {
  const rd = rawDir(dir);
  mkdirSync(rd, { recursive: true });
  const raw = {
    raw_schema_version: 2,
    id: String(ts),
    ts,
    run_outcome: "success",
    game_version: "1.00.11",
    duration: 90,
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
  };
  writeFileSync(join(rd, `${ts}.json`), JSON.stringify(raw), "utf-8");
  ingestPending(dir);
}
