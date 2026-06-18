import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// analytics-id.ts resolves its file under app.getPath("userData") — point that at a
// temp dir so the test never touches a real install's analytics id.
const dir = mkdtempSync(join(tmpdir(), "tbh-analytics-id-"));
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => dir },
}));

import { analyticsIdPath, getAnalyticsClientId, parseAnalyticsIdFile } from "../analytics-id.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseAnalyticsIdFile", () => {
  it("accepts a well-formed file", () => {
    const id = "0f8e7d6c-5b4a-4321-8765-0123456789ab";
    expect(parseAnalyticsIdFile(JSON.stringify({ analyticsId: id }))).toBe(id);
  });

  it("rejects corrupt JSON and non-uuid ids (regenerate instead of trusting them)", () => {
    expect(parseAnalyticsIdFile("not json")).toBeNull();
    expect(parseAnalyticsIdFile(JSON.stringify({ analyticsId: "hello" }))).toBeNull();
    expect(parseAnalyticsIdFile(JSON.stringify({}))).toBeNull();
    expect(parseAnalyticsIdFile(JSON.stringify(null))).toBeNull();
  });
});

describe("getAnalyticsClientId", () => {
  beforeEach(() => {
    rmSync(analyticsIdPath(), { force: true });
  });

  it("creates a uuid on first use, persists it, and is stable afterwards", () => {
    const id = getAnalyticsClientId();
    expect(id).toMatch(UUID_RE);
    expect(getAnalyticsClientId()).toBe(id); // cached
    const onDisk = parseAnalyticsIdFile(readFileSync(analyticsIdPath(), "utf-8"));
    expect(onDisk).toBe(id); // persisted
  });

  it("keeps returning the cached id even if the file is later corrupted", () => {
    const id = getAnalyticsClientId();
    writeFileSync(analyticsIdPath(), "garbage", "utf-8");
    expect(getAnalyticsClientId()).toBe(id);
  });
});
