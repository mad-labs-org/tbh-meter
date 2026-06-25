import { app, shell, screen, BrowserWindow, nativeImage, powerMonitor } from "electron";
import { join } from "path";
import { mkdirSync } from "node:fs";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import appIconAsset from "../../resources/icon.png?asset";
import {
  loadSettings,
  getSettings,
  applyLiveSettings,
  applyListSettings,
  applyLaunchOnStartup,
  saveLiveBounds,
  saveListBounds,
  resolveOutputDir,
} from "./settings.js";
import { clampFontScale } from "../shared/ipc-types.js";
import { createLiveDrag } from "./live-drag.js";
import { registerIpcHandlers } from "./ipc.js";
import { createTray, destroyTray, refreshTrayMenu } from "./tray.js";
import { getRunsSource } from "./sources/runs-source.js";
import { getLiveSource } from "./sources/live-source.js";
import { logsDir } from "./logs-archive.js";
import {
  startReader,
  stopReader,
  readerEvents,
  readerWillRun,
  getReaderState,
  getReaderStatus,
  readReaderLogs,
} from "./reader-process.js";
import type { ReaderStatus } from "../shared/ipc-types.js";
import type { LiveSnapshot } from "../shared/run-types.js";
import {
  initAutoUpdate,
  checkForUpdatesThrottled,
  checkAndApplyBootUpdate,
  getUpdateStatus,
  __devSetUpdateStatus,
} from "./auto-update.js";
import {
  shouldDismissStalledSplash,
  shouldForceDismissSplash,
  SEARCHING_DISMISS_MS,
} from "../shared/splash-decide.js";
import { startAutoUpload, stopAutoUpload, notifySignedIn } from "./auto-upload.js";
import { onSignedIn } from "./auth.js";
import { installGlobalErrorReporting } from "./error-report.js";
import { isRcBuild } from "./variant.js";
import {
  acquireSingleInstanceLock,
  makeSecondInstanceHandler,
  runIfPrimary,
} from "./single-instance.js";

// getIngestor() is lazy-imported during startup to prevent a static import of
// converter/ingest.js from pulling the full ingest -> legacy -> runs-source
// chain into the main chunk. The dynamic import in runs-source.ts avoids a
// static cycle, but only when nothing ELSE statically imports ingest.ts.
import type { Ingestor } from "./converter/ingest.js";
let _ingestor: Ingestor | null = null;
async function getIngestor(): Promise<Ingestor> {
  if (!_ingestor) {
    _ingestor = (await import("./converter/ingest.js")).getIngestor();
  }
  return _ingestor;
}

// Side-by-side RC variant: claim its own app identity BEFORE anything reads a name-derived
// path, so userData (settings, auth, uploads) lands in %APPDATA%\tbh-meter-rc and never
// mixes with the real install (which would otherwise share settings.json — including a
// custom outputDir — and break the data isolation). No-op for stable: the name is already
// "tbh-meter", so existing installs' userData path is unchanged.
app.setName(isRcBuild() ? "tbh-meter-rc" : "tbh-meter");

// Discord webhook error reporting (no Sentry/Datadog) — installed before anything
// else can fail so startup crashes are reported too. The reader-log tail (reader-diag.log +
// meter.log + live.json) rides along on every report so a Discord post is self-sufficient to debug.
installGlobalErrorReporting(readReaderLogs);

let liveWin: BrowserWindow | null = null;
let listWin: BrowserWindow | null = null;
let splashWin: BrowserWindow | null = null;
// While true, the live overlay stays hidden (the startup splash is up) until dismissed.
let splashActive = false;
let quitting = false;
// True only while the user is MOVING the overlay (title-bar drag). A pure reposition can't
// change the content height, so any pinLiveHeight / bounds-save that fires mid-move is
// spurious — it's a transient repaint from the OS move on high-DPI, and calling setBounds
// (or persisting getBounds().width) mid-setPosition re-enters Windows' DIP scaling and
// drives the width/position drift this bug is made of (#live-drag-width-feedback). We freeze
// the window geometry for the duration of the move and settle once on release.
let liveMoveActive = false;

