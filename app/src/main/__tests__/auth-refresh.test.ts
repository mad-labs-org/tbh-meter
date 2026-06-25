import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Refresh-token client (issue #62). Exercises the lazy/single-flight refresh in
// getAccessToken + refreshAccessToken, the code-exchange sign-in branch, and the
// best-effort logout — all against a MOCKED httpFetch so no real network is hit.
//
// Mirrors auth.test.ts: userData points at a temp dir (so we never touch a real
// install's auth-session.json), broadcast is spied, and each session-file scenario
// re-imports a fresh auth.js (its session state is module-memoized).

const dir = mkdtempSync(join(tmpdir(), "tbh-auth-refresh-"));
// openExternal is captured so the end-to-end signIn test can read the login URL
// (and its state nonce) the flow opens, then drive the loopback callback by hand.
const openExternal = vi.fn();
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => dir },
  shell: { openExternal: (url: string) => openExternal(url) },
  BrowserWindow: { getAllWindows: () => [] },
}));

const broadcast = vi.fn();
vi.mock("../broadcast.js", () => ({ broadcast: (...args: unknown[]) => broadcast(...args) }));

// The single mocked HTTP surface. Each test installs a handler that inspects the
// URL + parsed body and returns a fake Response. Calls are recorded for assertions.
type FetchCall = { url: string; init: RequestInit; body: unknown };
const fetchCalls: FetchCall[] = [];
let fetchHandler: (call: FetchCall) => Promise<unknown> = async () => {
  throw new Error("no httpFetch handler installed");
};
vi.mock("../net-fetch.js", () => ({
  httpFetch: async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const call: FetchCall = { url, init, body };
    fetchCalls.push(call);
    return fetchHandler(call);
  },
}));

const sessionPath = join(dir, "auth-session.json");

function jsonOk(status: number, payload: unknown): unknown {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function readPersisted(): Record<string, unknown> {
  return JSON.parse(readFileSync(sessionPath, "utf-8")) as Record<string, unknown>;
}

async function freshAuth() {
  vi.resetModules();
  return import("../auth.js");
}

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(sessionPath, { force: true });
  broadcast.mockClear();
  openExternal.mockReset();
  fetchCalls.length = 0;
  fetchHandler = async () => {
    throw new Error("no httpFetch handler installed");
  };
});

