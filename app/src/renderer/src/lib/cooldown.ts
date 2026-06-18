import { useEffect, useState } from "react";
import type { ChestCooldown, CooldownState } from "../../../shared/cooldown-types.js";
import { DEFAULT_COOLDOWN_MS } from "../../../shared/cooldown-types.js";
import { clampCooldownMin } from "../../../shared/ipc-types.js";

const EMPTY: CooldownState = { active: [], log: [] };

/** Subscribe to the main process's blue-chest cooldown state (active lines + history log).
 *  Fetches once on mount — catching drops auto-detected before this window opened — then
 *  stays in sync via the `meter:cooldowns` broadcast. SSOT is the main-process tracker. */
export function useCooldowns(): CooldownState {
  const [state, setState] = useState<CooldownState>(EMPTY);
  useEffect(() => {
    void window.meter.getCooldowns().then(setState);
    return window.meter.onCooldowns(setState);
  }, []);
  return state;
}

/** Whether the cooldown tracker is enabled (settings; default ON). Read-only here — the toggle
 *  lives in the runs-window Tracker tab; the overlay uses this to hide itself when off. */
export function useTrackerEnabled(): boolean {
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    void window.meter.getSettings().then((s) => setEnabled(s.cooldownTrackerEnabled));
    return window.meter.onSettingsChanged((s) => setEnabled(s.cooldownTrackerEnabled));
  }, []);
  return enabled;
}

/** The configured cooldown length in ms (user setting `chestCooldownMin`, clamped), kept in
 *  sync. Threaded into the cards/overlay so every countdown uses the same duration and one
 *  subscription drives them all. */
export function useCooldownMs(): number {
  const [ms, setMs] = useState(DEFAULT_COOLDOWN_MS);
  useEffect(() => {
    const read = (min: number): void => setMs(clampCooldownMin(min) * 60 * 1000);
    void window.meter.getSettings().then((s) => read(s.chestCooldownMin));
    return window.meter.onSettingsChanged((s) => read(s.chestCooldownMin));
  }, []);
  return ms;
}

/** The pinned route — blue-box keys the user wants always shown — kept in sync. Used by the
 *  Tracker tab and the overlay to synthesize placeholder cards for boxes that haven't dropped. */
export function useRoute(): number[] {
  const [route, setRoute] = useState<number[]>([]);
  useEffect(() => {
    void window.meter.getSettings().then((s) => setRoute(s.chestRoute));
    return window.meter.onSettingsChanged((s) => setRoute(s.chestRoute));
  }, []);
  return route;
}

/** A wall clock that re-renders every `intervalMs` so timestamp-anchored countdowns tick.
 *  Mirrors LiveView: the math stays anchored to `dropAt`; this only drives re-render, so it
 *  never accumulates interval drift. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** mm:ss for a remaining-ms duration (e.g. 438000 -> "7:18"). */
export function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** One row of the tracker: a chest level (box) + its active cooldown, or null when the box is
 *  only PINNED to the route and hasn't dropped yet (a placeholder, shown as "available"). */
export interface TrackerEntry {
  boxKey: number;
  cd: ChestCooldown | null;
}

/** The boxes to show: the union of active cooldowns and the pinned route, one entry per box. A
 *  pinned box that is currently on cooldown shows its real cooldown (not a placeholder). Order
 *  is by box key (the caller re-sorts by remaining time). */
export function buildTrackerEntries(active: ChestCooldown[], route: number[]): TrackerEntry[] {
  const byBox = new Map<number, ChestCooldown>();
  for (const cd of active) byBox.set(cd.boxKey, cd);
  const boxes = new Set<number>();
  for (const cd of active) boxes.add(cd.boxKey);
  for (const k of route) boxes.add(k);
  return [...boxes].map((boxKey) => ({ boxKey, cd: byBox.get(boxKey) ?? null }));
}
