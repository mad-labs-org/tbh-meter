import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../shared/run-types.js";

// Auto-uploader gate test (PR4 fix): before PR4 the app's read path dropped success-partials via
// cleanRecords, so they never reached the uploader. PR4 made the read path read pre-converted logs/
// (no cleanRecords), so the partial/degraded/skipped filter moved onto eligible() — onto the
// converter's sealed `quality` verdict. This asserts the redesign's "Upload: Degradada/parcial/
// skipped NÃO sobe" (progress.md): only a `counted` (or un-sealed legacy) success uploads.
//
// eligible() is module-private, so we drive the PUBLIC cycle (requestUploadNow -> runCycle) and
// assert WHICH runs uploadRun was called with — testing the real selection end-to-end.

const records: RunRecord[] = [];
const uploadRun = vi.fn(async (run: RunRecord) => ({ ok: true as const, url: `https://x/${run.id}` }));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/tbh-auto-upload-test", getAppPath: () => "/tmp" },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("../sources/runs-source.js", () => ({
  getRunsSource: () => ({ all: () => records }),
}));
vi.mock("../auth.js", () => ({ getAccessToken: async () => "token" }));
vi.mock("../settings.js", () => ({ getSettings: () => ({}) }));
vi.mock("../share.js", () => ({
  uploadRun: (run: RunRecord) => uploadRun(run),
  isUploaded: () => false,
  claimDeviceRuns: async () => {},
}));

import { requestUploadNow } from "../auto-upload.js";

/** A clean, leaderboard-eligible success run (the only class that SHOULD upload). */
function countedRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "sess-1:1",
    ts: 1_700_000_000,
    sessionId: "sess-1",
    schemaVersion: 1,
    structuredSchemaVersion: 1,
    gameVersion: "1.00.10",
    run: 1,
    status: "success",
    quality: "counted",
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
    issues: {},
    heroes: [{ heroKey: 1, class: "", classId: null, level: 1, exp: 0, items: [], skills: [], stats: {} }],
    ...overrides,
  };
}

/** Run one upload cycle and return the ids uploadRun was called with. */
async function uploadedIds(): Promise<string[]> {
  requestUploadNow();
  // requestUploadNow fires runCycle() fire-and-forget; let its awaits (getAccessToken etc.) settle.
  await new Promise((r) => setTimeout(r, 10));
  return uploadRun.mock.calls.map((c) => c[0].id);
}

beforeEach(() => {
  records.length = 0;
  uploadRun.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("auto-upload eligible() — only the converter's `counted` verdict uploads", () => {
  it("uploads a counted success run", async () => {
    records.push(countedRun());
    expect(await uploadedIds()).toEqual(["sess-1:1"]);
  });

  it("does NOT upload a partial success run (under-counted capture)", async () => {
    // A late-join capture: status success, positive-but-under-counted damage, valid stage+heroes —
    // it passes every OTHER predicate, so only the quality gate keeps it off the leaderboard.
    records.push(countedRun({ id: "p:1", quality: "partial", partial: true }));
    expect(await uploadedIds()).toEqual([]);
  });

  it("does NOT upload a degraded success run (a critical field was unreadable)", async () => {
    // The 1.00.10 class: gold/stage read failed, but stageKey+damage present -> would otherwise pass.
    records.push(countedRun({ id: "d:1", quality: "degraded", issues: { gold_gained: "err" } }));
    expect(await uploadedIds()).toEqual([]);
  });

  it("does NOT upload a skipped success run (below the floor / not a clean count)", async () => {
    records.push(countedRun({ id: "s:1", quality: "skipped", duration: 5, clearTime: 5 }));
    expect(await uploadedIds()).toEqual([]);
  });

  it("uploads ONLY the counted run out of a mixed batch", async () => {
    records.push(
      countedRun({ id: "ok:1" }),
      countedRun({ id: "p:1", quality: "partial", partial: true }),
      countedRun({ id: "d:1", quality: "degraded" }),
      countedRun({ id: "sk:1", quality: "skipped" }),
    );
    expect((await uploadedIds()).sort()).toEqual(["ok:1"]);
  });

  it("still uploads an un-sealed legacy-mirror run (no quality field — absent treated as uploadable)", async () => {
    // A pre-PR3 mirror log lacks `quality`. Requiring quality==="counted" would wrongly stop these;
    // the gate excludes only the FLAGGED verdicts, so an un-migrated mirror keeps uploading as before.
    const legacy = countedRun({ id: "old:1" });
    delete legacy.quality;
    records.push(legacy);
    expect(await uploadedIds()).toEqual(["old:1"]);
  });
});
