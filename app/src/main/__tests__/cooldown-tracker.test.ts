import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../shared/ipc-types.js";
import type { LiveSnapshot } from "../../shared/run-types.js";
import { DEFAULT_COOLDOWN_MS } from "../../shared/cooldown-types.js";

// The tracker is impure glue (settings + live stream + the "ready" OS notification). Stub its
// collaborators so we can drive onLive deterministically. The per-chest-type DROP notification
// is a SEPARATE module now (drop-notifier.ts, own test) — this suite only covers the tracker:
// cooldown detection/persistence, the cooldownTrackerEnabled gate, and the "ready" nudge.

// Hoisted so the vi.mock factory (lifted to the top of the file) can reference them.
const { shows, notificationCalls } = vi.hoisted(() => ({
  shows: vi.fn(),
  notificationCalls: [] as Array<{ title?: string; body?: string }>,
}));

vi.mock("electron", () => {
  class FakeNotification {
    static isSupported = vi.fn(() => true);
    constructor(opts: { title?: string; body?: string }) {
      notificationCalls.push(opts);
    }
    show = shows;
  }
  return { Notification: FakeNotification };
});

// `state.settings` is reassigned per test; the factory reads it lazily via the holder.
// The tracker only uses getLiveSource().on("live", fn), so a minimal emitter suffices.
const { state, updateSettings, liveBus } = vi.hoisted(() => {
  type Handler = (snap: unknown) => void;
  const handlers: Handler[] = [];
  const ev = {
    on(_event: string, fn: Handler) {
      handlers.push(fn);
      return ev;
    },
    emit(_event: string, snap: unknown) {
      for (const fn of [...handlers]) fn(snap);
    },
    removeAllListeners() {
      handlers.length = 0;
    },
  };
  const holder: { settings: AppSettings } = { settings: {} as AppSettings };
  const upd = vi.fn((partial: Partial<AppSettings>) => {
    holder.settings = { ...holder.settings, ...partial };
    return holder.settings;
  });
  return { state: holder, updateSettings: upd, liveBus: ev };
});

vi.mock("../settings.js", () => ({
  getSettings: () => state.settings,
  updateSettings: (partial: Partial<AppSettings>) => updateSettings(partial),
}));

vi.mock("../sources/live-source.js", () => ({ getLiveSource: () => liveBus }));

// i18n: echo the key so we can assert WHICH message fired without locale coupling.
vi.mock("../i18n.js", () => ({
  tMain: (key: string) => key,
}));

import { initCooldownTracker, clearAllCooldowns, rearmNotifications } from "../cooldown-tracker.js";

function baseSettings(over: Partial<AppSettings> = {}): AppSettings {
  return {
    cooldownTrackerEnabled: true,
    chestCooldowns: [],
    chestDropLog: [],
    chestCooldownMin: 13,
    chestRoute: [],
    trackOutsideRoute: true,
    // The rest of AppSettings is irrelevant to the tracker; cast keeps the test focused.
    ...over,
  } as AppSettings;
}

function snap(stageKey: number, blueCount: number): LiveSnapshot {
  return {
    runNumber: 1,
    stage: "Pasture",
    mode: "Normal",
    stageKey,
    mobs: 0,
    totalMobs: null,
    elapsedSec: 1,
    damage: 0,
    dps: 0,
    goldGain: null,
    xpGain: null,
    party: null,
    drops: [0, blueCount, 0],
    partyStats: null,
    approx: true,
  };
}

const broadcast = vi.fn();

beforeEach(() => {
  shows.mockClear();
  notificationCalls.length = 0;
  updateSettings.mockClear();
  broadcast.mockClear();
  liveBus.removeAllListeners();
  state.settings = baseSettings();
  initCooldownTracker(broadcast);
});

afterEach(() => {
  liveBus.removeAllListeners();
});

const readyTitles = () => notificationCalls.filter((c) => c.title === "cooldowns.notifTitle");

