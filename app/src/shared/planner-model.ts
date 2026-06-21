// Pure functions for the off-stage EXP "Optimal Climb" planner. No IO, no data imports — callers
// inject resolvers (RewardExpOf / MaxLifeOf, from exp-model.ts and here) and plain shapes, mirroring
// exp-model.ts's no-deps contract. Model + proofs: scratchpad/pl_{design,algorithm,review}.md and
// docs/exp-leveling-model.md. The XP numerator, keep penalty, level curve and per-level rate are
// REUSED from exp-model.ts — this module adds only clear-time (Investigation A), stage ranking, and
// the climb traversal + band collapse (Investigation C).
import {
  expToNextLevel,
  modeledExpPerSecond,
  type LevelCurve,
} from "./exp-model.js";

// ─────────────────────────── CLEAR-TIME (Investigation A) ───────────────────────────

/** One stage's clear-time calibration from the player's OWN counted runs (A§1, the T2 input). */
export interface StageClearStats {
  /** Fastest real clear — the DPS-independent schedule floor (a stronger party can't beat a clear it
   *  never actually achieved). */
  minClearS: number;
  /** Median real clear time (seconds). */
  medianClearS: number;
  /** Median measured DPS of those runs — the ratio's twin (cancels the build's skill bias, A§1). */
  medianDps: number;
  /** n, for the confidence badge (A§3). */
  sampleCount: number;
}

/**
 * T2 — self-calibrated clear-time from the player's own runs (A§1). Pure.
 * `= max( minClearS + max(0, medianClearS − minClearS) · (medianDps / partyDpsNow), minClearS )`.
 * The ratio rescales the median by how the current party's DPS compares to the runs' DPS; the floor
 * keeps a stronger party from being credited a clear faster than any it has ever achieved.
 * `partyDpsNow ≤ 0` → Infinity (no income).
 */
export function calibratedClearTime(stats: StageClearStats, partyDpsNow: number): number {
  if (partyDpsNow <= 0) return Infinity;
  const variable = Math.max(0, stats.medianClearS - stats.minClearS);
  const scaled = stats.minClearS + variable * (stats.medianDps / partyDpsNow);
  return Math.max(scaled, stats.minClearS);
}

/** Minimal stage HP shape for T3 (subset of stages.json; sibling of {@link StageExpInput}). */
export interface StageHpInput {
  /** Spawn table; monster keys are numbers here (the caller converts the JSON's string keys). */
  monsters: ReadonlyArray<{ monster: number; weight: number | null }>;
  levelScaling?: { hp?: number | null } | null;
  waveAmount: number | null;
  waveMonsterAmount: number | null;
  bossMonsterKey: number | null;
  bossMultipliers?: { hp?: number | null } | null;
}

/** Resolve a monster key to its level-1 base maxLife (data/json/monsters.json), or undefined. */
export type MaxLifeOf = (monsterKey: number) => number | undefined;

const permille = (v: number | null | undefined): number => (v == null ? 1000 : v) / 1000;

/**
 * Datamine effective enemy HP for a stage: spawn-weighted trash HP (÷ aoeClearFactor, since AoE
 * clears several trash mobs at once) + boss single-target HP. Pure. (A§2)
 *
 * Symmetric with {@link stageClearExp} — same spawn-weighting, same per-mille level scaling, same
 * kill count. `aoeClearFactor` divides TRASH only, never the boss. A boss-only stage (waveAmount
 * null/0) contributes 0 trash. Ground truth (stage 4309, L95): trash ≈ 20.30M, boss ≈ 598k.
 */
export function stageEnemyHp(
  stage: StageHpInput,
  maxLifeOf: MaxLifeOf,
  aoeClearFactor: number,
): number {
  const hpMult = permille(stage.levelScaling?.hp);
  const mons = stage.monsters ?? [];
  const totalWeight = mons.reduce((acc, m) => acc + (m.weight ?? 0), 0);
  let avgLifePerKill = 0;
  if (totalWeight > 0) {
    for (const m of mons) {
      const life = maxLifeOf(m.monster);
      if (life == null) continue;
      avgLifePerKill += life * hpMult * ((m.weight ?? 0) / totalWeight);
    }
  }
  const kills = (stage.waveAmount ?? 0) * (stage.waveMonsterAmount ?? 1);
  // AoE clears several trash at once, so effective time-to-clear HP is the trash pool / factor.
  const divisor = aoeClearFactor > 0 ? aoeClearFactor : 1;
  let total = (avgLifePerKill * kills) / divisor;
  if (stage.bossMonsterKey != null) {
    const bossLife = maxLifeOf(stage.bossMonsterKey);
    if (bossLife != null) total += bossLife * hpMult * permille(stage.bossMultipliers?.hp);
  }
  return total;
}

