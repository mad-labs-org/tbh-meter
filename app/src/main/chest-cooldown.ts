// Blue-chest cooldown ENGINE (#266) — pure, testable, no I/O. The tracker glue
// (cooldown-tracker.ts) owns the live subscription, persistence and broadcasts; this
// module is only the decision logic, so the rules below are exercised in isolation.

import type { LiveSnapshot } from "../shared/run-types.js";
import type { ChestCooldown } from "../shared/cooldown-types.js";
import { bossBoxForStage, isBlueBox } from "../shared/chest-boxes.js";

/** Max drop-log entries kept in settings (append-only history; oldest dropped). Bounds
 *  settings.json growth — ~200 recent farms is plenty of "history" context. */
export const DROP_LOG_CAP = 200;

/** The reader's stage-boss (blue) chest is `drops` index 1: [common(0), stageBoss(1), actBoss(2)]. */
export const BLUE_CHEST_INDEX = 1;

/** Ephemeral per-stage last-seen count. NOT persisted: rebuilt from the live stream, used
 *  only to detect a rising edge correctly across stage switches. */
export type SeenCounts = Map<number, number>;

/**
 * Pure rising-edge primitive: update `seen` for `key` and decide whether `count` is a NEW
 * rise above the last-seen value. Mutates `seen` (the caller owns it). Rules (#266):
 *  - FIRST time we see a `key` → seed its baseline, return false. Avoids a false drop on
 *    launch or the first observation mid-run (we don't know the prior count).
 *  - count > last-seen → rising edge (true).
 *  - count <= last-seen (a new run resets it toward 0) → update the baseline, return false;
 *    the next rise from there fires normally.
 * Per-key baselines (not a global counter) keep keys independent: a rise on B never looks
 * like a rise on A. Shared by the blue-chest cooldown tracker and the per-type drop notifier
 * (drop-notifier.ts), each owning its own `seen` map.
 */
export function observeRisingEdge(seen: SeenCounts, key: number, count: number): boolean {
  if (typeof count !== "number" || !Number.isFinite(count)) return false;
  const prev = seen.get(key);
  seen.set(key, count);
  if (prev === undefined) return false;
  return count > prev;
}

/**
 * Observe a live snapshot and decide whether it represents a NEW blue-chest (stage-boss)
 * drop. Resolves the snapshot's stage to its BOX (the chest level) and runs the rising-edge
 * on the blue-chest counter keyed by that box — so the same Lv80 box dropping on 3-9 then 1-9
 * is ONE cooldown, not two. Returns the verdict + boxKey + the originating stageKey, or null
 * when the snapshot carries no stage / blue-chest count, or the stage's box is not a blue box
 * (act-boss / unmapped stages have no blue cooldown).
 */
export function observeDrop(
  seen: SeenCounts,
  snap: LiveSnapshot,
): { dropped: boolean; boxKey: number; stageKey: number } | null {
  const stageKey = snap.stageKey;
  const count = snap.drops?.[BLUE_CHEST_INDEX];
  if (stageKey == null || typeof count !== "number" || !Number.isFinite(count)) return null;
  const boxKey = bossBoxForStage(stageKey);
  if (!isBlueBox(boxKey)) return null;
  return { dropped: observeRisingEdge(seen, boxKey!, count), boxKey: boxKey!, stageKey };
}

/** Upsert a drop into the ACTIVE set: newest first, one entry per BOX (a re-drop of the same
 *  chest level — on any stage — refreshes its line and moves it to the front rather than
 *  stacking duplicates). */
export function applyDrop(active: ChestCooldown[], event: ChestCooldown): ChestCooldown[] {
  return [event, ...active.filter((c) => c.boxKey !== event.boxKey)];
}

/** Clear (delete) the active line for a box — the runs-window tab's `X`. Does NOT touch the
 *  log; a later auto-detected drop re-creates the line (a pinned box returns as a placeholder). */
export function clearCooldown(active: ChestCooldown[], boxKey: number): ChestCooldown[] {
  return active.filter((c) => c.boxKey !== boxKey);
}

/** Hide a box's line from the OVERLAY only — the overlay's `X` (a declutter, not a delete).
 *  The entry stays active (still shown in the tab); a re-drop (applyDrop) replaces it with an
 *  un-hidden entry, so it returns to the overlay automatically. */
export function hideCooldown(active: ChestCooldown[], boxKey: number): ChestCooldown[] {
  return active.map((c) => (c.boxKey === boxKey ? { ...c, hidden: true } : c));
}

/** Append a drop to the history log (newest first), capped at `cap`. */
export function appendLog(
  log: ChestCooldown[],
  event: ChestCooldown,
  cap = DROP_LOG_CAP,
): ChestCooldown[] {
  return [event, ...log].slice(0, cap);
}
