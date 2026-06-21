// Renderer data layer for the EXP "Leveling Planner": marshals the player's persisted runs
// (window.meter.listRuns / getRun) + the bundled datamine (game-data) into the plain shapes the pure
// planner-model consumes. STRICTLY separate from the scheduling — every traversal decision lives in
// planner-model.ts; this file owns ALL the XP/keep/multiplier MATH (measured-first) and builds the
// per-hero candidate closures. Mirrors stage-threat.ts's data conventions (string monster keys →
// Number(), monsterMap by numeric key).
//
// MEASURED-FIRST model (the rework):
//  • The reader persists, per hero per run, the REAL `xpGained`. That number already embeds the
//    player's rune+accessory EXP bonus, the account multiplier AND the keep penalty — so for stages
//    a hero has farmed we use the hero's OWN measured XP, no datamine, no bonus/account knobs.
//  • For un-farmed stages we project from the datamine base × the player's RECOVERED effective EXP
//    multiplier `muH` (≈ (1+bonus/100)·accountMult), recovered from that hero's farmed stages.
//  • The only confidence signal is per-candidate `source: "measured" | "estimated"` — no banners.
//
// Load-bearing corrections inherited from the design + adversarial review:
//  • RunRecord.stageKey is NOT reliably the datamine key — old records carry the datamine key
//    directly (fast path), new v2 records carry a game-internal id. Resolve robustly via a
//    (difficulty, act, stageNo) reverse index off the bundled StageRecords; a stage the bundled data
//    doesn't cover is SKIPPED explicitly, never mapped to a phantom key. (review fix #2)
import stagesData from "../../../shared/data/stages.json";
import monstersData from "../../../shared/data/monsters.json";
import { levelCurve } from "./game-data";
import { stageClearExp, expKeepFraction, type RewardExpOf, type StageExpInput } from "../../../shared/exp-model.js";
import {
  resolveClearTime,
  stageEnemyHp,
  calibratedClearTime,
  type StageClearStats,
  type StageHpInput,
  type MaxLifeOf,
  type ClimbCandidate,
  type ClearTimeResult,
  type CandidateSource,
} from "../../../shared/planner-model.js";
import type { RunIndexEntry } from "../../../shared/ipc-types.js";
import type { RunRecord } from "../../../shared/run-types.js";

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

export interface ClearTimeCfg {
  /** Trash-HP divisor for the T3 datamine estimate (AoE clears several mobs per swing). FITTED from
   *  the player's own clears at load (recoverAoeClearFactor); the const below is only the seed/fallback. */
  aoeClearFactor: number;
  /** Soft per-wave floor so an enormous DPS can't predict a 0s clear. */
  secondsPerWave: number;
  /** True once the factor was fitted from runs → the T3 path tags clears "estimated-calibrated". */
  aoeFitFromRuns: boolean;
}

// ── T3 clear-time config — SEED/FALLBACK only ──
// The AoE factor here is NOT used directly: at load we FIT it from the player's own clears
// (recoverAoeClearFactor) and feed that through buildStageBases. This const is the cold-start
// fallback (no farmed stage yet) and the source of secondsPerWave. We seed the fallback at 1.0
// (NOT the old hardcoded 3): the meter's measured DPS already counts AoE multi-hits, so the total
// damage to clear ≈ total enemy HP, i.e. clearTime ≈ EHP/DPS at factor ≈ 1. The old 3 triple-counted
// AoE, making un-farmed (estimated) stages ~3× too fast and wrongly outranking farmed (measured)
// ones; 1.0 is the unbiased prior until the player's clears refine it.
export const CLEAR_TIME_CFG: ClearTimeCfg = { aoeClearFactor: 1, secondsPerWave: 0.4, aoeFitFromRuns: false };

/** Clamp for the fitted AoE factor — keeps a pathological clear (a near-instant T2 or a stall) from
 *  producing an absurd factor that warps every T3 estimate. */
export const AOE_FACTOR_RANGE = { min: 0.5, max: 5 } as const;

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

// ── Measured per-(hero, stage) XP samples (the rework's core input) ───────────────────────────

