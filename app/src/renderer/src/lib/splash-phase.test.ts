import { describe, expect, it } from "vitest";
import type { ReaderStatus, UpdateStatus } from "../../../shared/ipc-types.js";
import { splashPhase } from "./splash-phase.js";

const READER_STATES: ReaderStatus[] = ["searching", "resolving", "scanning", "ready"];

describe("splashPhase", () => {
  it("shows 'updating' while a real update is available or downloading", () => {
    expect(splashPhase({ state: "available", version: "1.4.3" }, "searching")).toBe("updating");
    expect(splashPhase({ state: "downloading", version: "1.4.3", percent: 40 }, "ready")).toBe(
      "updating",
    );
  });

  it("shows 'restarting' once the update is downloaded (about to quitAndInstall)", () => {
    expect(splashPhase({ state: "downloaded", version: "1.4.3" }, "searching")).toBe("restarting");
  });

  it("an in-flight update WINS over any reader phase", () => {
    for (const reader of READER_STATES) {
      expect(splashPhase({ state: "downloading", version: "1.4.3", percent: 5 }, reader)).toBe(
        "updating",
      );
    }
  });

  it("falls through to the reader phase for non-applying update states (no 'checking' flash)", () => {
    const passthrough: UpdateStatus[] = [
      { state: "idle" },
      { state: "checking" },
      { state: "up-to-date" },
      { state: "error", message: "offline" },
    ];
    for (const update of passthrough) {
      for (const reader of READER_STATES) {
        expect(splashPhase(update, reader)).toBe(reader);
      }
    }
  });
});