/**
 * T3 — theoretical clear-time = datamine effective enemy HP ÷ measured party DPS, floored by the
 * minimum time to play out every wave. Pure. (A§2) The LEAST-accurate tier (the AoE factor is a
 * rough fit — see the "estimated" badge). `partyDpsNow ≤ 0` → Infinity.
 */
export function theoreticalClearTime(
  stage: StageHpInput,
  maxLifeOf: MaxLifeOf,
  partyDpsNow: number,
  cfg: { aoeClearFactor: number; secondsPerWave: number },
): number {
  if (partyDpsNow <= 0) return Infinity;
  const dpsTime = stageEnemyHp(stage, maxLifeOf, cfg.aoeClearFactor) / partyDpsNow;
  const waveFloor = (stage.waveAmount ?? 0) * cfg.secondsPerWave;
  return Math.max(dpsTime, waveFloor);
}

export type ClearTimeTier = 2 | 3;
/** measured ⬤ (T2, n≥3) · measured-thin ◑ (T2, n=1–2) · estimated-calibrated ◔ (T3, fit) ·
 *  estimated ○ (T3, seed) · none (no DPS / no income). */
export type ClearConfidence =
  | "measured"
  | "measured-thin"
  | "estimated-calibrated"
  | "estimated"
  | "none";
export interface ClearTimeResult {
  seconds: number;
  tier: ClearTimeTier;
  confidence: ClearConfidence;
}

/**
 * Tier dispatch + confidence tagging — the ONE place tier priority lives (A§3). Prefer T2 (the
 * player's own runs exist for this stage) over T3 (datamine HP ÷ DPS). Pure.
 * `stats == null` → T3. `partyDpsNow ≤ 0` → `{ seconds: Infinity, tier: 3, confidence: "none" }`.
 */
export function resolveClearTime(
  args: { stats: StageClearStats | null; hp: StageHpInput },
  partyDpsNow: number,
  maxLifeOf: MaxLifeOf,
  cfg: { aoeClearFactor: number; secondsPerWave: number; aoeFitFromRuns: boolean },
): ClearTimeResult {
  if (partyDpsNow <= 0) return { seconds: Infinity, tier: 3, confidence: "none" };
  if (args.stats != null) {
    const seconds = calibratedClearTime(args.stats, partyDpsNow);
    return {
      seconds,
      tier: 2,
      confidence: args.stats.sampleCount >= 3 ? "measured" : "measured-thin",
    };
  }
  const seconds = theoreticalClearTime(args.hp, maxLifeOf, partyDpsNow, cfg);
  return {
    seconds,
    tier: 3,
    confidence: cfg.aoeFitFromRuns ? "estimated-calibrated" : "estimated",
  };
}

// ─────────────────────────── STAGE RANKING (single level) ───────────────────────────

/** A farmable stage with its precomputed XP-per-clear and clear-time (caller derives both from the
 *  bundled data + the player's runs). */
export interface FarmCandidate {
  /** Datamine key (4-digit) — for display/join, NOT the climb math. */
  stageKey: number;
  stageLevel: number;
  /** stageClearExp(stage), precomputed by the caller from bundled data. */
  expPerClear: number;
  /** resolveClearTime(...), precomputed by the caller. */
  clear: ClearTimeResult;
}

export interface HeroFarmInput {
  heroLevel: number;
  /** The hero's own gear/skill EXP bonus percent (RunHero.stats["47"]); default 0 (absent in logs). */
  bonusPct: number;
  /** level ≥ cap/target → no farming. */
  capped: boolean;
}

/** solid (gap 0–12) · thin (deep gap ≥+13 or interpolated anchor) · approx (under-level, gap<0). */
export type KeepConfidence = "solid" | "thin" | "approx";

export interface FarmRank {
  stageKey: number;
  stageLevel: number;
  xpPerSec: number;
  keep: number;
  /** gap = heroLevel − stageLevel (surfaced for the advisor/tooltips). */
  gap: number;
  clearTier: ClearTimeTier;
  clearConfidence: ClearConfidence;
  keepConfidence: KeepConfidence;
}

/** Deepest over-level gap with a MEASURED keep anchor (OVERLEVEL_KEEP tops out at gap 27, but past
 *  ~+12 the anchors thin out and the keep there is single-sample/interpolated). gap ≥ this → thin. */
const THIN_GAP_THRESHOLD = 13;

/** Confidence in the keep penalty at a given (heroLevel, stageLevel) gap (C edge E4/E7). */
export function keepConfidenceOf(gap: number): KeepConfidence {
  if (gap < 0) return "approx"; // under-level: the wiki formula, UNVALIDATED (exp-model.ts gap≤0 branch)
  if (gap >= THIN_GAP_THRESHOLD) return "thin"; // deep over-level: single-sample/interpolated anchors
  return "solid";
}