describe("cooldown tracker", () => {
  // The module-level `seen` map in cooldown-tracker.ts persists across tests (it mirrors a
  // long-lived process) and is now keyed by BOX. Each test uses stages that resolve to a UNIQUE
  // box so they stay order-independent — a test shuffle can't leak one test's baseline into
  // another. (1101→920011, 2201→920401, 4109→920801, 1308→920301, 1208→920201, 3205→920651.)
  it("records a cooldown on a rising blue-chest edge when enabled", () => {
    liveBus.emit("live", snap(1101, 0)); // seed baseline, no drop
    expect(updateSettings).not.toHaveBeenCalled();

    liveBus.emit("live", snap(1101, 1)); // rising edge → drop recorded
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith("meter:cooldowns", expect.anything());
  });

  it("does NOT record on the baseline snapshot (no false drop)", () => {
    liveBus.emit("live", snap(2201, 3)); // first observation of this stage
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("does NOT auto-detect when the master tracker is off", () => {
    state.settings = baseSettings({ cooldownTrackerEnabled: false });
    liveBus.emit("live", snap(4401, 0));
    liveBus.emit("live", snap(4401, 1));
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("fires the READY notification when the cooldown elapses", () => {
    vi.useFakeTimers();
    try {
      liveBus.emit("live", snap(4109, 0));
      liveBus.emit("live", snap(4109, 1)); // drop now; ready nudge armed for +cooldown
      // No ready notification yet (cooldown still running).
      expect(readyTitles()).toHaveLength(0);
      vi.advanceTimersByTime(DEFAULT_COOLDOWN_MS + 1000); // default 13-min timer
      expect(readyTitles()).toHaveLength(1);
      expect(shows).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("respects a shorter configured cooldown for the READY nudge", () => {
    vi.useFakeTimers();
    try {
      state.settings = baseSettings({ chestCooldownMin: 5 }); // 5-min timer
      liveBus.emit("live", snap(1208, 0));
      liveBus.emit("live", snap(1208, 1)); // drop on the Lv20 box
      vi.advanceTimersByTime(4 * 60 * 1000); // 4 min — not ready yet
      expect(readyTitles()).toHaveLength(0);
      vi.advanceTimersByTime(2 * 60 * 1000); // past 5 min total
      expect(readyTitles()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-arms the pending READY nudge when the cooldown length changes", () => {
    vi.useFakeTimers();
    try {
      liveBus.emit("live", snap(4109, 0));
      liveBus.emit("live", snap(4109, 1)); // drop on the Lv80 box → nudge armed for +13min (default)
      // User RAISES the cooldown to 60 min. The renderer re-derives its countdown every tick; the
      // main-process timer was armed with the old 13-min delay and must be re-derived too.
      state.settings = { ...state.settings, chestCooldownMin: 60 };
      rearmNotifications();
      // Past the OLD 13-min delay → must NOT fire (the timer was re-armed to 60 min).
      vi.advanceTimersByTime(13 * 60 * 1000 + 1000);
      expect(readyTitles()).toHaveLength(0);
      // Past the NEW 60-min mark → fires exactly once.
      vi.advanceTimersByTime(48 * 60 * 1000);
      expect(readyTitles()).toHaveLength(1);
      expect(shows).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("route filter (trackOutsideRoute)", () => {
    it("ignores a drop OUTSIDE the route, records one INSIDE it", () => {
      state.settings = baseSettings({ trackOutsideRoute: false, chestRoute: [920201] });
      // 1308 → box 920301, NOT in the route → gated (no card/log).
      liveBus.emit("live", snap(1308, 0));
      liveBus.emit("live", snap(1308, 1));
      expect(updateSettings).not.toHaveBeenCalled();
      // 1208 → box 920201, pinned → recorded.
      liveBus.emit("live", snap(1208, 0));
      liveBus.emit("live", snap(1208, 1));
      expect(updateSettings).toHaveBeenCalledTimes(1);
    });
  });

  describe("clearAllCooldowns", () => {
    it("wipes active cooldowns + history and broadcasts (route untouched)", () => {
      state.settings = baseSettings({ chestRoute: [920651] });
      liveBus.emit("live", snap(3205, 0));
      liveBus.emit("live", snap(3205, 1)); // record a Lv65 drop
      expect(state.settings.chestCooldowns.length).toBe(1);
      broadcast.mockClear();

      clearAllCooldowns();
      expect(state.settings.chestCooldowns).toEqual([]);
      expect(state.settings.chestDropLog).toEqual([]);
      expect(state.settings.chestRoute).toEqual([920651]); // route is config, kept
      expect(broadcast).toHaveBeenCalledWith("meter:cooldowns", expect.anything());
    });
  });
});
