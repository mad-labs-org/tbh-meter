import type { RunRecord, RunStatus, RunQuality, RunDrop, LiveSnapshot } from "./run-types.js";
import { type ChestCooldown, type CooldownState, DEFAULT_COOLDOWN_MIN } from "./cooldown-types.js";
export interface Bounds { x: number; y: number; width: number; height: number; }
/** A runs-list column's persisted state. The array ORDER is the column order; `visible` toggles it. */
export interface RunColumnConfig { key: string; visible: boolean; }
/** Per-chest-type drop-notification toggles, mirroring the reader's `drops` indices [common(0), stageBoss(1), actBoss(2)]. */
export interface ChestDropNotify { common: boolean; stageBoss: boolean; actBoss: boolean; }
export interface AppSettings { outputDir: string | null; opacity: number; /** Keep the live overlay above every other window (default on). Two entry points write it: the overlay's pin button and the Settings checkbox. The overlay keeps a taskbar button (`skipTaskbar: false`), so an unpinned, covered meter is recoverable from the taskbar. */ alwaysOnTop: boolean; liveBounds: Bounds | null; listBounds: Bounds | null; liveExpanded: boolean; runColumns: RunColumnConfig[]; /** Display filter (a view preference only — never deletes data): hide runs sealed `skipped` (too short / not a clean success) or `degraded` (a critical field unreadable). `counted` AND `partial` stay shown — a partial run is a REAL successful clear the reader joined mid-way (under-counted, so badged + tinted, but still the player's run); hiding partials made the list look empty after the slow first-launch attach, so players thought the meter wasn't recording runs. Default true; the toggle reveals the hidden runs (marked + filterable, never deleted). */ hideNonCounted: boolean; /** Display filter: hide runs shorter than this many seconds. null = off. The minimum is the SYSTEM floor (COUNT_FLOOR_SEC, 15s) — a preference, never below it; stage x-10 is exempt (ACT_BOSS_STAGE_NO). The floor itself is a converter constant, NOT this setting (don't conflate). */ minDurationSec: number | null; /** Auto-clean cap (Feature 2): keep at most this many NON-favorited runs locally; when the stored count exceeds it the app deletes the OLDEST non-favorited runs down to the cap (favorited runs are never deleted and never counted). null = OFF (unlimited history, the default). Clamped to MIN_MAX_RUNS before persisting (see prune.ts clampMaxRuns). */ maxRuns: number | null; /** Blue-chest cooldown tracker (#265): master on/off (default ON), toggled in the runs-window Tracker tab. Off = no auto-detect + overlay hidden; existing cooldowns are kept (not cleared), so re-enabling resumes them. */ cooldownTrackerEnabled: boolean; /** Per-chest-type OS drop notifications (independent of the cooldown tracker): fire when a chest of each type drops on ANY stage. `common` defaults OFF (drops ~constantly — would spam); `stageBoss` (blue) and `actBoss` default ON. Toggled in Settings. */ chestDropNotify: ChestDropNotify; /** Blue-chest cooldown tracker (#265). `chestCooldowns` = the ACTIVE per-BOX lines (one cooldown per chest level, keyed by boxKey; the hover X clears these); `chestDropLog` = the append-only drop HISTORY (the X never touches it). Both persist so a cooldown survives an app/game restart — remaining time is recomputed from each `dropAt`. */ chestCooldowns: ChestCooldown[]; chestDropLog: ChestCooldown[]; /** Blue-chest cooldown length in MINUTES (default DEFAULT_COOLDOWN_MIN). Single global value; the timestamp-anchored math re-derives every countdown when it changes (no migration). Clamped via clampCooldownMin. */ chestCooldownMin: number; /** Chest "route": blue-box keys (920xxx) the user pinned to always show — a card appears even before the box drops (placeholder = ready/available). Empty = no pins. */ chestRoute: number[]; /** Whether a drop on a box NOT in `chestRoute` still creates/updates a cooldown card. true (default) = additive: the route pins extras and everything auto-detected still shows (today's behavior). false = the route is an exclusive filter (only pinned levels track). Empty route + true = show all. */ trackOutsideRoute: boolean; /** Start the meter with Windows (#232): applied via app.setLoginItemSettings on the packaged Windows install (no-op elsewhere). Default off. */ launchOnStartup: boolean; /** UI language (#232): a locale code from shared/i18n LOCALES, or "auto" = follow the system language. */ language: string; /** Per-window UI scale (#232), applied as webContents zoom: 1 = 100%. The live overlay's bottom-edge drag adjusts liveFontScale too (its height is content-pinned, so scaling the content IS the vertical resize). Clamped to FONT_SCALE_MIN..MAX. */ liveFontScale: number; listFontScale: number; }
export const DEFAULT_SETTINGS: AppSettings = { outputDir: null, opacity: 1, alwaysOnTop: true, liveBounds: null, listBounds: null, liveExpanded: true, runColumns: [], hideNonCounted: true, minDurationSec: null, maxRuns: null, cooldownTrackerEnabled: true, chestDropNotify: { common: false, stageBoss: true, actBoss: true }, chestCooldowns: [], chestDropLog: [], chestCooldownMin: DEFAULT_COOLDOWN_MIN, chestRoute: [], trackOutsideRoute: true, launchOnStartup: false, language: "auto", liveFontScale: 1, listFontScale: 1 };
/** Font-scale clamp (#232): shared by the settings sliders, the overlay's bottom-edge drag and
 *  the main process's zoom apply, so every entry point agrees on the same bounds. */
