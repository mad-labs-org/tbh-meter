import { createPersistedUuid } from "./persisted-uuid.js";

// --------------------------------------------------------------------------- //
// Anonymous device id — a random UUID generated once per install, presented to
// POST /runs/claim to re-attribute legacy anonymous runs after sign-in. The
// server only ever stores its hash; treat the raw id like a credential
// (main-process only — it is NOT exposed over IPC).
// --------------------------------------------------------------------------- //

const store = createPersistedUuid({ fileName: "device-id.json", field: "deviceId" });

/** Exported for tests — production callers use getDeviceId(). */
export function deviceIdPath(): string {
  return store.path();
}

/** Exported for tests — parse a device-id.json payload, null when unusable. */
export function parseDeviceIdFile(raw: string): string | null {
  return store.parse(raw);
}

/**
 * The install's device id, creating (and persisting) it on first use. A corrupt
 * or hand-edited file is regenerated — the old anonymous runs then simply stay
 * unclaimed until their TTL.
 */
export function getDeviceId(): string {
  return store.get();
}
