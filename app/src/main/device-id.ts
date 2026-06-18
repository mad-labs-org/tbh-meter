import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

// --------------------------------------------------------------------------- //
// Anonymous device id — a random UUID generated once per install, sent as the
// X-Device-Id header on signed-out uploads so the API can group them, and later
// presented to POST /runs/claim to re-attribute them after sign-in. The server
// only ever stores its hash; treat the raw id like a credential (main-process
// only — it is NOT exposed over IPC).
// --------------------------------------------------------------------------- //

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DeviceIdFile {
  deviceId: string;
}

let cached: string | null = null;

/** Exported for tests — production callers use getDeviceId(). */
export function deviceIdPath(): string {
  return join(app.getPath("userData"), "device-id.json");
}

/** Exported for tests — parse a device-id.json payload, null when unusable. */
export function parseDeviceIdFile(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as Partial<DeviceIdFile> | null;
    const id = parsed?.deviceId;
    return typeof id === "string" && UUID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * The install's device id, creating (and persisting) it on first use. A corrupt
 * or hand-edited file is regenerated — the old anonymous runs then simply stay
 * unclaimed until their TTL.
 */
export function getDeviceId(): string {
  if (cached) return cached;
  const path = deviceIdPath();
  if (existsSync(path)) {
    try {
      const id = parseDeviceIdFile(readFileSync(path, "utf-8"));
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
    writeFileSync(path, JSON.stringify({ deviceId: id } satisfies DeviceIdFile, null, 2), "utf-8");
  } catch {
    // best effort — an unpersisted id still works for this app run
  }
  cached = id;
  return id;
}
