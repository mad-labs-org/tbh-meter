import { BrowserWindow } from "electron";

/** Fan a message out to every live window's renderer (skipping destroyed ones).
 *  Standalone (no app-module imports) so any main-process module can call it
 *  without risking an import cycle. */
export function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}
