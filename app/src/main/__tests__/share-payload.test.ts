import { describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../shared/run-types.js";

// share.ts (and its config.js import) touch electron at module scope.
vi.mock("electron", () => ({ app: { getVersion: () => "0.0.0-test", getPath: () => "/tmp" } }));
vi.mock("../auth.js", () => ({ getAccessToken: () => null }));
vi.mock("../runs-store.js", () => ({ getRun: () => null }));
vi.mock("../error-report.js", () => ({ reportError: () => {}, describeCause: () => ({}) }));

const { buildPayload } = await import("../share.js");

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "sess-1:7",
    ts: 1_750_000_000, // epoch SECONDS, as written by the reader
    sessionId: "sess-1",
    schemaVersion: 11,
    gameVersion: "1.0.0",
    run: 7,
    status: "success",
    stage: "3-9",
    act: 3,
    stageNo: 9,
    stageKey: 309,
    mode: "Hell",
    mobs: 487,
    totalMobs: 487,
    totalDamage: 4_520_000,
    dps: 19_590,
    clearTime: 217,
    duration: 219,
    goldGained: 500_000,
    goldSource: "delta",
    xpGained: 10_300_000,
    xpSource: "delta",
    xpPerSec: 47_465,
    goldPerSec: 2_304,
    partial: false,
    heroes: [{ heroKey: 201, class: "Knight", level: 80, skills: [], items: [] }],
    ...overrides,
  } as RunRecord;
}

// A complete RunHero, optionally carrying the reader's live FINAL stats.
function hero(stats: Record<string, number>): RunRecord["heroes"][number] {
  return { heroKey: 201, class: "Knight", classId: null, level: 80, exp: 0, skills: [], items: [], stats };
}

describe("buildPayload hero stats passthrough", () => {
  it("forwards the reader's live FINAL stats when the run carries them", () => {
    const payload = buildPayload(run({ heroes: [hero({ "1": 4184.82, "2": 1.11 })] }));
    expect(payload.party[0]!.stats).toEqual({ "1": 4184.82, "2": 1.11 });
  });

  it("omits stats when the reader provided none — reverting the passthrough would fail here", () => {
    const payload = buildPayload(run({ heroes: [hero({})] }));
    expect(payload.party[0]!.stats).toBeUndefined();
  });
});

describe("buildPayload endedAt", () => {
  it("converts the reader's epoch-seconds ts to epoch ms", () => {
    expect(buildPayload(run()).endedAt).toBe(1_750_000_000_000);
  });

  it("omits endedAt when ts is corrupt, instead of failing the upload", () => {
    expect(buildPayload(run({ ts: 0 })).endedAt).toBeUndefined();
    expect(buildPayload(run({ ts: Number.NaN })).endedAt).toBeUndefined();
    // pre-2020 / absurd-future values fall outside the API schema bounds
    expect(buildPayload(run({ ts: 1 })).endedAt).toBeUndefined();
    expect(buildPayload(run({ ts: 4_102_444_801 })).endedAt).toBeUndefined();
  });
});
