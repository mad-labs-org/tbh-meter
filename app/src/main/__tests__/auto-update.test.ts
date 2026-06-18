import { afterEach, describe, expect, it, vi } from "vitest";

// auto-update.ts destructures `autoUpdater` off electron-updater's default export and
// imports electron + variant at load — stub them so importing the module is side-effect free.
vi.mock("electron", () => ({ app: { isPackaged: true } }));
vi.mock("electron-updater", () => ({ default: { autoUpdater: {} } }));
vi.mock("../variant.js", () => ({ isRcBuild: () => false }));
vi.mock("../settings.js", () => ({ resolveOutputDir: () => "/tmp/tbh-meter-test" }));
// fetchLatestShippedVersion now rides Electron's net stack (httpFetch -> net.fetch).
// Delegate the helper to whatever global fetch the test currently stubs, so the
// existing vi.stubGlobal("fetch", ...) cases keep driving it unchanged.
vi.mock("../net-fetch.js", () => ({
  httpFetch: (input: string | GlobalRequest, init?: RequestInit) => fetch(input, init),
}));

import {
  awaitDownloadWithRetry,
  fetchLatestShippedVersion,
  isNewerVersion,
  shouldTriggeredCheck,
  triggeredCooldownFor,
  runBootUpdateGate,
} from "../auto-update.js";

const noSleep = () => Promise.resolve();
const never = () => new Promise<void>(() => {}); // never settles
const flush = () => new Promise((r) => setTimeout(r, 0)); // drain micro/macro tasks

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

describe("shouldTriggeredCheck", () => {
  const COOLDOWN = 10 * 60 * 1000;

  it("runs from a resting state once the cooldown has elapsed", () => {
    for (const state of ["idle", "up-to-date", "error"] as const) {
      expect(shouldTriggeredCheck(state, 0, COOLDOWN, COOLDOWN)).toBe(true);
    }
  });

  it("is blocked mid-flight regardless of how long since the last check", () => {
    for (const state of ["checking", "available", "downloading", "downloaded"] as const) {
      expect(shouldTriggeredCheck(state, 0, COOLDOWN * 100, COOLDOWN)).toBe(false);
    }
  });

  it("is throttled within the cooldown window even when resting", () => {
    expect(shouldTriggeredCheck("up-to-date", 1_000, 1_000 + COOLDOWN - 1, COOLDOWN)).toBe(false);
    // exactly at the boundary it's allowed again
    expect(shouldTriggeredCheck("up-to-date", 1_000, 1_000 + COOLDOWN, COOLDOWN)).toBe(true);
  });
});

describe("isNewerVersion", () => {
  it("compares X.Y.Z numerically, not lexically", () => {
    expect(isNewerVersion("0.31.0", "0.30.0")).toBe(true);
    expect(isNewerVersion("0.10.0", "0.9.1")).toBe(true); // string compare would say false
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
    expect(isNewerVersion("0.30.0", "0.30.0")).toBe(false);
    expect(isNewerVersion("0.29.9", "0.30.0")).toBe(false);
  });

  it("never claims newer on malformed input", () => {
    expect(isNewerVersion("", "0.30.0")).toBe(false);
    expect(isNewerVersion("0.0.1", "")).toBe(false); // "" would otherwise read as 0.0.0
    expect(isNewerVersion("abc", "0.30.0")).toBe(false);
    expect(isNewerVersion("0.31.0", "garbage")).toBe(false);
  });
});

