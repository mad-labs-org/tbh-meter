---
type: invariant
description: "CACHE_FMT bumps when the SHAPE of the calib block changes; every bump REQUIRES recapturing config/calib_seed.json (seed.fmt must == CACHE_FMT) — otherwise the RC's --selftest fails and the runtime rejects the seed by fmt and falls to a cold scan. Catalog VALUE validation (stage_info via _stage_info_ok, on both the save AND load gates) does NOT bump fmt — it rejects the calib and degrades down the ladder (seed → scan), self-healing a poisoned cache (persistent \"?\" mode). Completeness-vs-seed (_covers_seed_keys, also on both gates): a HOLEY catalog — missing some key the SAME fp's seed has — never persists nor shadows the seed."
symptoms:
  - "cache stale"
  - "stale cache"
  - "calib_seed outdated"
  - "seed fmt mismatch"
  - "CACHE_FMT"
  - "calib_seed"
  - "cold scan"
  - "scan every time"
  - "scan every launch"
  - "fast path not activating"
  - "fmt"
  - "selftest FAILED calib_seed"
  - "persistent ? mode"
  - "stage mode ? every run"
  - "poisoned catalog"
  - "poisoned cache"
  - "diff -1 in stage_info"
  - "hole in catalog"
  - "stage missing from catalog"
  - "stage ? only on a specific stage"
  - "cache with fewer stages than seed"
code_anchors:
  - meter_windows.py::CACHE_FMT
  - meter_windows.py::_stage_info_ok
  - meter_windows.py::_covers_seed_keys
  - il2cpp/resolver.py::resolve_via_rva
  - config/calib_seed.json
asserts:
  - meter_windows.CACHE_FMT == 9
guarded_by:
  - tests/test_calib.py::TestTolerateOldJson::test_old_fmt_returns_none
  - tests/test_calib.py::TestSeedFallback::test_seed_fp_miss_returns_none
  - tests/test_calib.py::TestAtomicityAndMerge::test_written_file_has_current_fmt
  - tests/test_calib.py::TestPoisonedCatalogSelfHeal::test_poisoned_user_cache_falls_through_to_seed
  - tests/test_calib.py::TestPoisonedCatalogSelfHeal::test_holey_user_cache_healed_by_seed_same_load
  - tests/test_calib.py::TestSeedCoverageGateLoad::test_cache_missing_seed_stage_key_serves_seed
  - tests/test_calib.py::TestSeedCoverageGateLoad::test_cache_with_extra_keys_beyond_seed_served
  - tests/test_calib.py::TestSeedCoverageGatePersist::test_holey_stage_info_not_persisted_when_seed_covers_fp
  - tests/test_calib.py::TestSeedCoverageGatePersist::test_no_seed_for_fp_persists_as_today
  - tests/test_calib.py::TestPersistGate::test_invalid_diff_stage_info_not_persisted
  - tests/test_meter_windows.py::test_bundled_seed_passes_load_validation
---

# Cache management (CACHE_FMT + calib_seed)

The reader no longer stores absolute addresses. The only persisted artifact is the **`calib[fp]`
block** — a **build-stable** pair `{anchor_rva, indices{name:idx}, idx_ut, stage_info, item_cat,
hero_cat}`, written to the user's `resolve_cache.json` (learned at the end of a scan, in
`save_calib`) and to the **bundled seed** `config/calib_seed.json` (captured offline, committed, and
shipped inside the `.exe` via `--add-data`). This is what lets the FIRST launch on a shipped build
skip the ~70s scan (it becomes ~ms).

**The hard rule.** `CACHE_FMT` (the only live definition lives in `meter_windows.py`) bumps
**whenever the SHAPE of the calib block changes** — a new key, a different shape for a catalog, new
semantics for a field. The current `9`, for instance, started including the ACTBOSS stages (x-10)
in `stage_info`; calibs written under the previous shape lack those keys, and since the fast path
would reuse them forever, the bump forces ONE re-scan. **But bumping `CACHE_FMT` ALONE is a
half-bump that breaks the seed:** the committed `calib_seed.json` still carries the old `fmt`, on
TWO fronts:

