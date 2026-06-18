import { createPersistedUuid } from "./persisted-uuid.js";

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

const store = createPersistedUuid({ fileName: "analytics-id.json", field: "analyticsId" });

/** Exported for tests — production callers use getAnalyticsClientId(). */
export function analyticsIdPath(): string {
  return store.path();
}

/** Exported for tests — parse an analytics-id.json payload, null when unusable. */
export function parseAnalyticsIdFile(raw: string): string | null {
  return store.parse(raw);
}

/**
 * The install's analytics client id, creating (and persisting) it on first use.
 * A corrupt or hand-edited file is regenerated — the only cost is that the install
 * is counted as a new user from then on.
 */
export function getAnalyticsClientId(): string {
  return store.get();
}
