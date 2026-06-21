# EXP & leveling model

Everything the meter needs to estimate **how long until each hero levels up**, and the evidence
behind it. The model has four pieces: the **level curve** (EXP per level), the **per-clear EXP** a
stage yields, the hidden **over/under-level penalty**, and the **time-to-level** projection that
combines them with a measured or modeled EXP rate.

Canonical implementations:
- TypeScript (app feature): [`app/src/shared/exp-model.ts`](../app/src/shared/exp-model.ts) (+ co-located test).
- Python (probe + data regen): [`scripts/exp-penalty/exp_model.py`](../scripts/exp-penalty/exp_model.py).

---

## 1. Level curve — EXP to advance a level

`LevelInfoData.ExpForLevelUp[level]` = EXP required to go **from** `level` to `level+1`. Levels
1–100 (level 101 = cap; no curve entry → no progression). The reader already bundles this exact
table as `reader/config/level_curve.json` and uses it in `reader/metrics/xp.py`. Same source the
game uses (datamine `LevelInfoData`).

A hero's distance to its next level = `ExpForLevelUp[level] − expIntoLevel`, where `expIntoLevel`
is the live within-level EXP the reader reads (`HeroRuntime.EXP_FAKE`).

## 2. Per-clear EXP a stage yields (base, un-penalized)

```
expPerClear(stage) = avgExpPerKill × (waveAmount × waveMonsterAmount) + bossExp
  avgExpPerKill = Σ_monsters [ monster.rewardExp × (levelScaling.exp/1000) × (weight / ΣweightS) ]
  bossExp       = boss.rewardExp × (levelScaling.exp/1000) × (bossMultipliers.exp/1000)   # if boss
```

- `monster.rewardExp` = `MonsterInfoData.RewardExp` (level-1 base), from `data/json/monsters.json`.
- `levelScaling.exp` = `StageLevelInfoData.MonsterExpMultiplier` (permille; **1000 = 1×**, and note
  stage-level 1 = 100 = 0.1×, growing to ~365× by stage-level 67), from `data/json/stages.json`.
- `waveAmount × waveMonsterAmount` = total trash kills; `bossMultipliers.exp` scales the boss.

This is a port of the wiki's `web/src/lib/stage-math.ts:stageClearRewards`, validated **to the digit**
against taskbarhero.wiki per-stage JSON. Our port matches its reference EXP/clear within ≤3%
(Pasture 15.5 vs 16, Cursed Land 5981 vs 6000, Sacred Tomb 30556 vs 31000).

## 3. Over/under-level penalty — `keep(heroLevel, stageLevel)` ⭐

The game silently multiplies EXP by a hidden factor based on `heroLevel − stageLevel`
(`TaskbarHero.Util.ExpRateCalculator`). The **exact formula**, recovered from
`taskbarherowiki.com/farm` (function `x` in its JS bundle; the site states it is reverse-engineered
from the game code and validated to within 1% of real runs):

```
keep(heroLevel, stageLevel):
  over = heroLevel >= stageLevel
  a    = over ? 0.5 : 0.4
  s    = ln(heroLevel + 1) / 10 + 1          # level-scaled band factor
  n    = trunc(s * (over ? 2 : 5))           # flat no-penalty band  (UNDER band wider → gentler)
  r    = trunc(s * (over ? 5 : 6))           # quadratic ramp width
  c    = abs(heroLevel - stageLevel)         # level gap
  if   c <= n:      1.0                       # within the flat band → full EXP
  elif c <= n + r:  max(1 - (1-a)·((c-n)/r)², 0.01)   # quadratic falloff
  else:             max((0.01/a)^((c-n-r)/max(heroLevel/3,1))·a, 0.01)   # exponential tail, floor 1%
```

**Properties**
- **Per-hero AND hero-level-scaled.** Higher-level heroes get a *wider* forgiving band. So it is NOT
  a fixed curve-by-gap — it depends on the hero's own level.
- **Asymmetric.** Over-level bites early and craters; under-level has a wider flat band and a gentle
  ramp, only really biting at large gaps.
- **Floor = 1%** (never zero).

**Behavior (keep %), by hero level**

| | gap 2 | 4 | 6 | 8 | 10 | 12 | 15 | 20 | 25 |
|---|---|---|---|---|---|---|---|---|---|
| **over, hero 30** | 100 | 94 | 78 | 50 | 23 | 10 | 3 | 1 | — |
| **over, hero 71** | 100 | 96 | 84 | 63 | 42 | 30 | 19 | 8 | — |
| **under, hero 30** | 100 | 100 | 100 | 96 | 85 | 66 | 28 | 4 | 1 |
| **under, hero 71** | 100 | 100 | 100 | 99 | 92 | 77 | 40 | 18 | 8 |