/**
 * Rank candidate stages for ONE hero by modeled XP/sec, descending (best first). Pure; delegates the
 * rate to {@link modeledExpPerSecond}. A capped hero → []. A stage with clearTime ≤ 0 / Infinity (or
 * Infinite-seconds T3) yields xpPerSec 0 and sorts last. The account multiplier scales every stage
 * equally, so it never changes the order (F-A). (wf_design §3.2)
 */
export function rankStagesForHero(
  hero: HeroFarmInput,
  candidates: ReadonlyArray<FarmCandidate>,
  accountXpMultiplier: number,
): FarmRank[] {
  if (hero.capped) return [];
  const ranked = candidates.map((c): FarmRank => {
    const gap = hero.heroLevel - c.stageLevel;
    const clearSec = c.clear.seconds;
    const xpPerSec = Number.isFinite(clearSec)
      ? modeledExpPerSecond(
          c.expPerClear,
          hero.heroLevel,
          c.stageLevel,
          clearSec,
          hero.bonusPct,
          accountXpMultiplier,
        )
      : 0;
    return {
      stageKey: c.stageKey,
      stageLevel: c.stageLevel,
      xpPerSec,
      keep: keepFractionFromRate(c, hero, accountXpMultiplier),
      gap,
      clearTier: c.clear.tier,
      clearConfidence: c.clear.confidence,
      keepConfidence: keepConfidenceOf(gap),
    };
  });
  // Sort by xpPerSec desc; stable tiebreak by stageKey so output is deterministic.
  ranked.sort((a, b) => b.xpPerSec - a.xpPerSec || a.stageKey - b.stageKey);
  return ranked;
}

/** Recover the keep fraction the rate used, for display. modeledExpPerSecond folds keep in, so we
 *  re-derive it from the public exp-model surface rather than duplicating the table. */
function keepFractionFromRate(
  c: FarmCandidate,
  hero: HeroFarmInput,
  accountXpMultiplier: number,
): number {
  // rate = epc·keep·(1+bonus/100)·acct / clearSec  ⇒  keep = rate·clearSec / (epc·(1+bonus/100)·acct)
  const clearSec = c.clear.seconds;
  if (!Number.isFinite(clearSec) || clearSec <= 0 || c.expPerClear <= 0) return 0;
  const rate = modeledExpPerSecond(
    c.expPerClear,
    hero.heroLevel,
    c.stageLevel,
    clearSec,
    hero.bonusPct,
    accountXpMultiplier,
  );
  return (rate * clearSec) / (c.expPerClear * (1 + hero.bonusPct / 100) * accountXpMultiplier);
}

// ─────────────────────────── THE CLIMB (Investigation C) ───────────────────────────

/** The level at which a hero is maxed / capped — the level curve has key 100 (the 100→101 level-up)
 *  but no key 101, so `expToNextLevel(101)` is null. A hero at MAX_LEVEL has nothing left to climb. */
export const MAX_LEVEL = 101;

/** A candidate the climb may pick at any level. `clearTimeAtLevel` is a FUNCTION of hero level so a
 *  future DPS-growth refinement (C§3) is a drop-in: v1 callers return a constant (current DPS). */
export interface ClimbCandidate {
  stageKey: number;
  stageLevel: number;
  expPerClear: number;
  clearTimeAtLevel: (heroLevel: number) => ClearTimeResult;
}

export interface ClimbHero {
  heroKey: number;
  level: number;
  /** Within-level EXP already banked (RunHero.exp) — sets the FIRST band's remainder (edge E8). */
  expIntoLevel: number;
  bonusPct: number;
}

export interface PlanBand {
  /** Half-open [from, to): `to` = the first level NOT in the band (= the level reached at band end). */
  fromLevel: number;
  toLevel: number;
  stageKey: number;
  stageLevel: number;
  seconds: number;
  clearTier: ClearTimeTier;
  clearConfidence: ClearConfidence;
  keepConfidence: KeepConfidence;
}

export type PlanStatus = "ok" | "capped" | "already-at-target" | "no-farmable-stage";

export interface HeroPlan {
  heroKey: number;
  status: PlanStatus;
  /** Half-open level bands (empty for the non-ok statuses). */
  bands: PlanBand[];
  /** Infinity-free; the non-ok cases are carried by `status`, never by a NaN/Infinity here. */
  totalSeconds: number;
}

/** One per-level decision before band collapse (internal). */
interface LevelStep {
  level: number;
  stageKey: number;
  stageLevel: number;
  seconds: number;
  clearTier: ClearTimeTier;
  clearConfidence: ClearConfidence;
  keepConfidence: KeepConfidence;
}

