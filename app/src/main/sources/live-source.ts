import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LiveSnapshot } from "../../shared/run-types.js";
import type { RawLive } from "../../shared/live-types.js";
import { computeDps, modeName, resolveStage, round } from "../converter/helpers.js";

const POLL_INTERVAL_MS = 700;
// The reader rewrites live.json every ~1s while a run is active. If it has not been touched in this
// long, the meter is OFFLINE / between runs -> emit null.
const STALE_AFTER_MS = 5_000;

/** COOK a raw live snapshot into the overlay's LiveSnapshot. The reader emits raw numbers/ids
 *  (`live.json`); the app derives the SAME way a finished run does — `dps` via `computeDps` (the
 *  identical formula the converter uses, with `clearTime=0` so the reference is the live `elapsed`),
 *  the stage label via `resolveStage`, the mode name via `modeName`. One formula, no Python↔TS drift
 *  (progress.md "Live-meter" / "helper compartilhado"). `goldGain`/`xpGain` stay RAW gains (the
 *  overlay computes its own per-second rate); `approx` is always true (a live snapshot is mid-run).
 *  Pure: a RawLive in, a LiveSnapshot out — no I/O. */
export function cookLive(raw: RawLive): LiveSnapshot {
  const elapsed = typeof raw.elapsed === "number" && Number.isFinite(raw.elapsed) ? raw.elapsed : 0;
  const damage =
    typeof raw.damage_now === "number" && Number.isFinite(raw.damage_now) ? raw.damage_now : 0;
  const party = Array.isArray(raw.party)
    ? raw.party.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
    : null;
  const drops = Array.isArray(raw.drops)
    ? raw.drops.map((n) => (typeof n === "number" && Number.isFinite(n) ? n : 0))
    : null;
  // Per-hero FINAL_STATS: reader sends `{heroKey: {statId: value}}` with JSON-string keys.
  // Re-key to numbers for the renderer; keep only finite numeric stat values. `undefined`
  // (older reader, no field) → null, so the resistance tooltip degrades cleanly.
  const partyStats = cookPartyStats(raw.party_stats);
  return {
    runNumber: typeof raw.run === "number" && Number.isFinite(raw.run) ? raw.run : null,
    // SAME derivation the run record uses (converter/helpers): label from act-stageNo, localized
    // mode name from the difficulty enum. "?" when a piece is missing, so the overlay never shows null.
    stage: resolveStage(raw.act ?? null, raw.stageNo ?? null),
    mode: modeName(raw.difficulty ?? null),
    stageKey: typeof raw.stageKey === "number" && Number.isFinite(raw.stageKey) ? raw.stageKey : null,
    mobs: typeof raw.mobs === "number" && Number.isFinite(raw.mobs) ? raw.mobs : 0,
    totalMobs:
      typeof raw.total_mobs === "number" && Number.isFinite(raw.total_mobs) ? raw.total_mobs : null,
    elapsedSec: elapsed,
    damage,
    // dps = damage / elapsed via the SHARED helper (clearTime 0 -> reference is the live elapsed,
    // floored at 1s). Identical to the finished record's dps when fed the same numbers.
    dps: round(computeDps(damage, 0, elapsed)),
    // gold/xp gained so far — RAW gains (null = unresolved this tick, the overlay omits the line).
    goldGain: typeof raw.gold_now === "number" && Number.isFinite(raw.gold_now) ? raw.gold_now : null,
    xpGain: typeof raw.xp_now === "number" && Number.isFinite(raw.xp_now) ? raw.xp_now : null,
    party: party && party.length > 0 ? party : null,
    drops,
    partyStats,
    approx: true,
  };
}

/** Re-key the reader's `{ "201": { "52": 27 } }` (JSON-string keys) to numeric `{201:{52:27}}`,
 *  dropping non-finite values. Returns null for a missing/empty/invalid map so the renderer can
 *  treat "no per-hero stats" uniformly (older reader, or no live party). Pure, never throws. */