/** One measured per-hero clear of a stage: the real per-hero run XP and the hero's level then. */
interface MeasuredSample {
  xpGained: number;
  level: number;
}

/** Aggregated measured XP for one (hero, stage): median per-clear XP and the rounded median level
 *  at which it was earned (the anchor level Lm). */
interface MeasuredXp {
  /** median(xpGained) over the hero's counted clears of this stage. > 0 (guarded by the builder). */
  measuredXpc: number;
  /** round(median(level_at_run)) — the level the measured XP is anchored at. */
  anchorLevel: number;
}

/**
 * Group counted-success runs into per-(stageKey, heroKey) measured XP samples. A run contributes a
 * sample only when its stage resolves to a bundled key AND the party entry for the hero carries a
 * positive `xpGained` (the per-hero run XP). Pure given the index.
 *
 * Returns: stageKey → (heroKey → samples[]). The candidate builder reduces samples to a MeasuredXp.
 */
export function collectMeasuredXp(
  index: ReadonlyArray<RunIndexEntry>,
): Map<number, Map<number, MeasuredSample[]>> {
  const byStage = new Map<number, Map<number, MeasuredSample[]>>();
  for (const e of index) {
    if (!isCalibrationRun(e)) continue;
    const key = resolveStageKeyFromIndex(e);
    if (key == null) continue;
    let byHero = byStage.get(key);
    if (!byHero) byStage.set(key, (byHero = new Map()));
    for (const p of e.party) {
      const xp = p.xpGained;
      if (typeof xp !== "number" || !Number.isFinite(xp) || xp <= 0) continue;
      if (!Number.isFinite(p.level) || p.level <= 0) continue;
      let samples = byHero.get(p.heroKey);
      if (!samples) byHero.set(p.heroKey, (samples = []));
      samples.push({ xpGained: xp, level: p.level });
    }
  }
  return byStage;
}

/** Reduce a hero's samples on a stage to a single MeasuredXp (median XP + rounded median level), or
 *  null when no usable positive sample exists. */
function reduceMeasured(samples: ReadonlyArray<MeasuredSample>): MeasuredXp | null {
  const xps = samples.map((s) => s.xpGained).filter((x) => x > 0);
  if (xps.length === 0) return null;
  const measuredXpc = median(xps);
  if (!(measuredXpc > 0)) return null;
  const anchorLevel = Math.round(median(samples.map((s) => s.level)));
  return { measuredXpc, anchorLevel };
}

// ── Build the climb candidates from bundled data + calibration + measured XP ──────────────────

/** Project a bundled `RawStage` into the plain shape the pure model consumes. The raw `levelScaling`
 *  / `bossMultipliers` carry BOTH the `hp` and `exp` scaling fields, so the result is structurally
 *  assignable to BOTH `StageHpInput` (clear-time) and `StageExpInput` (stageClearExp) — one helper,
 *  both call sites, identical behaviour. */
function toStageInput(s: RawStage): StageHpInput & StageExpInput {
  return {
    monsters: (s.monsters ?? []).map((m) => ({ monster: Number(m.monster), weight: m.weight })),
    levelScaling: s.levelScaling ?? null,
    waveAmount: s.waveAmount ?? null,
    waveMonsterAmount: s.waveMonsterAmount ?? null,
    bossMonsterKey: s.bossMonsterKey ?? null,
    bossMultipliers: s.bossMultipliers ?? null,
  };
}

/** A bundled, farmable stage with everything the per-hero candidate build needs precomputed once. */
interface StageBase {
  stageKey: number;
  stageLevel: number;
  /** stageClearExp(...) — the datamine base EXP per clear, BEFORE keep/bonus/account. > 0. */
  base: number;
  /** Clear-time resolved from the player's calibration (T2) or the datamine (T3). */
  clear: ClearTimeResult;
}

