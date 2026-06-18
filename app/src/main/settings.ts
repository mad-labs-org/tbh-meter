import { app } from "electron";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import type { AppSettings, Bounds } from "../shared/ipc-types.js";
import { DEFAULT_SETTINGS, clampFontScale, clampCooldownMin } from "../shared/ipc-types.js";
import type { ChestCooldown } from "../shared/cooldown-types.js";
import { bossBoxForStage, isBlueBox } from "../shared/chest-boxes.js";
import { isRcBuild } from "./variant.js";

/**
 * Convert persisted cooldown entries to the box-keyed shape, dropping any that don't resolve to
 * a blue box. Legacy entries (shipped before the #3 fix) were keyed by `stageKey` and carried a
 * `stage` string; here we derive the box from the stage and keep the stage as `lastStageKey`.
 * When `collapse` is true (the ACTIVE list), duplicate boxes — the old per-stage lines that are
 * really one chest level — collapse to the most recent drop per box. The history log keeps every
 * entry (collapse = false).
 */
export function migrateChestCooldowns(list: unknown, collapse: boolean): ChestCooldown[] {
  if (!Array.isArray(list)) return [];
  const out: ChestCooldown[] = [];
  for (const raw of list as (Partial<ChestCooldown> & { stageKey?: number })[]) {
    if (!raw || typeof raw.dropAt !== "number") continue;
    let boxKey = typeof raw.boxKey === "number" ? raw.boxKey : null;
    let lastStageKey = typeof raw.lastStageKey === "number" ? raw.lastStageKey : undefined;
    if (boxKey == null && typeof raw.stageKey === "number") {
      boxKey = bossBoxForStage(raw.stageKey); // legacy: derive box from the stage
      lastStageKey = raw.stageKey;
    }
    if (boxKey == null || !isBlueBox(boxKey)) continue;
    const cd: ChestCooldown = { boxKey, dropAt: raw.dropAt };
    if (lastStageKey != null) cd.lastStageKey = lastStageKey;
    if (typeof raw.mode === "string") cd.mode = raw.mode;
    if (raw.hidden) cd.hidden = true;
    out.push(cd);
  }
  if (!collapse) return out;
  const byBox = new Map<number, ChestCooldown>();
  for (const cd of out) {
    const prev = byBox.get(cd.boxKey);
    if (!prev || cd.dropAt > prev.dropAt) byBox.set(cd.boxKey, cd);
  }
  return [...byBox.values()].sort((a, b) => b.dropAt - a.dropAt);
}

/** Sanitize a persisted route: keep only finite blue-box keys, de-duplicated, order preserved. */
export function sanitizeRoute(list: unknown): number[] {
  if (!Array.isArray(list)) return [];
  const out: number[] = [];
  for (const k of list) {
    if (typeof k === "number" && isBlueBox(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

const settingsPath = (): string => join(app.getPath("userData"), "settings.json");

/**
 * The meter folder: a visible, non-hidden folder under the user's home
 * (Windows: C:\Users\<user>\tbh-meter). Use "home" (NOT "documents",
 * which OneDrive/policy can redirect, nor "userData", which is hidden) so the
 * Python reader can resolve the IDENTICAL path via os.path.expanduser("~").
 * This ONE folder holds raw/<id>.json + live.json (written by the reader) and
 * a logs/ subfolder of per-run structured JSON (written by this app's converter).
 *
 * The RC variant uses ~/tbh-meter-rc so a side-by-side install never reads or
 * pollutes the real app's runs. The app always passes this path to the reader via
 * --output (reader-process.ts), so the reader follows the variant's folder too.
 */
export function defaultMeterDir(): string {
  return join(app.getPath("home"), isRcBuild() ? "tbh-meter-rc" : "tbh-meter");
}

let cache: AppSettings = { ...DEFAULT_SETTINGS };
let writeTimer: ReturnType<typeof setTimeout> | null = null;

export function loadSettings(): AppSettings {
  const path = settingsPath();
  if (!existsSync(path)) {
    cache = { ...DEFAULT_SETTINGS };
    return cache;
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    cache = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      // Nested object: deep-default so a hand-edited or partial settings.json never
      // drops a chest type to undefined (the shallow spread only covers missing keys).
      chestDropNotify: { ...DEFAULT_SETTINGS.chestDropNotify, ...parsed.chestDropNotify },
      // Cooldowns are now keyed by box (chest level); migrate + collapse any legacy per-stage
      // entries on load (the active list collapses duplicates; the history keeps every drop).
      chestCooldowns: migrateChestCooldowns(parsed.chestCooldowns, true),
      chestDropLog: migrateChestCooldowns(parsed.chestDropLog, false),
      chestRoute: sanitizeRoute(parsed.chestRoute),
      chestCooldownMin: clampCooldownMin(parsed.chestCooldownMin),
    };
  } catch {
    cache = { ...DEFAULT_SETTINGS };
  }
  return cache;
}

export function getSettings(): AppSettings {
  return { ...cache };
}

export function updateSettings(partial: Partial<AppSettings>): AppSettings {
  cache = { ...cache, ...partial };
  scheduleWrite();
  return { ...cache };
}

function scheduleWrite(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      const path = settingsPath();
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, JSON.stringify(cache, null, 2), "utf-8");
    } catch {
      // best effort — never crash on a settings write failure
    }
  }, 300);
}

