import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../shared/ipc-types.js";

// ── Mock electron ─────────────────────────────────────────────────────────
const mockScreen = {
  getAllDisplays: () => [
    {
      id: 1,
      size: { width: 2560, height: 1440 },
      displayFrequency: 165,
      scaleFactor: 1.25,
      workAreaSize: { width: 2560, height: 1400 },
    },
    {
      id: 2,
      size: { width: 1920, height: 1080 },
      displayFrequency: 60,
      scaleFactor: 1,
      workAreaSize: { width: 1920, height: 1040 },
    },
  ],
  getPrimaryDisplay: () => mockScreen.getAllDisplays()[0]!,
};

vi.mock("electron", () => ({
  app: { getVersion: () => "0.5.0-test" },
  screen: mockScreen,
}));

// ── Test dir ──────────────────────────────────────────────────────────────
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tbh-debug-info-"));
  // Stub process.env for proxy tests
  vi.stubEnv("HTTPS_PROXY", "");
  vi.stubEnv("HTTP_PROXY", "");
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────

/** Full AppSettings (uses DEFAULT_SETTINGS, overridden with test values). */
function defaultSettings() {
  return {
    ...DEFAULT_SETTINGS,
    outputDir: dir,
    liveBounds: { x: 100, y: 200, width: 320, height: 96 },
    listBounds: { x: 400, y: 300, width: 800, height: 600 },
  };
}

/** Minimal opts that satisfy DebugInfoOpts. */
function defaultOpts(overrides: Record<string, unknown> = {}) {
  return {
    getLiveBounds: () => ({ x: 100, y: 200, width: 320, height: 96 }),
    isLiveVisible: () => true,
    isLiveAlwaysOnTop: () => true,
    getListBounds: () => ({ x: 400, y: 300, width: 800, height: 600 }),
    splashActive: false,
    readerState: "ready",
    updateState: { state: "up-to-date" },
    signedIn: true,
    settings: defaultSettings(),
    outputDir: dir,
    isRc: false,
    ...overrides,
  };
}

/** Write a file into the test dir. */
function touch(rel: string, content: string) {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf-8");
}

/** Create a minimal resolve_cache.json. */
function seedCache(fmt = 12, fps: string[] = ["abc123"]) {
  touch("resolve_cache.json", JSON.stringify({ fmt, calib: Object.fromEntries(fps.map((f) => [f, {}])) }));
}

// ── Dynamic import after mocks ────────────────────────────────────────────
// vitest hoists vi.mock above imports; the dynamic import picks up mocks.