const CONFIDENCE_RANK: Record<ClearConfidence, number> = {
  measured: 0,
  "measured-thin": 1,
  "estimated-calibrated": 2,
  estimated: 3,
  none: 4,
};
const KEEP_RANK: Record<KeepConfidence, number> = { solid: 0, thin: 1, approx: 2 };

/** Per-level argmax: the best stage at a given hero level, with the modeled rate it achieves. Shared
 *  by the single-hero climb (band engine) and the team loop. Returns null when no farmable stage. */
function bestStageAtLevel(
  level: number,
  bonusPct: number,
  candidates: ReadonlyArray<ClimbCandidate>,
  accountXpMultiplier: number,
  excludeUnderLevel: boolean,
): { cand: ClimbCandidate; rate: number; clear: ClearTimeResult } | null {
  let best: { cand: ClimbCandidate; rate: number; clear: ClearTimeResult } | null = null;
  for (const cand of candidates) {
    if (excludeUnderLevel && cand.stageLevel > level) continue; // edge E4: stay in the validated region
    const clear = cand.clearTimeAtLevel(level);
    const clearSec = clear.seconds;
    if (!Number.isFinite(clearSec) || clearSec <= 0) continue; // edge E5: no income on this stage
    const rate = modeledExpPerSecond(
      cand.expPerClear,
      level,
      cand.stageLevel,
      clearSec,
      bonusPct,
      accountXpMultiplier,
    );
    if (rate <= 0) continue;
    // Deterministic tiebreak by stageKey so equal-rate ties (and tests) are stable.
    if (best == null || rate > best.rate || (rate === best.rate && cand.stageKey < best.cand.stageKey)) {
      best = { cand, rate, clear };
    }
  }
  return best;
}

/** Collapse a per-level step list into maximal same-stage bands [from, to) (half-open). The band
 *  inherits the WEAKEST confidence of its member levels. */
function collapseBands(steps: ReadonlyArray<LevelStep>): PlanBand[] {
  const bands: PlanBand[] = [];
  let i = 0;
  while (i < steps.length) {
    let j = i;
    while (j + 1 < steps.length && steps[j + 1].stageKey === steps[i].stageKey) j++;
    let seconds = 0;
    let clearConfidence = steps[i].clearConfidence;
    let keepConfidence = steps[i].keepConfidence;
    let clearTier = steps[i].clearTier;
    for (let k = i; k <= j; k++) {
      seconds += steps[k].seconds;
      if (CONFIDENCE_RANK[steps[k].clearConfidence] > CONFIDENCE_RANK[clearConfidence]) {
        clearConfidence = steps[k].clearConfidence;
        clearTier = steps[k].clearTier;
      }
      if (KEEP_RANK[steps[k].keepConfidence] > KEEP_RANK[keepConfidence]) {
        keepConfidence = steps[k].keepConfidence;
      }
    }
    bands.push({
      fromLevel: steps[i].level,
      toLevel: steps[j].level + 1, // half-open
      stageKey: steps[i].stageKey,
      stageLevel: steps[i].stageLevel,
      seconds,
      clearTier,
      clearConfidence,
      keepConfidence,
    });
    i = j + 1;
  }
  return bands;
}

/**
 * EXACTLY-OPTIMAL single-hero climb: per-level argmax + band collapse (C§1, proven by exchange/
 * separability and verified against a brute-force DP). Pure.
 *
 * Edge cases route to {@link PlanStatus}, never a NaN/Infinity band:
 *  - target ≤ current → "already-at-target" (E6/E2, empty bands, 0s)
 *  - cap (expToNextLevel == null) reached before target → "capped" (E1)
 *  - no farmable stage at some level (all rates ≤ 0 / Infinite) → "no-farmable-stage" (E3/E5)
 *  - `excludeUnderLevel` drops gap<0 candidates (E4)
 */
