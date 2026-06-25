import { app, shell } from "electron";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { API_URL, AUTH_CALLBACK_PORT } from "./config.js";
import { httpFetch } from "./net-fetch.js";
import { broadcast } from "./broadcast.js";

// --------------------------------------------------------------------------- //
// Auth service — Discord OAuth via the API's desktop loopback flow, entirely in
// the MAIN process. The renderer never sees the token; it only asks for status
// and triggers sign-in/out over IPC.
//
// The browser-based OAuth flow (code-exchange + refresh):
//   1. We start a throwaway loopback HTTP server on 127.0.0.1:<ephemeral port>.
//   2. We open the system browser (shell.openExternal) to
//      `${API_URL}/auth/discord/login?redirect=<http://127.0.0.1:port/callback>
//       &state_nonce=<nonce>&flow=code`. `flow=code` opts into the refresh flow.
//   3. The API runs the Discord consent and 302-redirects to
//      `<redirect>?code=<oneTimeCode>&state=<nonce>` (query, not fragment — a
//      fragment never reaches a local HTTP server). The one-time CODE — not a
//      bearer — lands in the browser's URL history; it is single-use and short-
//      lived, so a leaked history entry is worthless after the immediate exchange
//      below. (The OLD API echoed `?access_token=<jwt>` directly; we still accept
//      that as a fallback for an un-upgraded API, persisting just the accessToken
//      with no refresh capability.)
//   4. The loopback handler verifies the echoed `state` nonce (double-submit CSRF
//      check), then POSTs the code to `/auth/exchange`, which returns a SHORT-lived
//      access token (24h), a long-lived refresh token (90d), and the access token's
//      expiry. We persist all three, show a tiny page, and the server self-closes
//      (also times out after a couple of minutes so it never lingers).
//
// REFRESH / ROTATION INVARIANT (security-critical):
//   The access token is short (24h). When it nears expiry we POST the refresh
//   token to `/auth/refresh`, which ROTATES it: the response carries a BRAND-NEW
//   refresh token and the old one is now revoked server-side. We MUST persist the
//   new refresh token (see refreshAccessToken) — if we ever replay a rotated-away
//   token the server treats it as reuse and revokes EVERY session for this user.
//   Refresh is also SINGLE-FLIGHT (refreshInFlight): two concurrent callers (e.g.
//   getAccessToken and the upload 401 path firing together) must share ONE network
//   refresh. Two parallel refreshes would rotate twice and one of the two returned
//   tokens would be immediately revoked — the next refresh with it then nukes all
//   sessions. The single-flight guard makes concurrent callers await one request.
//
// DEPLOY-ORDERING DEPENDENCY (not enforced in code, by design — see finding #8):
// the access tokens are HS256 JWTs only accepted by the API while AUTH_MODE is
// bridge or railway; under AUTH_MODE=supabase the API rejects them with 401. We
// deliberately do NOT add a client-side mode guard — the gating is operational:
// shipping a new meter to players must wait until the API has cut over off
// AUTH_MODE=supabase (the migration runbook owns that ordering). Merging this code
// does not ship it.
//
// The session is persisted to a JSON file under userData (the SAME on-disk slot
// the old Supabase session used — auth-session.json). The shapes are NOT
// compatible: an old Supabase session has no top-level `accessToken`, so
// loadSession() rejects it and the user reads as signed-out on first launch after
// upgrade. That stale content is intentionally discarded and gets overwritten the
// next time we persist.
//
// BACKWARD COMPAT: a LEGACY session has only `accessToken` (the old ~30-day token,
// no refresh token, no expiry). It still loads and stays usable — it just has no
// refresh capability: when the API answers 401 the token has expired and the
// upload path calls clearSession("expired"), the same "sign in again" UX as today.
// --------------------------------------------------------------------------- //

const CALLBACK_PATH = "/callback";
const SIGN_IN_TIMEOUT_MS = 2 * 60 * 1000;
// Hard cap on the best-effort `GET /me` profile fetch. It runs AFTER the session
// is already persisted (see signIn), so the worst case is just a nameless
// signed-in until the next /me succeeds — but bounding it also keeps signInInFlight
// from being held open by a hung request (the 2-min OAuth timer only covers up to
// token receipt, not this follow-up call).
const PROFILE_FETCH_TIMEOUT_MS = 10 * 1000;
// Bound on the code-exchange and refresh round-trips so a hung API never wedges
// sign-in (exchange) or a getAccessToken caller (refresh).
const TOKEN_REQUEST_TIMEOUT_MS = 10 * 1000;
// Logout is best-effort and fired right before clearing the local session; a hung
// request must not delay the user-visible sign-out, so it is tightly bounded.
const LOGOUT_TIMEOUT_MS = 5 * 1000;
// Refresh slightly BEFORE the access token actually expires so an in-flight upload
// started just under the wire still carries a valid token. Also covers small clock
// skew between this machine and the API.
const ACCESS_EXPIRY_SKEW_MS = 60 * 1000;

