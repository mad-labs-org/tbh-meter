# EXP experiments — ground-truth log

Living ledger for nailing TBH's XP math **exactly** from real measurements. The model lives in
[exp-leveling-model.md](./exp-leveling-model.md); this file records each experiment, what it proved,
and every formula correction. Tool: `tbh-meter-dev/xp_experiment_probe.py` (reads entry/exit XP per
hero from memory; logs `xp_experiment_log.jsonl`). Workflow: Mario runs a controlled stage visit →
reports the on-screen XP + clear count → we reconcile vs the probe → correct the formula here.

## Current formulas (revision r1 — offline-validated, awaiting in-game ground truth)

- **Base EXP/clear** (un-penalized, no bonus): `stageClearExp` (see model doc §2). Matches the wiki
  reference within ≤3%. **Open: is it EXACT?** A no-bonus, keep=1 single clear must equal it exactly.
- **keep(heroLevel, stageLevel)**: the band/ramp/tail formula (model doc §3). Reproduces the wiki
  over-level anchors exactly. **Open: exact across all gaps, esp. under-level?**
- **Bonus combination**: HYPOTHESIS `gain = expPerClear × clears × keep × (1 + IncreaseExp%/100) + AdditionalExp_flat × kills`.
  **Open: unverified** — order (keep before/after bonus?), whether keep applies to the flat term, and
  the exact units of the `IncreaseExpAmount` stat.

## Open questions (what each experiment should resolve)

1. **Is `expPerClear` exact?** → no-bonus hero, hero level inside the flat band (keep = 1), exactly
   1 clear. Measured gain must equal `expPerClear`. Any % off = correct the base.
2. **Is `keep` exact, per gap?** → no-bonus hero, vary the gap (over and under), 1 clear.
   `gain / expPerClear` = the true keep at that gap. Build the real curve, correct the formula.
3. **Does keep change as you level up mid-clear?** → watch for the `⚠LEVELOU` flag; prefer clears
   with no level-up for clean points.
4. **Per-kill vs per-clear penalty?** → compare a trash-heavy stage vs a boss-heavy one at the same gap.
5. **Bonus combination & stat units** → repeat a confirmed (stage, hero) with vs without an EXP rune.

## Protocol (cleanest first)

1. Pick a hero with **no EXP runes/gear** (probe shows `IncreaseExp=0 AdditionalExp=0`).
2. Enter a stage, do **exactly 1 clear**, **leave** (the probe closes the segment on stage change).
3. Read the comparison; send `xp_experiment_log.jsonl` + the **on-screen entry/exit XP** + **clear count**.
4. Then vary: same hero on stages above/below its level (sweep the gap); then a boss-only stage; then add a rune.

## Experiments

**E1 (2026-06-20, game 1.00.17)** — stage **4301 Snowbound Outpost, stageLevel 91**, base
expPerClear (data) = 5,314,181. Party farmed simultaneously: Knight lv91 (gap 0, bonus 1.0),
Sorcerer lv93 (gap +2, bonus **1.087** = the +8.7% accessory), Ranger lv101 (max → gains 0, capped).
Probe captured 103 fragments over the session (~11 Knight clears: span 58.77M / epc ≈ 11.06).

