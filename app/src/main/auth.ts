import { app, shell } from "electron";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { API_URL, AUTH_CALLBACK_PORT } from "./config.js";
import { broadcast } from "./broadcast.js";

// --------------------------------------------------------------------------- //
// Auth service — Discord OAuth via the API's desktop loopback flow, entirely in
// the MAIN process. The renderer never sees the token; it only asks for status
// and triggers sign-in/out over IPC.
//
// The browser-based OAuth flow:
//   1. We start a throwaway loopback HTTP server on 127.0.0.1:<ephemeral port>.
//   2. We open the system browser (shell.openExternal) to
//      `${API_URL}/auth/discord/login?redirect=<http://127.0.0.1:port/callback>`.
//   3. The API runs the Discord consent, mints an HS256 JWT (sub = user id, ~30d,
//      NO refresh token) and 302-redirects to `<redirect>?access_token=<jwt>`
//      (the token is in the QUERY string — a fragment would never reach a local
//      HTTP server). Accepted desktop-OAuth tradeoff: a query-param bearer lands
//      in the system browser's history (our loopback server logs nothing and the
//      result page does not echo it, but the browser's own URL history will hold
//      the 30-day JWT). A fragment would avoid history but is unreachable by an
//      HTTP server, and a code-exchange/PKCE round-trip is out of scope here.
//   4. The loopback handler reads `access_token`, shows a tiny page, and the
//      server self-closes (and times out after a couple of minutes so it never
//      lingers, and handles the user just closing the browser → no token).
//
// DEPLOY-ORDERING DEPENDENCY (not enforced in code, by design — see finding #8):
// these HS256 tokens are only accepted by the API while AUTH_MODE is bridge or
// railway; under AUTH_MODE=supabase the API rejects them with 401. We deliberately
// do NOT add a client-side mode guard — the gating is operational: shipping a new
// meter to players must wait until the API has cut over off AUTH_MODE=supabase
// (the migration runbook owns that ordering). Merging this code does not ship it.
//
// The JWT is persisted to a JSON file under userData (the SAME on-disk slot the
// old Supabase session used — auth-session.json). The shapes are NOT compatible:
// an old Supabase session has no top-level `accessToken`, so loadSession() rejects
// it and the user reads as signed-out on first launch after upgrade. That stale
// content is intentionally discarded — it is unusable under railway auth — and
// gets overwritten the next time we persist. There is NO refresh token: when the
// API answers 401 the token has simply expired, and the upload path calls
// clearSession() — same "signed out" UX as a lost session.
// --------------------------------------------------------------------------- //

const CALLBACK_PATH = "/callback";
const SIGN_IN_TIMEOUT_MS = 2 * 60 * 1000;
// Hard cap on the best-effort `GET /me` profile fetch. It runs AFTER the session
// is already persisted (see signIn), so the worst case is just a nameless
// signed-in until the next /me succeeds — but bounding it also keeps signInInFlight
// from being held open by a hung request (the 2-min OAuth timer only covers up to
// token receipt, not this follow-up call).
const PROFILE_FETCH_TIMEOUT_MS = 10 * 1000;

export interface AuthStatus {
  signedIn: boolean;
  displayName?: string;
  avatarUrl?: string;
}

// --------------------------------------------------------------------------- //
// Persisted session — the bearer JWT plus the last profile we fetched from
// `GET /me`, cached so a restart restores the renderer's display name/avatar
// without a network round-trip. Mirrored to disk on every change.
// --------------------------------------------------------------------------- //

interface Profile {
  displayName?: string;
  avatarUrl?: string;
}

interface StoredSession {
  accessToken: string;
  profile?: Profile;
}

/**
 * Outcome of parsing the loopback callback URL the API redirects back to.
 * Pure + exported so the redirect-handling branch is unit-testable without an
 * HTTP server: `{ token, state }` on success, `{ error }` for an OAuth `?error=...`,
 * `{}` when neither is present (the "Missing sign-in token" 400 case). `state` is the
 * echoed CSRF nonce the caller compares to the one it generated for this sign-in.
 */
export interface CallbackParse {
  token?: string;
  error?: string;
  state?: string;
}

/**
 * Extract the auth result from the loopback callback URL's query string. The API
 * 302s to `${redirect}?access_token=<jwt>` on success or `?error=<reason>` on a
 * denied/failed consent. (Query, not fragment — a fragment never reaches an HTTP
 * server; see the flow note at the top of this file.)
 */
