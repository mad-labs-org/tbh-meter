import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Integration test for the settings PERSIST -> RELOAD cycle (PR6 "settings persiste e recarrega"),
// focused on the new display-filter prefs (hideNonCounted / minDurationSec). settings.ts caches in a
// module-level var and writes settings.json (debounced) under app.getPath("userData"); mock electron
// to a temp userData so the write hits a real file we can read back. The debounced write uses a
// 300ms timer, so we flush it with fake timers.

const userData = mkdtempSync(join(tmpdir(), "tbh-settings-ud-"));
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => userData },
}));

import {
  loadSettings,
  getSettings,
  updateSettings,
} from "../settings.js";
import {
  DEFAULT_SETTINGS,
  FONT_SCALE_MIN,
  FONT_SCALE_MAX,
  clampFontScale,
} from "../../shared/ipc-types.js";

const settingsFile = join(userData, "settings.json");

beforeEach(() => {
  vi.useFakeTimers();
  // Reset the on-disk + in-memory state to defaults before each test.
  rmSync(settingsFile, { force: true });
  loadSettings();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(settingsFile, { force: true });
});

afterAll(() => {
  rmSync(userData, { recursive: true, force: true });
});

/** Read the persisted settings.json straight from disk. */
function readDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsFile, "utf-8"));
}

describe("settings — display-filter defaults", () => {
  it("DEFAULT_SETTINGS ships hideNonCounted on, minDurationSec off", () => {
    expect(DEFAULT_SETTINGS.hideNonCounted).toBe(true);
    expect(DEFAULT_SETTINGS.minDurationSec).toBeNull();
  });

  it("loadSettings with no file returns the defaults (filter prefs included)", () => {
    expect(existsSync(settingsFile)).toBe(false);
    const s = loadSettings();
    expect(s.hideNonCounted).toBe(true);
    expect(s.minDurationSec).toBeNull();
  });
});

describe("settings — persist then reload", () => {
  it("updateSettings persists the filter prefs to disk and a fresh load restores them", () => {
    updateSettings({ hideNonCounted: false, minDurationSec: 30 });
    // The debounced write is scheduled; flush it.
    vi.advanceTimersByTime(300);

    // Persisted on disk...
    const disk = readDisk();
    expect(disk.hideNonCounted).toBe(false);
    expect(disk.minDurationSec).toBe(30);

    // ...and a fresh load (e.g. next app launch) restores them over the defaults.
    const reloaded = loadSettings();
    expect(reloaded.hideNonCounted).toBe(false);
    expect(reloaded.minDurationSec).toBe(30);
  });

  it("an OLD settings.json without the new keys loads with the defaults filled in", () => {
    // A pre-PR6 settings.json (no hideNonCounted / minDurationSec). loadSettings merges over
    // DEFAULT_SETTINGS, so the new prefs come up at their defaults rather than undefined.
    rmSync(settingsFile, { force: true });
    updateSettings({ opacity: 0.5 }); // write SOME pre-existing setting
    vi.advanceTimersByTime(300);
    // Simulate an old file: strip the new keys back off on disk.
    const disk = readDisk();
    delete disk.hideNonCounted;
    delete disk.minDurationSec;
    // Re-write the stripped file and reload.
    rmSync(settingsFile, { force: true });
    updateSettings(disk); // updateSettings -> schedules a write of the merged cache
    vi.advanceTimersByTime(300);

    const reloaded = loadSettings();
    expect(reloaded.opacity).toBe(0.5); // the old setting survived
    expect(reloaded.hideNonCounted).toBe(true); // new pref defaulted
    expect(reloaded.minDurationSec).toBeNull();
  });

  it("getSettings reflects an update before the debounce flushes (in-memory cache)", () => {
    updateSettings({ minDurationSec: 45 });
    // No timer flush yet — the cache is updated synchronously even though the disk write is debounced.
    expect(getSettings().minDurationSec).toBe(45);
  });

  it("null minDurationSec round-trips (the filter-off state persists, not coerced away)", () => {
    updateSettings({ minDurationSec: 60 });
    vi.advanceTimersByTime(300);
    updateSettings({ minDurationSec: null });
    vi.advanceTimersByTime(300);
    expect(readDisk().minDurationSec).toBeNull();
    expect(loadSettings().minDurationSec).toBeNull();
  });
});

describe("settings — #232 prefs (startup / language / font scales)", () => {
  it("ships the right defaults: no auto-start, auto language, 100% font in both windows", () => {
    expect(DEFAULT_SETTINGS.launchOnStartup).toBe(false);
    expect(DEFAULT_SETTINGS.language).toBe("auto");
    expect(DEFAULT_SETTINGS.liveFontScale).toBe(1);
    expect(DEFAULT_SETTINGS.listFontScale).toBe(1);
  });

  it("persists and reloads the new prefs", () => {
    updateSettings({
      launchOnStartup: true,
      language: "pt-br",
      liveFontScale: 1.25,
      listFontScale: 0.9,
    });
    vi.advanceTimersByTime(300);

    const reloaded = loadSettings();
    expect(reloaded.launchOnStartup).toBe(true);
    expect(reloaded.language).toBe("pt-br");
    expect(reloaded.liveFontScale).toBe(1.25);
    expect(reloaded.listFontScale).toBe(0.9);
  });

  it("an OLD settings.json without the #232 keys loads with their defaults filled in", () => {
    // Simulate a pre-#232 file on disk: only legacy keys, none of the new ones.
    writeFileSync(settingsFile, JSON.stringify({ opacity: 0.7, alwaysOnTop: false }), "utf-8");

    const reloaded = loadSettings();
    expect(reloaded.opacity).toBe(0.7); // the old settings survived
    expect(reloaded.launchOnStartup).toBe(false); // new prefs defaulted
    expect(reloaded.language).toBe("auto");
    expect(reloaded.liveFontScale).toBe(1);
    expect(reloaded.listFontScale).toBe(1);
  });

  it("clampFontScale bounds the zoom to FONT_SCALE_MIN..MAX and heals bad input", () => {
    expect(clampFontScale(1)).toBe(1);
    expect(clampFontScale(0.5)).toBe(FONT_SCALE_MIN);
    expect(clampFontScale(9)).toBe(FONT_SCALE_MAX);
    expect(clampFontScale(Number.NaN)).toBe(1);
    expect(clampFontScale(Number.POSITIVE_INFINITY)).toBe(1);
  });
});
