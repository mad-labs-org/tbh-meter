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
  // Forward the reason arg so the test can assert "expired" vs "manual".
  clearSession: (reason?: string) => clearSession(reason),
}));
vi.mock("../settings.js", () => ({ getSettings: () => ({}) }));
vi.mock("../device-id.js", () => ({ getDeviceId: () => "device-uuid" }));
vi.mock("../runs-store.js", () => ({ getRun: () => null }));
const reportError = vi.fn();
vi.mock("../error-report.js", () => ({
  reportError: (...args: unknown[]) => reportError(...args),
  describeCause: () => ({}),
}));
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
  reportError.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadRun 401 -> clearSession", () => {
  it("clears the session as 'expired' on a 401 (expired token, no refresh)", async () => {
    mockFetchStatus(401);
    const res = await uploadRun(run());
    expect(res.ok).toBe(false);
    expect(clearSession).toHaveBeenCalledTimes(1);
    // "expired" (not "manual") so the renderer prompts a re-sign-in instead of
    // going silently offline.
    expect(clearSession).toHaveBeenCalledWith("expired");
  });

  it("pings session-expired telemetry on a 401 (the 401 is suppressed from the upload-failed relay)", async () => {
    mockFetchStatus(401);
    await uploadRun(run());
    expect(reportError).toHaveBeenCalledWith(
      "auth:session-expired",
      expect.any(String),
      expect.objectContaining({ status: 401 }),
    );
  });

  it("does NOT clear the session on a non-401 4xx (a payload rejection)", async () => {
    mockFetchStatus(400);
    const res = await uploadRun(run());
    expect(res.ok).toBe(false);
    expect(clearSession).not.toHaveBeenCalled();
  });

  it("does NOT clear the session on a 403 (run-signature rejection, not auth)", async () => {
    // The run-signature gate (REQUIRE_RUN_SIGNATURE) returns 403, not 401. A logged-in
    // user with a valid token but a bad/clock-skewed/missing signature must stay signed
    // in (the 2026-06-19 regression: a signature 401 signed users out). Surfacing the
    // "forbidden" code lets auto-upload abort the cycle without dropping the session.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 403,
        json: async () => ({ error: { code: "forbidden", message: "Request signature verification failed." } }),
      })),
    );
    const res = await uploadRun(run());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("forbidden");
    expect(clearSession).not.toHaveBeenCalled();
  });
});
