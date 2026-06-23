import type { ReaderStatus, UpdateStatus } from "./ipc-types.js";

// Pure splash DISMISS decisions, shared by the main process (which owns the splash window and
// actually tears it down) and unit-tested in isolation. Lives in src/shared so main can import
// it without reaching into renderer code (the renderer's splash-phase.ts only picks the VISUAL
// phase; the dismiss logic is main-owned). No Electron/Node imports — pure functions only.

/**
 * Safety-net deadline for a splash stuck on "searching" (game not running).
 *
 * The reader exits cleanly when no game is open (code 0, failure streak stays 0) and re-polls
 * every 5s, leaving the bring-up phase pinned at "searching" indefinitely. In that state the
 * three existing dismissals all miss: a live snapshot never arrives (no running game), the reader
 * never reaches "ready", and the streak never crosses into "blocked" (that needs 5 spawn/exit
 * FAILURES — a clean no-game exit is not one). Since #205 removed the "Pular" button there is no
 * manual escape either, so the splash stays up forever. This deadline is the fourth dismissal.
 *
 * 45s is chosen to be unambiguous and regression-proof:
 *  - ≫ READY_FALLBACK_MS (8s) and ≫ a calibrated ~8s boot, so a build that's about to find the
 *    game and stream is never cut off;
 *  - ~9 of the reader's 5s no-game poll cycles — at 45s the game plainly isn't running;
 *  - if the game launches within the window the reader leaves "searching" (→ "resolving"), which
 *    flips shouldDismissStalledSplash to false, so the deadline never fires on a real bring-up.
 */
export const SEARCHING_DISMISS_MS = 45_000;

/**
 * Whether the safety-net deadline may dismiss the splash given the CURRENT signals. Pure so the
 * rule is unit-tested, not buried in a timer callback. It fires ONLY in the dead-end case and
 * defers to every legitimate splash state:
 *
 *  - reader past "searching" (`resolving`/`scanning`/`ready`) → false: the reader engaged the
 *    game and a real (possibly slow first-time) bring-up is in flight; its own first-live / ready
 *    / blocked dismissals own that moment, and a cold calibration scan must never be cut short.
 *  - an update in flight (`available`/`downloading`/`downloaded`) → false: the boot-update gate
 *    runs BEFORE the reader, so the reader status is still its initial "searching" while a real
 *    update downloads — the deadline must never kill the live update-progress screen (the app is
 *    about to relaunch into the new build anyway).
 *  - otherwise (reader still "searching", no update applying) → true: the game isn't running, so
 *    hand off to the overlay's normal idle "waiting for the game" state (a null live snapshot).
 */
export function shouldDismissStalledSplash(update: UpdateStatus, reader: ReaderStatus): boolean {
  if (reader !== "searching") return false;
  if (
    update.state === "available" ||
    update.state === "downloading" ||
    update.state === "downloaded"
  ) {
    return false;
  }
  return true;
}

/**
 * HARD ceiling for the splash, independent of the reader phase — the fifth and last-resort dismissal.
 *
 * {@link shouldDismissStalledSplash} only fires while the reader is parked on "searching". A reader
 * STUCK mid-bring-up — "resolving" or "scanning" that never completes (e.g. a cold value-scan on a
 * build the seed doesn't cover, where the managers only resolve in active combat, so the scan loops
 * and the splash hangs) — yields none of the four dismiss signals: no live snapshot, never "ready",
 * never "blocked", never back to "searching". Past this ceiling we dismiss REGARDLESS of phase and
 * hand off to the overlay's own "starting up" message, so the user is never trapped behind a frozen
 * splash. (The reader also now emits "searching" when it abandons an incomplete scan, which the
 * searching deadline catches far sooner; this ceiling backstops the cases where it never gets there.)
 *
 * 6 min is chosen WELL beyond the splash's own "first launch 1–2 min, up to 5" promise, so a
 * legitimately slow first-time bring-up is never cut short — only a genuinely stuck reader reaches it.
 * An update being applied still defers (the app is about to relaunch into the new build anyway).
 */
export const SPLASH_HARD_DISMISS_MS = 360_000;

export function shouldForceDismissSplash(update: UpdateStatus, msSinceArmed: number): boolean {
  if (msSinceArmed < SPLASH_HARD_DISMISS_MS) return false;
  if (
    update.state === "available" ||
    update.state === "downloading" ||
    update.state === "downloaded"
  ) {
    return false;
  }
  return true;
}
