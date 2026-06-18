import { describe, expect, it } from "vitest";
import { parseHumanized, parseIntOr } from "../sources/parse.js";

describe("parseHumanized", () => {
  it("parses a bare integer", () => {
    expect(parseHumanized("147")).toBe(147);
  });

  it("parses K suffix", () => {
    expect(parseHumanized("70.20K")).toBeCloseTo(70_200);
  });

  it("parses M suffix", () => {
    expect(parseHumanized("6.66M")).toBeCloseTo(6_660_000);
  });

  it("parses B suffix", () => {
    expect(parseHumanized("1.50B")).toBeCloseTo(1_500_000_000);
  });

  it("parses T suffix", () => {
    expect(parseHumanized("2.00T")).toBeCloseTo(2_000_000_000_000);
  });

  it("strips trailing /s (DPS format)", () => {
    expect(parseHumanized("6.66M/s")).toBeCloseTo(6_660_000);
  });

  it("strips trailing /S (case-insensitive)", () => {
    expect(parseHumanized("100K/S")).toBeCloseTo(100_000);
  });

  it("handles lowercase suffix", () => {
    expect(parseHumanized("5.00m")).toBeCloseTo(5_000_000);
  });

  it("returns 0 for empty string", () => {
    expect(parseHumanized("")).toBe(0);
  });

  it("returns 0 for null", () => {
    expect(parseHumanized(null)).toBe(0);
  });

  it("returns 0 for undefined", () => {
    expect(parseHumanized(undefined)).toBe(0);
  });

  it("returns 0 for non-numeric string", () => {
    expect(parseHumanized("abc")).toBe(0);
  });

  it("handles negative values", () => {
    expect(parseHumanized("-5")).toBe(-5);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseHumanized("  100K  ")).toBeCloseTo(100_000);
  });

  it("handles decimal without suffix", () => {
    expect(parseHumanized("3.14")).toBe(3.14);
  });
});

describe("parseIntOr", () => {
  it("parses a standalone integer", () => {
    expect(parseIntOr("42")).toBe(42);
  });

  it("extracts first integer from mixed string", () => {
    expect(parseIntOr("mobs 147/601")).toBe(147);
  });

  it("handles negative integers", () => {
    expect(parseIntOr("-5")).toBe(-5);
  });

  it("returns null for non-numeric string by default", () => {
    expect(parseIntOr("abc")).toBeNull();
  });

  it("returns custom fallback for non-numeric string", () => {
    expect(parseIntOr("abc", 0)).toBe(0);
  });

  it("returns null for null input", () => {
    expect(parseIntOr(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(parseIntOr(undefined)).toBeNull();
  });

  it("returns fallback for null with custom fallback", () => {
    expect(parseIntOr(null, -1)).toBe(-1);
  });
});
