import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

// --------------------------------------------------------------------------- //
// Shared machinery for a per-install UUID: lazily created, persisted to a
// one-field JSON under userData, regenerated if missing/corrupt, and cached in a
// module-level var. device-id.ts and analytics-id.ts are thin wrappers over this.
// --------------------------------------------------------------------------- //

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PersistedUuid {
  /** Resolve the JSON file path under userData. Exported via the wrappers for tests. */
  path(): string;
  /** Parse a payload, null when unusable. Exported via the wrappers for tests. */
  parse(raw: string): string | null;
  /** The install's id, creating (and persisting) it on first use. */
  get(): string;
}

/**
 * Build the read/create/persist/cache machinery for a one-field UUID JSON file.
 * `fileName` is the file under userData; `field` is the single JSON key holding
 * the UUID.
 */
export function createPersistedUuid(opts: { fileName: string; field: string }): PersistedUuid {
  const { fileName, field } = opts;
  let cached: string | null = null;

  function path(): string {
    return join(app.getPath("userData"), fileName);
  }

  function parse(raw: string): string | null {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown> | null;
      const id = parsed?.[field];
      return typeof id === "string" && UUID_RE.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  function get(): string {
    if (cached) return cached;
    const p = path();
    if (existsSync(p)) {
      try {
        const id = parse(readFileSync(p, "utf-8"));
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
      writeFileSync(p, JSON.stringify({ [field]: id }, null, 2), "utf-8");
    } catch {
      // best effort — an unpersisted id still works for this app run
    }
    cached = id;
    return id;
  }

  return { path, parse, get };
}