/**
 * Resolve the effective output directory: the user override if set, else the
 * default meter folder. Always returns a usable path (zero-config), so the app
 * reads and writes the meter folder out of the box on every platform.
 */
export function resolveOutputDir(): string {
  return cache.outputDir ?? defaultMeterDir();
}

// Last-applied window props, so repeated applies skip unchanged native calls: the live
// bottom-edge drag writes settings at rAF rate (#232), and re-issuing setAlwaysOnTop
// with an unchanged flag still cycles the window's z-order on Windows. Keyed by window
// (a recreated window starts fresh and gets a full apply).
const appliedLive = new WeakMap<BrowserWindow, { opacity: number; alwaysOnTop: boolean; zoom: number }>();
const appliedListZoom = new WeakMap<BrowserWindow, number>();

/** Apply opacity + always-on-top + font scale (zoom) from settings to the LIVE window. */
export function applyLiveSettings(liveWin: BrowserWindow): void {
  if (liveWin.isDestroyed()) return;
  const prev = appliedLive.get(liveWin);
  const opacity = Math.max(0.1, Math.min(1, cache.opacity));
  // Font size (#232) as a webContents zoom: scales the whole strip uniformly. The
  // window height follows via the content-pinned re-pin in index.ts (pinLiveHeight).
  const zoom = clampFontScale(cache.liveFontScale);
  if (prev?.opacity !== opacity) liveWin.setOpacity(opacity);
  if (prev?.alwaysOnTop !== cache.alwaysOnTop) liveWin.setAlwaysOnTop(cache.alwaysOnTop, "screen-saver");
  if (prev?.zoom !== zoom) liveWin.webContents.setZoomFactor(zoom);
  appliedLive.set(liveWin, { opacity, alwaysOnTop: cache.alwaysOnTop, zoom });
}

/** Apply the font scale (zoom) from settings to the RUNS-LIST window (#232). */
export function applyListSettings(listWin: BrowserWindow): void {
  if (listWin.isDestroyed()) return;
  const zoom = clampFontScale(cache.listFontScale);
  if (appliedListZoom.get(listWin) !== zoom) listWin.webContents.setZoomFactor(zoom);
  appliedListZoom.set(listWin, zoom);
}

/**
 * Register/unregister the app as a Windows login item from the launchOnStartup
 * setting (#232). Packaged Windows only: in dev this would register the bare
 * Electron binary, and the shipped meter is Windows-only anyway. The RC variant
 * registers under its own app name + exe, so it never clashes with stable.
 */
export function applyLaunchOnStartup(): void {
  if (!app.isPackaged || process.platform !== "win32") return;
  try {
    app.setLoginItemSettings({ openAtLogin: cache.launchOnStartup });
  } catch {
    // best effort — a registry write failure must never break settings handling
  }
}

export function saveLiveBounds(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const b = win.getBounds();
  // Ignore transient/degenerate bounds (e.g. a 0 width during early layout) so we
  // never persist a window size that would open unusably small next time.
  if (b.width < 120 || b.height < 10) return;
  updateSettings({ liveBounds: toBounds(b) });
}

export function saveListBounds(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  updateSettings({ listBounds: toBounds(win.getBounds()) });
}

function toBounds(b: Electron.Rectangle): Bounds {
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}