let collectDebugInfo: typeof import("../debug-info.js").collectDebugInfo;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("../debug-info.js");
  collectDebugInfo = mod.collectDebugInfo;
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("collectDebugInfo", () => {
  it("produces a non-empty string with all sections present", async () => {
    seedCache();
    const out = await collectDebugInfo(defaultOpts());
    expect(out).toContain("TBH Meter Debug Info");
    expect(out).toContain("--- Environment ---");
    expect(out).toContain("--- Network ---");
    expect(out).toContain("--- App State ---");
    expect(out).toContain("--- Reader ---");
    expect(out).toContain("--- Settings ---");
  });

  // ── Header ──────────────────────────────────────────────────────────
  it("includes app version and OS info", async () => {
    const out = await collectDebugInfo(defaultOpts());
    expect(out).toContain("App: 0.5.0-test (stable)");
    expect(out).toMatch(/Windows/);
    expect(out).toMatch(/Electron:/);
  });

  it("marks RC variant in header when isRc=true", async () => {
    const out = await collectDebugInfo(defaultOpts({ isRc: true }));
    expect(out).toContain("App: 0.5.0-test (RC)");
  });

  // ── Environment ──────────────────────────────────────────────────────
  it("lists monitor count and display specs", async () => {
    const out = await collectDebugInfo(defaultOpts());
    expect(out).toContain("Monitors: 2");
    expect(out).toContain("Primary");
    expect(out).toContain("Secondary");
    expect(out).toContain("2560x1440");
    expect(out).toContain("1920x1080");
  });

  // ── Network (offline) ────────────────────────────────────────────────
  it("reports offline when all probes fail", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const out = await collectDebugInfo(defaultOpts());
    expect(out).toContain("Online: no");
  });

  // ── Network (online) ─────────────────────────────────────────────────
  it("reports online and latencies when probes succeed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    );
    const out = await collectDebugInfo(defaultOpts());
    expect(out).toContain("Online: yes");
    expect(out).toMatch(/GitHub API: \d+ms/);
    expect(out).toMatch(/TBH Helper API: \d+ms/);
    expect(out).toMatch(/Discord OAuth: \d+ms/);
  });

  it("marks unreachable endpoints when some succeed and some fail", async () => {
    let call = 0;
    vi.stubGlobal("fetch", () => {
      call++;
      if (call === 1) return Promise.resolve(new Response(null, { status: 200 }));
      return Promise.reject(new Error("down"));
    });
    const out = await collectDebugInfo(defaultOpts());
    // One endpoint succeeded → online
    expect(out).toContain("Online: yes");
    // The failed ones show unreachable
    expect(out).toContain("unreachable");
  });

  it("reports proxy from env vars", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy:8080");
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    // Reset modules so process.env is re-read
    vi.resetModules();
    const mod = await import("../debug-info.js");
    const out = await mod.collectDebugInfo(defaultOpts());
    expect(out).toContain("Proxy: http://proxy:8080");
  });

  // ── App State ────────────────────────────────────────────────────────
  it("reports reader, update, auth, splash state", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const out = await collectDebugInfo(
      defaultOpts({
        readerState: "scanning",
        updateState: { state: "downloading" },
        signedIn: false,
        splashActive: true,
      }),
    );
    expect(out).toContain("Reader status: scanning");
    expect(out).toContain("Update status: downloading");
    expect(out).toContain("Auth: signed out");
    expect(out).toContain("Splash: active");
  });

  it("shows live window bounds when created", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const out = await collectDebugInfo(defaultOpts());
    expect(out).toContain("Live window: x=100 y=200 w=320 h=96  visible  alwaysOnTop");
  });

  it("shows 'not created' when live window is null", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const out = await collectDebugInfo(
      defaultOpts({ getLiveBounds: () => null }),
    );
    expect(out).toContain("Live window: not created");
  });

  it("shows list window bounds when open, 'closed' when null", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const open = await collectDebugInfo(defaultOpts());
    expect(open).toContain("List window: x=400 y=300 w=800 h=600");

    const closed = await collectDebugInfo(
      defaultOpts({ getListBounds: () => null }),
    );
    expect(closed).toContain("List window: closed");
  });

  it("shows RC variant: yes when isRc=true in App State section", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const stable = await collectDebugInfo(defaultOpts({ isRc: false }));
    expect(stable).toMatch(/RC variant: no/);

    const rc = await collectDebugInfo(defaultOpts({ isRc: true }));
    expect(rc).toMatch(/RC variant: yes/);
  });

  // ── Reader — resolve_cache.json ──────────────────────────────────────
  it("reports resolve_cache.json present with metadata", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    seedCache(14, ["fp1", "fp2", "fp3"]);
    const out = await collectDebugInfo(defaultOpts());
    expect(out).toContain("resolve_cache.json: present");
    expect(out).toContain("fmt: 14");
    expect(out).toContain("fingerprints: 3");
    expect(out).toContain("latest fp: fp3");
  });

  it("reports resolve_cache.json absent when missing", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const out = await collectDebugInfo(defaultOpts());
    expect(out).toContain("resolve_cache.json: absent");
  });

  it("reports corrupt resolve_cache.json gracefully", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    touch("resolve_cache.json", "not json!!!");
    const out = await collectDebugInfo(defaultOpts());
    expect(out).toContain("parse: failed (corrupt?)");
  });

  // ── Reader — live.json ───────────────────────────────────────────────
  it("reports live.json present with age", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    touch("live.json", '{"hero": {}}');
    const out = await collectDebugInfo(defaultOpts());
    expect(out).toContain("live.json: present");
    expect(out).toMatch(/mtime \d+s ago/);
  });

  it("reports live.json absent when missing", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const out = await collectDebugInfo(defaultOpts());
    expect(out).toContain("live.json: absent");
  });

  // ── Reader — raw/ ────────────────────────────────────────────────────
  it("reports raw/ file count", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    mkdirSync(join(dir, "raw"));
    writeFileSync(join(dir, "raw", "1.json"), "{}");
    writeFileSync(join(dir, "raw", "2.json"), "{}");
    const out = await collectDebugInfo(defaultOpts());
    expect(out).toContain("raw/: 2 files");
  });

  it("reports raw/ absent when directory missing", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const out = await collectDebugInfo(defaultOpts());
    expect(out).toContain("raw/: absent or empty");
  });

  // ── Reader — runs.jsonl ──────────────────────────────────────────────
  it("reports runs.jsonl present when file exists", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    touch("runs.jsonl", '{"id":"a"}\n');
    const out = await collectDebugInfo(defaultOpts());
    expect(out).toContain("runs.jsonl: present");
  });

  // ── Settings ─────────────────────────────────────────────────────────
  it("includes only whitelisted settings keys", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const out = await collectDebugInfo(defaultOpts());
    // Whitelisted keys must appear
    expect(out).toContain("liveFontScale:");
    expect(out).toContain("alwaysOnTop:");
    expect(out).toContain("opacity:");
    expect(out).toContain("analyticsEnabled:");
    expect(out).toContain("Launch on startup:");
  });

  it("redacts outputDir when it contains a Windows user path", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const s = defaultSettings();
    const out = await collectDebugInfo(
      defaultOpts({
        settings: { ...s, outputDir: "C:\\Users\\john\\AppData\\Roaming\\tbh-meter\\meter" },
      }),
    );
    expect(out).toContain("C:\\Users\\<user>");
    expect(out).not.toContain("C:\\Users\\john");
  });

  // ── Log tails ────────────────────────────────────────────────────────
  it("appends log tails when log files exist", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const logLines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    touch("meter.log", logLines.join("\n"));
    const out = await collectDebugInfo(defaultOpts());
    expect(out).toContain("--- meter.log (last 50 lines) ---");
    // Only last 50 lines — "line 10" (10th) is excluded, "line 11" (11th) is first included
    expect(out).toMatch(/^line 11$/m);
    expect(out).not.toMatch(/^line 10$/m);
    // "line 1" must not appear as a standalone line (substring of "line 11" is fine)
    expect(out).not.toMatch(/^line 1$/m);
  });

  it("shows not found for missing log files", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const out = await collectDebugInfo(defaultOpts());
    expect(out).toContain("--- meter.log (not found) ---");
    expect(out).toContain("--- reader-diag.log (not found) ---");
    expect(out).toContain("--- updater.log (not found) ---");
  });

  it("redacts Windows user paths in log tails", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    touch("meter.log", '2025-01-01 Reader started from C:\\Users\\john\\Downloads\\tbh-meter\n');
    const out = await collectDebugInfo(defaultOpts());
    expect(out).toContain("C:\\Users\\<user>");
    expect(out).not.toContain("C:\\Users\\john");
  });

  // ── Security — no PII leakage ────────────────────────────────────────
  it("does NOT expose tokens, device-id, or raw run data in output", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    seedCache();
    // Inject sensitive-looking fields into the settings to prove they're NOT whitelisted
    const s = {
      ...defaultSettings(),
      accessToken: "sk-secret-token-12345",
      refreshToken: "rt-secret-67890",
      deviceId: "abc-device-uuid",
      discordId: "user-discord-id",
    } as Record<string, unknown>;
    const out = await collectDebugInfo(
      defaultOpts({ settings: s }),
    );
    // None of the non-whitelisted keys should appear
    expect(out).not.toContain("sk-secret-token");
    expect(out).not.toContain("rt-secret");
    expect(out).not.toContain("abc-device-uuid");
    expect(out).not.toContain("user-discord-id");
    expect(out).not.toContain("accessToken");
    expect(out).not.toContain("refreshToken");
    expect(out).not.toContain("deviceId");
    expect(out).not.toContain("discordId");
  });

  // ── Custom outputDir ─────────────────────────────────────────────────
  it("reads reader files from custom outputDir", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const customDir = mkdtempSync(join(tmpdir(), "tbh-custom-"));
    try {
      const cachePath = join(customDir, "resolve_cache.json");
      writeFileSync(cachePath, JSON.stringify({ fmt: 99, calib: {} }));
      const out = await collectDebugInfo(
        defaultOpts({ outputDir: customDir }),
      );
      expect(out).toContain("fmt: 99");
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  });

  // ── Edge: empty fingerprint list ─────────────────────────────────────
  it("handles resolve_cache with empty calib", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    touch("resolve_cache.json", JSON.stringify({ fmt: 10, calib: {} }));
    const out = await collectDebugInfo(defaultOpts());
    expect(out).toContain("fingerprints: 0");
    // Should NOT have "latest fp" when there are no fingerprints
    expect(out).not.toContain("latest fp:");
  });

  // ── Edge: missing fmt field in cache ─────────────────────────────────
  it("shows fmt: unknown when cache has no fmt field", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    touch("resolve_cache.json", JSON.stringify({ calib: { a: {} } }));
    const out = await collectDebugInfo(defaultOpts());
    expect(out).toContain("fmt: unknown");
  });

  // ── Edge: null liveBounds ────────────────────────────────────────────
  it("shows 'none' when settings.liveBounds is null", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const s = { ...defaultSettings(), liveBounds: null };
    const out = await collectDebugInfo(
      defaultOpts({ settings: s }),
    );
    expect(out).toContain("liveBounds: none");
  });

  // ── Edge: default outputDir message ──────────────────────────────────
  it("shows default message when settings.outputDir is null", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const s = { ...defaultSettings(), outputDir: null };
    const out = await collectDebugInfo(
      defaultOpts({ settings: s }),
    );
    expect(out).toContain("default (~/tbh-meter)");
  });
});