Headline measurement — the two heroes farmed **at the same time**, so their per-tick gain ratio
cancels clears + epc + stage:
- `Sorc_gain / Knight_gain = 1.0258` (**sd 0.0002**, n=100; identical in Mario's run-2 and run-3 windows).
- Knight (gap 0) → keep = 1.0 (on-level). Sorc gets `keep(93,91) × 1.087`. So
  **keep(+2) = 1.0258 / 1.087 = 0.9437**.

| # | stage (lvl) | hero | gap | bonus(mult) | measured | result |
|---|---|---|---|---|---|---|
| E1a | 4301 (91) | Knight lv91 | 0 | 1.0 | gain 58.77M / ~11 clears | keep(0) ≈ 1.0 (epc within ~1%) |
| E1b | 4301 (91) | Sorc lv93 | +2 | 1.087 | Sorc/Knight = 1.0258 | **keep(+2) = 0.944** (formula said **1.000** ❌) |

### Findings

1. **Reader XP == on-screen XP, to the unit.** Probe's Knight entry = `635,596,992` = Mario's screen
   number **exactly (Δ0)**. The memory read is ground-truth-accurate; no calibration doubt.
2. **`IncreaseExpAmount` FINAL stat is a MULTIPLIER, not a percent.** Knight 1.0 (none), Sorc 1.087
   (+8.7% ✓ matches the accessory), Ranger 1.059. → bonus factor = the stat value directly (do NOT do
   `1 + x/100` on it). Bonus is **multiplicative** on the gain.
3. **Over-level penalty starts immediately — the formula's flat band is WRONG.** Measured keep at
   gap +2 = **0.944**; the taskbarherowiki formula predicts **1.0** (flat band n = trunc(s·2) = 2 for
   lv~92). So at high level there is **no 2-level grace** on the over side; ~2.8%/level near the top.
   (Sorc's +8.7% bonus only netted +2.6% over Knight → the +2 gap ate ~5.6%.)
4. **Capped heroes (lv101) gain 0** (phantom) — consistent with the reader's cap handling; unusable
   for keep.
5. **epc ≈ right (±~1%).** Knight gain / epc ≈ 11.06 clears (near-integer) supports both epc and
   keep(0)=1.0; not a tight proof (no clean single-clear yet).

**E2 (2026-06-20, game 1.00.17) — the over-level curve, MEASURED.** Team Priest 90 / Knight 91 /
Sorc 93 (+8.7%) farmed a ladder of 9 stages (stageLevel 91 → 66), one quick visit each. Within each
stage all 3 heroes share clears+epc, so their `gain/bonus` ratios are pure keep ratios; consecutive
stages share an overlapping gap, so absolute keep **chains** from the Knight gap-0 = 100% anchor.
(Capped Ranger lv101 → 0, skipped. gap −1 from a brief Priest swap on 4301 → discarded as artifact.)

**Calibrated over-level keep (gap = heroLevel − stageLevel)** — replaces the formula:

| gap | +0 | +2 | +3 | +4 | +5 | +6 | +7 | +8 | +9 | +11 | +12 | +14 | +16 | +18 | +20 | +22 | +25 | +27 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **keep** | 100 | 94.4 | 93.4 | 85.4 | 80.9 | 70.5 | 62.8 | 50.6 | 40.0 | 29.3 | 25.9 | 19.2 | 15.0 | 11.2 | 8.9 | 6.8 | 4.7 | 3.6 |
| old formula | 100 | 100 | 99 | 96 | 91 | 84 | 74 | 63 | 50 | 39 | 34 | 26 | 20 | 16 | 12 | 9 | 6 | 5 |

Solid for gaps **0→+14** (directly chained); +15→+27 is shape-measured with the level set via a
formula bridge (less certain, but the tail barely matters). Confidence on the bend region: high
(within-stage ratios had sd ~0.0002 on E1).

### Findings (E2)

6. **The over-level penalty starts immediately and is much harsher than the formula.** No flat band:
   +2 already = 94.4%; it ~halves every 4–5 levels (50% at +8, 25% at +12, 12.5% at +17). The old
   formula over-predicted keep by **1.06× at +2 rising to ~1.4× at +14+** — i.e. time-to-level for
   over-leveled heroes was being under-estimated.
7. **Calibration baked in.** `expKeepFraction` (TS + Python) now uses this measured table for gap > 0
   (piecewise-linear), gap-only. The taskbarherowiki formula is kept ONLY for gap ≤ 0 (under-level).

### Still open

- **Level-dependence of the over-level curve is unverified** — measured only at hero lv ~90–93. A
  low-level hero over-leveling a low stage *might* differ. Re-measure opportunistically if we ever
  have lower-level heroes.
- **Under-level penalty is UNMEASURED** — can't reach stages above our heroes (team cap 3, max usable
  level 93). Still the (unvalidated) taskbarherowiki formula. Only testable by putting a low-level
  hero in a strong team on a high stage, once such a hero exists.
- The +15→+27 tail level is approximate (formula-bridged); fine for the feature.

**E3 (2026-06-21, game 1.00.17) — end-to-end validation + the feature shipped.** Re-ran the model
against the raw E2 tick log (`xp_log_fresh.jsonl`, 112 rows) programmatically: `stageClearExp`
reproduces the log's `expPerClear` to **0.0000%** on all 9 stages; the keep curve round-trips the
measured Sorc/Knight ratio to **≤0.23%** across gaps +2→+27 (keep(+2)=0.9437, −0.035% vs the committed
0.944). **Caveat — round-trip, not out-of-sample:** every gap in the log lands on a table anchor, so
interpolation between anchors and the entire **under-level** branch stay UNVALIDATED. No correction to
`OVERLEVEL_KEEP`. The "time to level" overlay feature was built on the MEASURED live rate (reader
`party_progress` → `measuredExpPerSecond` → `timeToNextLevel`), so the live readout carries zero
penalty-model risk; the modeled curve only powers projection/ranking.

## Formula revisions

- **r7** (2026-06-21) — **time-to-level shipped (live overlay).** Reader emits per-hero `party_progress`
  (level + within-level exp + run-accumulated gain) on `live.json`; the app derives the rate
  (`measuredExpPerSecond` = gain/elapsed, the game's own number) and ETA (`timeToNextLevel`), shown per
  hero in the live Team frame with a hover card (progress + rate + ETA + resistances). Level curve
  bundled to the renderer (`game-data.levelCurve`); `formatEta` for compact ETAs. Validated end-to-end
  (E3); no formula change. Sweet-spot advisor + best-stage ranker are follow-ups.
- **r6** (2026-06-20) — **over-level keep reverted to the MEASURED table** (from the logistic). The
  Sorc validation forced it: the logistic gave keep(+2)=0.979 → predicted the Sorc +3.7% high; the
  measured 0.944 fits it to **±0.03%**. `expKeepFraction` interpolates the table (works for any gap)
  and reproduces the real data exactly. The logistic `1/(1+(gap/8.1)^2.75)` stays documented only as
  a rough mental approximation (±~3.5pp at small gaps). **Same-stage caveat (Knight run2 vs Sorc
  run3):** both on 4301, but NOT the same SIZE — run2 Knight = 17,736,256 = exactly 1 full clear
  (base 5,314,181 × account 3.3375); over the Sorc's run3 interval the Knight gained only 17,057,822
  (~4% less, boundary slop / not an identical clear). So Knight-run2 ÷ Sorc-run3 gives a wrong
  keep(0.9075); Sorc ÷ same-run Knight = 1.0258 → keep 0.944 (also the 103-sample E1 session ratio).
  Lesson: validate hero-vs-hero WITHIN one run, never across runs.
- **r5** (2026-06-20) — **account-wide XP multiplier added.** The datamine `expPerClear` is the BASE
  (no account boosts) — it matched the community calc but was **3.34× below** the real Knight (1 run,
  gap 0, no accessory: 17,736,256 vs base 5,314,181). The gap is an **account-wide XP boost from
  runes** (`IncreaseExpAmount`/`AdditionalExp*`), applied at XP-grant, NOT in the per-hero stat
  (Knight's per-hero `inc47`=1.0 yet it got the boost). Real per-clear = `base × accountXpMultiplier`;
  for the test account (ALL runes) = **3.3375** (calibrated from the Knight; ≈ +234%). `modeledExpPerSecond`
  now takes `accountXpMultiplier`; validated `5,314,181 × 3.3375 = 17,736,256` (the real Knight). The
  reader reads per-player runes (`build._read_runes`, `RuneSaveData`, run-record `runes` field →
  effect via `data/runes.json`), so this generalizes per player; the live meter measures it directly.
  Rune raw→% units are unclear (the wiki simulator treats `IncreaseExpAmount` value as a direct % →
  would give ~×20 for "all runes", clearly wrong), so calibrate the multiplier from a clean clear, not
  the raw values. keep curve UNAFFECTED (the multiplier cancels in hero-vs-hero ratios).
- **r4** (2026-06-20) — **over-level RULE extracted** (closed form): `keep = 1/(1 + (gap/8.1)^2.75)`,
  gap = heroLevel − stageLevel. A logistic fit to the E2 curve (RMS ~1.5pp; reproduces the "halves
  every ~4.5 levels" structure exactly). Baked into `exp-model.ts` + `exp_model.py` (replaces the
  piecewise table). Caveat: ~3pp OPTIMISTIC at the smallest gaps — rule says 97.9% at +2, but the
  rock-solid E1 measurement is 94.4% (and that 94.4% reproduces the real Sorc gain to ±0.0%). A
  3-param fit `1/(1+0.0135·gap+0.0023·gap^2.85)` cuts the +2 error to ~1.4pp if small-gap fidelity
  matters. Half-point (8.1) measured at lv~91; level-dependence untested. Tests + self-test green.
- **r3** (2026-06-20, after E2) — **over-level keep REPLACED by the measured table** (gaps 0→+27,
  gap-only, piecewise-linear) in `app/src/shared/exp-model.ts` + `scripts/exp-penalty/exp_model.py`.
  Penalty starts at +1 (no flat band); old formula over-predicted by up to ~1.4×. Under-level still
  the unvalidated formula. Tests updated to the measured anchors; `pnpm check` + self-test green.
- **r2** (2026-06-20, after E1) — **bonus = `gain × keep × inc47_multiplier`** (the stat is the
  multiplier, confirmed). **keep over-level flat band is too wide**: measured keep(+2)=0.944 vs
  formula 1.0 — penalty starts at +1, not after a band. NOT re-fit yet (1 point); gathering gaps.
  Probe updated to read the bonus as a multiplier + resist segment fragmentation.
- **r1** (2026-06-20) — initial: keep = taskbarherowiki formula; expPerClear = stage-math port;
  bonus combination = hypothesis. (Superseded by r2 on the bonus + over-level flat band.)
