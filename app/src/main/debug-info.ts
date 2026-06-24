// debug-info.ts — collects diagnostic data for bug reports. Pure async
// function with zero static dependencies on index.ts internals. All state
// is read from OS APIs, the filesystem, or the opts parameter passed by
// the caller (index.ts). Returns a plaintext block safe to paste in
// GitHub Issues or Discord. No PII, no tokens, no raw run data.
import { app, screen } from "electron";
import { platform, release } from "node:os";
import { statSync, readFileSync, readdirSync } from "node:fs";
import { join } from "path";
import type { AppSettings } from "../shared/ipc-types.js";

export interface DebugInfoOpts {
  /** The live window bounds + visibility (null = not created yet). */
  getLiveBounds: () => { x: number; y: number; width: number; height: number } | null;
  /** Whether the live window is visible. */
  isLiveVisible: () => boolean;
  /** Whether the live window is always-on-top. */
  isLiveAlwaysOnTop: () => boolean;
  /** The list window bounds (null = closed). */
  getListBounds: () => { x: number; y: number; width: number; height: number } | null;
  /** Whether the startup splash is still active. */
  splashActive: boolean;
  /** The reader state (searching/resolving/scanning/ready/blocked/crashed/offline). */
  readerState: string;
  /** The auto-updater state payload. */
  updateState: { state: string };
  /** Whether the user is signed in (no token — just the boolean). */
  signedIn: boolean;
  /** The full AppSettings object (sanitized on output — only whitelisted keys). */
  settings: AppSettings;
  /** The output directory (resolved, not the raw setting). */
  outputDir: string;
  /** Whether this is the RC variant. */
  isRc: boolean;
}

