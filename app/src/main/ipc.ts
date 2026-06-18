import { app, ipcMain, dialog, shell, BrowserWindow } from "electron";
import { dataDir } from "./logs-archive.js";
import { getReaderStatus, readerEvents, getReaderState, retryReader } from "./reader-process.js";
import type { LiveSnapshot } from "../shared/run-types.js";
import type { ReaderStatus, AppSettings } from "../shared/ipc-types.js";
import { getSettings, updateSettings, resolveOutputDir, applyLaunchOnStartup, sanitizeRoute } from "./settings.js";
import { getAnalyticsClientId } from "./analytics-id.js";
import { clampCooldownMin } from "../shared/ipc-types.js";
import { tMain } from "./i18n.js";
import { listRuns, getRun, clearAllRuns, pruneToMaxRuns } from "./runs-store.js";
import { getRunsSource, setFavoritePredicate } from "./sources/runs-source.js";
import { isFavorite, toggleFavorite, invalidateFavoritesCache } from "./favorites-store.js";
import { getLiveSource } from "./sources/live-source.js";
import {
  initCooldownTracker,
  getCooldownState,
  dismissCooldown,
  hideCooldownInOverlay,
  clearAllCooldowns,
  rearmNotifications,
} from "./cooldown-tracker.js";
import { initDropNotifier } from "./drop-notifier.js";
import {
  getUpdateStatus,
  onUpdateStatus,
  quitAndInstallUpdate,
  updaterSupported,
  checkForUpdates,
} from "./auto-update.js";
import { initAuth, getStatus, signIn, signOut } from "./auth.js";
import { shareRun, getShareStatus } from "./share.js";
import { reportError } from "./error-report.js";
import { requestUploadNow } from "./auto-upload.js";
import { isValidSessionId, sessionStatsUrl, requestSessionReset } from "./session-stats.js";
import { SITE_URL, DISCORD_INVITE_URL } from "./config.js";
import { broadcast } from "./broadcast.js";

interface IpcDeps {
  /** Apply opacity/always-on-top/font-scale from settings to the live window. */
  applyLiveSettings(): void;
  /** Apply the font scale from settings to the runs-list window (if open). */
  applyListSettings(): void;
  /** Rebuild the tray menu with the current language's labels. */
  refreshTrayMenu(): void;
  /** Create (or focus) the runs list window. */
  openListWindow(): void;
  /** Pin the live window's height to the renderer-measured content height. */
  setLiveHeight(height: number): void;
  /** Begin a custom live-overlay move (title bar) or width-resize (right edge). Geometry
   *  is resolved main-side against the OS cursor in DIP — see live-drag.ts. */
  startWindowDrag(mode: "move" | "resize"): void;
  /** Apply one drag tick (main re-reads the cursor and moves/resizes the live window). */
  moveWindowDrag(): void;
  /** End the drag in progress. */
  endWindowDrag(): void;
  /** Recenter the live overlay on-screen at the default size (lost-window recovery). */
  resetLiveWindow(): void;
}

/** Re-point the file sources at the currently-resolved output directory. */
function repointSources(): void {
  const dir = resolveOutputDir();
  // The favorites sidecar lives in the output dir, so a re-point must reload it (a different folder
  // — or the RC vs stable variant — has its own favorites.json). Drop the cache before the sources
  // reload, so the next listIndex() projection stamps `favorite` from the NEW dir.
  invalidateFavoritesCache();
  getRunsSource().setDir(dir);
  getLiveSource().setDir(dir);
}

