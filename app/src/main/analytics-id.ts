import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

// --------------------------------------------------------------------------- //
// Analytics client id — a random UUID generated once per install, used ONLY as
// the GA4 client_id for usage analytics (renderer/lib/analytics.ts). Deliberately
// separate from the device id (device-id.ts): the device id is an upload
// credential that must never leave the main process, whereas this id exists only
// to identify a meter install to Google and IS exposed over IPC + sent in hits.
//
// Why persist it main-side: the production renderer runs from a file:// origin,
// where Chromium blocks cookies/localStorage, so gtag cannot store its own
// client_id (and silently sends nothing). A stable id also keeps active-user
// counts honest — one id per install, not a fresh "user" every overlay open.
// --------------------------------------------------------------------------- //

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AnalyticsIdFile {
  analyticsId: string;
}

let cached: string | null = null;

/** Exported for tests — production callers use getAnalyticsClientId(). */
export function analyticsIdPath(): string {
  return join(app.getPath("userData"), "analytics-id.json");
}

/** Exported for tests — parse an analytics-id.json payload, null when unusable. */
export function parseAnalyticsIdFile(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as Partial<AnalyticsIdFile> | null;
    const id = parsed?.analyticsId;
    return typeof id === "string" && UUID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * The install's analytics client id, creating (and persisting) it on first use.
 * A corrupt or hand-edited file is regenerated — the only cost is that the install
 * is counted as a new user from then on.
 */
export function getAnalyticsClientId(): string {
  if (cached) return cached;
  const path = analyticsIdPath();
  if (existsSync(path)) {
    try {
      const id = parseAnalyticsIdFile(readFileSync(path, "utf-8"));
      if (id) {
        cached = id;
        return id;
      }
    } catch {
      // unreadable -> regenerate below
    }
  }
  const id = randomUUID();
  try {
    writeFileSync(path, JSON.stringify({ analyticsId: id } satisfies AnalyticsIdFile, null, 2), "utf-8");
  } catch {
    // best effort — an unpersisted id still works for this app run
  }
  cached = id;
  return id;
}
