import { describe, expect, it } from "vitest";
import {
  classifyOutcome,
  computeBackoffMs,
  isBlocked,
  isFailure,
  READER_BASE_RESPAWN_MS,
  READER_BLOCKED_THRESHOLD,
  READER_MAX_BACKOFF_MS,
} from "../reader-policy.js";

describe("classifyOutcome", () => {
  it("a spawn throw / 'error' event is spawn-failed (the EPERM/ENOENT path)", () => {
    expect(classifyOutcome({ spawnError: true, exitCode: null, signal: null })).toBe("spawn-failed");
  });

  it("exit code 0 is clean — the reader's normal 'no game open' poll exit", () => {
    expect(classifyOutcome({ spawnError: false, exitCode: 0, signal: null })).toBe("clean");
  });

  it("a non-zero exit code is a crash (killed mid-run — e.g. AV on Windows)", () => {
    expect(classifyOutcome({ spawnError: false, exitCode: 1, signal: null })).toBe("crashed");
    expect(classifyOutcome({ spawnError: false, exitCode: 3221225786, signal: null })).toBe(
      "crashed",
    );
  });

  it("a terminating signal is a crash even with a null code", () => {
    expect(classifyOutcome({ spawnError: false, exitCode: null, signal: "SIGKILL" })).toBe(
      "crashed",
    );
  });

  it("a null code with no signal defaults to clean (don't over-report ambiguity)", () => {
    expect(classifyOutcome({ spawnError: false, exitCode: null, signal: null })).toBe("clean");
  });
});

describe("isFailure", () => {
  it("clean is benign; spawn-failed and crashed are failures", () => {
    expect(isFailure("clean")).toBe(false);
    expect(isFailure("spawn-failed")).toBe(true);
    expect(isFailure("crashed")).toBe(true);
  });
});

describe("computeBackoffMs", () => {
  it("no streak -> base delay (preserves the 5s game-poll cadence)", () => {
    expect(computeBackoffMs(0)).toBe(READER_BASE_RESPAWN_MS);
    expect(computeBackoffMs(-1)).toBe(READER_BASE_RESPAWN_MS);
  });

  it("doubles per consecutive failure", () => {
    expect(computeBackoffMs(1)).toBe(5_000);
    expect(computeBackoffMs(2)).toBe(10_000);
    expect(computeBackoffMs(3)).toBe(20_000);
    expect(computeBackoffMs(4)).toBe(40_000);
  });

  it("caps at the max backoff", () => {
    expect(computeBackoffMs(5)).toBe(READER_MAX_BACKOFF_MS); // 80s -> capped to 60s
    expect(computeBackoffMs(50)).toBe(READER_MAX_BACKOFF_MS);
  });
});

describe("isBlocked", () => {
  it("flips exactly at the threshold", () => {
    expect(isBlocked(READER_BLOCKED_THRESHOLD - 1)).toBe(false);
    expect(isBlocked(READER_BLOCKED_THRESHOLD)).toBe(true);
    expect(isBlocked(READER_BLOCKED_THRESHOLD + 1)).toBe(true);
  });
});