export interface AuthStatus {
  signedIn: boolean;
  displayName?: string;
  avatarUrl?: string;
}

// --------------------------------------------------------------------------- //
// Persisted session — the bearer access token, the rotating refresh token + the
// access token's expiry (epoch ms), plus the last profile we fetched from
// `GET /me`, cached so a restart restores the renderer's display name/avatar
// without a network round-trip. Mirrored to disk on every change.
//
// `refreshToken` / `accessExpiresAt` are OPTIONAL: a legacy session (or the
// fallback ?access_token= login branch) carries only `accessToken`.
// --------------------------------------------------------------------------- //

interface Profile {
  displayName?: string;
  avatarUrl?: string;
}

interface StoredSession {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms at which `accessToken` expires. Absent for a legacy/long-lived token. */
  accessExpiresAt?: number;
  profile?: Profile;
}

/** The token triple every `/auth/exchange` and `/auth/refresh` 200 returns. */
interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  accessExpiresAt: number;
}

/**
 * Outcome of parsing the loopback callback URL the API redirects back to.
 * Pure + exported so the redirect-handling branch is unit-testable without an
 * HTTP server. On success we get EITHER a one-time `code` (the new code flow) or a
 * `token` (the legacy ?access_token= flow); `{ error }` for an OAuth `?error=...`;
 * `{}` when none is present (the "Missing sign-in token" 400 case). `state` is the
 * echoed CSRF nonce the caller compares to the one it generated for this sign-in.
 */
export interface CallbackParse {
  code?: string;
  token?: string;
  error?: string;
  state?: string;
}

/**
 * Extract the auth result from the loopback callback URL's query string. The API
 * 302s to `${redirect}?code=<code>&state=<nonce>` (the code flow) or, on an older
 * API, `${redirect}?access_token=<jwt>&state=<nonce>`, or `?error=<reason>` on a
 * denied/failed consent. (Query, not fragment — a fragment never reaches an HTTP
 * server; see the flow note at the top of this file.)
 */
export function parseCallbackUrl(reqUrl: string, base: string): CallbackParse {
  const url = new URL(reqUrl, base);
  const error = url.searchParams.get("error");
  if (error) return { error };
  const state = url.searchParams.get("state") ?? undefined;
  // Prefer the code flow; fall back to the legacy direct-token flow.
  const code = url.searchParams.get("code");
  if (code) return { code, state };
  const token = url.searchParams.get("access_token");
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
 *  + drains). Idempotent.
 *
 *  We do NOT proactively refresh here — refresh is LAZY, driven by getAccessToken
 *  (and the upload 401 path). A restored session (even one whose short access
 *  token already expired) still reads as "signed in" to the renderer; the access
 *  token is refreshed on first use. This keeps startup free of a blocking network
 *  round-trip and the signed-in UX intact across a long offline gap. */
export function initAuth(): void {
  if (initialized) return;
  initialized = true;
  broadcastStatus();
  if (loadSession()) fireSignedIn();
}

export function getStatus(): Promise<AuthStatus> {
  return Promise.resolve(statusFromSession());
}

// --------------------------------------------------------------------------- //
// Token persistence + refresh.
// --------------------------------------------------------------------------- //

/** Validate the `{ accessToken, refreshToken, accessExpiresAt }` triple from
 *  /auth/exchange or /auth/refresh. A malformed body must NOT clobber the session. */
function parseTokenResponse(body: unknown): TokenResponse | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.accessToken !== "string" || b.accessToken.length === 0) return null;
  if (typeof b.refreshToken !== "string" || b.refreshToken.length === 0) return null;
  if (typeof b.accessExpiresAt !== "number" || !Number.isFinite(b.accessExpiresAt)) return null;
  return {
    accessToken: b.accessToken,
    refreshToken: b.refreshToken,
    accessExpiresAt: b.accessExpiresAt,
  };
}

