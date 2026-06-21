// Renderer data layer for the EXP "Optimal Climb" planner: marshals the player's persisted runs
// (window.meter.listRuns / getRun) + the bundled datamine (game-data) into the plain shapes the pure
// planner-model consumes. STRICTLY separate from the math — every decision lives in planner-model.ts;
// this file only reads IPC + bundled JSON and builds resolvers/candidates. Mirrors stage-threat.ts's
// data conventions (string monster keys → Number(), monsterMap by numeric key).
//
// Load-bearing corrections inherited from the design + adversarial review:
//  • RunRecord.stageKey is NOT reliably the datamine key — old records carry the datamine key
//    directly (fast path), new v2 records carry a game-internal id. Resolve robustly via a
//    (difficulty, act, stageNo) reverse index off the bundled StageRecords; a stage the bundled data
//    doesn't cover is SKIPPED explicitly, never mapped to a phantom key. (review fix #2)
//  • Per-hero EXP bonus (RunHero.stats["47"]) is absent in 100% of real logs → default 0, and the
//    UI shows a GLOBAL "bonuses uncaptured" banner. (review fix #3)
//  • accountXpMultiplier is hard-pinned to 1.0 in v1 (not recoverable from logs). (review fix #4)
import stagesData from "../../../shared/data/stages.json";
import monstersData from "../../../shared/data/monsters.json";
import { levelCurve } from "./game-data";
import { stageClearExp, type RewardExpOf } from "../../../shared/exp-model.js";
import {
  resolveClearTime,
  type StageClearStats,
  type StageHpInput,
  type MaxLifeOf,
  type ClimbCandidate,
  type ClearTimeResult,
} from "../../../shared/planner-model.js";
import type { RunIndexEntry } from "../../../shared/ipc-types.js";
import type { RunRecord, RunHero } from "../../../shared/run-types.js";

// ── Bundled datamine shapes (the JSON has more fields than game-data's StageRecord subset) ──

interface RawStage {
  key: number;
  act: number;
  stageNo: number;
  difficulty?: string; // UPPERCASE: "NORMAL" | "NIGHTMARE" | "HELL" | "TORMENT"
  stageLevel?: number;
  waveAmount?: number | null;
  waveMonsterAmount?: number | null;
  monsters?: { monster: string; weight: number | null }[];
  bossMonsterKey?: number | null;
  bossMultipliers?: { hp?: number | null; exp?: number | null } | null;
  levelScaling?: { hp?: number | null; exp?: number | null } | null;
}
interface RawMonster {
  key: number;
  maxLife?: number;
  rewardExp?: number;
}

const RAW_STAGES = stagesData as RawStage[];
const RAW_MONSTERS = monstersData as RawMonster[];

const monsterLifeMap = new Map<number, number>();
const monsterExpMap = new Map<number, number>();
for (const m of RAW_MONSTERS) {
  if (typeof m.maxLife === "number") monsterLifeMap.set(m.key, m.maxLife);
  if (typeof m.rewardExp === "number") monsterExpMap.set(m.key, m.rewardExp);
}

const rewardExpOf: RewardExpOf = (k) => monsterExpMap.get(k);
const maxLifeOf: MaxLifeOf = (k) => monsterLifeMap.get(k);

// ── T3-floor calibration config (Ship 1 defaults; Ship 5 will fit aoeClearFactor from runs) ──
// The AoE factor is a rough datamine fit (review: AOE=3 is ~2× too fast for this build; fitted ≈1.31
// for stage 4309). We DON'T hardcode 1.35 (n=1 today) — keep the conservative datamine default and
// flag T3 as "estimated". secondsPerWave is a soft floor so a huge DPS can't predict a 0s clear.
export const CLEAR_TIME_CFG = { aoeClearFactor: 3, secondsPerWave: 0.4, aoeFitFromRuns: false } as const;

/** v1 account multiplier: hard-pinned 1.0 (review fix #4 — not recoverable from logs; cancels in
 *  ranking; only the absolute total would shift, and we qualify that in the UI). */
export const ACCOUNT_XP_MULTIPLIER = 1.0;

// ── Robust stage-key resolution (review fix #2) ──────────────────────────────────────────────

/** Reverse index: "DIFFICULTY|act|stageNo" → datamine key. Built from the bundled stages' OWN
 *  fields so it never fabricates a non-existent key. */
const reverseStageIndex = new Map<string, number>();
for (const s of RAW_STAGES) {
  if (s.difficulty == null) continue;
  reverseStageIndex.set(`${s.difficulty.toUpperCase()}|${s.act}|${s.stageNo}`, s.key);
}
const stageByKey = new Map<number, RawStage>(RAW_STAGES.map((s) => [s.key, s]));

