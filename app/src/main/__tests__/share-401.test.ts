import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../shared/run-types.js";

// share.ts uploads with the Discord bearer; on a 401 it now tries refreshAccessToken()
// first. With a refresh token it refreshes + retries ONCE; with a legacy session
// (no refresh token → refreshAccessToken returns false) the 401 stays terminal and
// it clearSession()s as before. This pins both: legacy-401 clears, a refresh-backed
// 401 recovers, and a non-401 4xx (a payload rejection) leaves the session intact.

// share.ts + its config.js/error-report.js graph touch electron at module scope.
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0-test", getPath: () => "/tmp" },
}));

const clearSession = vi.fn();
// Mutable per-test: the bearer getAccessToken hands back, and whether a refresh
// succeeds. Default mirrors a LEGACY session — a token but no refresh capability —
// so the inherited 401 assertions exercise the terminal path unchanged.
const authState = { token: "bearer-token" as string | null, refreshOk: false };
const refreshAccessToken = vi.fn(async () => authState.refreshOk);
vi.mock("../auth.js", () => ({
  getAccessToken: async () => authState.token,
  // Forward the reason arg so the test can assert "expired" vs "manual".
  clearSession: (reason?: string) => clearSession(reason),
  refreshAccessToken: () => refreshAccessToken(),
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
  refreshAccessToken.mockClear();
  authState.token = "bearer-token";
  authState.refreshOk = false;
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

describe("uploadRun 401 -> refresh (refresh-token sessions)", () => {
  it("refreshes, retries ONCE with the new token, and succeeds", async () => {
    authState.refreshOk = true;
    // The refresh rotates the token; getAccessToken returns the NEW one for the retry.
    refreshAccessToken.mockImplementationOnce(async () => {
      authState.token = "bearer-token-refreshed";
      return true;
    });

    // First POST 401s; the retry (after refresh) 200s. Capture the retry's bearer.
    const fetchSpy = vi.fn();
    fetchSpy
      .mockImplementationOnce(async () => ({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: "unauthorized", message: "expired" } }),
      }))
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        const headers = init.headers as Record<string, string>;
        expect(headers["Authorization"]).toBe("Bearer bearer-token-refreshed");
        return { ok: true, status: 200, json: async () => ({ id: "run-99", duplicate: false }) };
      });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await uploadRun(run());

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // original + exactly one retry
    expect(res.ok).toBe(true);
    expect(clearSession).not.toHaveBeenCalled(); // recovered, not signed out
  });

  it("clears the session as 'expired' when the refresh fails", async () => {
    authState.refreshOk = false; // refresh can't recover → terminal 401
    mockFetchStatus(401);

    const res = await uploadRun(run());

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(false);
    expect(clearSession).toHaveBeenCalledWith("expired");
  });

  it("does NOT loop: a second 401 after a successful refresh is terminal", async () => {
    authState.refreshOk = true;
    // Both attempts 401 (e.g. the freshly-refreshed token is itself rejected). The
    // retry must fire exactly once — no refresh/retry loop — then clearSession.
    mockFetchStatus(401);

    const res = await uploadRun(run());

    expect(refreshAccessToken).toHaveBeenCalledTimes(1); // refreshed once, never re-tried
    expect(res.ok).toBe(false);
    expect(clearSession).toHaveBeenCalledWith("expired");
  });
});
