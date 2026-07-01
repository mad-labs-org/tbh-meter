import { app } from "electron";

// --------------------------------------------------------------------------- //
// Crash recovery — reloads a renderer whose process died mid-session so the
// window comes back instead of sitting blank/frozen forever.
//
// Why this exists: on Electron 42.4.1 / Chromium 148 (Windows 11) the meter's
// renderers die in bulk — a 9-day #log-error harvest was dominated by 179
// `renderer:process-gone` + 177 `child:GPU:process-gone` reports (74% of all
// meter errors), reasons "killed"/"crashed" (GPU exitCode 34). This is the known
// Electron-42 transparent-overlay GPU crash cascade (the LIVE overlay window is
// `transparent: true`), and error-report.ts already RELAYS it as telemetry. But
// relaying is all that happened: a dead renderer process is NOT auto-restarted by
// Chromium (only GPU/utility CHILD processes are), so the overlay/splash window
// went blank and stayed blank for the rest of the session — matching the field
// reports of "meter won't open / stuck on 'Iniciando' forever, reinstalling
// doesn't help". This module closes that gap by reloading the crashed webContents.
//
// Separation of concerns: this is deliberately NOT in error-report.ts. That module
// documents that "reporting must never … change crash semantics", and reloading a
// renderer DOES change crash semantics — so recovery is its own module with its own
// listener. error-report.ts still owns the reporting; we only own the reload. Both
// subscribe to render-process-gone independently (Electron fans one event out to
// every listener), so neither depends on the other's ordering or state.
//
// Loop-guard: a renderer that crashes on load (e.g. a GPU state so broken every
// paint re-crashes) would reload → crash → reload in a tight storm, pinning the CPU
// and spamming the relay. So we cap reloads per window to MAX_RELOADS within
// RELOAD_WINDOW_MS; past that we give up and leave the window as-is (the crash is
// still reported by error-report.ts). A window that recovers and only crashes again
// much later ages out of the window and gets a fresh budget — the cap targets a
// storm, not a rare repeat.
// --------------------------------------------------------------------------- //

/** Max renderer reloads allowed within {@link RELOAD_WINDOW_MS} before we give up. */
export const MAX_RELOADS = 3;
/** Sliding window over which {@link MAX_RELOADS} is counted. */
export const RELOAD_WINDOW_MS = 60_000;

/**
 * Pure decision: may we reload a renderer that just crashed, given the timestamps
 * of its recent reloads? True iff fewer than `max` reloads fall within the last
 * `windowMs`. Pure (no Electron/Node) so the loop-guard is unit-tested in isolation,
 * exactly like reader-policy.ts / splash-decide.ts — the installer below owns the
 * side effects (the actual reload and the timestamp bookkeeping).
 */
export function shouldReloadCrashedRenderer(
  recentReloadTimestamps: number[],
  now: number,
  max: number = MAX_RELOADS,
  windowMs: number = RELOAD_WINDOW_MS,
): boolean {
  const cutoff = now - windowMs;
  let withinWindow = 0;
  for (const ts of recentReloadTimestamps) {
    if (ts > cutoff) withinWindow++;
  }
  return withinWindow < max;
}

// True once the app begins quitting. During shutdown Electron tears down the
// renderers, firing render-process-gone with non-clean reasons ("killed") as NORMAL
// teardown — reloading then would fight the quit (and can throw on a half-torn-down
// webContents). We own this flag independently of index.ts and error-report.ts (same
// pattern error-report.ts uses) so recovery makes no assumptions about their state.
let quitting = false;

// Per-webContents (keyed by webContents.id) history of recent reload timestamps.
// Bounded by pruning to the sliding window on each crash and dropping the entry when
// the webContents is destroyed, so it never grows unbounded across a long session.
const reloadHistory = new Map<number, number[]>();

/**
 * Install the renderer crash-recovery hook. Call once, alongside
 * installGlobalErrorReporting in main/index.ts.
 *
 * Only render-process-gone is handled: renderers are not auto-restarted, so a dead
 * one needs a manual reload. child-process-gone (GPU/utility) is intentionally left
 * alone — Chromium relaunches those itself, and error-report.ts already reports them
 * as telemetry; a reload is not applicable there.
 */
export function installCrashRecovery(): void {
  app.on("before-quit", () => {
    quitting = true;
  });

  app.on("render-process-gone", (_event, webContents, details) => {
    // A clean exit is an intentional teardown (e.g. window closed), not a fault —
    // nothing to recover. Once quitting, every renderer death is expected shutdown.
    if (quitting || details.reason === "clean-exit") return;
    // The window may already be gone (closed as its process died); reloading a
    // destroyed webContents throws. Also drop any stale history for that id.
    if (webContents.isDestroyed()) {
      reloadHistory.delete(webContents.id);
      return;
    }

    const now = Date.now();
    const cutoff = now - RELOAD_WINDOW_MS;
    // First crash we've seen for this id — decided BEFORE the map is written so we arm
    // the destroyed-cleanup exactly once per window (see below).
    const firstSeen = !reloadHistory.has(webContents.id);
    // Keep only timestamps still inside the window, so the map stays bounded and the
    // guard reflects only recent activity (an old crash must not spend the budget).
    const history = (reloadHistory.get(webContents.id) ?? []).filter((ts) => ts > cutoff);

    // Drop the history when the window is finally destroyed so the map doesn't leak ids
    // across the session. Armed ONCE per window (on its first crash): re-arming on every
    // reload would pile "destroyed" once-listeners onto a window that crash-reloads many
    // times over a session and trip Node's MaxListenersExceededWarning. The give-up path
    // never needs its own arm — it's only reachable after prior reloads already armed it.
    if (firstSeen) webContents.once("destroyed", () => reloadHistory.delete(webContents.id));

    if (!shouldReloadCrashedRenderer(history, now)) {
      // Reload storm — give up. The crash is already relayed by error-report.ts; a
      // persistently-crashing renderer that we keep reloading would just spin.
      reloadHistory.set(webContents.id, history);
      console.warn(
        `[crash-recovery] renderer ${webContents.id} exceeded ${MAX_RELOADS} reloads in ${RELOAD_WINDOW_MS}ms (${details.reason}) — giving up`,
      );
      return;
    }

    history.push(now);
    reloadHistory.set(webContents.id, history);

    // Best-effort, exactly like error-report.ts: recovery must never throw out of an
    // Electron event handler (that would surface as an uncaught main-process error).
    try {
      webContents.reload();
    } catch (err) {
      console.warn(
        `[crash-recovery] reload of renderer ${webContents.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}