describe("fetchLatestShippedVersion", () => {
  // The boot gate's whole resilience story rests on this contract: the authority lookup
  // RESOLVES (string | null) on every failure shape — it never rejects, never throws.
  afterEach(() => vi.unstubAllGlobals());

  const okJson = (body: unknown) =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

  it("returns the version for a well-formed shipped tag", async () => {
    vi.stubGlobal("fetch", vi.fn(() => okJson({ tag_name: "tbh-meter-v0.31.0" })));
    await expect(fetchLatestShippedVersion()).resolves.toBe("0.31.0");
  });

  it("returns null when the network fails (offline / DNS / abort-timeout)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("ENOTFOUND api.github.com"))));
    await expect(fetchLatestShippedVersion()).resolves.toBeNull();
  });

  it("returns null on a non-2xx response (403 anonymous quota, 404, 5xx)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) })));
    await expect(fetchLatestShippedVersion()).resolves.toBeNull();
  });

  it("returns null when the body is not parseable JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.reject(new Error("bad json")) })),
    );
    await expect(fetchLatestShippedVersion()).resolves.toBeNull();
  });

  it("returns null when the tag is missing or not a stable meter tag", async () => {
    for (const body of [
      {},
      { tag_name: "v0.31.0" }, // wrong prefix
      { tag_name: "tbh-meter-v0.31.0-rc.2" }, // RC never counts as shipped
      { tag_name: "tbh-meter-pr-123" },
    ]) {
      vi.stubGlobal("fetch", vi.fn(() => okJson(body)));
      await expect(fetchLatestShippedVersion()).resolves.toBeNull();
    }
  });

  it("never throws synchronously even when fetch itself does", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new TypeError("fetch is broken");
      }),
    );
    await expect(fetchLatestShippedVersion()).resolves.toBeNull();
  });
});

describe("triggeredCooldownFor", () => {
  it("holds the full cooldown in normal resting states", () => {
    for (const state of ["idle", "up-to-date", "checking", "downloaded"] as const) {
      expect(triggeredCooldownFor(state)).toBe(10 * 60 * 1000);
    }
  });

  it("drops to a short floor after a failed check — error is 'don't know', not 'current'", () => {
    expect(triggeredCooldownFor("error")).toBe(30_000);
    expect(triggeredCooldownFor("error")).toBeLessThan(triggeredCooldownFor("up-to-date"));
  });
});

describe("awaitDownloadWithRetry", () => {
  it("resolves without retrying when the initial download succeeds", async () => {
    const redownload = vi.fn(() => Promise.resolve(["file.exe"]));
    await expect(
      awaitDownloadWithRetry(Promise.resolve(["file.exe"]), redownload, { sleep: noSleep }),
    ).resolves.toBeUndefined();
    expect(redownload).not.toHaveBeenCalled();
  });

  it("retries a failed download and succeeds — clears the non-deterministic rename race", async () => {
    let calls = 0;
    const redownload = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("ENOENT rename")) : Promise.resolve(["ok"]);
    });
    const onRetry = vi.fn();
    await expect(
      awaitDownloadWithRetry(Promise.reject(new Error("ENOENT rename")), redownload, {
        sleep: noSleep,
        onRetry,
      }),
    ).resolves.toBeUndefined();
    expect(redownload).toHaveBeenCalledTimes(2); // retry #1 rejects, retry #2 resolves
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxRetries and rethrows so the caller can surface status:error", async () => {
    const boom = () => Promise.reject(new Error("still locked"));
    const redownload = vi.fn(boom);
    await expect(
      awaitDownloadWithRetry(boom(), redownload, { maxRetries: 3, sleep: noSleep }),
    ).rejects.toThrow("still locked");
    expect(redownload).toHaveBeenCalledTimes(3); // 1 initial attempt + 3 retries
  });
});

