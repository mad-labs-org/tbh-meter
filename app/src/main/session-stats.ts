// Pure helpers for the "open session stats" / "reset session" IPC handlers — kept
// separate from the Electron-bound handlers so the logic is unit-testable.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Upper bound mirrors the website route's zod cap (max 190). */
const MAX_SESSION_ID_LEN = 190;

/** Control-channel flag file consumed by the reader (meter_windows.py): its presence in
 *  the output dir asks the reader to rotate the session id and restart run numbering. */
export const SESSION_RESET_FILENAME = "session_reset";

/** The reader's persisted session record (meter_windows.py save_session). */
export const SESSION_FILENAME = "session.json";

/**
 * A sessionId is valid when it is a non-empty, reasonably-short string with no
 * colon. The colon is reserved as the `<sessionId>:<runNo>` separator in
 * external_id, so a session token containing one would let the website's prefix
 * match bleed into another session — the API rejects those, so we never open a URL
 * the server would refuse.
 */
export function isValidSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SESSION_ID_LEN &&
    !value.includes(":")
  );
}

/** Build the website session-stats URL for a (pre-validated) sessionId. */
export function sessionStatsUrl(siteUrl: string, sessionId: string): string {
  return `${siteUrl}/meter/session/${encodeURIComponent(sessionId)}`;
}

/** App-side "Nova sessão" cut markers (Redesign 2): the timestamps (ms) at which the user asked for
 *  a fresh grind. The session is DERIVED app-side (deriveSessions) from run ts + these cuts — the
 *  reader no longer owns sessions. Stored as a JSON number[] in the output dir. */
export const SESSION_CUTS_FILENAME = "session-cuts.json";

/** Read the manual session-cut timestamps (ms). [] when absent/unreadable/malformed — never throws. */
export function readSessionCuts(outputDir: string | null): number[] {
  if (!outputDir) return [];
  try {
    const parsed = JSON.parse(readFileSync(join(outputDir, SESSION_CUTS_FILENAME), "utf-8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * "Nova sessão": record a manual cut at `nowMs` so the app's session derivation starts a NEW session
 * for runs after it (Redesign 2). App-side now — replaces the old reader flag file (the reader no
 * longer owns sessions). Appends to the cuts file (keeps the most recent 500). Returns false when
 * there is no output dir or the write fails — never throws across IPC.
 */
export function requestSessionReset(outputDir: string | null, nowMs: number = Date.now()): boolean {
  if (!outputDir) return false;
  try {
    const cuts = readSessionCuts(outputDir);
    cuts.push(nowMs);
    writeFileSync(join(outputDir, SESSION_CUTS_FILENAME), JSON.stringify(cuts.slice(-500)));
    return true;
  } catch {
    return false;
  }
}

/**
 * The reader's CURRENT session id, read from session.json in the output dir. This is the
 * authoritative source (persisted across app restarts), so the runs list can mark the
 * current session even between runs / when no live snapshot is arriving. Returns null when
 * the file is absent, unreadable, or malformed — never throws across IPC.
 */
export function readCurrentSessionId(outputDir: string | null): string | null {
  if (!outputDir) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(outputDir, SESSION_FILENAME), "utf-8")) as {
      session_id?: unknown;
    };
    return isValidSessionId(parsed.session_id) ? parsed.session_id : null;
  } catch {
    return null;
  }
}