export const FONT_SCALE_MIN = 0.8;
export const FONT_SCALE_MAX = 1.5;
export function clampFontScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, scale));
}
/** Smallest a user can set the auto-clean cap to — a fat-fingered "1" can't nuke history down to a
 *  single run (Feature 2). Shared so the Settings control and the main-process prune agree. */
export const MIN_MAX_RUNS = 10;
/** Clamp a user-entered max-runs cap: null / non-finite / <= 0 -> null (OFF, unlimited); otherwise
 *  floor to an integer raised to MIN_MAX_RUNS. No upper clamp (a huge cap is effectively off). */
export function clampMaxRuns(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return Math.max(MIN_MAX_RUNS, Math.floor(value));
}
/** Blue-chest cooldown bounds (minutes). The control + the persist path share these so a
 *  fat-fingered value can't push the timer to 0 or absurd. */
export const COOLDOWN_MIN_MINUTES = 1;
export const COOLDOWN_MAX_MINUTES = 60;
/** Clamp a user-entered cooldown length (minutes): non-finite -> DEFAULT_COOLDOWN_MIN; otherwise
 *  rounded and held within [COOLDOWN_MIN_MINUTES, COOLDOWN_MAX_MINUTES]. */
export function clampCooldownMin(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return DEFAULT_COOLDOWN_MIN;
  return Math.min(COOLDOWN_MAX_MINUTES, Math.max(COOLDOWN_MIN_MINUTES, Math.round(value)));
}
export interface RunIndexEntry { id: string; ts: number; sessionId: string; status: RunStatus; /** The converter's quality verdict — drives the display filter (PR6). Optional: a legacy-mirror log produced before the converter (PR3) has none, treated as visible. */ quality?: RunQuality; stage: string; /** Raw stage number, carried so the duration filter can honour the x-10 (ACT_BOSS_STAGE_NO) exemption without fetching the full record. */ stageNo: number | null; mode: string; dps: number; totalDamage: number; goldGained: number; xpGained: number; xpPerSec: number; goldPerSec: number; mobs: number; totalMobs: number | null; duration: number; clearTime: number; schemaVersion: number; /** Top-3 deployed heroes, in IN-GAME FORMATION order (by `slot`). `xpGained` (per-hero run XP) is carried so the Leveling Planner can measure real per-(hero,stage) XP off the index without an N+1 getRun fetch; absent on older records that didn't persist per-hero gain. `slot` (0/1/2) is the formation position; absent on older runs. */ party: { heroKey: number; class: string; level: number; xpGained?: number; slot?: number }[]; drops?: RunDrop[]; /** Favorite flag (Feature 3) — a main-owned sidecar (favorites.json), NOT a field on the immutable logs record. Stamped onto the index so the renderer renders the star + can filter "favorites only". A favorited run is exempt from auto-clean + clear-all. */ favorite?: boolean; }
/** Auto-update lifecycle, surfaced to the renderer. Only ever advances past "idle" on
 *  the packaged Windows NSIS install; elsewhere the updater stays dormant. */
export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "downloading"; version: string; percent: number }
  | { state: "downloaded"; version: string }
  | { state: "up-to-date" }
  | { state: "error"; message: string };
/** Reader bring-up phase, surfaced to the startup splash. */
export type ReaderStatus = "searching" | "resolving" | "scanning" | "ready";
/** Reader supervisor status (Windows), surfaced to the renderer for the no-data message.
 *  idle = not managing; starting = bringing the reader up / first resolve; offline = no
 *  game open (re-polling); blocked = the reader keeps being killed (almost always AV). */
