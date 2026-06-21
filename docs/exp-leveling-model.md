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

---

# Leveling Planner — off-stage "fastest route to a target level"

The planner answers two questions for a hero or the whole team: **"where do I farm the next
level-up?"** (a ranked stage comparison) and **"what's the whole road to level N?"** (a schedule of
level bands). It is built on the §1–§4 primitives above, adds a **clear-time** model (Investigation A),
a **measured-first per-clear XP** model, and a **climb traversal** (Investigation C), then exposes the
real-vs-estimated split as a **Practical / Theoretical** mode.

Canonical implementations (both pure, unit-tested; this section is the spec the in-code `A§`/`C§`/`E#`
citations point at):
- Scheduling (no IO, no data imports): [`app/src/shared/planner-model.ts`](../app/src/shared/planner-model.ts).
- Data layer (runs + bundled datamine → the model's plain shapes; owns ALL the XP math):
  [`app/src/renderer/src/lib/planner-data.ts`](../app/src/renderer/src/lib/planner-data.ts).
- UI: [`app/src/renderer/src/views/PlannerView.tsx`](../app/src/renderer/src/views/PlannerView.tsx).

---

## A. Clear-time — how long one clear of a stage takes (Investigation A)

Time-to-level needs an EXP **rate** (EXP/sec), so the planner needs a clear-time per stage. Two tiers,
preferring the player's own data over the datamine.

### A§0.1 — Calibration off the run INDEX (no N+1)

Clear-time stats are grouped from the **run index** (`RunIndexEntry[]`, already in memory), not by
fetching each full record — so the planner never does an O(history) `getRun` sweep. A run feeds
calibration when it is counted (or legacy-unmarked), a real clear, with positive `clearTime` + `dps`.
Runs whose stage doesn't resolve to a bundled datamine key are **skipped** (see `review fix #2`).

### A§1 — T2: self-calibrated clear-time (the player's own runs)

For a FARMED stage, clear-time is rescaled from the player's real clears by how the current party's
DPS compares to the DPS in those runs (the wiki "**B1**" worked-example ratio, floored):

```
calibratedClearTime(stats, partyDpsNow) =
  max( minClearS + max(0, medianClearS − minClearS) · (medianDps / partyDpsNow),  minClearS )
```

- `minClearS` is a hard floor — a stronger party can't be credited a clear faster than any it ever
  actually achieved.
- `partyDpsNow ≤ 0` → `Infinity` (no income).
- Worked example (the test's "B1"): min 100, samples (200 s @ 40k) + (120 s @ 80k) → median (160 s,
  60k); at `partyDpsNow` 50k → `100 + (160−100)·(60/50) = 172 s`.

Confidence: **measured** (n ≥ 3) / **measured-thin** (n = 1–2).

### A§2 — T3: theoretical clear-time (datamine EHP ÷ DPS)

For an UN-farmed stage, estimate from datamine enemy HP and the party's measured DPS:

```
stageEnemyHp(stage, aoeClearFactor) = (trashPool / aoeClearFactor) + bossHp
  trashPool = avgLifePerKill × (waveAmount × waveMonsterAmount)     # symmetric with §2's EXP sum
  avgLifePerKill = Σ_monsters [ maxLife × (levelScaling.hp/1000) × (weight/Σweight) ]
  bossHp = boss.maxLife × (levelScaling.hp/1000) × (bossMultipliers.hp/1000)   # boss is NOT AoE-divided
theoreticalClearTime = max( stageEnemyHp / partyDpsNow,  waveAmount × secondsPerWave )
```

The wave-floor term keeps an enormous DPS from predicting a 0 s clear. `partyDpsNow ≤ 0` → `Infinity`.
Confidence: **estimated** (datamine seed) / **estimated-calibrated** (AoE factor fitted from runs, see
A§2.1). Ground truth for the HP sum (stage 4309, L95): trash ≈ 20.30 M, boss ≈ 598 k.

### A§2.1 — AoE-clear-factor recovery (the measured-first de-bias) ⭐

`aoeClearFactor` divides the trash pool because AoE clears several mobs per swing. It was originally
hardcoded at **3**, which made T3 (estimated) clears ~3× too fast and let un-farmed stages wrongly
outrank farmed ones. The fix: **fit it from the player's own clears** rather than guess.

Rationale: the meter's measured DPS already counts AoE multi-hits, so total damage-to-clear ≈ total
enemy HP, hence `clearTime ≈ EHP / DPS` at factor ≈ 1. We invert `theoreticalClearTime` on each FARMED
stage to back out the factor the clears imply, then take the median, clamped to `[0.5, 5]`:

```
dpsTime       = max( calibratedClearTime(stats, dps) − waveAmount·secondsPerWave,  ε )
impliedFactor = stageEnemyHp(stage, 1) / (dps · dpsTime)          # EHP@1 / (DPS · HP-bound time)
aoeClearFactor = clamp( median(impliedFactor over farmed stages),  0.5, 5 )   # fallback 1.0, NOT 3
```

Validated: a real Torment 1-6 clear dealt 13.49 M damage ≈ datamine `EHP@1` 13.67 M → true factor ≈ 1.0.
On a seeded L84 team the fit lands ≈ 1.48 (per-stage 1.16/1.48/1.78), vs the old 3. The fallback when
no farmed stage resolves is **1.0** (the unbiased prior), not 3. *(Nuance: the inverter attributes the
wave floor to play-out time — `dpsTime = clear − waveFloor` — while `theoreticalClearTime` is
`max(dpsTime, waveFloor)`; immaterial since `dpsTime ≫ waveFloor` for real content.)*

### A§3 — Tier dispatch + confidence

One place decides the tier: prefer **T2** (the player has clears for this stage) over **T3** (datamine
HP ÷ DPS). `partyDpsNow ≤ 0` → `{ Infinity, T3, "none" }`. The per-row UI badge is driven by the
candidate's **data source** (measured vs estimated, see the XP model), not this clear-confidence tier.

---

## The measured-first per-clear XP model

The reader persists, **per hero per run**, the real `xpGained` — which already embeds the player's
rune+accessory EXP bonus, the account multiplier, AND the §3 keep penalty. So the planner uses the
player's REAL XP for stages they've farmed, and only models the rest.

For each hero **H** and stage **S** (`base = expPerClear(S)` from §2, `keep(L) = keep(L, S.stageLevel)`
from §3):

- **Farmed** (≥1 measured sample): let `measuredXpc = median(xpGained_H on S)` at anchor level
  `Lm = round(median(level_at_run))`. Then
  `expPerClearAtLevel(L) = measuredXpc · keep(L)/keep(Lm)` — at `L = Lm` it reproduces the measured XP
  exactly; off-Lm it scales by the keep ratio. `source = "measured"`, clear-time = T2.
- **Un-farmed**: `expPerClearAtLevel(L) = base · keep(L) · μ_H`. `source = "estimated"`, clear-time = T3.
- **μ_H** = the hero's recovered effective EXP multiplier ≈ `(1 + bonus_H/100) · accountMult`:
  `μ_H = median over H's farmed stages S' of [ measuredXpc(S') / (base(S') · keep(Lm, S')) ]`. Each
  ratio strips the datamine base + keep out of the measured XP, leaving the (bonus × account) scalar.
  Prefers over-level samples (validated keep regime); **fallback 1.0** when H has no farmed stage.

The per-level **rate** the climb consumes is then simply
`rate(L) = expPerClearAtLevel(L) / clearTimeAtLevel(L)`. This replaced the old global "EXP bonus not
captured / account multiplier assumed" banners (`review fix #3`/`#4`, now retired) — measured XP makes
them unnecessary; the only confidence signal is the per-row measured/estimated source badge.

---

## C. The climb — sequencing stages to a target level (Investigation C)

### C§1 — Single hero: greedy "best-stage-per-level" is EXACTLY optimal

At each level `L`, pick the stage with the highest `rate(L)`; the time for that level is
`(ExpForLevelUp[L] − expIntoLevel_at_L) / rate(L)`. Collapse maximal runs of consecutive same-stage
levels into half-open `[from, to)` **bands**.

**Why it is globally optimal (separability):** the time to clear level `L` depends ONLY on `(L, stage)`
— never on which stages were chosen at other levels (`keep` is a function of the gap at `L`, and
`expIntoLevel` only carries into the very first level). So the total is a sum of per-level terms with
no cross-coupling, and minimizing each term independently minimizes the sum. **Verified vs a
brute-force DP** over thousands of random in-region instances (deviation < 1e-9). A band inherits the
**weakest** confidence (clear + keep + source) of its member levels.

### C§2 — Team: makespan via greedy-minnorm + 1-step rollout

The team farms one stage at a time (shared clears); each clear advances every not-done hero at **its
own** rate (per-hero candidate map: same stage SET + clear-time, hero-specific `expPerClearAtLevel`).
The objective is the **makespan** — when the LAST hero reaches target.

- **Greedy-minnorm**: pick the stage that maximizes, over not-done heroes, the MIN of
  `rate / xpRemainingToTarget` — i.e. balance normalized progress so no hero falls behind.
- **1-step rollout (DEFAULT ON, `review fix #1`/`review issue #1`)**: bare minnorm is myopic — on
  known keep-cliff counterexamples it runs up to ~3.85% off optimal. So we score each candidate first
  move by forcing it for one segment on a clone, then running bare minnorm to the end, and keep the
  minimum (strictly-better-only, so ties stay deterministic). This closes the counterexamples to
  optimal and matches the exact makespan DP across random in-region instances.
- Each hero's `perHero[]` plan is its exact C§1 single-hero climb (shown alongside the shared schedule).
- **Gating hero** (`review issue #2`): a band is attributed to the hero whose rate the chosen stage
  was selected to MAXIMIZE (the binding constraint) — NOT the per-segment slowest, which would
  misattribute the choice. The global "gated by" is the hero with the largest finish time.

### C§3 — Party strength (current DPS)

Rates use the party's **median recent measured DPS** as "current strength". Holding DPS constant
OVER-estimates time (a real party gears up), so the plan is a safe upper bound. `MAX_LEVEL = 101`
(curve key 100 is the 100→101 level-up; there is no key 101).

### Edge cases (E1–E8)

The traversal routes every degenerate input to an explicit status, **never** a `NaN`/`Infinity` band:

| | case | handling |
|---|---|---|
| **E1** | cap reached before target (`ExpForLevelUp` null at some level) | status `capped`; a capped hero is "done" (finish 0) and never gates the team |
| **E2** | target ≤ current level | status `already-at-target`, empty bands, 0 s |
| **E3** | no farmable stage at some level (all rates ≤ 0) | status `no-farmable-stage` |
| **E4** | `excludeUnderLevel` — drop stages above the hero's level | stay in the validated keep region (gap ≥ 0) |
| **E5** | a stage gives no income (clear-time ≤ 0 / `Infinity`) | rate 0 → excluded; team bails to `no-farmable-stage` |
| **E6** | target already met | folds into E2 (`already-at-target`) |
| **E7** | deep over-level / interpolated keep anchor | keep-confidence `thin` (gap ≥ +13); under-level gap < 0 → `approx` (the lone surviving keep warning) |
| **E8** | mid-level start | the FIRST level consumes only the within-level remainder (`ExpForLevelUp − expIntoLevel`); later levels need the full amount |

### `review fix #2` — robust stage-key resolution (no phantom keys)

`RunRecord.stageKey` is NOT reliably the datamine key: old records carry the datamine key directly
(fast path), new v2 records carry a game-internal id. Resolution: (a) direct datamine-key hit → else
(b) a `(mode→DIFFICULTY, act, stageNo)` reverse index built from the bundled stages' OWN fields → else
(c) **null → skip the run**. It never fabricates a key for a stage the bundled data doesn't cover
(e.g. an Act-4/5 stage absent from the L1–L95 Act-1–3 bundle).

---

## Practical / Theoretical — the data-basis split

The planner exposes the real-vs-estimated distinction as a top-level mode (default **Practical**):

- **Practical** — keep only `source === "measured"` candidates: stages the player has actually farmed,
  ranked by their real XP/s, with real clear times. No estimates. If the chosen hero has no farmed
  stage, the UI points the user to Theoretical rather than showing a "clear a higher stage" banner.
- **Theoretical** — every stage, including never-farmed ones; times are datamine estimates (XP via
  `base · keep · μ_H`, clear-time via the A§2 model with the A§2.1 fitted factor).

The filter applies to BOTH the climb (C§1/C§2) and the next-level rank, so the mode is honoured
everywhere.

---

## Citation index (in-code label → section)

The planner source tags decisions with short labels; they resolve here:

| label | section |
|---|---|
| `A§0.1` | A§0.1 — calibration off the run index |
| `A§1` / wiki "B1" | A§1 — T2 self-calibrated clear-time |
| `A§2` | A§2 — T3 datamine EHP ÷ DPS |
| `A§3` | A§3 — tier dispatch + confidence |
| `C§1` | C§1 — single-hero exact-optimal climb |
| `C§2` | C§2 — team makespan (greedy-minnorm + rollout) |
| `C§3` | C§3 — party strength / current DPS |
| `E1`–`E8` | Edge cases (E1–E8) table |
| `review fix #1` / `review issue #1` | C§2 — rollout is the default |
| `review issue #2` | C§2 — gating hero attribution |
| `review fix #2` | `review fix #2` — robust stage-key resolution |
| `review fix #3` / `#4` | retired — superseded by the measured-first XP model |