/**
 * Recover the AoE clear factor from the player's OWN farmed clears — the measured-first fix for the
 * T3 bias. Pure.
 *
 * Rationale: the meter's measured DPS already counts AoE multi-hits, so the total damage to clear a
 * stage ≈ the stage's total enemy HP, hence `clearTime ≈ EHP / DPS` with an AoE factor of ≈ 1. The
 * old hardcoded factor 3 triple-counted AoE and made un-farmed (estimated, T3) stages ~3× too fast,
 * wrongly outranking farmed (measured, T2) stages at the measured/estimated boundary. We instead
 * INVERT theoreticalClearTime on each farmed stage to back out the factor the player's clears imply:
 *   dpsTime          = max(calibratedClearTime(stats, dps) − waveFloor, ε)   // the HP-bound part
 *   impliedFactor    = stageEnemyHp(S, maxLifeOf, 1) / (dps · dpsTime)        // EHP@1 / (DPS·time)
 * then take the median over farmed stages, clamped to {@link AOE_FACTOR_RANGE}. Fallback 1.0 (NOT 3)
 * when no farmed stage has a resolvable EHP. `secondsPerWave` matches the cfg used downstream.
 */
export function recoverAoeClearFactor(
  calibration: ReadonlyMap<number, StageClearStats>,
  partyDpsNow: number,
  stageHpInputsByKey: ReadonlyMap<number, StageHpInput>,
  secondsPerWave: number,
): number {
  if (partyDpsNow <= 0) return 1.0;
  const implied: number[] = [];
  for (const [key, stats] of calibration) {
    const hp = stageHpInputsByKey.get(key);
    if (!hp) continue; // stage not in the bundled data → no datamine EHP to invert against
    const ehp1 = stageEnemyHp(hp, maxLifeOf, 1); // enemy-HP pool WITHOUT any AoE division
    if (!(ehp1 > 0)) continue;
    const waveFloor = (hp.waveAmount ?? 0) * secondsPerWave;
    const clearSec = calibratedClearTime(stats, partyDpsNow);
    if (!Number.isFinite(clearSec)) continue;
    // The HP-bound portion of the real clear (the wave floor is play-out time, not DPS-limited).
    const dpsTime = Math.max(clearSec - waveFloor, 1e-6);
    const factor = ehp1 / (partyDpsNow * dpsTime);
    if (Number.isFinite(factor) && factor > 0) implied.push(factor);
  }
  if (implied.length === 0) return 1.0;
  const fitted = median(implied);
  return Math.min(AOE_FACTOR_RANGE.max, Math.max(AOE_FACTOR_RANGE.min, fitted));
}

/** The set of bundled stages with a known level + positive base EXP, paired with their clear-time.
 *  Computed ONCE (shared across heroes); each hero's candidate set scales `base`+`keep` differently.
 *  `cfg` carries the FITTED AoE factor (recoverAoeClearFactor) so the T3 path is unbiased + tagged
 *  estimated-calibrated; callers that omit it get the seed/fallback {@link CLEAR_TIME_CFG}. */
export function buildStageBases(
  calibration: Map<number, StageClearStats>,
  partyDpsNow: number,
  cfg: ClearTimeCfg = CLEAR_TIME_CFG,
): StageBase[] {
  const out: StageBase[] = [];
  for (const s of RAW_STAGES) {
    if (typeof s.stageLevel !== "number") continue;
    const base = stageClearExp(toStageInput(s), rewardExpOf);
    if (!(base > 0)) continue; // guard: skip non-positive base (review: never a phantom rate)
    const clear = resolveClearTime(
      { stats: calibration.get(s.key) ?? null, hp: toStageInput(s) },
      partyDpsNow,
      maxLifeOf,
      cfg,
    );
    out.push({ stageKey: s.key, stageLevel: s.stageLevel, base, clear });
  }
  return out;
}

/**
 * Recover a hero's effective EXP multiplier `muH` ≈ (1+bonus_H/100)·accountMult, from the hero's
 * FARMED stages: `muH = median over farmed S' of [ measuredXpc(S') / (base(S') · keep_at_anchor(S')) ]`.
 * Each ratio strips the datamine base + the keep at the anchor level out of the measured XP, leaving
 * only the (bonus × account) scalar. Prefers OVER-level samples (anchorLevel ≥ stageLevel) when both
 * regimes exist (the keep there is the MEASURED curve; under-level keep is unvalidated). Fallback 1.0
 * when the hero has no farmed stage. Pure.
 */
