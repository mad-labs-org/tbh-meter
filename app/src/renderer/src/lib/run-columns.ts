import type { RunColumnConfig } from "../../../shared/ipc-types.js";

// Pure helpers for the runs-list column config (order + visibility). The React view owns
// the column REGISTRY (labels, grid tracks, cell renderers); these operate only on the
// persisted {key, visible}[] so they stay trivially testable. SSOT for the config shape
// is RunColumnConfig in ipc-types.

/**
 * Resolve a saved config against the registry's default key order:
 *  - empty/absent saved -> every default key, visible, in default order;
 *  - otherwise keep the saved order + visibility for known keys, DROP unknown (removed)
 *    keys, and APPEND any default keys missing from the saved config (columns added in a
 *    newer build) as visible at the end.
 * Forward-compatible and idempotent: resolve(resolve(x)) === resolve(x).
 */
export function resolveColumnConfig(
  defaultKeys: string[],
  saved: RunColumnConfig[] | undefined | null,
): RunColumnConfig[] {
  if (!saved || saved.length === 0) return defaultKeys.map((key) => ({ key, visible: true }));
  const known = new Set(defaultKeys);
  const seen = new Set<string>();
  const out: RunColumnConfig[] = [];
  for (const c of saved) {
    if (known.has(c.key) && !seen.has(c.key)) {
      out.push({ key: c.key, visible: c.visible });
      seen.add(c.key);
    }
  }
  for (const key of defaultKeys) {
    if (!seen.has(key)) out.push({ key, visible: true });
  }
  return out;
}

/** Drag & drop reorder: move `fromKey` to land at `toKey`'s slot. No-op if a key is missing
 *  or they're equal (returns the same array reference so callers can skip a save). */
export function reorderColumnConfig(
  config: RunColumnConfig[],
  fromKey: string,
  toKey: string,
): RunColumnConfig[] {
  if (fromKey === toKey) return config;
  const from = config.findIndex((c) => c.key === fromKey);
  const to = config.findIndex((c) => c.key === toKey);
  if (from < 0 || to < 0) return config;
  const next = config.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Toggle a column's visibility — but never hide the LAST visible column (an empty table
 *  is useless, and there'd be no header affordance left to bring columns back). */
export function toggleColumnConfig(config: RunColumnConfig[], key: string): RunColumnConfig[] {
  const visibleCount = config.filter((c) => c.visible).length;
  return config.map((c) =>
    c.key === key && !(c.visible && visibleCount <= 1) ? { key: c.key, visible: !c.visible } : c,
  );
}
