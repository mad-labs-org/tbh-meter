// --------------------------------------------------------------------------- //
// single-instance — the APP side of the single-writer guarantee (progress.md
// "Dedup"). The reader-process supervisor already makes ONE app the single owner
// of the reader (kill-before-respawn + kill-on-quit, by image name, in
// reader-process.ts). But that only governs the readers a SINGLE app instance
// spawns. If the user launches the app a SECOND time (double-click again, an
// auto-start + a manual open), the second Electron process would call
// startReader() too — and on win32 each app's killAllReaders()/spawn race the
// other, so two readers can end up attached to the game. Two readers double-write
// the per-run raw/<id>.json under their OWN session ids, and the memory contention
// drops the LIVE gold read into the stale SAVE fallback (2× gold) — the exact root
// cause behind duplicate runs + 2×-gold (the session-scoped net in runs-source.ts
// is the safety layer; this lock attacks the cause).
//
// So: the FIRST app instance grabs Electron's single-instance lock; a second
// instance fails to grab it, surfaces the already-running window, and quits BEFORE
// it ever reaches startReader() — one app, therefore one reader owner.
//
// Variant isolation: the lock is keyed by the app's name/userModelId, which
// index.ts sets to "tbh-meter" vs "tbh-meter-rc" (+ distinct appIds) BEFORE this
// runs. So the side-by-side RC build holds a SEPARATE lock and still runs next to
// the stable install — exactly as the RC is designed to (its whole point is to
// validate next to prod without clobbering it). A second copy of the SAME variant
// is what this blocks.
//
// Pure-ish + injectable (matching auto-update.ts): the real Electron `app` is the
// default dependency, but the decision is driven through a tiny interface so the
// gate-and-quit wiring is unit-testable without spinning up Electron.
// --------------------------------------------------------------------------- //

import { app, type BrowserWindow } from "electron";

/** The slice of Electron's `app` this module needs — injectable so a test can drive
 *  the lock outcome + observe quit without the real runtime. */
export interface SingleInstanceApp {
  /** Electron returns false when another instance already holds the lock. */
  requestSingleInstanceLock(): boolean;
  /** Fires in the PRIMARY instance when a second instance is launched (and quits). */
  on(event: "second-instance", listener: () => void): unknown;
  /** Release the lock + quit this (secondary) instance. */
  quit(): void;
}

/**
 * Try to become the single app instance.
 *
 * Returns true when THIS process owns the lock (the primary) — the caller proceeds
 * with normal startup (and, on win32, becomes the single reader owner). Returns
 * false when another instance already holds it — the caller must abort startup
 * (we've already asked the app to quit, and registered no reader spawn).
 *
 * `onSecondInstance` is invoked in the PRIMARY whenever a later launch is rejected,
 * so the running app can surface its window (the user clicked the icon again and
 * expects the app, not silence). It is NEVER called in the secondary.
 */
export function acquireSingleInstanceLock(
  onSecondInstance: () => void,
  electronApp: SingleInstanceApp = app,
): boolean {
  // A second instance fails to grab the lock: quit immediately so it never spawns a
  // reader (it hasn't started one yet — this runs before startReader()).
  if (!electronApp.requestSingleInstanceLock()) {
    electronApp.quit();
    return false;
  }
  // Primary: when a second instance is launched (and self-quits above), Electron
  // notifies us here so we can raise the existing window instead of doing nothing.
  electronApp.on("second-instance", onSecondInstance);
  return true;
}

/** Bring an existing window forward (un-minimize, show, focus) — the primary's
 *  response to a second launch attempt. Tolerates a null/destroyed window. */
export function focusWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

/**
 * Build the second-instance handler the primary registers via acquireSingleInstanceLock.
 *
 * The window is pulled through a GETTER (not captured eagerly) because the live overlay
 * is created asynchronously after this wiring runs, and can be recreated on macOS
 * "activate" — so the handler must always raise the CURRENT window, never a stale (or
 * still-null) reference. Extracted as a factory so the index.ts composition
 * (`focusWindow(liveWin)`) is unit-testable without Electron, instead of an inline arrow
 * whose wiring no test can reach.
 */
export function makeSecondInstanceHandler(getWindow: () => BrowserWindow | null): () => void {
  return () => focusWindow(getWindow());
}

/**
 * Run `fn` only when THIS process is the primary app instance.
 *
 * A secondary instance (lost the single-instance lock) started NOTHING and is already
 * quitting — it must skip BOTH startup (never spawn a second reader) AND the will-quit
 * reaping. The reaping skip is the load-bearing one: stopReader() -> killAllReaders()
 * kills tbh-reader.exe BY IMAGE NAME (reader-process.ts), so a secondary that ran it
 * would tear down the PRIMARY's healthy reader on every accidental double-launch —
 * defeating the single-writer guarantee this whole module exists to provide.
 *
 * Extracted from the bare `if (!isPrimaryInstance) return;` guards inline in index.ts so
 * the skip is unit-testable: a test can prove a non-primary never calls startReader nor
 * stopReader/killAllReaders.
 */
export function runIfPrimary(isPrimary: boolean, fn: () => void): void {
  if (!isPrimary) return;
  fn();
}
