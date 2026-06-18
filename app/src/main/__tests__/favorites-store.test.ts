import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// favorites-store persists a sidecar favorites.json in the RESOLVED output dir. settings.ts resolves
// that dir (outputDir override, else ~/tbh-meter). Mock electron's userData + point the output dir
// at a temp folder so reads/writes hit a real file we can assert on.

const userData = mkdtempSync(join(tmpdir(), "tbh-fav-ud-"));
const outDir = mkdtempSync(join(tmpdir(), "tbh-fav-out-"));
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => userData },
}));

import { loadSettings, updateSettings } from "../settings.js";
import {
  getFavorites,
  isFavorite,
  toggleFavorite,
  pruneFavorites,
  invalidateFavoritesCache,
  FAVORITES_FILENAME,
  MAX_FAVORITES,
} from "../favorites-store.js";

const favFile = join(outDir, FAVORITES_FILENAME);

beforeEach(() => {
  vi.useFakeTimers();
  rmSync(favFile, { force: true });
  loadSettings();
  updateSettings({ outputDir: outDir });
  invalidateFavoritesCache();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(favFile, { force: true });
});

describe("toggleFavorite", () => {
  it("adds then removes a run id, persisting to favorites.json", () => {
    expect(isFavorite("run-1")).toBe(false);

    expect(toggleFavorite("run-1")).toBe(true);
    expect(isFavorite("run-1")).toBe(true);
    expect(JSON.parse(readFileSync(favFile, "utf-8"))).toEqual(["run-1"]);

    expect(toggleFavorite("run-1")).toBe(false);
    expect(isFavorite("run-1")).toBe(false);
    expect(JSON.parse(readFileSync(favFile, "utf-8"))).toEqual([]);
  });

  it("refuses an ADD at the cap WITHOUT persisting (no in-memory/disk divergence)", () => {
    // Seed the file AT the cap, then try to add one more.
    const atCap = Array.from({ length: MAX_FAVORITES }, (_, i) => `f${i}`);
    writeFileSync(favFile, JSON.stringify(atCap));
    invalidateFavoritesCache();

    expect(toggleFavorite("overflow")).toBe(false); // refused — still not favorited
    expect(isFavorite("overflow")).toBe(false); // in-memory set did NOT grow
    const persisted = JSON.parse(readFileSync(favFile, "utf-8")) as string[];
    expect(persisted.length).toBe(MAX_FAVORITES); // file unchanged — the newest star was not dropped
    expect(persisted).not.toContain("overflow");

    // Un-favoriting at the cap still works (frees a slot).
    expect(toggleFavorite("f0")).toBe(false);
    expect(isFavorite("f0")).toBe(false);
  });

  it("ignores a non-string / empty id", () => {
    expect(toggleFavorite(undefined)).toBe(false);
    expect(toggleFavorite("")).toBe(false);
    expect(toggleFavorite(42)).toBe(false);
    expect(getFavorites().size).toBe(0);
  });

  it("survives a cache reload from disk", () => {
    toggleFavorite("a");
    toggleFavorite("b");
    invalidateFavoritesCache(); // simulate a re-point / fresh read
    expect(isFavorite("a")).toBe(true);
    expect(isFavorite("b")).toBe(true);
    expect(getFavorites().size).toBe(2);
  });
});

describe("pruneFavorites", () => {
  it("drops favorite ids whose run no longer exists", () => {
    toggleFavorite("keep");
    toggleFavorite("gone");
    pruneFavorites(new Set(["keep"]));
    expect(isFavorite("keep")).toBe(true);
    expect(isFavorite("gone")).toBe(false);
  });

  it("no-op (no write churn) when every favorite still has a run", () => {
    toggleFavorite("x");
    pruneFavorites(new Set(["x", "y"]));
    expect(isFavorite("x")).toBe(true);
  });
});

describe("malformed / absent sidecar", () => {
  it("treats a missing file as empty", () => {
    expect(existsSync(favFile)).toBe(false);
    expect(getFavorites().size).toBe(0);
  });
});
