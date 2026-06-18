import { describe, expect, it } from "vitest";
import type { ReaderStatus, UpdateStatus } from "./ipc-types.js";
import { shouldDismissStalledSplash, SEARCHING_DISMISS_MS } from "./splash-decide.js";

// Update states that are NOT an in-flight install — the safety net is allowed to fire under these
// (they fall through to the reader phase in splashPhase, so the splash shows the reader card).
const NON_APPLYING_UPDATES: UpdateStatus[] = [
  { state: "idle" },
  { state: "checking" },
  { state: "up-to-date" },
  { state: "error", message: "offline" },
];

// The reader bring-up phases past "searching" — the reader has engaged the game.
const ENGAGED_READER: ReaderStatus[] = ["resolving", "scanning", "ready"];

describe("shouldDismissStalledSplash", () => {
  it("dismisses when the reader is stuck on 'searching' and no update is applying (game not running)", () => {
    // The core bug: meter opened with the game closed → reader cleanly exits, stays "searching",
    // never streams / never "ready" / never "blocked". The deadline must free the user.
    for (const update of NON_APPLYING_UPDATES) {
      expect(shouldDismissStalledSplash(update, "searching")).toBe(true);
    }
  });

  it("does NOT dismiss once the reader has engaged the game (a real bring-up is in flight)", () => {
    // resolving/scanning = first-time calibration reading the game's memory; its own first-live /
    // ready+fallback dismissals own that moment — a cold scan must never be cut short.
    for (const reader of ENGAGED_READER) {
      for (const update of NON_APPLYING_UPDATES) {
        expect(shouldDismissStalledSplash(update, reader)).toBe(false);
      }
    }
  });

  it("does NOT dismiss while an update is actively in flight, even though the reader is still 'searching'", () => {
    // The boot-update gate runs BEFORE the reader, so the reader status is still its initial
    // "searching" while a real update downloads — the deadline must not kill the progress screen.
    const inFlight: UpdateStatus[] = [
      { state: "available", version: "1.4.3" },
      { state: "downloading", version: "1.4.3", percent: 0 },
      { state: "downloading", version: "1.4.3", percent: 99 },
      { state: "downloaded", version: "1.4.3" },
    ];
    for (const update of inFlight) {
      expect(shouldDismissStalledSplash(update, "searching")).toBe(false);
    }
  });

  it("an in-flight update keeps the splash up regardless of reader phase", () => {
    const allReaders: ReaderStatus[] = ["searching", ...ENGAGED_READER];
    for (const reader of allReaders) {
      expect(
        shouldDismissStalledSplash({ state: "downloading", version: "1.4.3", percent: 50 }, reader),
      ).toBe(false);
      expect(shouldDismissStalledSplash({ state: "downloaded", version: "1.4.3" }, reader)).toBe(
        false,
      );
    }
  });

  it("uses a budget comfortably larger than the 8s ready-fallback / calibrated boot", () => {
    // Regression guard on the constant itself: a budget anywhere near 8s could cut a calibrated
    // boot that's about to stream. Keep it well clear (≥ 4× the 8s fallback).
    expect(SEARCHING_DISMISS_MS).toBeGreaterThanOrEqual(8000 * 4);
  });
});