export function singleHeroClimb(
  hero: ClimbHero,
  targetLevel: number,
  candidates: ReadonlyArray<ClimbCandidate>,
  curve: LevelCurve,
  accountXpMultiplier: number,
  opts: { excludeUnderLevel: boolean },
): HeroPlan {
  const cappedTarget = Math.min(targetLevel, MAX_LEVEL);
  if (cappedTarget <= hero.level) {
    return { heroKey: hero.heroKey, status: "already-at-target", bands: [], totalSeconds: 0 };
  }
  const steps: LevelStep[] = [];
  for (let level = hero.level; level < cappedTarget; level++) {
    const need = expToNextLevel(level, curve);
    if (need == null) {
      // Hit the cap before reaching target (E1).
      return { heroKey: hero.heroKey, status: "capped", bands: [], totalSeconds: 0 };
    }
    const best = bestStageAtLevel(
      level,
      hero.bonusPct,
      candidates,
      accountXpMultiplier,
      opts.excludeUnderLevel,
    );
    if (best == null) {
      return { heroKey: hero.heroKey, status: "no-farmable-stage", bands: [], totalSeconds: 0 };
    }
    // First level only consumes the within-level remainder (E8); later levels need the full amount.
    const remaining = level === hero.level ? Math.max(0, need - hero.expIntoLevel) : need;
    const gap = level - best.cand.stageLevel;
    steps.push({
      level,
      stageKey: best.cand.stageKey,
      stageLevel: best.cand.stageLevel,
      seconds: remaining / best.rate,
      clearTier: best.clear.tier,
      clearConfidence: best.clear.confidence,
      keepConfidence: keepConfidenceOf(gap),
    });
  }
  const bands = collapseBands(steps);
  const totalSeconds = steps.reduce((acc, s) => acc + s.seconds, 0);
  return { heroKey: hero.heroKey, status: "ok", bands, totalSeconds };
}

export interface TeamPlanBand extends PlanBand {
  /** The hero whose rate this stage was chosen to MAXIMIZE (the binding constraint) — NOT the
   *  per-segment slowest, which would misattribute the choice (review issue #2). */
  gatingHeroKey: number;
}

export interface TeamPlan {
  status: PlanStatus;
  /** Team-shared bands; `totalSeconds` = makespan (the last hero to reach target). */
  bands: TeamPlanBand[];
  totalSeconds: number;
  /** Each hero's EXACT single-hero plan (C§1 optimal), shown alongside the team view. */
  perHero: HeroPlan[];
  /** Per-hero finish time within the SHARED schedule (heroKey → seconds; capped/done → 0). */
  perHeroFinishSeconds: Record<number, number>;
  /** The hero that finishes the shared climb LAST (the global "gated by"), or null if none climb. */
  gatedByHeroKey: number | null;
}

/** Mutable per-hero state inside the team loop. */
interface TeamHeroState {
  heroKey: number;
  level: number;
  expIntoLevel: number;
  bonusPct: number;
  finishSeconds: number | null; // set when this hero first reaches target
}

/** Total EXP a hero still needs to reach `target` from its current state (current-level remainder +
 *  each full intermediate level). Infinity if any intermediate level is capped (shouldn't happen for
 *  target ≤ MAX_LEVEL, but guarded). */
function xpRemainingToTarget(state: TeamHeroState, target: number, curve: LevelCurve): number {
  const need0 = expToNextLevel(state.level, curve);
  if (need0 == null) return 0; // already capped → effectively done
  let total = Math.max(0, need0 - state.expIntoLevel);
  for (let level = state.level + 1; level < target; level++) {
    const need = expToNextLevel(level, curve);
    if (need == null) break;
    total += need;
  }
  return total;
}

/** One team segment outcome (internal): the stage farmed and how long until the next level-up. */
interface SegmentChoice {
  cand: ClimbCandidate;
  clear: ClearTimeResult;
  /** heroKey → modeled rate on the chosen stage at that hero's current level. */
  rates: Map<number, number>;
  /** The hero whose normalized progress the stage maximizes (the binding constraint). */
  gatingHeroKey: number;
}

/** Greedy-minnorm stage pick for the current team state: maximize, over not-done heroes, the MIN of
 *  (rate / xpRemainingToTarget) — i.e. balance normalized progress so no hero falls behind. Returns
 *  null when no stage gives every not-done hero positive income. */
function pickStageMinNorm(
  notDone: ReadonlyArray<TeamHeroState>,
  target: number,
  candidates: ReadonlyArray<ClimbCandidate>,
  curve: LevelCurve,
  accountXpMultiplier: number,
  excludeUnderLevel: boolean,
): SegmentChoice | null {
  // Precompute each not-done hero's remaining XP (independent of stage).
  const remaining = new Map<number, number>();
  for (const h of notDone) remaining.set(h.heroKey, Math.max(1e-9, xpRemainingToTarget(h, target, curve)));

  let best: SegmentChoice | null = null;
  let bestNorm = -Infinity;
  for (const cand of candidates) {
    const rates = new Map<number, number>();
    let minNorm = Infinity;
    let gatingHeroKey = notDone[0]?.heroKey ?? -1;
    let feasible = true;
    for (const h of notDone) {
      if (excludeUnderLevel && cand.stageLevel > h.level) {
        feasible = false;
        break;
      }
      const clear = cand.clearTimeAtLevel(h.level);
      const clearSec = clear.seconds;
      const rate =
        Number.isFinite(clearSec) && clearSec > 0
          ? modeledExpPerSecond(
              cand.expPerClear,
              h.level,
              cand.stageLevel,
              clearSec,
              h.bonusPct,
              accountXpMultiplier,
            )
          : 0;
      if (rate <= 0) {
        feasible = false;
        break;
      }
      rates.set(h.heroKey, rate);
      const norm = rate / (remaining.get(h.heroKey) ?? 1);
      if (norm < minNorm) {
        minNorm = norm;
        gatingHeroKey = h.heroKey;
      }
    }
    if (!feasible) continue;
    if (minNorm > bestNorm || (minNorm === bestNorm && (best == null || cand.stageKey < best.cand.stageKey))) {
      bestNorm = minNorm;
      best = { cand, clear: cand.clearTimeAtLevel(notDone[0].level), rates, gatingHeroKey };
    }
  }
  return best;
}