// ── formatUptime ───────────────────────────────────────────────────────────

describe("formatUptime (indirectly via output)", () => {
  it("formats uptime as HH:MM:SS", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const out = await collectDebugInfo(defaultOpts());
    // Uptime should match HH:MM:SS pattern
    expect(out).toMatch(/Uptime: \d{2}:\d{2}:\d{2}/);
  });
});

// ── redactPath ─────────────────────────────────────────────────────────────
// The function is not exported, so we test it indirectly through output.

describe("path redaction", () => {
  it("redacts C:\\Users\\<name> in outputDir setting", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const s = { ...defaultSettings(), outputDir: "C:\\Users\\Gone\\tbh-meter" };
    const out = await collectDebugInfo(defaultOpts({ settings: s }));
    expect(out).toContain("C:\\Users\\<user>");
    expect(out).not.toContain("C:\\Users\\Gone");
  });

  it("redacts user paths in log content", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    touch(
      "meter.log",
      [
        "[2025-06-27] Starting reader",
        "[2025-06-27] Output dir: C:\\Users\\Alice\\Documents\\meter",
        "[2025-06-27] Config loaded from %USERPROFILE%\\AppData\\Roaming",
      ].join("\n"),
    );
    const out = await collectDebugInfo(defaultOpts());
    expect(out).toContain("C:\\Users\\<user>");
    expect(out).not.toContain("C:\\Users\\Alice");
    // Documents and AppData subpaths are stripped
    expect(out).not.toMatch(/Documents\\meter/);
  });
});