export type ReaderState = "idle" | "starting" | "offline" | "blocked";
export interface MeterApi {
  /** App version (package.json's "version"); shown in Settings and used for updates. */
  getAppVersion(): Promise<string>;
  getSettings(): Promise<AppSettings>;
  setSettings(partial: Partial<AppSettings>): Promise<AppSettings>;
  /** Settings changed in the MAIN process (e.g. follow-game auto-disabled by a manual
   *  drag of the live strip) — keeps every window's settings UI in sync. */
  onSettingsChanged(cb: (settings: AppSettings) => void): () => void;
  pickOutputDir(): Promise<string | null>;
  resolvedOutputDir(): Promise<string | null>;
  listRuns(): Promise<RunIndexEntry[]>;
  getRun(id: string): Promise<RunRecord | null>;
  /** Delete ALL local run history (runs.jsonl + logs/ mirror) EXCEPT favorited runs (Feature 3),
   *  which are kept. Returns false on failure. */
  clearRuns(): Promise<boolean>;
  /** Toggle a run's favorite flag (Feature 3). Returns the NEW state (true = now favorited).
   *  Persists to the favorites.json sidecar and broadcasts onRunsChanged so every window re-renders
   *  the star + any "favorites only" filter. */
  toggleFavorite(runId: string): Promise<boolean>;
  onLive(cb: (snap: LiveSnapshot | null) => void): () => void;
  onRunsChanged(cb: () => void): () => void;
  /** Current blue-chest cooldown state (active lines + history log) — fetch on mount to
   *  catch drops detected before this window opened. */
  getCooldowns(): Promise<CooldownState>;
  /** Subscribe to cooldown-state changes (auto-detected drop or a dismiss). Returns an unsubscribe fn. */
  onCooldowns(cb: (state: CooldownState) => void): () => void;
  /** DELETE the active cooldown line for a box (chest level) — the runs-window tab's `X`. The
   *  history log is kept; a later auto-detected drop re-creates the line. A pinned (route) box
   *  reappears as a placeholder. */
  dismissCooldown(boxKey: number): void;
  /** HIDE a box's line from the live overlay only — the overlay's `X` (declutter, not delete):
   *  it stays active + in the tab, and a re-detected drop brings it back. */
  hideCooldown(boxKey: number): void;
  /** Clear ALL tracked cooldowns + the drop history in one go (the Tracker tab's "Clear all").
   *  The pinned route is KEPT (it is config, edited via the level chips). */
  clearCooldowns(): void;
  openListWindow(): Promise<void>;
  /** Renderer-measured content height (px) for the live strip; main pins the window to it. */
  setLiveHeight(height: number): void;
  /** Open the meter's data folder (contains logs/) in the OS file explorer. */
  openDataFolder(): void;
  /** Begin a custom live-overlay drag — "move" (title bar) or "resize" (right edge width).
   *  Geometry is resolved MAIN-side against `screen.getCursorScreenPoint()` (DIP) so it is
   *  correct under any Windows display scale; the renderer's screenX leaks physical px at
   *  devicePixelRatio != 1, which made the resize run away on scaled monitors (#377). */
  startWindowDrag(mode: "move" | "resize"): void;
  /** Tick the drag in progress: main re-reads the cursor and moves/resizes the live window. */
  moveWindowDrag(): void;
  /** End the drag in progress. */
  endWindowDrag(): void;
  /** Recenter the live overlay on the primary display at the default size — recovery for
   *  an overlay dragged or pushed off-screen (there is no auto-follow). */
  resetWindowPosition(): void;
  /** Current reader bring-up phase for the startup splash (fetch on mount to catch a
   *  phase set before this window opened). */
  getReaderStatus(): Promise<ReaderStatus>;
  /** Subscribe to reader bring-up phase changes (startup splash). Returns an unsubscribe fn. */
  onReaderStatus(cb: (status: ReaderStatus) => void): () => void;
  /** Current reader status (Windows): "starting" while bringing the reader up, "offline"
   *  when idle / no game open, "blocked" when it keeps being killed (likely antivirus).
   *  Drives the no-data message in LiveView. */
  readerStatus(): Promise<ReaderState>;
  /** Manually retry the reader after it entered "blocked" (the Retry affordance). */
  retryReader(): void;
  /** True on installs that can self-update (packaged Windows NSIS) — gates the manual
   *  "Check for updates" button in Settings. */
  updaterSupported(): Promise<boolean>;
  /** Manually check for updates now; progress flows through onUpdateStatus. */
  checkForUpdates(): void;
  /** Current auto-update status — fetch on mount to catch events fired before this window opened. */
  getUpdateStatus(): Promise<UpdateStatus>;
  /** Subscribe to auto-update status changes. Returns an unsubscribe fn. */
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void;
  /** Quit and install a downloaded update now (only acts when status is "downloaded"). */
  quitAndInstall(): void;
  /** Open an allowlisted URL (community Discord, project GitHub) in the default browser. */
  openExternal(url: string): void;
  /** Start a new session (subsequent runs get a fresh session id and run numbering).
   *  Local history is untouched. Resolves false when the request could not be written. */
  resetSession(): Promise<boolean>;
  /** The current session id, or null if none yet. Persists across app restarts, so the
   *  runs list can mark the current session even between runs. */
  getCurrentSession(): Promise<string | null>;
  /** Collect diagnostic info (environment, app state, reader, settings, log tails)
   *  for bug reports. Returns a plaintext block with no PII or tokens. */
  debugInfo(): Promise<string>;
  windowControls: { minimize(): void; close(): void };
}
declare global { interface Window { meter: MeterApi } }
