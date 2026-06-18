import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SESSION_CUTS_FILENAME,
  SESSION_FILENAME,
  isValidSessionId,
  readCurrentSessionId,
  readSessionCuts,
  requestSessionReset,
  sessionStatsUrl,
} from "../session-stats.js";

describe("isValidSessionId", () => {
  it("accepts a normal opaque token", () => {
    expect(isValidSessionId("abc123")).toBe(true);
    expect(isValidSessionId("9f8e-7d6c-5b4a")).toBe(true);
  });

  it("rejects empty / non-string values", () => {
    expect(isValidSessionId("")).toBe(false);
    expect(isValidSessionId(undefined)).toBe(false);
    expect(isValidSessionId(null)).toBe(false);
    expect(isValidSessionId(42)).toBe(false);
  });

  it("rejects ids containing a colon (the external_id run separator)", () => {
    expect(isValidSessionId("abc:1")).toBe(false);
    expect(isValidSessionId(":")).toBe(false);
  });

  it("rejects ids over the 190-char cap", () => {
    expect(isValidSessionId("a".repeat(190))).toBe(true);
    expect(isValidSessionId("a".repeat(191))).toBe(false);
  });
});

describe("sessionStatsUrl", () => {
  it("builds an origin-scoped, encoded URL", () => {
    expect(sessionStatsUrl("https://tbherohelper.com", "abc 123")).toBe(
      "https://tbherohelper.com/meter/session/abc%20123",
    );
  });
});

describe("requestSessionReset", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tbh-session-reset-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends a manual cut timestamp (app-side; replaces the old reader flag)", () => {
    expect(requestSessionReset(dir, 1_717_800_000_000)).toBe(true);
    expect(existsSync(join(dir, SESSION_CUTS_FILENAME))).toBe(true);
    expect(readSessionCuts(dir)).toEqual([1_717_800_000_000]);
    // a grind can be split more than once -> cuts accumulate, in order
    expect(requestSessionReset(dir, 1_717_800_100_000)).toBe(true);
    expect(readSessionCuts(dir)).toEqual([1_717_800_000_000, 1_717_800_100_000]);
  });

  it("returns false without a resolved output dir", () => {
    expect(requestSessionReset(null)).toBe(false);
  });

  it("returns false when the dir does not exist (write fails, never throws)", () => {
    expect(requestSessionReset(join(dir, "missing", "deeper"))).toBe(false);
  });
});

describe("readCurrentSessionId", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tbh-session-read-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the reader's persisted session id", () => {
    writeFileSync(
      join(dir, SESSION_FILENAME),
      JSON.stringify({ session_id: "1780851599-29324", last_run_ts: 1780851599 }),
    );
    expect(readCurrentSessionId(dir)).toBe("1780851599-29324");
  });

  it("returns null when absent, malformed, or without a valid id", () => {
    expect(readCurrentSessionId(dir)).toBeNull(); // file absent
    expect(readCurrentSessionId(null)).toBeNull(); // no output dir
    writeFileSync(join(dir, SESSION_FILENAME), "{not json");
    expect(readCurrentSessionId(dir)).toBeNull();
    writeFileSync(join(dir, SESSION_FILENAME), JSON.stringify({ session_id: "" }));
    expect(readCurrentSessionId(dir)).toBeNull();
    writeFileSync(join(dir, SESSION_FILENAME), JSON.stringify({ session_id: "has:colon" }));
    expect(readCurrentSessionId(dir)).toBeNull(); // would bleed across sessions
  });
});