// Single-writer: be the ONE app instance. A second launch of
// the SAME variant fails to grab the lock and quits here BEFORE we register any
// lifecycle / startReader — guaranteeing a single reader owner (two app copies would
// otherwise each spawn a reader and race; two readers double-write the per-run raw +
// drop the live gold read into the 2× SAVE fallback). Keyed by the app name set above,
// so the side-by-side RC variant holds a SEPARATE lock and still runs next to stable
// (its whole purpose). When primary, the second-instance callback raises the existing
// overlay (the user clicked the icon again and expects the app, not silence).
// The handler reads liveWin through a getter (not a captured value): the overlay is
// created later and can be recreated on macOS "activate", so it must raise the CURRENT
// window. Built in single-instance.ts so the composition is unit-tested (not inline).
const isPrimaryInstance = acquireSingleInstanceLock(makeSecondInstanceHandler(() => liveWin));

// Live strip sizing: width is user-resizable down to a sane floor; HEIGHT is NOT a
// constant — the renderer measures the strip's content and pins the window via
// setLiveHeight(), so there are no magic height numbers.
// Default width matches the GAME window at "Window scale 1x" (#232) so a fresh
// install's meter lines up with an unscaled game instead of sticking out past it.
const DEFAULT_LIVE_WIDTH = 435;
// Floor: wide enough for the expanded card's one-line stats row (Gold · EXP · Loot).
const MIN_LIVE_WIDTH = 420;

// Startup splash: a small fixed rounded card, centered.
const SPLASH_WIDTH = 380;
const SPLASH_HEIGHT = 460;

const preloadPath = (): string => join(__dirname, "../preload/index.mjs");

function commonWebPreferences(): Electron.WebPreferences {
  return {
    preload: preloadPath(),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
  };
}

function openExternalLinks(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

// --------------------------------------------------------------------------- //
// LIVE window — frameless, transparent, small, always-on-top/opacity from settings.
// minimize -> hide; close -> hide (the tray keeps the app alive).
// --------------------------------------------------------------------------- //

function createLiveWindow(): BrowserWindow {
  const settings = getSettings();
  const b = settings.liveBounds;

  // Seed the stable width tracker from the SAME restored bounds the window opens at,
  // so the first pinLiveHeight doesn't overwrite the user's custom width with the default.
  lastKnownWidth = b?.width && b.width >= MIN_LIVE_WIDTH ? b.width : DEFAULT_LIVE_WIDTH;

  const win = new BrowserWindow({
    x: b?.x,
    y: b?.y,
    // Width: user-resizable to match the game's width (floor = MIN_LIVE_WIDTH).
    // Height: a throwaway placeholder — the renderer measures the strip's real
    // content height and pins the window to it via setLiveHeight(), so the height
    // is never a magic number and can't be stretched past the content.
    // Ignore a missing/degenerate saved width (a width of 0 once slipped through
    // and pinned the window to its minimum) — fall back to the default.
    width: b?.width && b.width >= MIN_LIVE_WIDTH ? b.width : DEFAULT_LIVE_WIDTH,
    height: 48,
    minWidth: MIN_LIVE_WIDTH,
    frame: false,
    transparent: true,
    // Native resize is OFF: transparent frameless windows resize unreliably on
    // Windows (the window jumps instead of stretching). Width is driven by a JS
    // edge-handle via setBounds (meter:set-window-width); height is content-pinned.
    resizable: false,
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: false,
    icon: appIconAsset,
    backgroundColor: "#00000000",
    show: false,
    webPreferences: commonWebPreferences(),
  });

  win.on("ready-to-show", () => {
    applyLiveSettings(win);
    // While the startup splash is up, the overlay stays hidden until the splash
    // dismisses (on reader "ready" or the user skipping). No splash -> show as usual.
    if (!splashActive) win.show();
  });

  win.on("moved", () => {
    // Mid our custom MOVE drag the window is being setPosition'd; getBounds().width can read
    // transiently inflated on high-DPI, so saving here would persist a bad width that the
    // next launch reopens at. endWindowDrag saves once on release with stable bounds.
    if (!liveMoveActive) saveLiveBounds(win);
  });
  win.on("resized", () => saveLiveBounds(win));

  // close -> hide instead of destroy, unless the app is genuinely quitting.
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });

  openExternalLinks(win);
  loadRenderer(win, null);
  return win;
}