export function recoverHeroMultiplier(
  heroKey: number,
  bases: ReadonlyArray<StageBase>,
  measuredByStage: ReadonlyMap<number, ReadonlyMap<number, MeasuredSample[]>>,
): number {
  const baseByKey = new Map(bases.map((b) => [b.stageKey, b]));
  const over: number[] = [];
  const all: number[] = [];
  for (const b of bases) {
    const samples = measuredByStage.get(b.stageKey)?.get(heroKey);
    if (!samples) continue;
    const m = reduceMeasured(samples);
    if (!m || !baseByKey.has(b.stageKey)) continue;
    const keep = expKeepFraction(m.anchorLevel, b.stageLevel);
    if (!(keep > 0) || !(b.base > 0)) continue;
    const ratio = m.measuredXpc / (b.base * keep);
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    all.push(ratio);
    if (m.anchorLevel >= b.stageLevel) over.push(ratio); // over-level: validated keep regime
  }
  const pool = over.length > 0 ? over : all;
  if (pool.length === 0) return 1.0; // fallback: no farmed stage
  return median(pool);
}

/**
 * Build ONE hero's full candidate set: every bundled stage, with a per-clear-XP closure that is
 * MEASURED for stages the hero has farmed and ESTIMATED (datamine × muH) elsewhere. Pure.
 *
 * For each stage S with `base=base(S)`, `keep(L)=expKeepFraction(L, S.stageLevel)`:
 *  - FARMED (≥1 sample): `measuredXpc = median(xpGained)`, `Lm = round(median(level))`,
 *      `expPerClearAtLevel(L) = measuredXpc · keep(L)/keep(Lm)` (≡ effBase·keep(L), effBase =
 *      measuredXpc/keep(Lm)). At L=Lm it reproduces the measured XP exactly; off-Lm it scales by the
 *      keep ratio. `source = "measured"`, clearTime = T2 (calibrated).
 *  - UNFARMED: `expPerClearAtLevel(L) = base · keep(L) · muH`. `source = "estimated"`, clearTime = T3.
 *  Guards: a farmed stage with `measuredXpc ≤ 0` or `keep(Lm) ≤ 0` falls back to ESTIMATED; the
 *  emitted closure is always finite & ≥ 0 (negative/NaN levels clamp keep to a finite value).
 */
export function buildHeroCandidates(
  heroKey: number,
  bases: ReadonlyArray<StageBase>,
  measuredByStage: ReadonlyMap<number, ReadonlyMap<number, MeasuredSample[]>>,
  muH: number,
): ClimbCandidate[] {
  const out: ClimbCandidate[] = [];
  for (const b of bases) {
    const stageLevel = b.stageLevel;
    const keepAt = (L: number): number => {
      const k = expKeepFraction(L, stageLevel);
      return Number.isFinite(k) && k > 0 ? k : 0;
    };

    const samples = measuredByStage.get(b.stageKey)?.get(heroKey);
    const measured = samples ? reduceMeasured(samples) : null;
    const keepAtAnchor = measured ? expKeepFraction(measured.anchorLevel, stageLevel) : 0;

    let expPerClearAtLevel: (heroLevel: number) => number;
    let source: CandidateSource;
    let clear: ClearTimeResult;

    if (measured && measured.measuredXpc > 0 && keepAtAnchor > 0) {
      // MEASURED: effBase = measuredXpc / keep(Lm); per-clear = effBase · keep(L).
      const effBase = measured.measuredXpc / keepAtAnchor;
      expPerClearAtLevel = (L) => {
        const v = effBase * keepAt(L);
        return Number.isFinite(v) && v > 0 ? v : 0;
      };
      source = "measured";
      clear = b.clear; // T2 from this stage's calibration (resolveClearTime already preferred it)
    } else {
      // ESTIMATED: datamine base × keep × the hero's recovered effective multiplier.
      const mul = Number.isFinite(muH) && muH > 0 ? muH : 1.0;
      expPerClearAtLevel = (L) => {
        const v = b.base * keepAt(L) * mul;
        return Number.isFinite(v) && v > 0 ? v : 0;
      };
      source = "estimated";
      clear = b.clear; // T3 (datamine) for an un-farmed stage; T2 if calibration happens to exist
    }

    out.push({
      stageKey: b.stageKey,
      stageLevel,
      expPerClearAtLevel,
      clearTimeAtLevel: () => clear,
      source,
    });
  }
  return out;
}