export function registerIpcHandlers(deps: IpcDeps): void {
  // Single source of truth: app.getVersion() reads package.json's version, the same
  // field CI writes the computed release version into (see scripts/compute-version.mjs).
  ipcMain.handle("meter:get-app-version", () => app.getVersion());

  // Stable per-install GA4 client_id for the overlay's usage analytics (analytics.ts).
  ipcMain.handle("meter:get-analytics-id", () => getAnalyticsClientId());

  ipcMain.handle("meter:get-settings", () => getSettings());

  ipcMain.handle("meter:set-settings", (_event, partial) => {
    const prevDir = resolveOutputDir();
    const changed = (partial ?? {}) as Partial<Record<string, unknown>>;
    // Sanitize the blue-chest fields at the persist boundary, not just at load: a malformed
    // chestRoute or out-of-range timer from the renderer would otherwise sit raw in settings.json
    // until the next relaunch (everything reads them clamped, but the stored value should be sane).
    if (changed.chestCooldownMin !== undefined) changed.chestCooldownMin = clampCooldownMin(changed.chestCooldownMin as number);
    if (changed.chestRoute !== undefined) changed.chestRoute = sanitizeRoute(changed.chestRoute);
    const settings = updateSettings(changed as Partial<AppSettings>);
    deps.applyLiveSettings();
    deps.applyListSettings();
    // Per-key side effects (#232): the login item touches the registry and the tray
    // menu rebuild is visible, so only run them when their key was actually sent.
    if (changed.launchOnStartup !== undefined) applyLaunchOnStartup();
    if (changed.language !== undefined) deps.refreshTrayMenu();
    if (resolveOutputDir() !== prevDir) repointSources();
    // Lowering (or enabling) the max-runs cap should take effect immediately — prune the surplus
    // now instead of waiting for the next finished run. Only when the cap key was actually sent.
    if (changed.maxRuns !== undefined) pruneToMaxRuns();
    // The "ready" notification timers are armed with the cooldown length at schedule time; when
    // the user changes it, re-derive every pending timer (the renderer countdowns already do).
    if (changed.chestCooldownMin !== undefined) rearmNotifications();
    // Keep every OTHER window's settings copy in sync (language/font-scale changes in
    // the runs window must reach the live overlay + splash live). The sender already
    // has the value optimistically; receiving the echo is harmless.
    broadcast("meter:settings-changed", settings);
    return settings;
  });

  ipcMain.handle("meter:pick-output-dir", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;
    const chosen = result.filePaths[0];
    const settings = updateSettings({ outputDir: chosen });
    repointSources();
    broadcast("meter:settings-changed", settings);
    return chosen;
  });

  ipcMain.handle("meter:resolved-output-dir", () => resolveOutputDir());

  ipcMain.handle("meter:list-runs", () => listRuns());
  ipcMain.handle("meter:get-run", (_event, id: string) => getRun(id));
  ipcMain.handle("meter:clear-runs", () => clearAllRuns());
  // Favorite toggle (Feature 3): flip the sidecar flag, then reload the source so its index
  // re-projects `favorite` and broadcasts runs-changed — every window re-renders the star + any
  // "favorites only" filter. Returns the new state to the caller for an optimistic UI flip.
  ipcMain.handle("meter:toggle-favorite", (_event, runId: unknown) => {
    const now = toggleFavorite(runId);
    getRunsSource().reloadNow();
    return now;
  });

  // --- Blue-chest cooldowns (#265) -------------------------------------------
  // Auto-detected from the live stream by cooldown-tracker (keyed by chest level / box). Manual
  // paths: the hover "X" (clears one active line; history kept) and the Settings tab's "Clear all".
  ipcMain.handle("meter:get-cooldowns", () => getCooldownState());
  ipcMain.on("meter:dismiss-cooldown", (_event, boxKey: unknown) => {
    if (typeof boxKey === "number") dismissCooldown(boxKey);
  });
  ipcMain.on("meter:hide-cooldown", (_event, boxKey: unknown) => {
    if (typeof boxKey === "number") hideCooldownInOverlay(boxKey);
  });
  ipcMain.on("meter:clear-cooldowns", () => clearAllCooldowns());
  // Open the web wiki's stage page for a stageKey. The numeric key resolves on the site and
  // 301-redirects to the readable slug, so no slug is computed here. URL is built from
  // SITE_URL (never escapes the allowlisted origin).
  ipcMain.on("meter:open-stage-page", (_event, stageKey: unknown) => {
    if (typeof stageKey !== "number" || !Number.isFinite(stageKey)) return;
    void shell.openExternal(`${SITE_URL}/stages/${stageKey}`);
  });

  ipcMain.handle("meter:open-list-window", () => {
    deps.openListWindow();
  });

  ipcMain.on("meter:set-live-height", (_event, height: number) => {
    deps.setLiveHeight(Number(height) || 0);
  });

  ipcMain.on("meter:open-data-folder", () => {
    void shell.openPath(dataDir());
  });

  // Custom live-overlay drag/resize. The renderer (pointer-captured, #377) only drives
  // cadence and sends NO coordinates: the geometry is resolved main-side against the OS
  // cursor in DIP, so it is correct under any Windows display scale (the renderer's screenX
  // leaks physical px at devicePixelRatio != 1 and drove a runaway resize). See live-drag.ts.
  ipcMain.on("meter:window-drag-start", (_event, mode: "move" | "resize") => {
    deps.startWindowDrag(mode === "resize" ? "resize" : "move");
  });

  ipcMain.on("meter:window-drag-move", () => {
    deps.moveWindowDrag();
  });

  ipcMain.on("meter:window-drag-end", () => {
    deps.endWindowDrag();
  });

  ipcMain.on("meter:reset-window-position", () => {
    deps.resetLiveWindow();
  });

  ipcMain.handle("meter:get-reader-status", () => getReaderStatus());
  ipcMain.handle("meter:reader-status", () => getReaderState());
  ipcMain.on("meter:reader-retry", () => retryReader());

  ipcMain.handle("meter:updater-supported", () => updaterSupported());
  ipcMain.on("meter:check-updates", () => checkForUpdates());
  ipcMain.handle("meter:get-update-status", () => getUpdateStatus());
  ipcMain.on("meter:quit-and-install", () => quitAndInstallUpdate());

  ipcMain.on("meter:minimize", (event) => {
    // Hide to the tray — the meter keeps reading in the background; restore via the
    // tray ("Show live meter" / click).
    BrowserWindow.fromWebContents(event.sender)?.hide();
  });
  ipcMain.on("meter:close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  // --- Auth (Discord OAuth, main-process only) --------------------------------
  // initAuth broadcasts the restored auth status and fires onSignedIn if a JWT
  // session was restored from disk -> "meter:auth-changed" reaches the renderer.
  initAuth();
  ipcMain.handle("meter:auth-get-status", () => getStatus());
  ipcMain.handle("meter:auth-sign-in", async () => {
    try {
      await signIn();
    } catch (err) {
      // Surface nothing to the renderer here; the auth-changed broadcast (or its
      // absence) reflects the outcome. Log for diagnostics.
      console.warn(`[auth] sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  ipcMain.handle("meter:auth-sign-out", () => signOut());

  // --- Leaderboard sharing ----------------------------------------------------
  ipcMain.handle("meter:share-run", (_event, runId: string) => shareRun(String(runId)));
  ipcMain.handle("meter:get-share-status", (_event, runId: string) =>
    getShareStatus(String(runId)),
  );

  // Open an allowlisted URL externally. Validate the origin so the renderer can
  // NOT ask the main process to open an arbitrary URL.
  ipcMain.on("meter:open-external", (_event, url: unknown) => {
    if (typeof url !== "string") return;
    if (!url.startsWith(SITE_URL) && url !== DISCORD_INVITE_URL) return;
    void shell.openExternal(url);
  });

  // Open the website's session-stats dashboard. An explicit sessionId arg is
  // validated; without one (or an invalid one), resolve the newest run's session.
  // The URL is always built from SITE_URL + an encoded, colon-free sessionId, so
  // it can never escape the allowlisted origin.
  ipcMain.handle("meter:open-session-stats", async (event, arg: unknown) => {
    const sessionId = isValidSessionId(arg) ? arg : getRunsSource().all()[0]?.sessionId;
    if (!isValidSessionId(sessionId)) return; // nothing resolvable → no-op
    // Upload requires sign-in (Phase 2): while signed out NOTHING is uploaded, so
    // the website's session page would be empty (#252). Offer sign-in first — the
    // auto-uploader drains the local backlog (including this session's runs) right
    // after — instead of opening a dead-end page.
    if (!(await getStatus()).signedIn) {
      const win = BrowserWindow.fromWebContents(event.sender);
      const opts = {
        type: "warning" as const,
        title: tMain("dialog.notSignedInTitle"),
        message: tMain("dialog.notSignedInMsg"),
        detail: tMain("dialog.notSignedInDetail"),
        buttons: [tMain("common.signInDiscord"), tMain("dialog.openAnyway"), tMain("common.cancel")],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      };
      const { response } = win
        ? await dialog.showMessageBox(win, opts)
        : await dialog.showMessageBox(opts);
      if (response === 2) return;
      if (response === 0) {
        // Resolves when the browser OAuth flow completes; abandoning it (or a
        // failure) leaves us signed out -> don't open the empty page.
        await signIn().catch(() => {});
        if (!(await getStatus()).signedIn) return;
      }
    }
    // Freshen the page: fire-and-forget an immediate upload sweep before opening.
    requestUploadNow();
    void shell.openExternal(sessionStatsUrl(SITE_URL, sessionId));
  });

  // "Nova sessão" (#220): drop the flag file the reader consumes (~1s) to rotate the
  // session id. Local runs and already-uploaded runs are untouched.
  ipcMain.handle("meter:reset-session", () => requestSessionReset(resolveOutputDir()));

  // The CURRENT session = the session of the newest run, DERIVED app-side (Redesign 2) — same source
  // as the session-stats URL above (not the reader's vestigial session.json). null when no runs yet.
  ipcMain.handle("meter:get-current-session", () => getRunsSource().all()[0]?.sessionId ?? null);

  // Renderer error reports (window error / unhandledrejection) -> Discord webhook.
  // Inputs are untrusted: type-check and cap before forwarding.
  ipcMain.on("meter:report-error", (_event, context: unknown, message: unknown, stack: unknown) => {
    if (typeof context !== "string" || typeof message !== "string") return;
    reportError(`renderer:${context.slice(0, 80)}`, {
      message: message.slice(0, 1000),
      stack: typeof stack === "string" ? stack.slice(0, 2000) : undefined,
    });
  });

  // Favorite predicate (Feature 3): wire the sidecar lookup into the source's index projection so
  // every listIndex() stamps `favorite`. Done before the first reload below so the initial list
  // already carries the flag.
  setFavoritePredicate(isFavorite);

  // Source -> renderer fan-out. Registered once; broadcasts to every open window. A new run landing
  // also triggers an auto-clean prune (debounced + re-entrancy-guarded): pruneToMaxRuns deletes the
  // oldest non-favorited surplus and reloads, which re-fires "changed" — the guard stops that
  // second pass from re-pruning (it finds nothing over the cap anyway), so there is no loop.
  let pruning = false;
  getRunsSource().on("changed", () => {
    broadcast("meter:runs-changed");
    if (!pruning) {
      pruning = true;
      try {
        pruneToMaxRuns();
      } finally {
        pruning = false;
      }
    }
  });
  getLiveSource().on("live", (snap: LiveSnapshot | null) => broadcast("meter:live", snap));
  // Blue-chest cooldown tracker: watches the same live stream, persists + broadcasts
  // cooldown state on "meter:cooldowns", and fires the OS "ready" notification.
  initCooldownTracker(broadcast);
  // Per-chest-type drop notifier: watches the same live stream and fires an OS
  // notification when an enabled chest type drops. Independent of the tracker above.
  initDropNotifier();
  // Auto-update status -> every open window (same fan-out as the sources above).
  onUpdateStatus((status) => broadcast("meter:update-status", status));
  // Reader bring-up phase -> the startup splash (own channel, distinct from the
  // readerStatus() invoke on "meter:reader-status").
  readerEvents.on("status", (status: ReaderStatus) => broadcast("meter:reader-phase", status));
}