// --------------------------------------------------------------------------- //
// LIST window — created on demand, frameless, opaque, resizable, larger.
// Reused (focused) if already open. close just closes the window.
// --------------------------------------------------------------------------- //

function openListWindow(): void {
  if (listWin && !listWin.isDestroyed()) {
    if (listWin.isMinimized()) listWin.restore();
    listWin.show();
    listWin.focus();
    return;
  }

  const settings = getSettings();
  const b = settings.listBounds;

  const win = new BrowserWindow({
    x: b?.x,
    y: b?.y,
    width: b?.width ?? 1080,
    height: b?.height ?? 580,
    frame: false,
    transparent: false,
    resizable: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    icon: appIconAsset,
    show: false,
    webPreferences: commonWebPreferences(),
  });

  win.on("ready-to-show", () => {
    applyListSettings(win); // font scale (zoom) — settings-driven, like the live overlay
    win.show();
  });
  win.on("moved", () => saveListBounds(win));
  win.on("resized", () => saveListBounds(win));
  win.on("closed", () => {
    listWin = null;
  });

  openExternalLinks(win);
  loadRenderer(win, "list");
  listWin = win;
}

// --------------------------------------------------------------------------- //
// SPLASH window — Discord-style startup screen. Shown on launch while the reader
// brings the game's memory up; dismissed main-side once real data flows (no skip button).
// Frameless + OPAQUE on purpose: a transparent window let Electron 42's Chromium compose
// the opaque card as translucent on Windows (the desktop showed through), so we paint an
// opaque window background instead. Win11 still rounds the corners natively.
// --------------------------------------------------------------------------- //

function createSplashWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: SPLASH_WIDTH,
    height: SPLASH_HEIGHT,
    center: true,
    frame: false,
    transparent: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    icon: appIconAsset,
    backgroundColor: "#0d0e1a",
    show: false,
    webPreferences: commonWebPreferences(),
  });

  win.on("ready-to-show", () => win.show());
  win.on("closed", () => {
    splashWin = null;
  });

  openExternalLinks(win);
  loadRenderer(win, "splash");
  return win;
}

let readyDismissTimer: ReturnType<typeof setTimeout> | null = null;
// Fallback only: keep the splash at most this long after "ready" if real data never
// arrives (a reader that stalled right after resolving). The first live snapshot
// normally dismisses well before this.
const READY_FALLBACK_MS = 8000;
// While the splash is up, watch for the reader going "blocked" (AV keeps killing it):
// loading can't proceed, so hand off to the overlay's blocked + Retry message rather than
// trap the user behind a splash that never loads (this replaced the old manual skip button).
let splashBlockedWatch: ReturnType<typeof setInterval> | null = null;
// Safety-net deadline: a reader stuck on "searching" (game not running) yields none of the
// three dismiss signals (no live data, never "ready", never "blocked"), so the splash would hang
// forever. After SEARCHING_DISMISS_MS we dismiss IF still stalled (shouldDismissStalledSplash —
// not while a real first-time resolve or an update download is in flight). One interval re-checks
// past the deadline so a transient blocker (e.g. an update that finishes) can't strand the user.
let splashSearchingWatch: ReturnType<typeof setInterval> | null = null;
let splashArmedAt = 0;

/** "ready" no longer dismisses the splash — it only flips the renderer's text to "Ready!"
 *  (via onReaderStatus) and arms a FALLBACK timer. The splash stays up until the meter has
 *  actually loaded — i.e. real data flows (onFirstLiveForSplash). The fallback just guards
 *  against a reader that reaches "ready" but never streams, so the user is never trapped. */
function onReaderStatusForSplash(status: ReaderStatus): void {
  if (status === "ready" && readyDismissTimer === null) {
    readyDismissTimer = setTimeout(dismissSplash, READY_FALLBACK_MS);
  }
}

/** PRIMARY dismiss: real live data flowing = the meter loaded correctly. Keeps the splash
 *  up until there is actually something to show (not merely until the reader says "ready"). */
function onFirstLiveForSplash(snap: LiveSnapshot | null): void {
  if (snap) dismissSplash();
}

