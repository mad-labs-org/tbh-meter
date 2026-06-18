// Blue-chest cooldown TRACKER — the impure glue around the pure engine (chest-cooldown.ts).
// Owns the live subscription, persistence (AppSettings), the renderer broadcast, and the
// OS "ready" notification. Auto-detect only: there is NO manual "mark dropped" — the manual
// actions are the renderer's hover `X` (dismiss, on the Tracker tab + overlay) and the Settings
// tab's "Clear all". A re-detected drop re-creates a cleared line, so tracking never stops (the
// differentiator vs the manual community tool). Everything is keyed by BOX (chest level), not
// stage — the same Lv80 box dropping on different stages is one cooldown.

import { Notification } from "electron";
import type { LiveSnapshot } from "../shared/run-types.js";
import type { ChestCooldown, CooldownState } from "../shared/cooldown-types.js";
import { remainingMs } from "../shared/cooldown-types.js";
import { clampCooldownMin } from "../shared/ipc-types.js";
import { boxLevel } from "../shared/chest-boxes.js";
import { getSettings, updateSettings } from "./settings.js";
import { getLiveSource } from "./sources/live-source.js";
import { tMain } from "./i18n.js";
import { observeDrop, applyDrop, clearCooldown, hideCooldown, appendLog, type SeenCounts } from "./chest-cooldown.js";

type Broadcast = (channel: string, payload?: unknown) => void;

let broadcast: Broadcast = () => {};
// Ephemeral (NOT persisted): per-BOX last-seen blue-chest count for rising-edge detection.
const seen: SeenCounts = new Map();
// One pending "ready" notification per box, keyed by boxKey (cleared/replaced on re-drop or
// dismiss so we never fire a stale or duplicate nudge).
const notifyTimers = new Map<number, ReturnType<typeof setTimeout>>();

/** The configured cooldown length in ms (user setting, clamped), shared by the notification
 *  scheduler. The renderer reads the same setting for its countdowns. */
function cooldownMs(): number {
  return clampCooldownMin(getSettings().chestCooldownMin) * 60 * 1000;
}

/** Wire the tracker once (from registerIpcHandlers): subscribe to the live stream and
 *  re-arm "ready" notifications for cooldowns that were still cooling at launch. */
export function initCooldownTracker(bcast: Broadcast): void {
  broadcast = bcast;
  getLiveSource().on("live", onLive);
  // Persisted cooldowns survive restart; re-schedule notifications for any still cooling.
  // Already-ready ones are skipped (they readied while the app was closed — no launch spam).
  for (const cd of getSettings().chestCooldowns) scheduleNotify(cd);
}

/** Re-arm every pending "ready" notification against the CURRENT cooldown length. Call this when
 *  `chestCooldownMin` changes: the renderer countdowns re-derive from `dropAt` each tick, but the
 *  main-process setTimeout was armed with the OLD delay (cooldownMs is read once, at schedule
 *  time) — without this it would fire early (timer raised) or late (timer lowered). scheduleNotify
 *  cancels-then-reschedules per box, so re-running it over the active list is idempotent. */
export function rearmNotifications(): void {
  for (const cd of getSettings().chestCooldowns) scheduleNotify(cd);
}

/** Current cooldown state for the renderer (active lines + history log). */
export function getCooldownState(): CooldownState {
  const s = getSettings();
  return { active: s.chestCooldowns, log: s.chestDropLog };
}

/** Clear the active line for a box (the hover `X`). Keeps the history log; cancels any
 *  pending notification. A later auto-detected drop re-creates the line (a pinned box returns
 *  as a placeholder). */
export function dismissCooldown(boxKey: number): void {
  if (typeof boxKey !== "number" || !Number.isFinite(boxKey)) return;
  cancelNotify(boxKey);
  updateSettings({ chestCooldowns: clearCooldown(getSettings().chestCooldowns, boxKey) });
  broadcast("meter:cooldowns", getCooldownState());
}

/** Hide a box's line from the OVERLAY only (the overlay's `X`). Keeps the entry active (still
 *  shown in the runs-window tab) and lets its "ready" notification still fire — only the overlay
 *  strip is decluttered. A re-detected drop brings it back. */
export function hideCooldownInOverlay(boxKey: number): void {
  if (typeof boxKey !== "number" || !Number.isFinite(boxKey)) return;
  updateSettings({ chestCooldowns: hideCooldown(getSettings().chestCooldowns, boxKey) });
  broadcast("meter:cooldowns", getCooldownState());
}

/** Clear ALL active cooldowns + the drop history (the Settings tab's "Clear all"). The pinned
 *  route is KEPT — it is config (edited via the Tracker tab's level chips), not tracked drops.
 *  Cancels every pending "ready" notification. */
export function clearAllCooldowns(): void {
  for (const t of notifyTimers.values()) clearTimeout(t);
  notifyTimers.clear();
  updateSettings({ chestCooldowns: [], chestDropLog: [] });
  broadcast("meter:cooldowns", getCooldownState());
}

function onLive(snap: LiveSnapshot | null): void {
  if (!snap) return;
  // Tracker disabled in settings → don't auto-detect. `seen` isn't updated while off, so on
  // re-enable the first observation re-seeds the baseline without firing a false drop.
  if (!getSettings().cooldownTrackerEnabled) return;
  const result = observeDrop(seen, snap);
  if (!result || !result.dropped) return;
  // Route filter: when "track outside route" is off, a drop of a box NOT pinned to the route
  // is ignored here (no card/log). The independent drop notifier (drop-notifier.ts) still fires.
  const s = getSettings();
  if (!s.trackOutsideRoute && !s.chestRoute.includes(result.boxKey)) return;
  const event: ChestCooldown = {
    boxKey: result.boxKey,
    dropAt: Date.now(),
    lastStageKey: result.stageKey,
    mode: snap.mode,
  };
  updateSettings({
    chestCooldowns: applyDrop(s.chestCooldowns, event),
    chestDropLog: appendLog(s.chestDropLog, event),
  });
  scheduleNotify(event);
  broadcast("meter:cooldowns", getCooldownState());
}

/** Arm a single "ready" notification for this cooldown, replacing any prior one for the
 *  box. No-op once already ready (delay <= 0) so a relaunch never fires stale nudges. */
function scheduleNotify(cd: ChestCooldown): void {
  cancelNotify(cd.boxKey);
  const delay = remainingMs(cd, Date.now(), cooldownMs());
  if (delay <= 0) return;
  const timer = setTimeout(() => {
    notifyTimers.delete(cd.boxKey);
    notifyReady(cd);
  }, delay);
  // Don't let a pending notification alone keep the app alive (mirrors auto-update's timer).
  timer.unref?.();
  notifyTimers.set(cd.boxKey, timer);
}

function cancelNotify(boxKey: number): void {
  const t = notifyTimers.get(boxKey);
  if (t) {
    clearTimeout(t);
    notifyTimers.delete(boxKey);
  }
}

function notifyReady(cd: ChestCooldown): void {
  if (!Notification.isSupported()) return;
  const lvl = boxLevel(cd.boxKey);
  const where = [lvl != null ? `Lv${lvl}` : null, cd.mode].filter(Boolean).join(" · ") || `Lv?`;
  new Notification({
    title: tMain("cooldowns.notifTitle"),
    body: tMain("cooldowns.notifBody", { where }),
  }).show();
}
