import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../shared/run-types.js";

// share.ts uploads with the Discord bearer; on a 401 (the ~30d HS256 token
// expired — there is NO refresh token) it must terminally clearSession() so the
// app drops to signed-out. This pins that branch: 401-with-token clears, while a
// non-401 4xx (a payload rejection) leaves the session intact.

// share.ts + its config.js/error-report.js graph touch electron at module scope.
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0-test", getPath: () => "/tmp" },
}));

const clearSession = vi.fn();
vi.mock("../auth.js", () => ({
  getAccessToken: async () => "bearer-token",
  clearSession: () => clearSession(),
}));
vi.mock("../settings.js", () => ({ getSettings: () => ({}) }));
vi.mock("../device-id.js", () => ({ getDeviceId: () => "device-uuid" }));
vi.mock("../runs-store.js", () => ({ getRun: () => null }));
vi.mock("../error-report.js", () => ({ reportError: () => {}, describeCause: () => ({}) }));
// uploadRun posts via httpFetch (Electron net) — delegate to the stubbed global fetch.
vi.mock("../net-fetch.js", () => ({
  httpFetch: (input: string | GlobalRequest, init?: RequestInit) => fetch(input, init),
}));

const { uploadRun } = await import("../share.js");

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "sess-1:7",
    ts: 1_750_000_000,
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

function mockFetchStatus(status: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      status,
      json: async () => ({ error: { code: "x", message: "nope" } }),
    })),
  );
}

beforeEach(() => {
  clearSession.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadRun 401 -> clearSession", () => {
  it("clears the session on a 401 (expired token, no refresh)", async () => {
    mockFetchStatus(401);
    const res = await uploadRun(run());
    expect(res.ok).toBe(false);
    expect(clearSession).toHaveBeenCalledTimes(1);
  });

  it("does NOT clear the session on a non-401 4xx (a payload rejection)", async () => {
    mockFetchStatus(400);
    const res = await uploadRun(run());
    expect(res.ok).toBe(false);
    expect(clearSession).not.toHaveBeenCalled();
  });
});