export async function collectDebugInfo(opts: DebugInfoOpts): Promise<string> {
  const lines: string[] = [];
  const w = (k: string, v: unknown) => lines.push(`${k}: ${String(v)}`);
  const section = (title: string) => lines.push(`\n--- ${title} ---`);

  // ── Header ────────────────────────────────────────────────────────────
  lines.push("TBH Meter Debug Info");
  lines.push(new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC");
  w("App", `${app.getVersion()} (${opts.isRc ? "RC" : "stable"})`);
  w("Windows", `${platform()} ${release()}`);
  w("Electron", `${process.versions.electron}  Chromium: ${process.versions.chrome}`);

  // ── Environment ───────────────────────────────────────────────────────
  section("Environment");
  const displays = screen.getAllDisplays();
  w("Monitors", displays.length);
  for (const d of displays) {
    const primary = d.id === screen.getPrimaryDisplay().id ? "Primary" : "Secondary";
    w(`  ${primary}`, `${d.size.width}x${d.size.height} @ ${d.displayFrequency}Hz  ` +
       `scaleFactor: ${d.scaleFactor} (${Math.round(d.scaleFactor * 100)}%)  ` +
       `workArea: ${d.workAreaSize.width}x${d.workAreaSize.height}`);
  }

  // ── Network ───────────────────────────────────────────────────────────
  section("Network");
  const net = await checkNetwork();
  w("Online", net.online ? "yes" : "no");
  if (net.online) {
    w("  GitHub API",    net.github    >= 0 ? `${net.github}ms`    : "unreachable");
    w("  TBH Helper API", net.tbhHelper  >= 0 ? `${net.tbhHelper}ms`  : "unreachable");
    w("  Discord OAuth",  net.discord    >= 0 ? `${net.discord}ms`    : "unreachable");
  }
  w("  Proxy", net.proxy || "none");

  // ── App State ─────────────────────────────────────────────────────────
  section("App State");
  w("RC variant", opts.isRc ? "yes" : "no");
  w("Uptime", formatUptime(process.uptime()));
  w("Reader status", opts.readerState);
  w("Update status", opts.updateState.state);
  w("Auth", opts.signedIn ? "signed in" : "signed out");

  const lb = opts.getLiveBounds();
  if (lb) {
    w("Live window", `x=${lb.x} y=${lb.y} w=${lb.width} h=${lb.height}  ` +
      `${opts.isLiveVisible() ? "visible" : "hidden"}  ` +
      `${opts.isLiveAlwaysOnTop() ? "alwaysOnTop" : "normal"}`);
  } else {
    w("Live window", "not created");
  }

  const list = opts.getListBounds();
  if (list) {
    w("List window", `x=${list.x} y=${list.y} w=${list.width} h=${list.height}`);
  } else {
    w("List window", "closed");
  }

  w("Splash", opts.splashActive ? "active" : "dismissed");

  // ── Reader ────────────────────────────────────────────────────────────
  section("Reader");

  // resolve_cache.json metadata (NOT content)
  const cachePath = join(opts.outputDir, "resolve_cache.json");
  try {
    const st = statSync(cachePath);
    w("resolve_cache.json", `present  ${(st.size / 1024).toFixed(1)} KB`);
    try {
      const raw = JSON.parse(readFileSync(cachePath, "utf-8"));
      const fps = Object.keys(raw.calib || {});
      w("  fmt", raw.fmt ?? "unknown");
      w("  fingerprints", fps.length);
      if (fps.length > 0) w("  latest fp", fps[fps.length - 1]);
    } catch {
      w("  parse", "failed (corrupt?)");
    }
  } catch {
    w("resolve_cache.json", "absent");
  }

  // live.json
  try {
    const livePath = join(opts.outputDir, "live.json");
    const st = statSync(livePath);
    const age = Math.round((Date.now() - st.mtimeMs) / 1000);
    w("live.json", `present  ${(st.size / 1024).toFixed(1)} KB  mtime ${age}s ago`);
  } catch {
    w("live.json", "absent");
  }

  // raw/ file count
  try {
    const files = readdirSync(join(opts.outputDir, "raw"));
    w("raw/", `${files.length} files`);
  } catch {
    w("raw/", "absent or empty");
  }

  // runs.jsonl (legacy)
  try {
    const st = statSync(join(opts.outputDir, "runs.jsonl"));
    w("runs.jsonl", `present  ${(st.size / 1024).toFixed(1)} KB (legacy)`);
  } catch {
    w("runs.jsonl", "absent");
  }

  // ── Settings (whitelisted — no tokens, no device-id) ──────────────────
  section("Settings");
  const s = opts.settings;
  w("liveFontScale", s.liveFontScale);
  w("liveExpanded", s.liveExpanded);
  w("alwaysOnTop", s.alwaysOnTop);
  w("liveBounds", s.liveBounds ? JSON.stringify(s.liveBounds) : "none");
  w("outputDir", s.outputDir || "default (~/tbh-meter)");
  w("RC variant", opts.isRc ? "yes" : "no");
  w("Launch on startup", s.launchOnStartup ?? false);
  w("opacity", s.opacity);
  w("analyticsEnabled", s.analyticsEnabled);

  // ── Log tails ─────────────────────────────────────────────────────────
  await appendLogTail(lines, join(opts.outputDir, "meter.log"), "meter.log", 50);
  await appendLogTail(lines, join(opts.outputDir, "reader-diag.log"), "reader-diag.log", 50);
  await appendLogTail(lines, join(opts.outputDir, "updater.log"), "updater.log", 50);

  return lines.join("\n");
}

// ── Helpers ──────────────────────────────────────────────────────────────

interface NetworkReport {
  online: boolean;
  github: number;
  tbhHelper: number;
  discord: number;
  proxy: string | null;
}

async function checkNetwork(): Promise<NetworkReport> {
  const probe = async (url: string): Promise<number> => {
    const t0 = Date.now();
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 3000);
      await fetch(url, { method: "HEAD", signal: ctrl.signal });
      return Date.now() - t0;
    } catch {
      return -1;
    }
  };

  const [github, tbhHelper, discord] = await Promise.all([
    probe("https://api.github.com"),
    probe("https://api.tbherohelper.com"),
    probe("https://discord.com"),
  ]);

  return {
    online: github >= 0 || tbhHelper >= 0 || discord >= 0,
    github,
    tbhHelper,
    discord,
    proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null,
  };
}

async function appendLogTail(
  lines: string[],
  path: string,
  label: string,
  maxLines: number,
): Promise<void> {
  try {
    const text = readFileSync(path, "utf-8");
    const all = text.split("\n").filter(Boolean);
    const tail = all.slice(-maxLines);
    lines.push(`\n--- ${label} (last ${tail.length} lines) ---`);
    for (const line of tail) lines.push(line);
  } catch {
    lines.push(`\n--- ${label} (not found) ---`);
  }
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
