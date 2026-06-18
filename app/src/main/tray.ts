import { app, Menu, nativeImage, Tray, type BrowserWindow } from "electron";
// Dedicated tray mark, NOT the full app icon: the tray renders at 16px (see the
// resize below) and the detailed speedometer turns to mud that small. icon-tray.png
// is a simplified, bold sword-on-gauge that stays legible when shrunk.
import trayIconAsset from "../../resources/icon-tray.png?asset";
import { tMain } from "./i18n.js";

let tray: Tray | null = null;
// Kept so the menu can be rebuilt with fresh labels on a language change (#232).
// The live window is read through a GETTER (not a captured reference): macOS
// "activate" recreates it, and a captured copy would leave the tray acting on the
// destroyed instance forever (same pattern as makeSecondInstanceHandler).
let trayDeps: { getLiveWin: () => BrowserWindow | null; openListWindow: () => void } | null = null;

function showLive(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  win.show();
  win.focus();
}

function buildMenu(): Menu {
  const deps = trayDeps;
  return Menu.buildFromTemplate([
    { label: tMain("tray.showLive"), click: () => showLive(deps?.getLiveWin() ?? null) },
    { label: tMain("tray.openRuns"), click: () => deps?.openListWindow() },
    { type: "separator" },
    { label: tMain("tray.quit"), click: () => app.quit() },
  ]);
}

export function createTray(
  getLiveWin: () => BrowserWindow | null,
  openListWindow: () => void,
): Tray {
  const icon = nativeImage
    .createFromPath(trayIconAsset)
    .resize({ width: 16, height: 16 });

  trayDeps = { getLiveWin, openListWindow };
  tray = new Tray(icon);
  tray.setToolTip("tbh-meter");
  tray.setContextMenu(buildMenu());

  tray.on("click", () => {
    const liveWin = getLiveWin();
    if (!liveWin || liveWin.isDestroyed()) return;
    if (liveWin.isVisible()) {
      liveWin.hide();
    } else {
      showLive(liveWin);
    }
  });

  return tray;
}

/** Rebuild the tray menu with the current language's labels (#232). No-op before createTray. */
export function refreshTrayMenu(): void {
  if (tray && trayDeps) tray.setContextMenu(buildMenu());
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
  trayDeps = null;
}