The **sweet spot for EXP is a band around the hero's own level** — pushing a hero far above (harsh)
or far below (gentle) its level cuts EXP. This is why time-to-level is inherently per-hero and
non-monotonic with stage difficulty.

### Provenance & confidence

| Direction | Confidence | Basis |
|---|---|---|
| Over-level | **High** | Formula reproduces the sibling wiki's independently-derived anchors `[100,94,78,50,23,10,3]` *exactly* at hero lv30, and the known gap+8 = 50%. Sibling wiki validated <1% vs real meter runs. |
| Under-level | **Medium-high** | Same formula/source; taskbarherowiki states <1% validation. Not yet independently confirmed against our own real runs → see the live probe (§5). Community/Mario data point (hero 71, stage 81, gap −10) recalled as ~96%; formula gives 91.6% (consistent). |

Binary note: I decompiled `GameAssembly.dll` 1.00.16 (from the SMB-mounted Windows share) with
Il2CppDumper and confirmed `ExpRateCalculator` exists, but it is **inlined + managed-stripped +
name-obfuscated** (Beebyte) and called virtually, with no `.rdata` keep-curve table — so the raw
game constants are not statically extractable without a full decompiler. The formula above is the
community reverse-engineering, corroborated by the cross-checks in the table.

## 4. Time-to-level projection

```
expRate (EXP/sec) — two ways:
  measured: from the meter's live per-hero accumulator (metrics/xp.py) over elapsed run time.
            Bakes in the real penalty + bonuses + stage automatically. Most accurate for "now".
  modeled:  expPerClear(stage) × keep(heroLevel, stageLevel) × (1 + bonusPct/100) / clearTimeSec
            Lets you answer "what if I farmed stage X" (planning).

timeToNextLevel = (ExpForLevelUp[level] − expIntoLevel) / expRate
timeToLevel(target) = timeToNextLevel + Σ_{L=level+1}^{target-1} ExpForLevelUp[L] / rate(L)
```

For the modeled rate, `rate` depends on the hero's level (via `keep`), so multi-level projections
should recompute `keep(L, stageLevel)` per future level `L` (the penalty changes as the hero levels
up toward/away from the stage level). EXP bonuses: `IncreaseExpAmount` (% multiplier),
`AdditionalExp[/NormalMonster/StageBoss]` (flat per kill) — runes/pets/gear; see `simulator.ts`.

---

## 5. How we test it

Three layers, increasing strength:

### (a) Offline validation — DONE
`scripts/exp-penalty/exp_model.py` self-test asserts `keep()` reproduces the wiki over-level anchors
and gap+8 = 50%, and that `stage_clear_exp()` matches the wiki reference EXP/clear within 3%. Mirrored
as unit tests in `app/src/shared/exp-model.test.ts` (run by `cd app && pnpm test`).

### (b) Live in-game probe — real-data confirmation
`tbh-meter-dev/exp_penalty_probe.py` (+ `stage_exp.json`). It attaches to the running game
(read-only), reads each deployed hero's **real EXP gain**, level, EXP-bonus stat, and the current
stage, and checks the formula.

**The self-checking trick:** on one stage, party heroes have **different levels → different gaps**,
but all get the **same number of clears**. So `normalizedGain / keep(heroLevel, stageLevel)` must be
**constant across heroes** if the formula is right — no clear-counting or absolute EXP needed. The
probe reports that constant `K` and its spread; spread ≤ 8% = confirmed. If it diverges, it prints
the implied real keep-curve vs the formula per gap.

**Protocol (run on Windows, admin, game open):**
1. Sync `tbh-meter-dev/reader` to repo HEAD; ensure `stage_exp.json` is next to the probe
   (regenerate with `scripts/exp-penalty/gen_stage_exp.py` if the game data changed).
2. Build a party with **widely spread hero levels** (e.g. 30/45/60/75) so one stage gives several
   over- AND under-level samples. Prefer heroes with **no EXP runes** (cleanest reading).
3. Pick a stage whose `stageLevel` lands in the middle of those hero levels, and **farm it ~2–3 min**.
4. `python exp_penalty_probe.py` → farm → `Ctrl+C`. Send back `exp_penalty_probe_out.txt`.

Repeat on a high-stage-level stage with under-leveled heroes to stress the under-level side
specifically (the part with medium confidence above).

### (c) Cross-source check
Our `keep()` and the sibling wiki's `overLevelExpFactor` should agree on the over-level side at
hero lv30 (they do, exactly). The wiki's `StageBenchmark.medianXp` (real per-clear EXP from meter
uploads, in the Railway Postgres DB) is a second real-data oracle for `stage_clear_exp` if we want
to validate absolute EXP/clear later.
