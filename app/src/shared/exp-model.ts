// Canonical EXP & leveling math for the "time to level up" feature. Pure functions, no deps.
// Model + evidence: docs/exp-leveling-model.md. Mirrors scripts/exp-penalty/exp_model.py and the
// wiki's stage-math.ts. Validated offline (see exp-model.test.ts) and in-game (the live probe).

/** Level -> EXP required to advance FROM that level (LevelInfoData.ExpForLevelUp). A level with no
 *  entry is the cap (no further progression). Source: reader/config/level_curve.json. */
export type LevelCurve = Readonly<Record<number, number>>;

/** Minimal stage shape for {@link stageClearExp} (subset of data/json/stages.json). */
export interface StageExpInput {
  monsters: ReadonlyArray<{ monster: number; weight: number | null }>;
  levelScaling?: { exp?: number | null } | null;
  waveAmount: number | null;
  waveMonsterAmount: number | null;
  bossMonsterKey: number | null;
  bossMultipliers?: { exp?: number | null } | null;
}

/** Resolve a monster key to its level-1 base RewardExp (data/json/monsters.json), or undefined. */
export type RewardExpOf = (monsterKey: number) => number | undefined;

const permille = (v: number | null | undefined): number => (v == null ? 1000 : v) / 1000;

// Over-level keep — MEASURED in-game (experiment E2, game 1.00.17, heroes lv90-93), as a (gap, keep)
// table; gap = heroLevel − stageLevel. Piecewise-linear between anchors → works for ANY gap and
// reproduces the real data exactly (validated to ±0.0% on the Knight gap-0 and Sorc gap-2 runs). A
// clean closed-form `1/(1+(gap/8.1)^2.75)` approximates this within ~2pp for gap≥3 but runs ~3.5pp
// optimistic at +1/+2 (it predicts keep(+2)=0.979 vs the measured 0.944), so we use the table, not the
// formula, for fidelity. gap-only (anchored at lv~91; level-dependence untested). See docs/exp-experiments.md.
const OVERLEVEL_KEEP: ReadonlyArray<readonly [gap: number, keep: number]> = [
  [0, 1.0], [2, 0.944], [3, 0.934], [4, 0.854], [5, 0.809], [6, 0.705], [7, 0.628],
  [8, 0.506], [9, 0.4], [11, 0.293], [12, 0.259], [14, 0.192], [15, 0.169], [16, 0.15],
  [18, 0.112], [19, 0.099], [20, 0.089], [22, 0.068], [24, 0.052], [25, 0.047], [27, 0.036],
];

/**
 * Fraction of EXP a hero KEEPS on a stage (hidden over/under-level penalty). gap = heroLevel − stageLevel.
 * - gap > 0 (over-level): MEASURED curve (E2), piecewise-linear over {@link OVERLEVEL_KEEP} — any gap.
 * - gap ≤ 0 (under-level): NOT measurable with the test roster — taskbarherowiki formula, UNVALIDATED.
 */
export function expKeepFraction(heroLevel: number, stageLevel: number): number {
  const gap = heroLevel - stageLevel;
  if (gap > 0) {
    const last = OVERLEVEL_KEEP[OVERLEVEL_KEEP.length - 1];
    if (gap >= last[0]) return last[1];
    for (let i = 1; i < OVERLEVEL_KEEP.length; i++) {
      const [g1, k1] = OVERLEVEL_KEEP[i];
      if (gap <= g1) {
        const [g0, k0] = OVERLEVEL_KEEP[i - 1];
        return k0 + ((gap - g0) / (g1 - g0)) * (k1 - k0);
      }
    }
    return last[1];
  }
  const e = heroLevel;
  const c = -gap;
  const a = 0.4;
  const s = Math.log(e + 1) / 10 + 1;
  const n = Math.trunc(s * 5);
  const r = Math.trunc(s * 6);
  if (c <= n) return 1;
  if (c <= n + r) {
    const u = (c - n) / r;
    return Math.max(1 - (1 - a) * u * u, 0.01);
  }
  return Math.max((0.01 / a) ** ((c - n - r) / Math.max(e / 3, 1)) * a, 0.01);
}

/**
 * Expected base EXP for one full clear of a stage (game base × stage-level scaling), BEFORE the
 * over/under-level penalty and any rune/pet bonus. Spawn-weighted average kill × total kills + boss.
 * Port of wiki stage-math.ts:stageClearRewards.
 */