/** Advance the team by one segment on `choice.cand`: farm until the next not-done hero levels up,
 *  applying the XP gain to every not-done hero. Mutates `states`; returns the segment duration and
 *  the clear-time result observed (for the band confidence). Infinity → caller bails (E5). */
function advanceSegment(
  choice: SegmentChoice,
  states: ReadonlyArray<TeamHeroState>,
  target: number,
  curve: LevelCurve,
  elapsedSoFar: number,
): number {
  const notDone = states.filter((s) => s.level < target);
  // dt = time until the SOONEST not-done hero crosses its next level-up on this stage.
  let dt = Infinity;
  for (const h of notDone) {
    const rate = choice.rates.get(h.heroKey) ?? 0;
    if (rate <= 0) continue;
    const need = expToNextLevel(h.level, curve);
    if (need == null) continue;
    const tToLevel = Math.max(0, need - h.expIntoLevel) / rate;
    if (tToLevel < dt) dt = tToLevel;
  }
  if (!Number.isFinite(dt)) return Infinity;
  // Apply XP to every not-done hero, then resolve level-ups and finishes.
  for (const h of notDone) {
    const rate = choice.rates.get(h.heroKey) ?? 0;
    h.expIntoLevel += rate * dt;
    while (h.level < target) {
      const need = expToNextLevel(h.level, curve);
      if (need == null) break;
      if (h.expIntoLevel + 1e-6 >= need) {
        h.expIntoLevel -= need;
        h.level += 1;
      } else break;
    }
    if (h.level >= target && h.finishSeconds == null) h.finishSeconds = elapsedSoFar + dt;
  }
  return dt;
}

/** Run greedy-minnorm to completion from a (cloned) team state, returning the ABSOLUTE makespan (the
 *  final elapsed). `startElapsed` threads a prefix already consumed (the rollout's forced first
 *  segment) so finish times share one origin. Used by the rollout to score each candidate first
 *  move. Infinity → infeasible. */
function minNormMakespan(
  states: TeamHeroState[],
  target: number,
  candidates: ReadonlyArray<ClimbCandidate>,
  curve: LevelCurve,
  accountXpMultiplier: number,
  excludeUnderLevel: boolean,
  startElapsed = 0,
): number {
  let elapsed = startElapsed;
  // Bound the loop defensively (each segment levels ≥1 hero by ≥1 level): heroes × span + slack.
  const maxSegments = states.length * (target + 2) + 8;
  let segs = 0;
  while (states.some((s) => s.level < target)) {
    if (++segs > maxSegments) return Infinity;
    const notDone = states.filter((s) => s.level < target);
    const choice = pickStageMinNorm(notDone, target, candidates, curve, accountXpMultiplier, excludeUnderLevel);
    if (choice == null) return Infinity;
    const dt = advanceSegment(choice, states, target, curve, elapsed);
    if (!Number.isFinite(dt)) return Infinity;
    elapsed += dt;
  }
  return elapsed;
}

function cloneStates(states: ReadonlyArray<TeamHeroState>): TeamHeroState[] {
  return states.map((s) => ({ ...s }));
}

/**
 * TEAM climb (shared clears, makespan) via greedy-minnorm with a 1-step rollout (C§2). Pure.
 *
 * The team farms one stage at a time; each clear advances every not-done hero at its own keep-rate.
 * The objective is the MAKESPAN — the time the last hero reaches target. Greedy-minnorm balances
 * normalized progress; the 1-step rollout (DEFAULT, per review issue #1) closes the known
 * keep-cliff counterexamples where bare minnorm is up to ~3.85% off optimal. `perHero[]` is each
 * hero's EXACT single-hero plan (shown alongside). Capped heroes are "done" and never gate.
 *
 * `opts.rollout` defaults to TRUE; pass false only as a test/benchmark escape hatch.
 */