/** Run `mode` (title-cased: "Torment") → stages.json `difficulty` (UPPERCASE: "TORMENT"). */
function modeToDifficulty(mode: string): string {
  return mode.toUpperCase();
}

/**
 * Resolve a run's stage to a bundled datamine key, or null if the bundled data doesn't cover it
 * (then the caller SKIPS the run — never maps to a phantom key). Pure; the heart of review fix #2.
 *
 *  (a) fast path — `stageKey` is already a direct datamine key (old-format records like 4309);
 *  (b) reverse index — `(mode→DIFFICULTY, act, stageNo)` → key (new v2 internal-id records);
 *  (c) neither matches (e.g. an Act-4/5 stage absent from the L1–L95 Act-1–3 bundle) → null.
 */
export function resolveStageKey(
  run: { stageKey: number | null; mode: string; act: number | null; stageNo: number | null },
): number | null {
  // (a) direct datamine-key hit
  if (run.stageKey != null && stageByKey.has(run.stageKey)) return run.stageKey;
  // (b) reconstruct from the run's own (difficulty, act, stageNo)
  if (run.act != null && run.stageNo != null) {
    const key = reverseStageIndex.get(`${modeToDifficulty(run.mode)}|${run.act}|${run.stageNo}`);
    if (key != null) return key;
  }
  // (c) unknown to the bundled data
  return null;
}

/** Same resolution, but for a `RunIndexEntry` — whose `stage` is "act-stageNo" and which carries no
 *  raw `stageKey`/`act`. Parses the compact code, then runs reverse-index resolution. */
export function resolveStageKeyFromIndex(entry: {
  stage: string;
  stageNo: number | null;
  mode: string;
}): number | null {
  const parts = entry.stage.split("-");
  const act = Number(parts[0]);
  const stageNo = entry.stageNo ?? Number(parts[1]);
  if (!Number.isFinite(act) || !Number.isFinite(stageNo)) return null;
  const key = reverseStageIndex.get(`${modeToDifficulty(entry.mode)}|${act}|${stageNo}`);
  return key ?? null;
}

// ── Per-stage clear-time calibration off the run INDEX (no N+1 — A§0.1) ──────────────────────

/** A run good enough to calibrate a stage: counted (or legacy unmarked), a real clear, positive
 *  clearTime + dps. Mirrors the runs list's "counted" notion (quality may be absent on legacy logs). */
