import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSettings,
  AuthStatus,
  MeterApi,
  ReaderStatus,
  UpdateStatus,
} from "../shared/ipc-types.js";
import type { LiveSnapshot } from "../shared/run-types.js";
import type { CooldownState } from "../shared/cooldown-types.js";

const meter: MeterApi = {
  getAppVersion: () => ipcRenderer.invoke("meter:get-app-version"),

  getAnalyticsClientId: () => ipcRenderer.invoke("meter:get-analytics-id"),

  getSettings: () => ipcRenderer.invoke("meter:get-settings"),
  setSettings: (partial) => ipcRenderer.invoke("meter:set-settings", partial),

  onSettingsChanged: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, settings: AppSettings): void =>
      cb(settings);
    ipcRenderer.on("meter:settings-changed", listener);
    return () => ipcRenderer.off("meter:settings-changed", listener);
  },

  pickOutputDir: () => ipcRenderer.invoke("meter:pick-output-dir"),
  resolvedOutputDir: () => ipcRenderer.invoke("meter:resolved-output-dir"),

  listRuns: () => ipcRenderer.invoke("meter:list-runs"),
  getRun: (id) => ipcRenderer.invoke("meter:get-run", id),
  clearRuns: () => ipcRenderer.invoke("meter:clear-runs"),
  toggleFavorite: (runId) => ipcRenderer.invoke("meter:toggle-favorite", runId),

  onLive: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, snap: LiveSnapshot | null) => cb(snap);
    ipcRenderer.on("meter:live", listener);
    return () => ipcRenderer.off("meter:live", listener);
  },

  onRunsChanged: (cb) => {
    const listener = (): void => cb();
    ipcRenderer.on("meter:runs-changed", listener);
    return () => ipcRenderer.off("meter:runs-changed", listener);
  },

  getCooldowns: () => ipcRenderer.invoke("meter:get-cooldowns"),

  onCooldowns: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, state: CooldownState): void => cb(state);
    ipcRenderer.on("meter:cooldowns", listener);
    return () => ipcRenderer.off("meter:cooldowns", listener);
  },

  dismissCooldown: (boxKey) => ipcRenderer.send("meter:dismiss-cooldown", boxKey),
  hideCooldown: (boxKey) => ipcRenderer.send("meter:hide-cooldown", boxKey),
  clearCooldowns: () => ipcRenderer.send("meter:clear-cooldowns"),
  openStagePage: (stageKey) => ipcRenderer.send("meter:open-stage-page", stageKey),

  openListWindow: () => ipcRenderer.invoke("meter:open-list-window"),

  setLiveHeight: (height) => ipcRenderer.send("meter:set-live-height", height),

  openDataFolder: () => ipcRenderer.send("meter:open-data-folder"),

  startWindowDrag: (mode) => ipcRenderer.send("meter:window-drag-start", mode),
  moveWindowDrag: () => ipcRenderer.send("meter:window-drag-move"),
  endWindowDrag: () => ipcRenderer.send("meter:window-drag-end"),

  resetWindowPosition: () => ipcRenderer.send("meter:reset-window-position"),

  readerStatus: () => ipcRenderer.invoke("meter:reader-status"),
  retryReader: () => ipcRenderer.send("meter:reader-retry"),

  getReaderStatus: () => ipcRenderer.invoke("meter:get-reader-status"),

  onReaderStatus: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, status: ReaderStatus): void => cb(status);
    ipcRenderer.on("meter:reader-phase", listener);
    return () => ipcRenderer.off("meter:reader-phase", listener);
  },

  updaterSupported: () => ipcRenderer.invoke("meter:updater-supported"),

  checkForUpdates: () => ipcRenderer.send("meter:check-updates"),

  getUpdateStatus: () => ipcRenderer.invoke("meter:get-update-status"),

  onUpdateStatus: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatus): void => cb(status);
    ipcRenderer.on("meter:update-status", listener);
    return () => ipcRenderer.off("meter:update-status", listener);
  },

  quitAndInstall: () => ipcRenderer.send("meter:quit-and-install"),

  authGetStatus: () => ipcRenderer.invoke("meter:auth-get-status"),
  authSignIn: () => ipcRenderer.invoke("meter:auth-sign-in"),
  authSignOut: () => ipcRenderer.invoke("meter:auth-sign-out"),

  onAuthChanged: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, status: AuthStatus): void => cb(status);
    ipcRenderer.on("meter:auth-changed", listener);
    return () => ipcRenderer.off("meter:auth-changed", listener);
  },

  onSessionExpired: (cb) => {
    const listener = (): void => cb();
    ipcRenderer.on("meter:session-expired", listener);
    return () => ipcRenderer.off("meter:session-expired", listener);
  },

  shareRun: (runId) => ipcRenderer.invoke("meter:share-run", runId),
  getShareStatus: (runId) => ipcRenderer.invoke("meter:get-share-status", runId),

  onShareUpdated: (cb) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { runId: string; url: string },
    ): void => cb(payload);
    ipcRenderer.on("meter:share-updated", listener);
    return () => ipcRenderer.off("meter:share-updated", listener);
  },

  openExternal: (url) => ipcRenderer.send("meter:open-external", url),

  openSessionStats: (sessionId) => ipcRenderer.invoke("meter:open-session-stats", sessionId),

  resetSession: () => ipcRenderer.invoke("meter:reset-session"),

  getCurrentSession: () => ipcRenderer.invoke("meter:get-current-session"),

  reportError: (context, message, stack) =>
    ipcRenderer.send("meter:report-error", context, message, stack),

  windowControls: {
    minimize: () => ipcRenderer.send("meter:minimize"),
    close: () => ipcRenderer.send("meter:close"),
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("meter", meter);
  } catch (err) {
    console.error(err);
  }
} else {
  // fallback for non-isolated contexts
  window.meter = meter;
}