function cookPartyStats(
  raw: RawLive["party_stats"],
): Record<number, Record<number, number>> | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Record<number, Record<number, number>> = {};
  for (const [heroKey, stats] of Object.entries(raw)) {
    const hk = Number(heroKey);
    if (!Number.isFinite(hk) || !stats || typeof stats !== "object") continue;
    const cooked: Record<number, number> = {};
    for (const [statId, value] of Object.entries(stats)) {
      const sid = Number(statId);
      if (Number.isFinite(sid) && typeof value === "number" && Number.isFinite(value)) {
        cooked[sid] = value;
      }
    }
    if (Object.keys(cooked).length > 0) out[hk] = cooked;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Parse the reader's `live.json` text and COOK it into a LiveSnapshot. Null when the text is not
 *  valid JSON or not a live record (e.g. an empty/half-written file the atomic rename hasn't landed,
 *  or a totally unexpected shape) — the caller degrades that to OFFLINE. */
export function parseLiveJson(text: string): LiveSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<RawLive>;
  // A live record always carries the run sequence + a numeric elapsed; their absence means this is
  // not a live.json (defensive — never cook garbage into a snapshot).
  if (typeof r.run !== "number" || typeof r.elapsed !== "number") return null;
  return cookLive(r as RawLive);
}

// --------------------------------------------------------------------------- //
// LiveSource — poll <outputDir>/live.json, emit LiveSnapshot | null.
// --------------------------------------------------------------------------- //

export class LiveSource extends EventEmitter {
  private dir: string | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private started = false;
  // last emitted state, so we only re-emit on change or liveness flip.
  private lastWasNull = true;
  private lastSerialized = "";
  private emittedOnce = false;
  // Liveness via change-detection (SMB clock-skew immune): the file's last observed
  // mtime, and the LOCAL wall-clock time at which we last saw mtime advance.
  private lastMtimeMs = -1;
  private lastChangeWall = 0;

  private filePath(): string | null {
    return this.dir ? join(this.dir, "live.json") : null;
  }

  setDir(dir: string | null): void {
    if (dir === this.dir) return;
    this.dir = dir;
    if (this.started) {
      // force a fresh emit on the next tick
      this.lastSerialized = "";
      this.emittedOnce = false;
      this.lastMtimeMs = -1;
      this.lastChangeWall = 0;
      this.tick();
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.poll = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    this.tick();
  }

  stop(): void {
    this.started = false;
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
    this.lastWasNull = true;
    this.lastSerialized = "";
    this.emittedOnce = false;
    this.lastMtimeMs = -1;
    this.lastChangeWall = 0;
  }

  private emitNull(): void {
    if (this.emittedOnce && this.lastWasNull) return;
    this.lastWasNull = true;
    this.lastSerialized = "";
    this.emittedOnce = true;
    this.emit("live", null);
  }

  private emitSnap(snap: LiveSnapshot): void {
    const serialized = JSON.stringify(snap);
    if (this.emittedOnce && !this.lastWasNull && serialized === this.lastSerialized) return;
    this.lastWasNull = false;
    this.lastSerialized = serialized;
    this.emittedOnce = true;
    this.emit("live", snap);
  }

  /** One poll cycle. Never throws — any error degrades to OFFLINE (null). */
  private tick(): void {
    const path = this.filePath();
    if (!path) {
      this.emitNull();
      return;
    }
    try {
      if (!existsSync(path)) {
        this.emitNull();
        return;
      }
      // Liveness via CHANGE-DETECTION, never wall-clock-vs-mtime: an SMB share
      // reports mtime on the writer's (Windows) clock, which can be seconds off
      // from ours (observed ~+23s in the future). So we only watch whether mtime
      // ADVANCES and measure staleness with our own monotonic clock. The first
      // sighting does NOT count as live (could be a frozen leftover) — we wait for
      // one observed advance, which a running meter (~1s rewrite) yields within a
      // tick or two; a stopped meter never advances and stays offline.
      const m = statSync(path).mtimeMs;
      if (this.lastMtimeMs >= 0 && m !== this.lastMtimeMs) {
        this.lastChangeWall = Date.now();
      }
      this.lastMtimeMs = m;
      const isLive =
        this.lastChangeWall > 0 && Date.now() - this.lastChangeWall <= STALE_AFTER_MS;
      if (!isLive) {
        this.emitNull();
        return;
      }
      const text = readFileSync(path, "utf-8");
      const snap = parseLiveJson(text);
      if (!snap) {
        this.emitNull();
        return;
      }
      this.emitSnap(snap);
    } catch {
      // missing/again-appearing file, transient read error -> treat as offline
      this.emitNull();
    }
  }
}

let singleton: LiveSource | null = null;

export function getLiveSource(): LiveSource {
  if (!singleton) singleton = new LiveSource();
  return singleton;
}