export function teamClimb(
  party: ReadonlyArray<ClimbHero>,
  targetLevel: number,
  candidates: ReadonlyArray<ClimbCandidate>,
  curve: LevelCurve,
  accountXpMultiplier: number,
  opts: { excludeUnderLevel: boolean; rollout?: boolean },
): TeamPlan {
  const target = Math.min(targetLevel, MAX_LEVEL);
  const rollout = opts.rollout ?? true; // review fix #1: rollout is the DEFAULT.

  // Per-hero exact plans (always computed — they are the provably-optimal individual view).
  const perHero = party.map((h) =>
    singleHeroClimb(h, target, candidates, curve, accountXpMultiplier, {
      excludeUnderLevel: opts.excludeUnderLevel,
    }),
  );

  // The shared team schedule runs over the heroes that actually need to climb.
  const states: TeamHeroState[] = party.map((h) => ({
    heroKey: h.heroKey,
    level: h.level,
    expIntoLevel: h.expIntoLevel,
    bonusPct: h.bonusPct,
    finishSeconds: h.level >= target ? 0 : null,
  }));

  const perHeroFinishSeconds: Record<number, number> = {};
  for (const s of states) if (s.level >= target) perHeroFinishSeconds[s.heroKey] = 0;

  // Everyone already done → already-at-target (covers the capped-only team too).
  if (states.every((s) => s.level >= target)) {
    return {
      status: "already-at-target",
      bands: [],
      totalSeconds: 0,
      perHero,
      perHeroFinishSeconds,
      gatedByHeroKey: null,
    };
  }

  const segments: Array<{ choice: SegmentChoice; seconds: number; gatingHeroKey: number; levelAtStart: number }> = [];
  let elapsed = 0;
  const maxSegments = states.length * (target + 2) + 8;
  let segs = 0;

  while (states.some((s) => s.level < target)) {
    if (++segs > maxSegments) break; // defensive; should never trigger with positive rates
    const notDone = states.filter((s) => s.level < target);

    let choice = pickStageMinNorm(
      notDone,
      target,
      candidates,
      curve,
      accountXpMultiplier,
      opts.excludeUnderLevel,
    );
    if (choice == null) {
      return {
        status: "no-farmable-stage",
        bands: [],
        totalSeconds: 0,
        perHero,
        perHeroFinishSeconds,
        gatedByHeroKey: null,
      };
    }

    if (rollout) {
      // Score each first-stage choice by its rollout makespan (force that stage for one segment on a
      // CLONE, then run bare minnorm to the end) and keep the minimum. Closes minnorm's one-step
      // myopia (review issue #1: bare minnorm is up to ~3.85% off optimal in-region; rollout → exact
      // on the known counterexamples). The committable SegmentChoice is rebuilt against the real
      // not-done set so it advances the live state. Ties fall back to minnorm's pick (stage-key
      // order), keeping the result deterministic.
      let bestMakespan = makespanFromTrial(
        states,
        choice.cand,
        target,
        candidates,
        curve,
        accountXpMultiplier,
        opts.excludeUnderLevel,
      );
      for (const cand of candidates) {
        if (cand.stageKey === choice.cand.stageKey) continue;
        const candMakespan = makespanFromTrial(
          states,
          cand,
          target,
          candidates,
          curve,
          accountXpMultiplier,
          opts.excludeUnderLevel,
        );
        // Strictly better only (no `<=`), so the minnorm default wins exact ties → determinism.
        if (candMakespan < bestMakespan - 1e-9) {
          const rebuilt = scoreFirstChoice(
            cand,
            notDone,
            target,
            curve,
            accountXpMultiplier,
            opts.excludeUnderLevel,
          );
          if (rebuilt != null) {
            bestMakespan = candMakespan;
            choice = rebuilt;
          }
        }
      }
    }

    // Commit the chosen segment on the REAL state.
    const levelAtStart = Math.min(...notDone.map((s) => s.level));
    const dt = advanceSegment(choice, states, target, curve, elapsed);
    if (!Number.isFinite(dt)) {
      return {
        status: "no-farmable-stage",
        bands: [],
        totalSeconds: 0,
        perHero,
        perHeroFinishSeconds,
        gatedByHeroKey: null,
      };
    }
    segments.push({ choice, seconds: dt, gatingHeroKey: choice.gatingHeroKey, levelAtStart });
    elapsed += dt;
    for (const s of states) {
      if (s.level >= target && perHeroFinishSeconds[s.heroKey] == null && s.finishSeconds != null) {
        perHeroFinishSeconds[s.heroKey] = s.finishSeconds;
      }
    }
  }

  // Collapse consecutive same-stage segments into team bands. The band's level range tracks the
  // SLOWEST (gating) hero's level so it reads as a climb; the gating-hero label is the constraint.
  const bands = collapseTeamSegments(segments);

  // Global "gated by" = the hero with the largest finish time.
  let gatedByHeroKey: number | null = null;
  let latest = -Infinity;
  for (const s of states) {
    const fin = perHeroFinishSeconds[s.heroKey] ?? s.finishSeconds ?? 0;
    if (fin > latest) {
      latest = fin;
      gatedByHeroKey = s.heroKey;
    }
  }

  return {
    status: "ok",
    bands,
    totalSeconds: elapsed,
    perHero,
    perHeroFinishSeconds,
    gatedByHeroKey,
  };
}