/** Tear down the startup splash and reveal the live overlay. Idempotent. */
function dismissSplash(): void {
  if (!splashActive && !splashWin) return;
  splashActive = false;
  readerEvents.off("status", onReaderStatusForSplash);
  getLiveSource().off("live", onFirstLiveForSplash);
  if (readyDismissTimer !== null) {
    clearTimeout(readyDismissTimer);
    readyDismissTimer = null;
  }
  if (splashBlockedWatch !== null) {
    clearInterval(splashBlockedWatch);
    splashBlockedWatch = null;
  }
  if (splashSearchingWatch !== null) {
    clearInterval(splashSearchingWatch);
    splashSearchingWatch = null;
  }
  if (splashWin && !splashWin.isDestroyed()) splashWin.close();
  splashWin = null;
  if (liveWin && !liveWin.isDestroyed()) liveWin.show();
}

/** Load the shared renderer bundle, selecting the root via URL hash. */
function loadRenderer(win: BrowserWindow, hash: "list" | "splash" | null): void {
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    const base = process.env["ELECTRON_RENDERER_URL"];
    win.loadURL(hash ? `${base}#${hash}` : base);
  } else {
    const file = join(__dirname, "../renderer/index.html");
    if (hash) {
      win.loadFile(file, { hash });
    } else {
      win.loadFile(file);
    }
  }
}

// The renderer's last content-height report, in CSS px (pre-zoom). Kept main-side so a
// font-scale change can re-pin the window immediately — the renderer only re-reports
// when the zoomed layout actually reflows, which is not guaranteed.
let liveContentHeight = 48;

// The last known-good width, in DIP. Stored separately from the live window's bounds
// because getBounds().width can return transient inflated values on Windows while a
// transparent frameless window is being dragged via setPosition() on high-DPI monitors
// (200 % / 4K). When pinLiveHeight fires mid-drag and re-applies that transient width
// via setBounds, it creates a feedback loop that drives the width upward every tick of
// the move — the overlay keeps growing while the user drags (#live-drag-width-feedback).
// Keeping the width in a stable variable breaks the loop: the pin never feeds the bad
// value back. The explicit resize (right-edge drag → setLiveWidth) updates this variable
// normally, so user-driven resize is unaffected.
let lastKnownWidth = DEFAULT_LIVE_WIDTH;

/** Pin the live window's height to the renderer-measured content height × the live
 *  font scale (the zoom factor makes window px = CSS px × scale). Width is kept from
 *  the last known-good value — NOT from getBounds().width — to avoid a destructive
 *  feedback loop during a move drag on high-DPI monitors (see lastKnownWidth). */
function pinLiveHeight(): void {
  if (!liveWin || liveWin.isDestroyed()) return;
  // Never resize the overlay mid-MOVE — see liveMoveActive. The drag's setPosition is the
  // only thing that may touch the window; a setBounds here fights it and, on high-DPI,
  // re-inflates the width. Content height can't change during a pure move, so nothing is
  // lost; endWindowDrag re-pins once to settle.
  if (liveMoveActive) return;
  const scale = clampFontScale(getSettings().liveFontScale);
  const h = Math.max(1, Math.round(liveContentHeight * scale));
  liveWin.setMinimumSize(MIN_LIVE_WIDTH, h);
  liveWin.setMaximumSize(0, h); // width 0 => unlimited; height locked to content
  const b = liveWin.getBounds();
  const w = Math.max(lastKnownWidth, MIN_LIVE_WIDTH); // NOT b.width — see lastKnownWidth doc
  if (b.height !== h || b.width !== w) {
    liveWin.setBounds({ x: b.x, y: b.y, width: w, height: h });
  }
}

/** IPC entry: the renderer measured a new content height (CSS px) — store + pin.
 *  Called whenever the strip's content height changes — this is why the live window
 *  declares no fixed/min/max height. */
function setLiveHeight(height: number): void {
  liveContentHeight = Math.max(1, height);
  pinLiveHeight();
}

/** Set the live window's width from the renderer's edge-handle drag, clamped to the
 *  MIN_LIVE_WIDTH floor. The clamp MUST live here: the window is resizable:false +
 *  transparent, and on Windows a programmatic setBounds bypasses the OS minWidth clamp
 *  (that only fires on native resize, which is disabled), so a runaway drag could drive
 *  the width to ~0 and make the meter vanish. Height stays content-pinned. */