// ── Anchor team from the newest run ──────────────────────────────────────────────────────────

export interface AnchorHero {
  heroKey: number;
  class: string;
  level: number;
  /** Within-level EXP banked (RunHero.exp) — the first band's remainder. */
  expIntoLevel: number;
}

/** Project the newest run's heroes into the planner's anchor team (current levels + exp). */
export function anchorTeamFromRun(run: RunRecord | null): AnchorHero[] {
  if (!run) return [];
  return run.heroes.map((h) => ({
    heroKey: h.heroKey,
    class: h.class,
    level: h.level,
    expIntoLevel: typeof h.exp === "number" ? h.exp : 0,
  }));
}

// ── The everything-the-view-needs assembly (impure: reads IPC) ───────────────────────────────

export interface PlannerInputs {
  /** The anchor team (current levels/exp), newest run first. Empty on cold start. */
  team: AnchorHero[];
  /** Per-hero candidate sets (heroKey → that hero's farmable-stage candidates with measured-first
   *  XP). Same stage SET per hero; hero-specific `expPerClearAtLevel` + `source`. */
  candidatesByHero: Map<number, ClimbCandidate[]>;
  /** Median recent DPS used for the clear-time model (0 = cold start). */
  partyDpsNow: number;
  /** How many counted runs fed the calibration (for the context line + empty-state gate). */
  countedRuns: number;
  /** Distinct stages the calibration covered (for the context line). */
  calibratedStages: number;
  /** The bundled level curve. */
  curve: typeof levelCurve;
}

/** Load everything the planner view needs from IPC + bundled data. Impure (reads window.meter). */
export async function loadPlannerInputs(): Promise<PlannerInputs> {
  const index = await window.meter.listRuns();
  const counted = index.filter(isCalibrationRun);
  const anchorId = index[0]?.id;
  const anchorRun = anchorId ? await window.meter.getRun(anchorId) : null;

  const calibration = calibrateStages(index);
  const partyDpsNow = partyDpsFromIndex(index);

  // Fit the AoE clear factor from the player's OWN farmed clears (measured-first; removes the T3
  // bias) and feed it through, tagged estimated-calibrated. Only the farmed (calibrated) stages need
  // an HP input to invert against.
  const hpByKey = new Map<number, StageHpInput>();
  for (const key of calibration.keys()) {
    const s = stageByKey.get(key);
    if (s) hpByKey.set(key, toStageInput(s));
  }
  const aoeClearFactor = recoverAoeClearFactor(calibration, partyDpsNow, hpByKey, CLEAR_TIME_CFG.secondsPerWave);
  const cfg: ClearTimeCfg = {
    aoeClearFactor,
    secondsPerWave: CLEAR_TIME_CFG.secondsPerWave,
    // Fitted only when ≥1 farmed stage actually resolves to bundled HP (else it's the 1.0 fallback,
    // so the T3 path stays "estimated", not "estimated-calibrated").
    aoeFitFromRuns: hpByKey.size > 0 && partyDpsNow > 0,
  };

  const bases = buildStageBases(calibration, partyDpsNow, cfg);
  const measuredByStage = collectMeasuredXp(index);
  const team = anchorTeamFromRun(anchorRun);

  // One candidate set per anchor hero — measured XP is per-hero, so the candidates are too.
  const candidatesByHero = new Map<number, ClimbCandidate[]>();
  for (const h of team) {
    const muH = recoverHeroMultiplier(h.heroKey, bases, measuredByStage);
    candidatesByHero.set(h.heroKey, buildHeroCandidates(h.heroKey, bases, measuredByStage, muH));
  }

  return {
    team,
    candidatesByHero,
    partyDpsNow,
    countedRuns: counted.length,
    calibratedStages: calibration.size,
    curve: levelCurve,
  };
}