/** Persist a freshly-issued token triple, preserving the cached profile. Always
 *  used to land the ROTATED refresh token after a refresh/exchange — persisting
 *  the new refresh token is required (see the rotation invariant in the header). */
function persistTokens(tokens: TokenResponse): void {
  session = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessExpiresAt: tokens.accessExpiresAt,
    profile: session?.profile,
  };
  sessionLoaded = true;
  persistSession();
}

// Single-flight guard: at most one /auth/refresh request is ever in flight.
// Concurrent callers share this promise so the refresh token rotates exactly once
// (a second parallel rotation would revoke one of the two returned tokens — see
// the rotation invariant in the header).
let refreshInFlight: Promise<boolean> | null = null;

/**
 * Refresh the access token using the stored refresh token. Returns whether a
 * fresh access token is now available.
 *
 *   - No session / no refresh token (legacy or fallback session) → false, NO
 *     network call (nothing to refresh with).
 *   - 200 → persist the NEW { accessToken, refreshToken, accessExpiresAt } (the
 *     refresh token ROTATED; persisting the new one is REQUIRED) → true.
 *   - 401 / any non-2xx / network error → false. We deliberately do NOT
 *     clearSession here: a transient blip must not sign the user out. The CALLER
 *     decides whether a failed refresh is terminal (getAccessToken clears on a
 *     genuine near-expiry failure; the upload path falls back to its 401 handling).
 *
 * SINGLE-FLIGHT: concurrent callers share one in-flight request (refreshInFlight).
 */