1. **Build-time** — `--selftest` (run in the RC's CI) reads the seed and requires `seed.fmt ==
   CACHE_FMT`; on a mismatch it prints `selftest FAILED: calib_seed.json bundled but malformed` and
   exits with code 1 → **the RC won't even build**.
2. **Runtime** — even if it got through, `_read_calib` rejects any file whose `fmt` doesn't match
   `CACHE_FMT` (returns `None`), so `load_calib` ignores the stale seed and run() degrades to the
   guaranteed scan → **a cold scan on EVERY first launch of the build** (exactly the bug class
   "scan every time / cache stale").

**The recipe when bumping `CACHE_FMT`:** run the capturer (`scripts/seed_calib_capture.py` —
zero-arg, does a live scan and stamps the current `fmt`) to **recapture**
`config/calib_seed.json` in the new format, and update this note + the `assert`
(`meter_windows.CACHE_FMT == 9`). The shared `reader/` may be on an old fmt → sync HEAD before
capturing, or the seed comes out stamped wrong.

**Why this is SAFE even if the seed is old/from another build.** The calib is **build-keyed by
fingerprint** (`fp` = version + module hashes, computed live in run()): a seed that doesn't cover
the current `fp` is a plain MISS (`load_calib → None` → scan), never poisons. The **user cache
takes priority** over the seed (`load_calib` tries `resolve_cache.json` first, then the bundled
seed) — priority CONDITIONED on completeness-vs-seed: a cache whose catalogs don't cover every key
of the same `fp`'s seed is a holey catalog, and the seed is served instead (see the hole section
below). And the seed is **zero new trust**: the fast path (`_resolve_fast` → `resolve_via_rva`)
**revalidates live on every launch** — class-name round-trip (`class_name(K) == name`) + instance
`size` sanity (plus the gold round-trip) — and degrades to the scan on ANY mismatch. That's why
`_read_calib` loads the block as "raw data, validated by the caller": it stores no absolute address
(the `anchor_rva` is RELATIVE to `ga_base`, re-read per ASLR on every start), so there's no "stale
address" to revalidate — only semantic round-trip, always.

**Write hygiene.** `save_calib` only persists through a **completeness persist-gate** (all three
catalogs with `len > 0`, `stage_info` with every row VALID, and the catalogs covering every key of
the same `fp`'s seed when it exists — see the two sections below) — a scan run OUTSIDE a stage
would write an empty catalog, and the fast path would serve it degraded forever for that `fp`. And
it writes **atomically** (`.tmp` + `fsync` + `os.replace`), so a kill mid-write never leaves the
cache truncated/poisoned.

**Catalog VALUE sanity (no fmt bump).** Unlike the anchor/indices, the **catalogs have no live
round-trip** in the fast path — what's in the calib is served as-is. So `stage_info` passes through
the `_stage_info_ok` gate (every row in the 4-int shape with `diff` inside `EStageDifficulty`, the
keys from `DIFF_NAMES`) at **two points**: on **persist** (`save_calib` rejects a catalog with a
suspect row — a scan misread never becomes calibration) and on **load** (`_read_calib` rejects the
block → `load_calib` falls to the seed → scan). The real case: the old `_read_catalogs` catalogued
a horde row with an unreadable `DIFFICULTY` as diff `-1` → `DIFF_NAMES.get(-1)` = mode `"?"` on
EVERY run, persisted to `resolve_cache.json` and surviving restarts. The load-gate **self-heals**
that cache: the poisoned block is rejected, and the seed (or the scan, which re-calibrates and
overwrites `calib[fp]`) serves the sound catalog — without the user deleting anything. This is
VALUE validation, not a SHAPE change: it does **not** bump `CACHE_FMT` (and `--selftest` runs every
fp of the seed through the same `_read_calib`, so a seed the runtime would reject fails in CI, not
in production).

**A HOLEY catalog never shadows the seed (completeness-vs-seed, no fmt bump).** The
`_read_catalogs` row gate DROPS the misread row instead of cataloguing it with garbage — which
trades the poison for a **hole**: a catalog missing a stage passes ALL the VALUE gates
(`_stage_info_ok` doesn't know which keys should exist) and, once served/persisted, becomes "stage
missing from catalog" — mode `"?"` on just a specific stage + blind stage adoption/switch in the
loop for that stage — persisted to `calib[fp]` and **shadowing the good seed FOREVER** (nothing
re-triggers a scan; before this gate, only deleting the cache by hand healed it). The rule:
**catalogs are build CONSTANTS** — for the SAME `fp`, the shipped seed (validated live at capture)
is ground truth for WHICH keys exist, so a cache with fewer stages than the seed is provably worse.
The `_covers_seed_keys` gate requires the candidate to cover EVERY key of each catalog of the same
`fp`'s seed, at the SAME two points as the value gate: on **persist** (`save_calib` rejects the
holey catalog; the seed keeps serving on the next launches) and on **load** (`load_calib` serves
the SEED instead of the holey cache, with log `[calib] user cache ... missing seed keys:
stage_info=N ...` naming each holey catalog — remote triage via meter.log). **PRESENCE of key only,
never value comparison**: a local extra key always passes and the local value wins when present
(protects against a hypothetically stale seed under the same fp); with no seed covering the `fp`
there's no reference → everything behaves as before. Accepted cost: `load_calib` parses the seed
even on a cache-hit (~ms).

## Related
- [[invariants/rva-index-resolution]] — the fast path that consumes the calib's indices; the seed only speeds things up, never trusted without the live round-trip.
- [[invariants/gold-singleton-resolution]] — the calib's `idx_ut` feeds the gold fast path.
- [[invariants/metric-fallback-chains]] — calib→scan is the resolution's fallback chain.