export function parseCallbackUrl(reqUrl: string, base: string): CallbackParse {
  const url = new URL(reqUrl, base);
  const error = url.searchParams.get("error");
  if (error) return { error };
  const token = url.searchParams.get("access_token");
  const state = url.searchParams.get("state") ?? undefined;
  if (token) return { token, state };
  return {};
}

function sessionFilePath(): string {
  return join(app.getPath("userData"), "auth-session.json");
}

let session: StoredSession | null = null;
let sessionLoaded = false;

function loadSession(): StoredSession | null {
  if (sessionLoaded) return session;
  sessionLoaded = true;
  const path = sessionFilePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as StoredSession).accessToken === "string" &&
      (parsed as StoredSession).accessToken.length > 0
    ) {
      session = parsed as StoredSession;
    }
  } catch {
    session = null;
  }
  return session;
}

function persistSession(): void {
  try {
    const path = sessionFilePath();
    if (session) {
      writeFileSync(path, JSON.stringify(session), "utf-8");
    } else if (existsSync(path)) {
      unlinkSync(path);
    }
  } catch {
    // best effort — never crash on a session write failure
  }
}

// --------------------------------------------------------------------------- //
// Status broadcast — emitted to every window so the renderer updates live on
// sign-in / sign-out / session expiry.
// --------------------------------------------------------------------------- //

function statusFromSession(): AuthStatus {
  const s = loadSession();
  if (!s) return { signedIn: false };
  return {
    signedIn: true,
    displayName: s.profile?.displayName,
    avatarUrl: s.profile?.avatarUrl,
  };
}

function broadcastStatus(): void {
  broadcast("meter:auth-changed", statusFromSession());
}

type SignedInListener = () => void;
const signedInListeners: SignedInListener[] = [];

/** Register a callback fired whenever a session becomes available (a fresh
 *  sign-in or a session restored from disk at startup). Register before
 *  initAuth() so no event is missed. */
export function onSignedIn(listener: SignedInListener): void {
  signedInListeners.push(listener);
}

function fireSignedIn(): void {
  for (const listener of signedInListeners) listener();
}

let initialized = false;

/** Initialise auth at startup: broadcast the restored status and, if a session
 *  was restored from disk, fire the signed-in hook (so the auto-uploader claims
 *  + drains). Idempotent. */
export function initAuth(): void {
  if (initialized) return;
  initialized = true;
  broadcastStatus();
  if (loadSession()) fireSignedIn();
}

export function getStatus(): Promise<AuthStatus> {
  return Promise.resolve(statusFromSession());
}

/** The stored bearer JWT, or null while signed out. There is no refresh token —
 *  an expired token is detected by the API returning 401 (the upload path then
 *  calls clearSession()). */
export function getAccessToken(): Promise<string | null> {
  return Promise.resolve(loadSession()?.accessToken ?? null);
}

/** Clear the stored session + broadcast "signed out". Called on explicit sign-out
 *  and when the API rejects the bearer with 401 (the token expired — no refresh). */
export function clearSession(): void {
  if (!loadSession()) return;
  session = null;
  persistSession();
  broadcastStatus();
}

export function signOut(): Promise<void> {
  clearSession();
  return Promise.resolve();
}

// --------------------------------------------------------------------------- //
// Profile fetch — populate the renderer's display name + avatar from `GET /me`,
// mirroring what the Supabase session's user_metadata provided. Best-effort: a
// failure leaves the session signed-in with no profile (the renderer falls back
// to a generic label), rather than blocking sign-in.
// --------------------------------------------------------------------------- //

function pickString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

