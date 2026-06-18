import { afterEach, describe, expect, it, vi } from "vitest";

import { isRcBuild, variant } from "../variant.js";

afterEach(() => vi.unstubAllGlobals());

describe("variant", () => {
  it("falls back to stable when the build flag is absent (no define, e.g. under vitest)", () => {
    // The typeof guard must not throw on the undeclared global.
    expect(variant()).toBe("stable");
    expect(isRcBuild()).toBe(false);
  });

  it("reports rc when the build flag is rc", () => {
    vi.stubGlobal("__TBH_VARIANT__", "rc");
    expect(variant()).toBe("rc");
    expect(isRcBuild()).toBe(true);
  });

  it("reports stable when the build flag is explicitly stable", () => {
    vi.stubGlobal("__TBH_VARIANT__", "stable");
    expect(variant()).toBe("stable");
    expect(isRcBuild()).toBe(false);
  });
});