/** Build a SegmentChoice for a SPECIFIC candidate against the given not-done heroes (the rollout's
 *  forced first move). Returns null if the candidate gives any not-done hero zero income. */
function scoreFirstChoice(
  cand: ClimbCandidate,
  notDone: ReadonlyArray<TeamHeroState>,
  target: number,
  curve: LevelCurve,
  accountXpMultiplier: number,
  excludeUnderLevel: boolean,
): SegmentChoice | null {
  const remaining = new Map<number, number>();
  for (const h of notDone) remaining.set(h.heroKey, Math.max(1e-9, xpRemainingToTarget(h, target, curve)));
  const rates = new Map<number, number>();
  let minNorm = Infinity;
  let gatingHeroKey = notDone[0]?.heroKey ?? -1;
  for (const h of notDone) {
    if (excludeUnderLevel && cand.stageLevel > h.level) return null;
    const clear = cand.clearTimeAtLevel(h.level);
    const clearSec = clear.seconds;
    const rate =
      Number.isFinite(clearSec) && clearSec > 0
        ? modeledExpPerSecond(cand.expPerClear, h.level, cand.stageLevel, clearSec, h.bonusPct, accountXpMultiplier)
        : 0;
    if (rate <= 0) return null;
    rates.set(h.heroKey, rate);
    const norm = rate / (remaining.get(h.heroKey) ?? 1);
    if (norm < minNorm) {
      minNorm = norm;
      gatingHeroKey = h.heroKey;
    }
  }
  return { cand, clear: cand.clearTimeAtLevel(notDone[0].level), rates, gatingHeroKey };
}

/** Makespan if the team's FIRST segment is forced onto `cand`, then bare minnorm to the end. The
 *  authoritative rollout score (operates on a clone, common time origin 0). Infinity → infeasible. */
function makespanFromTrial(
  realStates: ReadonlyArray<TeamHeroState>,
  cand: ClimbCandidate,
  target: number,
  candidates: ReadonlyArray<ClimbCandidate>,
  curve: LevelCurve,
  accountXpMultiplier: number,
  excludeUnderLevel: boolean,
): number {
  const trial = cloneStates(realStates);
  const notDone = trial.filter((s) => s.level < target);
  const firstChoice = scoreFirstChoice(cand, notDone, target, curve, accountXpMultiplier, excludeUnderLevel);
  if (firstChoice == null) return Infinity;
  const dt = advanceSegment(firstChoice, trial, target, curve, 0);
  if (!Number.isFinite(dt)) return Infinity;
  // Continue with bare minnorm, threading `dt` as the origin so the returned value is the ABSOLUTE
  // makespan (the forced first segment + everything after).
  return minNormMakespan(trial, target, candidates, curve, accountXpMultiplier, excludeUnderLevel, dt);
}

/** Collapse consecutive same-stage team segments into bands, tracking the gating hero per band. */
function collapseTeamSegments(
  segments: ReadonlyArray<{ choice: SegmentChoice; seconds: number; gatingHeroKey: number; levelAtStart: number }>,
): TeamPlanBand[] {
  const bands: TeamPlanBand[] = [];
  let i = 0;
  while (i < segments.length) {
    let j = i;
    while (j + 1 < segments.length && segments[j + 1].choice.cand.stageKey === segments[i].choice.cand.stageKey) j++;
    let seconds = 0;
    for (let k = i; k <= j; k++) seconds += segments[k].seconds;
    const head = segments[i];
    const clear = head.choice.clear;
    const gap = head.levelAtStart - head.choice.cand.stageLevel;
    bands.push({
      fromLevel: head.levelAtStart,
      toLevel: segments[j].levelAtStart + 1, // half-open over the gating hero's level range
      stageKey: head.choice.cand.stageKey,
      stageLevel: head.choice.cand.stageLevel,
      seconds,
      clearTier: clear.tier,
      clearConfidence: clear.confidence,
      keepConfidence: keepConfidenceOf(gap),
      gatingHeroKey: head.gatingHeroKey,
    });
    i = j + 1;
  }
  return bands;
}
