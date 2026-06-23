---
type: guide
description: "Game updated? Playbook for fixing the reader: diagnose via the PE fingerprint (content patch vs recompile), confirm nothing offsets.py tracks shifted (IL2CPP dump + diff), re-seed for the new build, bump GAME_VERSION and validate live. In most updates the reader is NOT broken — it just lost the fast path; the fix is to re-seed, not to edit offsets."
symptoms:
  - "game updated"
  - "new version"
  - "gold 0 after update"
  - "stage ? after update"
  - "mode ? after update"
  - "GAME_VERSION"
  - "Version.txt"
  - "1.00.x"
  - "recompile"
  - "fingerprint changed"
  - "re-seed"
  - "reseed"
code_anchors:
  - scripts/preflight_calib.py
  - scripts/diff_offsets_vs_dump.py
  - scripts/seed_calib_capture.py
  - scripts/validate_live.py
  - il2cpp/typeinfo.py::build_fingerprint
  - meter_windows.py::GAME_VERSION
  - meter_windows.py::CACHE_FMT
---

# Guide — game update (re-seed + offset verification)

Every TBH update rebuilds `GameAssembly.dll` → the **build fingerprint changes** → the embedded
seed (`config/calib_seed.json`) **misses** → the client falls into the **cold scan**, which is the
fragile path (catalog + gold value-scan depend on game state/timing). Classic player symptom:
**damage/dps/xp work** (managers are always in memory) but **gold = 0** and **stage shows mode
"?"**. In the overwhelming majority of cases **nothing the reader reads has shifted offset** — the
fix is to **re-seed**, not to touch `offsets.py`. This guide tells you how to be CERTAIN of that
(and what to do in the rare case something did shift).

## Three buckets (what changes in an update)

1. **Never changes** — the PE/OS format and the **IL2CPP/Unity ABI** (`String`/`Array`/`List`/`Dict`/
   `Class`): these only change on an **engine** upgrade (`UnityPlayer.dll`), not on a game patch.
2. **Self-heals** — `fingerprint`, `anchor_rva`, `indices`, `idx_ut`, catalogs: change on **every**
   update, but the scan rediscovers and the re-seed recaptures. **Zero code edits** — just re-seed.
   See [[invariants/cache-management]] and [[invariants/rva-index-resolution]].
3. **Breaks silently (offset/enum)** — field offsets + enums in `config/offsets.py`: change **rarely**
   (only when the devs add/reorder fields/members in those classes), but when they do the reader reads
   **garbage/empty WITHOUT an error**. Step 3 below is the tripwire for this bucket.
4. **Breaks silently (encoding change) — caught ONLY by the live gate (step 6), invisible to step 3.**
   The anti-cheat/Obscured *encoding* can change with **zero offset movement**. Nailed in **1.00.20**: the
   ACTk `fakeValue` PLAIN decoy (how the reader legally read live `HeroRuntime` level/exp) was **zeroed
   build-wide** — every offset/enum/index unchanged (static preflight FULLY GREEN), the reseed correct, yet
   the live read returned 0 → `read_live_party` rejected every real deployed hero → party/xp/stats broke.
   The diff **cannot** see this (it is not an offset). The fix is **NOT a reseed nor an offset edit**: you
   cannot legally decode the cipher ([[invariants/obscured-data-offlimits]]), so **degrade the dead value to
   a legal source** (the save) while keeping the LIVE *identity*, and replace any discriminator that leaned
   on the dead value (the `lvl>0` ghost filter → a catalog-heroKey check — [[invariants/party-live-resolution]]).
   **Takeaway: a GREEN step 3 is necessary but NEVER sufficient — step 6 (`validate_live`, ALL metrics) is the
   only catcher for bucket 4.**

## Checklist (in order)

1. **Fingerprint — recompile or content only?** Read the new `GameAssembly.dll`'s PE header
   (`TimeDateStamp` + `SizeOfImage`) with the same formula as `il2cpp/typeinfo.py::build_fingerprint`,
   and the installed version from the `Version.txt` next to the `.exe`. Compare the native part against
   the committed seed's key:
   - **Same** → **content**-only patch: offsets/indices intact by construction; only the version
     string changed. Skip straight to step 4 (re-seed).
   - **Different** → native **recompile**: offsets/indices MAY have shifted. Do steps 2+3
     before trusting it.
2. **IL2CPP dump of the new build.** TBH's `global-metadata.dat` is unencrypted (magic `af1bb1fa`);
   run Il2CppDumper (via `dotnet`) over `GameAssembly.dll` + `global-metadata.dat` → `dump.cs`
   (with field offsets + `TypeDefIndex`). It's a static read, no need for the game to be running.
