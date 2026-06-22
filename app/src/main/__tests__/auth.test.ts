import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// auth.ts touches electron at module scope (config.ts reads app.isPackaged; the
// session file lives under app.getPath("userData")). Point userData at a temp dir
// so a test never reads/writes a real install's auth-session.json, and stub
// BrowserWindow so broadcastStatus() has windows to iterate (none).
const dir = mkdtempSync(join(tmpdir(), "tbh-auth-"));
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => dir },
  shell: { openExternal: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

// Spy on the renderer fan-out so we can assert clearSession("expired") emits the
// involuntary-logout signal (and a plain sign-out does not).
const broadcast = vi.fn();
vi.mock("../broadcast.js", () => ({ broadcast: (...args: unknown[]) => broadcast(...args) }));

const sessionPath = join(dir, "auth-session.json");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// auth.ts memoizes the loaded session in module state (sessionLoaded), so each
// session-file scenario re-imports a fresh module instance after writing disk.
async function freshAuth() {
  vi.resetModules();
  return import("../auth.js");
}

beforeEach(() => {
  rmSync(sessionPath, { force: true });
  broadcast.mockClear();
});

// --------------------------------------------------------------------------- //
// parseCallbackUrl — the loopback redirect-handling branch, pure + isolated.
// --------------------------------------------------------------------------- //

describe("parseCallbackUrl", () => {
  const base = "http://127.0.0.1:0";

  it("extracts the access_token from the success redirect query string", async () => {
    const { parseCallbackUrl } = await import("../auth.js");
    expect(parseCallbackUrl("/callback?access_token=jwt.abc.def", base)).toEqual({
      token: "jwt.abc.def",
    });
  });

  it("extracts the echoed CSRF state nonce alongside the token", async () => {
    const { parseCallbackUrl } = await import("../auth.js");
    // waitForCallback compares this `state` to the nonce it generated for the sign-in.
    expect(parseCallbackUrl("/callback?access_token=jwt.abc.def&state=nonce123", base)).toEqual({
      token: "jwt.abc.def",
      state: "nonce123",
    });
  });

  it("surfaces an OAuth ?error= (denied/failed consent) over a token", async () => {
    const { parseCallbackUrl } = await import("../auth.js");
    // error wins even if a token were somehow also present
    expect(parseCallbackUrl("/callback?error=access_denied", base)).toEqual({
      error: "access_denied",
    });
    expect(parseCallbackUrl("/callback?error=access_denied&access_token=x", base)).toEqual({
      error: "access_denied",
    });
  });

  it("returns neither token nor error when the callback carries no auth params", async () => {
    const { parseCallbackUrl } = await import("../auth.js");
    expect(parseCallbackUrl("/callback", base)).toEqual({});
    expect(parseCallbackUrl("/callback?foo=bar", base)).toEqual({});
  });
});

// --------------------------------------------------------------------------- //
// StoredSession load / persist / clear lifecycle, exercised through the public
// surface (getAccessToken / getStatus / clearSession / clearSessionFile).
// --------------------------------------------------------------------------- //

describe("StoredSession load", () => {
  it("loads a well-formed session: token via getAccessToken, profile via getStatus", async () => {
    writeFileSync(
      sessionPath,
      JSON.stringify({ accessToken: "tok-123", profile: { displayName: "Mario", avatarUrl: "u" } }),
      "utf-8",
    );
    const auth = await freshAuth();
    expect(await auth.getAccessToken()).toBe("tok-123");
    expect(await auth.getStatus()).toEqual({
      signedIn: true,
      displayName: "Mario",
      avatarUrl: "u",
    });
  });

  it("reads as signed-out when there is no session file", async () => {
    const auth = await freshAuth();
    expect(await auth.getAccessToken()).toBeNull();
    expect(await auth.getStatus()).toEqual({ signedIn: false });
  });

  it("discards a legacy Supabase session (no top-level accessToken) as signed-out", async () => {
    // The old Supabase session.json reused this same slot but has a different
    // shape (no top-level accessToken) — it is intentionally treated as
    // signed-out and overwritten on the next persist (audit finding #12).
    writeFileSync(
      sessionPath,
      JSON.stringify({ currentSession: { access_token: "supabase-old" }, user: {} }),
      "utf-8",
    );
    const auth = await freshAuth();
    expect(await auth.getAccessToken()).toBeNull();
    expect(await auth.getStatus()).toEqual({ signedIn: false });
  });

  it("rejects corrupt JSON and an empty-string token", async () => {
    const auth = await freshAuth();
    writeFileSync(sessionPath, "{ not json", "utf-8");
    expect(await auth.getAccessToken()).toBeNull();

    const auth2 = await freshAuth();
    writeFileSync(sessionPath, JSON.stringify({ accessToken: "" }), "utf-8");
    expect(await auth2.getAccessToken()).toBeNull();
  });
});

describe("clearSession / clearSessionFile", () => {
  it("clearSession deletes the on-disk session and flips status to signed-out", async () => {
    writeFileSync(sessionPath, JSON.stringify({ accessToken: "tok-xyz" }), "utf-8");
    const auth = await freshAuth();
    expect(await auth.getAccessToken()).toBe("tok-xyz"); // loaded

    auth.clearSession();

    expect(existsSync(sessionPath)).toBe(false); // persisted removal
    expect(await auth.getAccessToken()).toBeNull();
    expect(await auth.getStatus()).toEqual({ signedIn: false });
  });

  it("clearSession('expired') emits meter:session-expired (involuntary 401 logout)", async () => {
    writeFileSync(sessionPath, JSON.stringify({ accessToken: "tok-xyz" }), "utf-8");
    const auth = await freshAuth();
    await auth.getAccessToken(); // force load so clearSession has a session to clear

    auth.clearSession("expired");

    expect(broadcast).toHaveBeenCalledWith("meter:session-expired");
  });

  it("clearSession() (manual sign-out) does NOT emit meter:session-expired", async () => {
    writeFileSync(sessionPath, JSON.stringify({ accessToken: "tok-xyz" }), "utf-8");
    const auth = await freshAuth();
    await auth.getAccessToken();

    auth.clearSession();

    expect(broadcast).not.toHaveBeenCalledWith("meter:session-expired");
  });

  it("clearSessionFile removes the file even before the session was loaded", async () => {
    writeFileSync(sessionPath, JSON.stringify({ accessToken: "tok-xyz" }), "utf-8");
    const auth = await freshAuth();
    // no prior load: clearSessionFile must still wipe the slot
    auth.clearSessionFile();
    expect(existsSync(sessionPath)).toBe(false);
    expect(await auth.getAccessToken()).toBeNull();
  });
});