export function refreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  const current = loadSession();
  const refreshToken = current?.refreshToken;
  if (!refreshToken) return Promise.resolve(false);

  refreshInFlight = (async () => {
    try {
      const res = await httpFetch(`${API_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const tokens = parseTokenResponse(await res.json().catch(() => null));
      if (!tokens) return false;
      // Persist the rotated triple BEFORE returning so any caller that re-reads the
      // session sees the new tokens and the old refresh token is never replayed.
      persistTokens(tokens);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/**
 * The bearer access token to attach to API requests, or null while signed out.
 *
 * Refresh-aware: if the stored access token is at/near its expiry AND a refresh
 * token exists, refresh first and return the NEW access token; if that refresh
 * fails the session is genuinely expired → clearSession("expired") + null.
 * Otherwise return the stored token as-is, which covers both a still-valid short
 * token and a legacy long-lived token (no expiry, no refresh).
 */
export async function getAccessToken(): Promise<string | null> {
  const s = loadSession();
  if (!s) return null;

  const nearExpiry =
    typeof s.accessExpiresAt === "number" && Date.now() > s.accessExpiresAt - ACCESS_EXPIRY_SKEW_MS;

  if (nearExpiry && s.refreshToken) {
    if (await refreshAccessToken()) {
      return loadSession()?.accessToken ?? null;
    }
    // Near expiry AND refresh failed → the session is dead, not a transient blip
    // we should keep. Clear it as "expired" so the renderer prompts a re-sign-in.
    clearSession("expired");
    return null;
  }

  return s.accessToken;
}

/**
 * Clear the stored session + broadcast "signed out".
 *
 * `reason` distinguishes the two callers so the renderer can react differently:
 *   - "manual" (default): the user pressed Sign out — a deliberate, expected state.
 *   - "expired": the API rejected the bearer with 401 and no usable refresh path
 *     remained (a legacy token expired, the refresh token itself expired/was
 *     revoked, or there was no refresh token). The user was signed in a moment ago
 *     and is being kicked involuntarily, so we additionally emit
 *     `meter:session-expired` for the renderer to surface a clear "sign in again"
 *     prompt instead of silently dropping to OFFLINE. The silent logout was
 *     invisible to the user AND to us (401 upload failures are suppressed from the
 *     error relay — see share.ts isReportableUploadFailure), which is why a
 *     JWT_SECRET rotation only surfaced via player DMs.
 */
export function clearSession(reason: "manual" | "expired" = "manual"): void {
  if (!loadSession()) return;
  session = null;
  persistSession();
  broadcastStatus();
  if (reason === "expired") broadcast("meter:session-expired");
}

/**
 * Sign out: best-effort revoke the refresh token server-side (POST /auth/logout)
 * BEFORE clearing the local session, then clear it as "manual". The logout call is
 * fire-and-forget-with-await (bounded, failures ignored) — a server hiccup must
 * never block the user-visible sign-out, and the refresh token is dropped locally
 * regardless. Skipped entirely for a legacy session with no refresh token.
 */
export async function signOut(): Promise<void> {
  const refreshToken = loadSession()?.refreshToken;
  if (refreshToken) {
    try {
      await httpFetch(`${API_URL}/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
        signal: AbortSignal.timeout(LOGOUT_TIMEOUT_MS),
      });
    } catch {
      // best effort — the local session is cleared below regardless
    }
  }
  clearSession("manual");
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
    const res = await httpFetch(`${API_URL}/me`, {
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

/**
 * Exchange a one-time code from the code-flow callback for the token triple.
 * Returns the parsed triple on a 200, or null on any non-2xx / network / bad-body
 * (the caller treats null as a failed sign-in).
 */
async function exchangeCode(code: string): Promise<TokenResponse | null> {
  try {
    const res = await httpFetch(`${API_URL}/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return parseTokenResponse(await res.json().catch(() => null));
  } catch {
    return null;
  }
}

// NOTE (deploy ordering): this mints/persists HS256 access tokens the API only
// accepts while AUTH_MODE is bridge/railway — under AUTH_MODE=supabase it 401s. By
// design there is NO client-side mode guard; do not deploy a new meter to players
// until the API has cut over off supabase auth. Full rationale in the file header.
export async function signIn(): Promise<void> {
  if (signInInFlight) return;
  signInInFlight = true;
  try {
    await closeActiveServer();
    // The callback yields EITHER a one-time code (the code flow) or a direct token
    // (the legacy fallback). The state nonce was already verified in waitForCallback.
    const result = await waitForCallback();

    let accessToken: string;
    if (result.kind === "code") {
      const tokens = await exchangeCode(result.code);
      if (!tokens) throw new Error("Code exchange failed.");
      // Persist the FULL triple (access + rotating refresh + expiry) FIRST — the
      // profile is best-effort and a hung/failed `GET /me` must never cost us the
      // session. Once persisted, getAccessToken() returns it even if the profile
      // fetch below aborts.
      persistTokens(tokens);
      accessToken = tokens.accessToken;
    } else {
      // Legacy fallback: an older API redirected a bare access token with no refresh
      // capability. Persist just the token — getAccessToken returns it as-is (no
      // expiry, no refresh) and its eventual 401 takes the clearSession("expired") path.
      session = { accessToken: result.token, profile: session?.profile };
      sessionLoaded = true;
      persistSession();
      accessToken = result.token;
    }

    // We broadcast signed-in now (nameless) and again after the profile lands so
    // the name/avatar fill in.
    broadcastStatus();
    fireSignedIn();

    // Best-effort profile enrichment (bounded by PROFILE_FETCH_TIMEOUT_MS). On
    // success, merge it in and re-broadcast so the renderer shows name + avatar.
    const profile = await fetchProfile(accessToken);
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

/** What the loopback callback handed back: a one-time code (code flow) or a bare
 *  access token (legacy fallback). The state nonce is verified before resolving. */
type CallbackResult = { kind: "code"; code: string } | { kind: "token"; token: string };

/**
 * Start the loopback server, open the API's Discord login URL pointed at it, and
 * resolve once the API redirects back with ?code= (code flow) or ?access_token=
 * (legacy fallback) — or reject on the user closing the browser → timeout, a
 * missing token, or a CSRF nonce mismatch.
 */
function waitForCallback(): Promise<CallbackResult> {
  return new Promise<CallbackResult>((resolve, reject) => {
    let settled = false;
    // CSRF nonce for this sign-in: handed to /login and required to equal the `state`
    // the API echoes back to our loopback. A stray or forged callback (a code/token
    // minted for someone else) carries a different/absent nonce and is rejected.
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

      if (!parsed.code && !parsed.token) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(RESULT_PAGE("Missing sign-in token."));
        finish(() => reject(new Error("Missing sign-in code.")));
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
      finish(() =>
        resolve(
          parsed.code ? { kind: "code", code: parsed.code } : { kind: "token", token: parsed.token! },
        ),
      );
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
      // flow=code opts into the code-exchange + refresh flow (see header). The API
      // redirects back ?code=&state= instead of ?access_token=&state=.
      const loginUrl = `${API_URL}/auth/discord/login?redirect=${encodeURIComponent(redirect)}&state_nonce=${encodeURIComponent(expectedNonce)}&flow=code`;
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