3. **Static preflight — ONE COMMAND** (ruff + pytest + the code↔game tripwire). Run
   `scripts/preflight_calib.py --dump <out/dump.cs> --seed config/calib_seed.json`: it runs
   `ruff`, the `pytest` suite (regression — includes the docs↔code drift-test and the pinned
   `PlayerSaveData` offsets), and then `scripts/diff_offsets_vs_dump.py` (which imports
   `config/offsets.py` LIVE and checks every offset+field NAME of each named class, every enum by
   VALUE, and the seed's `TypeDefIndex`/`idx_ut`), and at the end PRINTS the `validate_live.py`
   command (the live layer of step 6, which it CANNOT run). **Always pass `--seed config/calib_seed.json`** —
   without it, index/`idx_ut` drift stays invisible until you re-seed.
   - **Exit 0** → every static layer passed; nothing the reader tracks *by offset/index* has shifted. Proceed
     to the re-seed — but green here only rules out buckets 2–3; a **bucket-4 encoding change** (e.g. 1.00.20's
     dead `fakeValue` decoy) stays invisible until **step 6**. NEVER ship on a green preflight alone.
   - **Non-zero** → STOP. A `✗` in the diff = update the shifted symbol in `config/offsets.py` (the
     single source — [[invariants/offsets-single-source]]) from `dump.cs` and re-run until it's clean;
     a ruff/pytest failure = a code regression. A missing dump FAILS on purpose (no diff = no
     knowing — the 1.00.12 trap). **Look at the diff's per-class dump** for a class whose offsets
     didn't change but whose field NAMES shifted (the only residual silent case).
   - **Obfuscated-name** classes (drift per build: `UnitHealthController`/`HeroRuntime`/
     `StatsHolder`/`AggregateManager`/`StatModifier`) come out as "unverifiable" — the diff can't
     find them by name; what validates them is the live run in step 6.
   - (Want just the tripwire? Run `scripts/diff_offsets_vs_dump.py` directly; the preflight just wraps
     ruff+pytest around it so a re-seed never skips the regression.)
4. **Re-seed for the new build.** With the game **open and in combat** (gold rising — the gold
   value-scan and the catalogs need this), run `scripts/seed_calib_capture.py`: it forces a full scan,
   discovers `anchor_rva`/`indices`/`idx_ut`, captures the catalogs and writes a FRESH `calib_seed.json`
   in the current `CACHE_FMT`, keyed by the new fingerprint. (If a `CACHE_FMT` bump is part of the work,
   the re-seed is MANDATORY in the same PR — see [[invariants/cache-management]].)
5. **Bump `meter_windows.py::GAME_VERSION`** (the fallback) to the new version. It's only a fallback (the
   live version comes from `Version.txt`), but it keeps the single source honest — it's the ONLY definition
   ([[invariants/offsets-single-source]]).
6. **Validate live — MANDATORY GATE, ALL metrics.** Run `--selftest` (seed shape:
   `fmt == CACHE_FMT` + non-empty calib) and then, with the game IN COMBAT on a stage, run
   **`scripts/validate_live.py`**: it resolves from the seed (just like the RC's 1st launch) and requires **PASS
   on ALL** — `calib/seed`, `gold`, live party, live xp, `stage`, catalogs. Exit != 0 = do NOT
   ship. This covers the OBFUSCATED classes the step 3 diff does NOT see (gold = `AggregateManager`;
   party+xp = `HeroRuntime`; stats = `StatsHolder`) — the blind spot where bugs slipped through.
   **NEVER validate only the field you fixed** ([[process/live-validation-gate]]): in 1.00.11 the
   gold was checked and the party (from the obfuscated `HeroRuntime`) came out broken because nobody looked at the rest.
7. **Ship.** Commit the new `calib_seed.json` + the bump; the seed ships embedded in the `.exe` (`--add-data`),
   so the fix only reaches players via a promoted release — see [[invariants/cache-management]].

## Related
- [[process/live-validation-gate]] — the mandatory live GATE from step 6 (all metrics, not just the fixed one)
- [[invariants/party-live-resolution]] — the live party / honest degradation that the gate confirms
- [[invariants/cache-management]]
- [[invariants/rva-index-resolution]]
- [[invariants/gold-singleton-resolution]]
- [[invariants/offsets-single-source]]
- [[process/value-mapping-method]]