function isCalibrationRun(e: RunIndexEntry): boolean {
  if (e.quality != null && e.quality !== "counted") return false;
  if (e.status !== "success") return false;
  return e.clearTime > 0 && e.dps > 0;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Group the run index into per-datamine-key clear-time calibration stats. Pure given the index.
 * Runs whose stage isn't in the bundled data are SKIPPED (review fix #2 — never phantom-mapped).
 */
export function calibrateStages(index: ReadonlyArray<RunIndexEntry>): Map<number, StageClearStats> {
  const byKey = new Map<number, { clears: number[]; dps: number[] }>();
  for (const e of index) {
    if (!isCalibrationRun(e)) continue;
    const key = resolveStageKeyFromIndex(e);
    if (key == null) continue; // bundled data doesn't cover this stage → skip explicitly
    let g = byKey.get(key);
    if (!g) byKey.set(key, (g = { clears: [], dps: [] }));
    g.clears.push(e.clearTime);
    g.dps.push(e.dps);
  }
  const stats = new Map<number, StageClearStats>();
  for (const [key, g] of byKey) {
    stats.set(key, {
      minClearS: Math.min(...g.clears),
      medianClearS: median(g.clears),
      medianDps: median(g.dps),
      sampleCount: g.clears.length,
    });
  }
  return stats;
}

/** Median measured DPS across the recent counted runs — the planner's "current party strength"
 *  (off-stage; C§3). Returns 0 when no usable run exists (caller treats as cold start). */
export function partyDpsFromIndex(index: ReadonlyArray<RunIndexEntry>, recentN = 10): number {
  const dps = index.filter(isCalibrationRun).slice(0, recentN).map((e) => e.dps);
  return dps.length ? median(dps) : 0;
}

// ── Build the climb candidates from bundled data + calibration ──────────────────────────────

function toHpInput(s: RawStage): StageHpInput {
  return {
    monsters: (s.monsters ?? []).map((m) => ({ monster: Number(m.monster), weight: m.weight })),
    levelScaling: s.levelScaling ?? null,
    waveAmount: s.waveAmount ?? null,
    waveMonsterAmount: s.waveMonsterAmount ?? null,
    bossMonsterKey: s.bossMonsterKey ?? null,
    bossMultipliers: s.bossMultipliers ?? null,
  };
}

function toExpInput(s: RawStage) {
  return {
    monsters: (s.monsters ?? []).map((m) => ({ monster: Number(m.monster), weight: m.weight })),
    levelScaling: s.levelScaling ?? null,
    waveAmount: s.waveAmount ?? null,
    waveMonsterAmount: s.waveMonsterAmount ?? null,
    bossMonsterKey: s.bossMonsterKey ?? null,
    bossMultipliers: s.bossMultipliers ?? null,
  };
}

export interface PlannerCandidate extends ClimbCandidate {
  /** Echoed for the FarmRank-style single-level view + display joins. */
  clearOnce: ClearTimeResult;
}

/**
 * Build the full candidate set the climb may pick from: every bundled stage with a known stageLevel,
 * its modeled XP-per-clear, and a (constant, v1) clear-time resolved from the player's calibration or
 * the datamine. Pure given the calibration map + partyDpsNow.
 */
export function buildCandidates(
  calibration: Map<number, StageClearStats>,
  partyDpsNow: number,
): PlannerCandidate[] {
  const out: PlannerCandidate[] = [];
  for (const s of RAW_STAGES) {
    if (typeof s.stageLevel !== "number") continue;
    const stageLevel = s.stageLevel;
    const expPerClear = stageClearExp(toExpInput(s), rewardExpOf);
    if (expPerClear <= 0) continue;
    const clear = resolveClearTime(
      { stats: calibration.get(s.key) ?? null, hp: toHpInput(s) },
      partyDpsNow,
      maxLifeOf,
      CLEAR_TIME_CFG,
    );
    // v1: constant clear-time at every level (the closure ignores heroLevel — DPS-growth is a
    // future drop-in per planner-model's ClimbCandidate contract).
    out.push({
      stageKey: s.key,
      stageLevel,
      expPerClear,
      clearTimeAtLevel: () => clear,
      clearOnce: clear,
    });
  }
  return out;
}

// ── Anchor team from the newest run ──────────────────────────────────────────────────────────

/** Per-hero EXP bonus from the FINAL stat 47 (IncreaseExpAmount), or 0 when absent (review fix #3 —
 *  absent in 100% of real logs today). The value is a percent (e.g. 8.7 → +8.7%). */
export function heroBonusPct(hero: RunHero): number {
  const v = hero.stats?.["47"];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export interface AnchorHero {
  heroKey: number;
  class: string;
  level: number;
  /** Within-level EXP banked (RunHero.exp) — the first band's remainder. */
  expIntoLevel: number;
  bonusPct: number;
  /** True when this hero lacks stat 47 (drives the global "bonuses uncaptured" banner). */
  bonusMissing: boolean;
}

/** Project the newest run's heroes into the planner's anchor team (current levels + exp + bonus). */
export function anchorTeamFromRun(run: RunRecord | null): AnchorHero[] {
  if (!run) return [];
  return run.heroes.map((h) => {
    const bonus = heroBonusPct(h);
    return {
      heroKey: h.heroKey,
      class: h.class,
      level: h.level,
      expIntoLevel: typeof h.exp === "number" ? h.exp : 0,
      bonusPct: bonus,
      bonusMissing: h.stats?.["47"] == null,
    };
  });
}

// ── The everything-the-view-needs assembly (impure: reads IPC) ───────────────────────────────

export interface PlannerInputs {
  /** The anchor team (current levels/exp/bonus), newest run first. Empty on cold start. */
  team: AnchorHero[];
  /** All farmable stage candidates with modeled XP + clear-time. */
  candidates: PlannerCandidate[];
  /** Median recent DPS used for the modeled rates (0 = cold start). */
  partyDpsNow: number;
  /** How many counted runs fed the calibration (for the context line + empty-state gate). */
  countedRuns: number;
  /** Distinct stages the calibration covered (for the context line). */
  calibratedStages: number;
  /** True when ANY anchor hero lacks the EXP-bonus stat (global banner). */
  anyBonusMissing: boolean;
  /** The bundled level curve. */
  curve: typeof levelCurve;
  accountXpMultiplier: number;
}

/** Load everything the planner view needs from IPC + bundled data. Impure (reads window.meter). */
export async function loadPlannerInputs(): Promise<PlannerInputs> {
  const index = await window.meter.listRuns();
  const counted = index.filter(isCalibrationRun);
  const anchorId = index[0]?.id;
  const anchorRun = anchorId ? await window.meter.getRun(anchorId) : null;

  const calibration = calibrateStages(index);
  const partyDpsNow = partyDpsFromIndex(index);
  const candidates = buildCandidates(calibration, partyDpsNow);
  const team = anchorTeamFromRun(anchorRun);

  return {
    team,
    candidates,
    partyDpsNow,
    countedRuns: counted.length,
    calibratedStages: calibration.size,
    anyBonusMissing: team.some((h) => h.bonusMissing),
    curve: levelCurve,
    accountXpMultiplier: ACCOUNT_XP_MULTIPLIER,
  };
}