function setLiveWidth(width: number): void {
  if (!liveWin || liveWin.isDestroyed()) return;
  const w = Math.max(MIN_LIVE_WIDTH, Math.round(width) || 0);
  const b = liveWin.getBounds();
  if (b.width !== w) {
    liveWin.setBounds({ x: b.x, y: b.y, width: w, height: b.height });
    lastKnownWidth = w;
  }
}

/** Recenter the live overlay near the top of the primary display at the default width,
 *  fully on-screen. Recovery for an overlay dragged or pushed off-screen — there's no
 *  auto-follow anymore, so this is how a user gets a lost meter back. */
function resetLiveWindow(): void {
  if (!liveWin || liveWin.isDestroyed()) return;
  const { workArea } = screen.getPrimaryDisplay();
  const width = DEFAULT_LIVE_WIDTH;
  const height = liveWin.getBounds().height; // content-pinned by setLiveHeight — keep it
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const y = Math.round(workArea.y + 24);
  liveWin.setBounds({ x, y, width, height });
  lastKnownWidth = width;
  if (!liveWin.isVisible()) liveWin.show();
  saveLiveBounds(liveWin);
}

// Custom move/width-resize of the live overlay. Geometry is resolved against the OS cursor
// in DIP (getCursorScreenPoint), the SAME space as getBounds/setBounds — so it is correct
// under any Windows display scale. The renderer's screenX is in CSS px that leak PHYSICAL
// px at devicePixelRatio != 1, which made the resize run away on scaled monitors (#377
// follow-up); the renderer now only drives cadence and sends no coordinates. See live-drag.ts.
const liveDrag = createLiveDrag({
  getWindow: () => (liveWin && !liveWin.isDestroyed() ? liveWin : null),
  getCursor: () => screen.getCursorScreenPoint(),
  setWidth: setLiveWidth,
});

// --------------------------------------------------------------------------- //
// App lifecycle — runs ONLY in the primary instance. A second instance already
// called app.quit() (acquireSingleInstanceLock above); runIfPrimary gates BOTH the
// whenReady startup (so it never reaches startReader/setDir — which would race a second
// reader before the quit lands) AND the will-quit reaping (so a secondary never runs
// stopReader -> killAllReaders, which kills by image name and would tear down the
// PRIMARY's reader). The gate is a testable seam (single-instance.ts), not an inline if.
// --------------------------------------------------------------------------- //