describe("runBootUpdateGate", () => {
  it("proceeds without checking on an unsupported install", async () => {
    const check = vi.fn();
    await expect(runBootUpdateGate({ supported: false, check, apply: vi.fn() })).resolves.toBe(
      "proceed",
    );
    expect(check).not.toHaveBeenCalled();
  });

  it("proceeds (no apply) when already up-to-date", async () => {
    const apply = vi.fn();
    const r = await runBootUpdateGate({
      supported: true,
      apply,
      sleep: never, // the check wins the race, so the timeout must never fire
      check: () => Promise.resolve({ hasUpdate: false, download: () => Promise.resolve() }),
    });
    expect(r).toBe("proceed");
    expect(apply).not.toHaveBeenCalled();
  });

  it("downloads then applies (quitAndInstall) when an update is available", async () => {
    const apply = vi.fn();
    const download = vi.fn(() => Promise.resolve());
    const r = await runBootUpdateGate({
      supported: true,
      apply,
      sleep: never,
      check: () => Promise.resolve({ hasUpdate: true, download }),
    });
    expect(r).toBe("updated");
    expect(download).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("degrades a synchronously-throwing apply to proceed — the gate never rejects", async () => {
    // quitAndInstall throwing must not abort the caller's boot sequence: the staged
    // update still applies on next quit (autoInstallOnAppQuit), the reader starts now.
    const onDownloadFail = vi.fn();
    const r = await runBootUpdateGate({
      supported: true,
      apply: () => {
        throw new Error("installer exploded");
      },
      onDownloadFail,
      sleep: never,
      check: () => Promise.resolve({ hasUpdate: true, download: () => Promise.resolve() }),
    });
    expect(r).toBe("proceed");
    expect(onDownloadFail).toHaveBeenCalledOnce();
  });

  it("falls back to proceed (NOT apply) when the download fails — never strands the user", async () => {
    const apply = vi.fn();
    const onDownloadFail = vi.fn();
    const r = await runBootUpdateGate({
      supported: true,
      apply,
      onDownloadFail,
      sleep: never,
      check: () =>
        Promise.resolve({ hasUpdate: true, download: () => Promise.reject(new Error("AV lock")) }),
    });
    expect(r).toBe("proceed");
    expect(apply).not.toHaveBeenCalled();
    expect(onDownloadFail).toHaveBeenCalledOnce();
  });

  it("proceeds when every check attempt fails (offline) — the feed error never blocks the boot", async () => {
    const apply = vi.fn();
    const check = vi.fn(() => Promise.reject(new Error("ENOTFOUND github.com")));
    const r = await runBootUpdateGate({
      supported: true,
      apply,
      sleep: never,
      retrySleep: noSleep,
      check,
    });
    expect(r).toBe("proceed");
    expect(check).toHaveBeenCalledTimes(2); // bounded: 1 attempt + 1 retry, then give up
    expect(apply).not.toHaveBeenCalled();
  });

  it("retries a transiently failing check and applies the update the retry finds", async () => {
    // The v0.31.0 incident shape: the first boot check mis-answers, the truth is one
    // re-attempt away. The gate must land on "updated", not strand the user on the old build.
    const apply = vi.fn();
    let calls = 0;
    const check = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("transient 503"))
        : Promise.resolve({ hasUpdate: true, download: () => Promise.resolve() });
    });
    const r = await runBootUpdateGate({
      supported: true,
      apply,
      sleep: never,
      retrySleep: noSleep,
      check,
    });
    expect(r).toBe("updated");
    expect(check).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("respects a custom attempt budget", async () => {
    const check = vi.fn(() => Promise.reject(new Error("still down")));
    const r = await runBootUpdateGate({
      supported: true,
      apply: vi.fn(),
      sleep: never,
      retrySleep: noSleep,
      checkAttempts: 3,
      check,
    });
    expect(r).toBe("proceed");
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("converges when the authority proves 'up to date' stale, then applies", async () => {
    // The v0.31.0 incident, solved with logic instead of timers: the public pointer still
    // serves the old release, the REST origin already knows the new one — the gate KNOWS
    // it is stale and re-checks until the pointer catches up.
    const apply = vi.fn();
    const noUpdate = { hasUpdate: false, download: () => Promise.resolve() };
    let calls = 0;
    const check = vi.fn(() => {
      calls += 1;
      return Promise.resolve(
        calls < 3 ? noUpdate : { hasUpdate: true, download: () => Promise.resolve() },
      );
    });
    const r = await runBootUpdateGate({
      supported: true,
      apply,
      sleep: never,
      retrySleep: noSleep,
      check,
      authoritativeVersion: () => Promise.resolve("0.31.0"),
      currentVersion: "0.30.0",
    });
    expect(r).toBe("updated");
    expect(check).toHaveBeenCalledTimes(3); // initial + 2 convergence re-checks
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("gives up convergence after its budget and proceeds (interval catches up later)", async () => {
    const onKnownStale = vi.fn();
    const check = vi.fn(() =>
      Promise.resolve({ hasUpdate: false, download: () => Promise.resolve() }),
    );
    const r = await runBootUpdateGate({
      supported: true,
      apply: vi.fn(),
      sleep: never,
      retrySleep: noSleep,
      check,
      authoritativeVersion: () => Promise.resolve("0.31.0"),
      currentVersion: "0.30.0",
      convergenceAttempts: 4,
      onKnownStale,
    });
    expect(r).toBe("proceed");
    expect(onKnownStale).toHaveBeenCalledWith("0.31.0");
    expect(check).toHaveBeenCalledTimes(1 + 4); // initial + the bounded convergence loop
  });

  it("swallows convergence re-check failures and keeps trying within the budget", async () => {
    const apply = vi.fn();
    const noUpdate = { hasUpdate: false, download: () => Promise.resolve() };
    let calls = 0;
    const check = vi.fn(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(noUpdate);
      if (calls === 2) return Promise.reject(new Error("blip"));
      return Promise.resolve({ hasUpdate: true, download: () => Promise.resolve() });
    });
    const r = await runBootUpdateGate({
      supported: true,
      apply,
      sleep: never,
      retrySleep: noSleep,
      check,
      authoritativeVersion: () => Promise.resolve("0.31.0"),
      currentVersion: "0.30.0",
    });
    expect(r).toBe("updated");
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("trusts 'up to date' when the authority has no signal or agrees", async () => {
    for (const authority of [null, "0.30.0", "0.29.9"]) {
      const check = vi.fn(() =>
        Promise.resolve({ hasUpdate: false, download: () => Promise.resolve() }),
      );
      const r = await runBootUpdateGate({
        supported: true,
        apply: vi.fn(),
        sleep: never,
        retrySleep: noSleep,
        check,
        authoritativeVersion: () => Promise.resolve(authority),
        currentVersion: "0.30.0",
      });
      expect(r).toBe("proceed");
      expect(check).toHaveBeenCalledTimes(1); // no convergence loop
    }
  });

  it("never converges on the timeout path, even with a stale authority", async () => {
    // A network too slow for the 8s check must not also pay the convergence loop — the
    // late check's download is drained in the background instead.
    const late = deferred<{ hasUpdate: boolean; download: () => Promise<void> }>();
    const check = vi.fn(() => late.promise);
    const r = await runBootUpdateGate({
      supported: true,
      apply: vi.fn(),
      sleep: () => Promise.resolve(), // timeout wins immediately
      retrySleep: noSleep,
      check,
      authoritativeVersion: () => Promise.resolve("0.31.0"),
      currentVersion: "0.30.0",
    });
    expect(r).toBe("proceed");
    expect(check).toHaveBeenCalledTimes(1); // no convergence re-checks
  });

  it("treats a rejecting authority as no signal", async () => {
    const check = vi.fn(() =>
      Promise.resolve({ hasUpdate: false, download: () => Promise.resolve() }),
    );
    const r = await runBootUpdateGate({
      supported: true,
      apply: vi.fn(),
      sleep: never,
      retrySleep: noSleep,
      check,
      authoritativeVersion: () => Promise.reject(new Error("403 rate limited")),
      currentVersion: "0.30.0",
    });
    expect(r).toBe("proceed");
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("on a slow check: proceeds now, then drains a late update's download in the background", async () => {
    const apply = vi.fn();
    const drainBackgroundDownload = vi.fn();
    const late = deferred<{ hasUpdate: boolean; download: () => Promise<void> }>();
    const r = await runBootUpdateGate({
      supported: true,
      apply,
      drainBackgroundDownload,
      sleep: () => Promise.resolve(), // timeout wins immediately
      check: () => late.promise,
    });
    expect(r).toBe("proceed");
    expect(drainBackgroundDownload).not.toHaveBeenCalled(); // check hasn't resolved yet

    const download = () => Promise.resolve();
    late.resolve({ hasUpdate: true, download });
    await flush();
    expect(drainBackgroundDownload).toHaveBeenCalledWith(download);
    expect(apply).not.toHaveBeenCalled(); // the timed-out path never auto-applies/relaunches
  });
});
