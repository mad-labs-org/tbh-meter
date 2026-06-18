import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, ChestDropNotify } from "../../shared/ipc-types.js";
import type { LiveSnapshot } from "../../shared/run-types.js";

// The drop notifier is impure glue (settings + live stream + per-type OS notifications).
// Stub its collaborators so we can drive onLive deterministically and assert WHICH chest
// type fired. It is INDEPENDENT of the cooldown tracker — never gated by
// cooldownTrackerEnabled — and fires only on a true rising edge (never the baseline).

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

const { state, liveBus } = vi.hoisted(() => {
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
  return { state: holder, liveBus: ev };
});

vi.mock("../settings.js", () => ({ getSettings: () => state.settings }));
vi.mock("../sources/live-source.js", () => ({ getLiveSource: () => liveBus }));

// i18n: echo the key so we can assert WHICH message fired without locale coupling.
vi.mock("../i18n.js", () => ({ tMain: (key: string) => key }));

import { initDropNotifier } from "../drop-notifier.js";

function baseSettings(notify: Partial<ChestDropNotify> = {}): AppSettings {
  return {
    // Independence check: tracker OFF must NOT suppress drop notifications.
    cooldownTrackerEnabled: false,
    chestDropNotify: { common: false, stageBoss: true, actBoss: true, ...notify },
  } as AppSettings;
}

/** Snapshot with explicit per-type drop counts [common, stageBoss, actBoss]. */
function snap(stageKey: number, drops: [number, number, number]): LiveSnapshot {
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
    drops,
    partyStats: null,
    approx: true,
  };
}

const firedFor = (titleKey: string) => notificationCalls.filter((c) => c.title === titleKey);

beforeEach(() => {
  shows.mockClear();
  notificationCalls.length = 0;
  liveBus.removeAllListeners();
  state.settings = baseSettings();
  initDropNotifier();
});

afterEach(() => {
  liveBus.removeAllListeners();
});

describe("drop notifier", () => {
  // The module-level per-type `seen` maps persist across tests (mirror a long-lived process),
  // so each test uses a UNIQUE stageKey to stay order-independent.
  it("fires the stage-boss (blue) notification on its rising edge when enabled", () => {
    liveBus.emit("live", snap(1101, [0, 0, 0])); // seed baseline
    liveBus.emit("live", snap(1101, [0, 1, 0])); // blue rose
    expect(firedFor("notifications.stageBossTitle")).toHaveLength(1);
    expect(firedFor("notifications.commonTitle")).toHaveLength(0);
    expect(firedFor("notifications.actBossTitle")).toHaveLength(0);
  });

  it("fires the act-boss notification on its rising edge when enabled", () => {
    liveBus.emit("live", snap(1201, [0, 0, 0]));
    liveBus.emit("live", snap(1201, [0, 0, 1])); // act-boss rose
    expect(firedFor("notifications.actBossTitle")).toHaveLength(1);
  });

  it("does NOT fire the common notification by default (off), even on a rising edge", () => {
    liveBus.emit("live", snap(1301, [0, 0, 0]));
    liveBus.emit("live", snap(1301, [5, 0, 0])); // common rose a lot
    expect(firedFor("notifications.commonTitle")).toHaveLength(0);
  });

  it("fires the common notification when its toggle is on", () => {
    state.settings = baseSettings({ common: true });
    liveBus.emit("live", snap(1401, [0, 0, 0]));
    liveBus.emit("live", snap(1401, [1, 0, 0]));
    expect(firedFor("notifications.commonTitle")).toHaveLength(1);
  });

  it("does NOT fire on the baseline snapshot (no false drop on first observation)", () => {
    liveBus.emit("live", snap(1501, [3, 2, 1])); // first observation of this stage
    expect(notificationCalls).toHaveLength(0);
    expect(shows).not.toHaveBeenCalled();
  });

  it("fires INDEPENDENTLY of the cooldown tracker (tracker off, notifications still fire)", () => {
    // baseSettings already sets cooldownTrackerEnabled:false.
    liveBus.emit("live", snap(1601, [0, 0, 0]));
    liveBus.emit("live", snap(1601, [0, 1, 0]));
    expect(firedFor("notifications.stageBossTitle")).toHaveLength(1);
  });

  it("suppresses a disabled type's notification but keeps its baseline (no fire on re-enable)", () => {
    state.settings = baseSettings({ stageBoss: false });
    liveBus.emit("live", snap(1701, [0, 0, 0]));
    liveBus.emit("live", snap(1701, [0, 1, 0])); // blue rose while OFF → tracked, not fired
    expect(firedFor("notifications.stageBossTitle")).toHaveLength(0);

    // Re-enable: the SAME count must not read as a fresh drop (baseline was kept).
    state.settings = baseSettings({ stageBoss: true });
    liveBus.emit("live", snap(1701, [0, 1, 0]));
    expect(firedFor("notifications.stageBossTitle")).toHaveLength(0);

    // A genuine new rise from there fires.
    liveBus.emit("live", snap(1701, [0, 2, 0]));
    expect(firedFor("notifications.stageBossTitle")).toHaveLength(1);
  });

  it("keeps stages independent (a blue rise on B is not a rise on A)", () => {
    liveBus.emit("live", snap(1801, [0, 1, 0])); // seed A blue=1
    liveBus.emit("live", snap(1901, [0, 0, 0])); // seed B blue=0
    liveBus.emit("live", snap(1901, [0, 1, 0])); // B rises → fire
    expect(firedFor("notifications.stageBossTitle")).toHaveLength(1);
    liveBus.emit("live", snap(1801, [0, 1, 0])); // A unchanged → no fire
    expect(firedFor("notifications.stageBossTitle")).toHaveLength(1);
  });
});