/** Wait until the predicate holds (polling) — small helper for the async loopback. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// --------------------------------------------------------------------------- //
// getAccessToken — refresh awareness.
// --------------------------------------------------------------------------- //

describe("getAccessToken refresh behavior", () => {
  it("returns the stored token unchanged when NOT near expiry (no refresh call)", async () => {
    writeFileSync(
      sessionPath,
      JSON.stringify({
        accessToken: "still-valid",
        refreshToken: "refresh-1",
        accessExpiresAt: Date.now() + 60 * 60 * 1000, // an hour out
      }),
      "utf-8",
    );
    const auth = await freshAuth();
    expect(await auth.getAccessToken()).toBe("still-valid");
    expect(fetchCalls).toHaveLength(0); // no refresh while comfortably valid
  });

  it("refreshes near expiry, persists the ROTATED tokens, and returns the new access token", async () => {
    writeFileSync(
      sessionPath,
      JSON.stringify({
        accessToken: "about-to-expire",
        refreshToken: "refresh-old",
        accessExpiresAt: Date.now() + 5_000, // inside the 60s skew window
        profile: { displayName: "Mario" },
      }),
      "utf-8",
    );
    const newExpiry = Date.now() + 24 * 60 * 60 * 1000;
    fetchHandler = async (call) => {
      expect(call.url).toContain("/auth/refresh");
      expect(call.body).toEqual({ refreshToken: "refresh-old" });
      return jsonOk(200, {
        accessToken: "access-new",
        refreshToken: "refresh-rotated",
        accessExpiresAt: newExpiry,
      });
    };

    const auth = await freshAuth();
    expect(await auth.getAccessToken()).toBe("access-new");

    // The rotated refresh token MUST be persisted (replaying the old one would get
    // every session revoked server-side). Profile is preserved.
    const persisted = readPersisted();
    expect(persisted.accessToken).toBe("access-new");
    expect(persisted.refreshToken).toBe("refresh-rotated");
    expect(persisted.accessExpiresAt).toBe(newExpiry);
    expect(persisted.profile).toEqual({ displayName: "Mario" });
  });

  it("clears the session as 'expired' when a near-expiry refresh 401s", async () => {
    writeFileSync(
      sessionPath,
      JSON.stringify({
        accessToken: "about-to-expire",
        refreshToken: "refresh-dead",
        accessExpiresAt: Date.now() + 5_000,
      }),
      "utf-8",
    );
    fetchHandler = async () => jsonOk(401, { error: { code: "unauthorized" } });

    const auth = await freshAuth();
    expect(await auth.getAccessToken()).toBeNull();
    expect(existsSync(sessionPath)).toBe(false); // session cleared
    expect(broadcast).toHaveBeenCalledWith("meter:session-expired");
  });
});

// --------------------------------------------------------------------------- //
// Legacy session — accessToken only, no refresh capability.
// --------------------------------------------------------------------------- //

describe("legacy session (no refreshToken)", () => {
  it("getAccessToken returns the legacy token and refreshAccessToken makes NO network call", async () => {
    // A legacy ~30d token has no accessExpiresAt and no refreshToken: it is never
    // 'near expiry' (no expiry field) and cannot be refreshed.
    writeFileSync(sessionPath, JSON.stringify({ accessToken: "legacy-30d" }), "utf-8");
    const auth = await freshAuth();

    expect(await auth.getAccessToken()).toBe("legacy-30d");
    expect(await auth.refreshAccessToken()).toBe(false);
    expect(fetchCalls).toHaveLength(0); // nothing to refresh with
  });
});

// --------------------------------------------------------------------------- //
// refreshAccessToken — single-flight.
// --------------------------------------------------------------------------- //

describe("refreshAccessToken single-flight", () => {
  it("two concurrent callers share ONE /auth/refresh request", async () => {
    writeFileSync(
      sessionPath,
      JSON.stringify({
        accessToken: "a",
        refreshToken: "refresh-1",
        accessExpiresAt: Date.now() + 5_000,
      }),
      "utf-8",
    );

    // Hold the in-flight refresh open until both callers have entered, proving they
    // share one request (a second rotation would revoke one of the two tokens).
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fetchHandler = async () => {
      await gate;
      return jsonOk(200, {
        accessToken: "access-new",
        refreshToken: "refresh-2",
        accessExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
      });
    };

    const auth = await freshAuth();
    const p1 = auth.refreshAccessToken();
    const p2 = auth.refreshAccessToken();
    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(fetchCalls).toHaveLength(1); // exactly one network refresh, shared
  });
});

// --------------------------------------------------------------------------- //
// signOut — best-effort revoke before clearing.
// --------------------------------------------------------------------------- //

describe("signOut logout call", () => {
  it("POSTs /auth/logout with the refresh token, then clears the session", async () => {
    writeFileSync(
      sessionPath,
      JSON.stringify({ accessToken: "a", refreshToken: "refresh-1", accessExpiresAt: Date.now() + 1_000_000 }),
      "utf-8",
    );
    fetchHandler = async (call) => {
      expect(call.url).toContain("/auth/logout");
      expect(call.body).toEqual({ refreshToken: "refresh-1" });
      return jsonOk(200, { ok: true });
    };

    const auth = await freshAuth();
    await auth.getAccessToken(); // force load so signOut sees the session
    await auth.signOut();

    expect(fetchCalls.some((c) => c.url.includes("/auth/logout"))).toBe(true);
    expect(existsSync(sessionPath)).toBe(false); // local session cleared regardless
  });

  it("skips the logout call for a legacy session with no refresh token", async () => {
    writeFileSync(sessionPath, JSON.stringify({ accessToken: "legacy-30d" }), "utf-8");
    const auth = await freshAuth();
    await auth.getAccessToken();
    await auth.signOut();

    expect(fetchCalls).toHaveLength(0); // nothing to revoke
    expect(existsSync(sessionPath)).toBe(false);
  });

  it("clears the session even if the logout request fails", async () => {
    writeFileSync(
      sessionPath,
      JSON.stringify({ accessToken: "a", refreshToken: "refresh-1" }),
      "utf-8",
    );
    fetchHandler = async () => {
      throw new Error("network down");
    };
    const auth = await freshAuth();
    await auth.getAccessToken();
    await auth.signOut();

    expect(existsSync(sessionPath)).toBe(false); // best-effort logout never blocks sign-out
  });
});

// --------------------------------------------------------------------------- //
// Code-exchange sign-in branch (parseCallbackUrl + /auth/exchange persist).
// --------------------------------------------------------------------------- //

describe("code flow callback", () => {
  it("parseCallbackUrl surfaces the one-time code + echoed state", async () => {
    const { parseCallbackUrl } = await freshAuth();
    expect(parseCallbackUrl("/callback?code=onetime123&state=nonce", "http://127.0.0.1:0")).toEqual({
      code: "onetime123",
      state: "nonce",
    });
  });

  it("parseCallbackUrl still accepts the legacy ?access_token= fallback", async () => {
    const { parseCallbackUrl } = await freshAuth();
    expect(
      parseCallbackUrl("/callback?access_token=jwt.abc&state=nonce", "http://127.0.0.1:0"),
    ).toEqual({ token: "jwt.abc", state: "nonce" });
  });

  it("end-to-end signIn: opens flow=code, exchanges the code, persists the token triple", async () => {
    const newExpiry = Date.now() + 24 * 60 * 60 * 1000;
    fetchHandler = async (call) => {
      if (call.url.includes("/auth/exchange")) {
        expect(call.body).toEqual({ code: "onetime-xyz" });
        return jsonOk(200, {
          accessToken: "access-fresh",
          refreshToken: "refresh-fresh",
          accessExpiresAt: newExpiry,
        });
      }
      if (call.url.includes("/me")) return jsonOk(200, { user: { username: "Luigi" } });
      throw new Error(`unexpected httpFetch to ${call.url}`);
    };

    const auth = await freshAuth();
    const signInPromise = auth.signIn();

    // The flow opens the system browser at the API login URL; read it to learn the
    // loopback redirect (host:port) and the CSRF state nonce it expects back.
    await waitUntil(() => openExternal.mock.calls.length > 0);
    const loginUrl = new URL(openExternal.mock.calls[0][0] as string);
    expect(loginUrl.searchParams.get("flow")).toBe("code"); // opted into the refresh flow
    const redirect = loginUrl.searchParams.get("redirect")!;
    const nonce = loginUrl.searchParams.get("state_nonce")!;

    // Simulate the API's 302 back to the loopback: ?code=&state=<nonce>.
    const callbackUrl = `${redirect}?code=onetime-xyz&state=${encodeURIComponent(nonce)}`;
    const cbRes = await fetch(callbackUrl);
    expect(cbRes.status).toBe(200);

    await signInPromise;

    const persisted = readPersisted();
    expect(persisted.accessToken).toBe("access-fresh");
    expect(persisted.refreshToken).toBe("refresh-fresh");
    expect(persisted.accessExpiresAt).toBe(newExpiry);
    // Profile from the best-effort /me lands too.
    expect(persisted.profile).toEqual({ displayName: "Luigi" });
  });
});