async function fetchProfile(token: string): Promise<Profile> {
  try {
    const res = await fetch(`${API_URL}/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROFILE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return {};
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return {};
    // Accept the profile either at the top level or nested under `user` (the
    // shape `/me` returns), and the common display-name/avatar field aliases.
    const user = (body.user && typeof body.user === "object" ? body.user : body) as Record<
      string,
      unknown
    >;
    const displayName =
      pickString(user.displayName) ??
      pickString(user.display_name) ??
      pickString(user.globalName) ??
      pickString(user.global_name) ??
      pickString(user.username) ??
      pickString(user.name) ??
      undefined;
    const avatarUrl =
      pickString(user.avatarUrl) ??
      pickString(user.avatar_url) ??
      pickString(user.avatar) ??
      undefined;
    return { displayName, avatarUrl };
  } catch {
    return {};
  }
}

// --------------------------------------------------------------------------- //
// Sign-in flow — one at a time. A stale server from an abandoned earlier attempt
// is closed before a new one starts so a port is never wedged.
// --------------------------------------------------------------------------- //

const RESULT_PAGE = (message: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>TBH Helper</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0b0f;color:#e5e7eb;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0}div{text-align:center}</style>
</head><body><div><h2>${message}</h2><p style="color:#9ca3af">You can close this tab.</p></div></body></html>`;

let activeServer: Server | null = null;
let signInInFlight = false;

// NOTE (deploy ordering): this mints/persists an HS256 token the API only accepts
// while AUTH_MODE is bridge/railway — under AUTH_MODE=supabase it 401s. By design
// there is NO client-side mode guard; do not deploy a new meter to players until
// the API has cut over off supabase auth. Full rationale in the file header.
export async function signIn(): Promise<void> {
  if (signInInFlight) return;
  signInInFlight = true;
  try {
    await closeActiveServer();
    const token = await waitForCallback();

    // Persist the token FIRST — the profile is best-effort and a hung/failed
    // `GET /me` must never cost us the token (which would lose the sign-in and
    // wedge signInInFlight until restart). Once persisted, getAccessToken() will
    // return it even if the profile fetch below aborts. We broadcast signed-in
    // now (nameless) and again after the profile lands so the name/avatar fill in.
    session = { accessToken: token };
    sessionLoaded = true;
    persistSession();
    broadcastStatus();
    fireSignedIn();

    // Best-effort profile enrichment (bounded by PROFILE_FETCH_TIMEOUT_MS). On
    // success, merge it in and re-broadcast so the renderer shows name + avatar.
    const profile = await fetchProfile(token);
    if (session && (profile.displayName || profile.avatarUrl)) {
      session = { ...session, profile };
      persistSession();
      broadcastStatus();
    }
  } finally {
    signInInFlight = false;
    await closeActiveServer();
  }
}

function closeActiveServer(): Promise<void> {
  return new Promise((resolve) => {
    const server = activeServer;
    activeServer = null;
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

/**
 * Start the loopback server, open the API's Discord login URL pointed at it, and
 * resolve with the JWT once the API redirects back with ?access_token=
 * (or reject on the user closing the browser → timeout, or a missing token).
 */
function waitForCallback(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    // CSRF nonce for this sign-in: handed to /login and required to equal the `state`
    // the API echoes back to our loopback. A stray or forged callback (a token minted
    // for someone else's account) carries a different/absent nonce and is rejected.
    const expectedNonce = randomBytes(32).toString("hex");
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const server = createServer((req, res) => {
      const base = `http://127.0.0.1:${port()}`;
      const reqUrl = req.url ?? "/";
      if (new URL(reqUrl, base).pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }

      const parsed = parseCallbackUrl(reqUrl, base);
      if (parsed.error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(RESULT_PAGE("Sign-in was cancelled."));
        finish(() => reject(new Error(parsed.error)));
        return;
      }

      const token = parsed.token;
      if (!token) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(RESULT_PAGE("Missing sign-in token."));
        finish(() => reject(new Error("Missing access token.")));
        return;
      }

      // Double-submit CSRF check: the echoed nonce must match the one we generated.
      if (!parsed.state || parsed.state !== expectedNonce) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(RESULT_PAGE("Sign-in verification failed. Please try again."));
        finish(() => reject(new Error("State nonce mismatch.")));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(RESULT_PAGE("Login complete — you can close this tab."));
      finish(() => resolve(token));
    });

    // Resolve the bound port lazily: 0 = OS-assigned ephemeral, captured in listen().
    let boundPort = 0;
    const port = (): number => boundPort;

    const timer = setTimeout(() => {
      finish(() => reject(new Error("Sign-in timed out.")));
    }, SIGN_IN_TIMEOUT_MS);

    server.on("error", (err) => {
      finish(() => reject(err));
    });

    // 0 = ephemeral; AUTH_CALLBACK_PORT env override (dev) still honoured if set non-zero.
    server.listen(AUTH_CALLBACK_PORT, "127.0.0.1", () => {
      activeServer = server;
      const addr = server.address();
      boundPort = addr && typeof addr === "object" ? addr.port : AUTH_CALLBACK_PORT;
      const redirect = `http://127.0.0.1:${boundPort}${CALLBACK_PATH}`;
      const loginUrl = `${API_URL}/auth/discord/login?redirect=${encodeURIComponent(redirect)}&state_nonce=${encodeURIComponent(expectedNonce)}`;
      void shell.openExternal(loginUrl);
    });
  });
}

// Clear the persisted session file (used only if a corrupt session must be reset).
export function clearSessionFile(): void {
  session = null;
  sessionLoaded = true;
  try {
    const path = sessionFilePath();
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best effort
  }
}