export function stageClearExp(stage: StageExpInput, rewardExpOf: RewardExpOf): number {
  const expMult = permille(stage.levelScaling?.exp);
  const mons = stage.monsters ?? [];
  const totalWeight = mons.reduce((acc, m) => acc + (m.weight ?? 0), 0);
  let avgExpPerKill = 0;
  if (totalWeight > 0) {
    for (const m of mons) {
      const re = rewardExpOf(m.monster);
      if (re == null) continue;
      avgExpPerKill += re * expMult * ((m.weight ?? 0) / totalWeight);
    }
  }
  const kills = (stage.waveAmount ?? 0) * (stage.waveMonsterAmount ?? 1);
  let total = avgExpPerKill * kills;
  if (stage.bossMonsterKey != null) {
    const bossExp = rewardExpOf(stage.bossMonsterKey);
    if (bossExp != null) total += bossExp * expMult * permille(stage.bossMultipliers?.exp);
  }
  return total;
}

/** EXP needed to advance FROM `level`, or null if the level is capped (no curve entry). */
export function expToNextLevel(level: number, curve: LevelCurve): number | null {
  const v = curve[level];
  return v == null ? null : v;
}

/**
 * Modeled EXP/sec a hero earns farming a stage (for "what-if" planning):
 * expPerClear × keep × (1 + bonusPct/100) × accountXpMultiplier ÷ clearTimeSec.
 *
 * - `bonusPct`: the hero's OWN gear/skill EXP bonus (per-hero `IncreaseExpAmount`, e.g. an +8.7%
 *   accessory). Shows up in the reader's per-hero FINAL stat.
 * - `accountXpMultiplier`: ACCOUNT-WIDE XP boost from runes (`IncreaseExpAmount`/`AdditionalExp*` —
 *   read per-player from `build._read_runes` + `data/runes.json`) and any global boost. This is
 *   applied at the XP-grant level, NOT in the per-hero stat — confirmed in-game: a no-bonus hero
 *   still got it (E2 Knight: real = base × 3.34). Default 1.0 (no account boost). For the live "now"
 *   estimate prefer the meter's MEASURED per-hero rate, which bakes ALL of this in automatically.
 */
export function modeledExpPerSecond(
  expPerClear: number,
  heroLevel: number,
  stageLevel: number,
  clearTimeSec: number,
  bonusPct = 0,
  accountXpMultiplier = 1,
): number {
  if (clearTimeSec <= 0) return 0;
  return (
    (expPerClear * expKeepFraction(heroLevel, stageLevel) * (1 + bonusPct / 100) * accountXpMultiplier) /
    clearTimeSec
  );
}

/**
 * Per-hero MEASURED EXP/sec: the live accumulator's cumulative run gain over elapsed run seconds.
 * This is the game's OWN number — it already bakes in keep, the hero bonus, and the account
 * multiplier — so the live "time to level" readout carries ZERO model uncertainty. Prefer this over
 * {@link modeledExpPerSecond} whenever a measured rate exists. `elapsedSec ≤ 0` → 0 (no rate yet).
 */
export function measuredExpPerSecond(cumulativeGain: number, elapsedSec: number): number {
  if (elapsedSec <= 0) return 0;
  return cumulativeGain / elapsedSec;
}

/**
 * Seconds until the hero reaches its next level. null = capped (no progression); Infinity = no EXP
 * income. `expPerSec` is the hero's current EXP/sec (measured or modeled).
 */
export function timeToNextLevel(
  level: number,
  expIntoLevel: number,
  expPerSec: number,
  curve: LevelCurve,
): number | null {
  const need = expToNextLevel(level, curve);
  if (need == null) return null;
  if (expPerSec <= 0) return Infinity;
  return Math.max(0, need - expIntoLevel) / expPerSec;
}

/**
 * Seconds until the hero reaches `targetLevel` (sums the current-level remainder + each full
 * intermediate level). `rateAtLevel(L)` returns the EXP/sec the hero would earn AT level L — pass a
 * constant for a measured rate, or a closure using {@link modeledExpPerSecond} so the penalty is
 * recomputed as the hero's level approaches/leaves the stage level. null if any level is capped.
 */
export function timeToLevel(
  currentLevel: number,
  expIntoLevel: number,
  targetLevel: number,
  rateAtLevel: (level: number) => number,
  curve: LevelCurve,
): number | null {
  if (targetLevel <= currentLevel) return 0;
  const need0 = expToNextLevel(currentLevel, curve);
  if (need0 == null) return null;
  const r0 = rateAtLevel(currentLevel);
  if (r0 <= 0) return Infinity;
  let total = Math.max(0, need0 - expIntoLevel) / r0;
  for (let level = currentLevel + 1; level < targetLevel; level++) {
    const need = expToNextLevel(level, curve);
    if (need == null) return null;
    const rate = rateAtLevel(level);
    if (rate <= 0) return Infinity;
    total += need / rate;
  }
  return total;
}