app.whenReady().then(() => runIfPrimary(isPrimaryInstance, async () => {
  // Dev-only mocked API (pnpm dev:mock): intercept the main process's global fetch with MSW
  // BEFORE any network call (auth/upload/update/error relay all fire below), so the meter runs
  // end-to-end with no backend. The `import.meta.env.DEV` guard makes electron-vite dead-code-
  // eliminate this block — and the dynamic import — from the production build, so MSW never ships.
  if (import.meta.env.DEV && process.env.TBH_MOCK_API === "1") {
    const { startMockApi } = await import("../mocks/node.js");
    startMockApi();
  }

  // a second instance is quitting (runIfPrimary skips this) — it must never reach
  // startReader, which would race a second reader against the primary before the quit lands.
  // Match the variant's appId so Windows treats the RC as a distinct app (its own taskbar
  // group + notifications), mirroring the electron-builder -c.appId override for the RC build.
  electronApp.setAppUserModelId(isRcBuild() ? "wiki.tbh.meter.rc" : "wiki.tbh.meter");

  // Override Electron's default icon at runtime (dev + packaged): the macOS dock
  // uses app.dock; Windows/Linux use the per-window `icon` set below.
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(appIconAsset));
  }

  app.on("browser-window-created", (_, win) => {
    optimizer.watchWindowShortcuts(win);
  });

  loadSettings();

  // Re-assert the Windows login item from settings on every boot (#232): self-heals a
  // registry entry lost to an OS cleanup and keeps it pointing at the installed exe.
  applyLaunchOnStartup();

  // Ensure the meter folder + its logs/ subfolder exist immediately (recursive
  // mkdir of logs/ also creates the parent meter folder). Best-effort: a failure
  // here must never block startup — the sources tolerate a missing dir.
  try {
    mkdirSync(logsDir(), { recursive: true });
  } catch {
    // best effort — never crash startup over a directory create failure
  }

  // Watermark init + immediate upload on sign-in. Must be registered before
  // registerIpcHandlers -> initAuth, which fires onSignedIn for a restored session.
  onSignedIn(notifySignedIn);

  registerIpcHandlers({
    applyLiveSettings: () => {
      if (liveWin && !liveWin.isDestroyed()) {
        applyLiveSettings(liveWin);
        // A live font-scale change resizes the content (zoom) without necessarily
        // reflowing CSS heights — re-pin from the stored content height × new scale.
        pinLiveHeight();
      }
    },
    applyListSettings: () => {
      if (listWin && !listWin.isDestroyed()) applyListSettings(listWin);
    },
    refreshTrayMenu,
    openListWindow,
    setLiveHeight,
    startWindowDrag: (mode) => {
      liveMoveActive = mode === "move";
      liveDrag.start(mode);
    },
    moveWindowDrag: liveDrag.move,
    endWindowDrag: () => {
      liveDrag.end();
      if (!liveMoveActive) return; // resize / idle: per-tick saves already persisted
      liveMoveActive = false;
      pinLiveHeight(); // settle: re-pin with a now-stable getBounds (setPosition stopped)
      if (liveWin && !liveWin.isDestroyed()) saveLiveBounds(liveWin);
    },
    resetLiveWindow,
  });

  // Gate the overlay behind the startup splash when a reader will actually run
  // (packaged Windows) — or in dev, so the splash is previewable. Set BEFORE the live
  // window is created so its ready-to-show keeps it hidden until the splash dismisses.
  splashActive = readerWillRun() || is.dev;

  liveWin = createLiveWindow();
  // Getter, not the instance: macOS "activate" recreates liveWin and the tray must
  // keep targeting the CURRENT window (see tray.ts).
  createTray(() => liveWin, openListWindow);

  if (splashActive) {
    splashWin = createSplashWindow();
    readerEvents.on("status", onReaderStatusForSplash);
    getLiveSource().on("live", onFirstLiveForSplash);
    // No skip button — the splash guards loading — so if the reader goes blocked (AV keeps
    // killing it), hand off to the overlay's blocked + Retry message instead of trapping.
    splashBlockedWatch = setInterval(() => {
      if (getReaderState() === "blocked") dismissSplash();
    }, 2000);
    // Safety net: after SEARCHING_DISMISS_MS, dismiss a splash still stuck on "searching" (game
    // not running) so it can never hang forever (the failure streak never reaches "blocked" on a
    // clean no-game exit, and no live data arrives). Re-checked on an interval so the deadline
    // still fires once a transient blocker (an update mid-download) clears. shouldDismissStalledSplash
    // keeps a real first-time resolve/scan and an in-flight update on screen.
    splashArmedAt = Date.now();
    splashSearchingWatch = setInterval(() => {
      const elapsed = Date.now() - splashArmedAt;
      // Stuck on "searching" (game not running, or the reader abandoned an incomplete scan) → free
      // the user after the searching deadline.
      if (elapsed >= SEARCHING_DISMISS_MS && shouldDismissStalledSplash(getUpdateStatus(), getReaderStatus())) {
        dismissSplash();
        return;
      }
      // Last-resort ceiling: a reader stuck mid-bring-up ("resolving"/"scanning" that never
      // completes) hits none of the other dismissals — past the hard cap, dismiss regardless of
      // phase so the splash can never hang forever (an in-flight update still defers).
      if (shouldForceDismissSplash(getUpdateStatus(), elapsed)) dismissSplash();
    }, 2000);
    // Dev preview without a real reader/updater (e.g. macOS): walk the WHOLE boot
    // animation — the update flow first, then the reader bring-up — so every splash
    // screen (updating, restarting, searching…ready) is visible end-to-end, then it
    // dismisses into the overlay. __devSetUpdateStatus is a no-op in packaged builds.
    if (is.dev && !readerWillRun()) {
      setTimeout(() => __devSetUpdateStatus({ state: "downloading", version: "1.4.3", percent: 24 }), 1200);
      setTimeout(() => __devSetUpdateStatus({ state: "downloading", version: "1.4.3", percent: 71 }), 2200);
      setTimeout(() => __devSetUpdateStatus({ state: "downloaded", version: "1.4.3" }), 3200);
      setTimeout(() => __devSetUpdateStatus({ state: "idle" }), 4400); // "relaunch" → reader flow
      setTimeout(() => readerEvents.emit("status", "resolving"), 4700);
      setTimeout(() => readerEvents.emit("status", "scanning"), 5700);
      setTimeout(() => readerEvents.emit("status", "ready"), 7400);
    }
  }

  // ── Boot update gate ──────────────────────────────────────────────────────
  // BEFORE the reader: if a newer meter was published (e.g. a game patch shipped a reseed),
  // download it + relaunch now, so the user lands on a build whose bundled seed matches the
  // new game — instead of sitting through the reader's 2–5 min cold scan. "updated" = the
  // app is relaunching (skip the rest); "proceed" = bring the reader up as usual. Instant
  // "proceed" off the supported NSIS-Windows install (dev / macOS / RC fall straight through
  // to the reader / dev-preview path). The splash is already up and shows the progress.
  if ((await checkAndApplyBootUpdate()) === "updated") return;

  // Spawn the bundled reader (Windows + packaged only; no-op otherwise). It writes
  // raw/<id>.json + live.json into the meter folder created above — the same dir the
  // sources poll below, so reads and writes share one folder.
  startReader();

  // Point both sources at the resolved output dir and start watching. A null /
  // non-existent dir is handled gracefully inside the sources (idle + null).
  const dir = resolveOutputDir();
  getRunsSource().setDir(dir);
  getLiveSource().setDir(dir);
  getRunsSource().start();
  getLiveSource().start();
  // Converter (PR3): the reader now writes raw/<id>.json (PR2) instead of appending runs.jsonl,
  // so the Ingestor — not the old runs.jsonl mirror — OWNS logs/. On boot it ingests raw/ ->
  // logs/ (converting any run with no/stale structured log) AND migrates the legacy runs.jsonl into
  // logs/ preserving each external_id; it then watches raw/ for new runs. App-read of logs/ is PR4.
  const ingestor = await getIngestor();
  ingestor.setDir(dir);
  ingestor.start();

  // Check GitHub for a newer release, download in the background, install on quit.
  // No-op unless this is the packaged Windows NSIS install (see auto-update.ts).
  initAutoUpdate();

  // On top of the 3min interval, re-check (throttled) on focus / wake — with suspended
  // timers a machine coming back from sleep would otherwise wait a full tick, and an
  // errored state retries after 30s when the user pokes the app. No-op off the supported
  // install / mid-flight / within the cooldown (all gated inside checkForUpdatesThrottled).
  app.on("browser-window-focus", () => checkForUpdatesThrottled());
  powerMonitor.on("resume", () => checkForUpdatesThrottled());

  // Background auto-upload of new successful runs while signed in (no-op signed out).
  startAutoUpload();

  app.on("activate", () => {
    if (liveWin && !liveWin.isDestroyed()) {
      liveWin.show();
    } else {
      liveWin = createLiveWindow();
    }
  });
}));

app.on("before-quit", () => {
  quitting = true;
});

app.on("window-all-closed", () => {
  // The live window hides (not closes), so this generally only fires on quit.
  // Do not auto-quit on macOS; the tray keeps the app alive.
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => runIfPrimary(isPrimaryInstance, () => {
  // A secondary instance (lost the lock) started NOTHING and must not reap here:
  // stopReader() -> killAllReaders() kills tbh-reader.exe BY IMAGE NAME, which would
  // tear down the PRIMARY's reader. Only the owner reaps (runIfPrimary skips the rest).
  // Stop the reader (suppress respawn + kill the tree) BEFORE the sources stop, so
  // no late writes race the shutdown.
  stopReader();
  stopAutoUpload();
  getRunsSource().stop();
  getLiveSource().stop();
  _ingestor?.stop();
  destroyTray();
}));
