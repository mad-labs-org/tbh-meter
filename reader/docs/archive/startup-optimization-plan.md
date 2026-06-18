---
type: archive
status: superseded
description: "SNAPSHOT histórico (RE cru ou plano entregue) — nomes/offsets/linhas podem estar obsoletos; a verdade atual está nas notas vivas (ver _index). Isento do drift-test de código."
---

# tbh-meter cold-startup optimization plan

## RVA resolution — IMPLEMENTED (branch `perf/meter-startup-optimization`)

> This section supersedes plan item **"Embed an RVA seed cache / fixed-RVA class addresses"** in *Rejected/deferred*. That item rejected fixed RVAs for the **Il2CppClass addresses themselves** — correctly, they live on the ASLR heap. What shipped instead resolves classes by a **fixed-RVA pointer to the runtime's TypeInfoTable**, which the runtime rewrites every launch. The class addresses stay dynamic; only the *anchor that locates the table* is build-stable. So the rejection stands and this is a different (valid) mechanism.

**What it does.** Replaces the ~280s cold start (class-resolve ~190s + gold value-scan ~90s on Mario's box) with deterministic resolution by **RVA + TypeInfoTable + TypeDefIndex** — name-free, gated by a build fingerprint, with the scan as a permanent fallback (zero-regression risk).

### The chain
```
module_base(GameAssembly.dll) + anchor_rva   →  [ptr]  s_TypeInfoTable base (heap, ASLR)
s_TypeInfoTable + TypeDefIndex * 8            →  [ptr]  Il2CppClass*
```
`anchor_rva` is a **fixed offset within GameAssembly.dll** (build-stable); the runtime rewrites the pointer there with the current table base on every launch, so reading `[ga_base + anchor_rva]` live always yields the current table. `TypeDefIndex` is a constant of the build. Both survive game restart **and** OS reboot (proven live: `ga_base` moved `0x7ffd…→0x7ff8…`, `anchor_rva` + indices identical). Implemented in `il2cpp/typeinfo.py` (`table_base`, `class_by_index`, `class_name`); the gold singleton is resolved by the same table at `idx_ut` in `metrics/gold.py::resolve_combat_gold_klass_by_index`.

### Self-calibrating cache (fingerprint-keyed, calib-only)
`resolve_cache.json` is **`CACHE_FMT 9` — calib-only** (was 8; later bumped for ACTBOSS x-10 stages): a `calib{fp: {...}}` block keyed by build fingerprint. The legacy block of absolute addresses (`sc_class`/`msm`/`lm`/… + `load_cache`/`save_cache`/`_managers_ok`) was **removed** — the fast path stores no absolute address, so there is nothing to revalidate by address.

- **fingerprint** = `f"{version}-{TimeDateStamp:#x}-{SizeOfImage:#x}"` (PE header of GameAssembly.dll + installed `Version.txt`). Reinforced with the version because `TimeDateStamp` can be `0` on deterministic builds and `SizeOfImage` can collide across rebuilds (`typeinfo.build_fingerprint`).
- **calib[fp]** holds: `anchor_rva` (RELATIVE → ASLR-stable), `indices{name: TypeDefIndex}`, `idx_ut` (gold singleton index), and the build-stable catalogs (`stage_info`/`item_cat`/`hero_cat`).
- **atomic write** (`save_calib`): `json.dump` → `.tmp` → `flush`+`os.fsync` → `os.replace` (atomic on the local `~/tbh-meter` volume); a mid-write kill never truncates/poisons the cache. **Persist-gate of completeness**: only persists if all three catalogs are non-empty (a scan run *outside* a stage would otherwise persist empty catalogs and serve degraded data forever for that fp).

### Fallback chain (zero-regression)
```
calib[fp] (build-stable)  →  scan + calibrate
```
The fast path **revalidates live every launch** — class round-trip (`class_name(class_by_index(idx)) == name`) **+** singleton instance size (`_manager_inst_ok`) **+** gold round-trip (`combat_gold_klass_ok`). ANY sanity-fail (bad anchor, wrong index, stale calib, drifted build) → `_resolve_fast` returns `None` → `resolve_all` falls to the guaranteed scan. It degrades, never poisons. On an **unknown build** (new fp) behavior is identical to today (scan), plus a one-time extra calibration step.

### Per-build calibration flow
- **First cold start on a new build** (no `calib[fp]`): runs the scan once (~280s), then `_calibrate` runs `typeinfo.discover_anchor` (deterministic: backref one known class → derive the dense-table base → verify ALL known classes appear at an index, false-pass-proof) + `gold.find_gold_index`, and persists `calib[fp]`.
- **Every launch after** (same fp): `_resolve_fast` — no scan.
- **Game patch** changes the PE fingerprint → `calib[fp]` misses → auto-recalibrates once (one slow start), then fast again. No human step, no hardcoded index.

### Timing
**Fast path `ready` ≈ ~10-12s** (≈25× vs ~280s), **not** ~1-2s. The class/manager/gold resolution itself is ~ms (index + bbwf), but `PlayerSaveData`/`CommonSaveData` are **not singletons** (`bbwf→None`) and are needed BEFORE the startup's first `new_run()` (build/heroes/gold baseline). They come from one directed synchronous backref (`resolver.instances_of`, single-sweep #110, ~8s) — which dominates the fast path. A future "save-manager singleton" probe could take PSD instant → ~1-2s (follow-up, out of scope).

### Name-free / build-stable summary
- **name-free** (§3): classes resolved by **index/structure**, never by name. The obfuscated gold singleton (`ut`→`uu` drift) is resolved by `idx_ut`, never by name. `class_name` is used ONLY to *validate* (round-trip), never to *pick*.
- **build-stable**: `anchor_rva` (relative), `indices`, `idx_ut`, catalogs — all constants of a build, keyed by fingerprint.
- **dynamic per launch**: `ga_base` (ASLR), `table_base` (rewritten by runtime), instance addresses (GC) — all re-read live.

### Validated reference (build v1.00.07)
`ANCHOR_RVA = 0x5b070e0`; fingerprint PE = `(TimeDateStamp 0x6a203f51, SizeOfImage 0x62ea000)`; gold `idx_ut = 2744`. TypeDefIndex reference set: `StageManager 2592 · CommonSaveData 2612 · PlayerSaveData 2616 · GetBoxLog 2822 · HeroDieLog 2823 · LogManager 2831 · ResurrectionLog 2837 · StageClearLog 2838 · StageFailedLog 2839 · CurrencySaveData 2918 · HeroSaveData 2919 · MonsterSpawnManager 2931 · HeroInfoData 3198 · ItemInfoData 3207 · StageInfoData 3269`. These are the **proof reference / regression check**, NOT production hardcodes — production learns them per-build via calibration. Live end-to-end verification: `tbh-meter-dev/rva_integration_probe.py` (run on Windows, in combat) exercises Phase A (scan+calibrate) vs Phase B (fast path), asserts equivalence (same class K's, same gold, identical catalogs) + the ~280s→~10-12s speedup.

---

## Seed-calib — IMPLEMENTED (2026-06-06, branch `improve-startup`)

> Kills the ~70s FIRST-run scan on a SHIPPED build (the RVA work above only made *subsequent* launches fast — the first launch per build still scanned once). Validated live: `tbh-meter-dev/seed_calib_probe.py` — **20/20 equivalence PASS, seed-path 7.8s vs scan 73.4s (~9x)**, seed loaded in 3.5ms, catalogs/gold/classes identical, corrupted seed → `_resolve_fast` None (degrades, never poisons).

**Mechanism.** The build-stable `calib[fp]` block (anchor_rva relative + indices + idx_ut + catalogs) ships as a read-only JSON `reader/config/calib_seed.json`, bundled via PyInstaller `--add-data`. `load_calib` checks the user cache (`~/tbh-meter/resolve_cache.json`) FIRST, then falls back to the bundled seed (`_seed_path` → `resource_path`). First launch on the build the reader shipped against hits the fast path (~6.6s) instead of scanning (~70s).

**Zero new trust (the seed is just a hypothesis).** `_resolve_fast` live-revalidates every calib it loads (class-name round-trip + manager List size + gold round-trip) and degrades to the guaranteed scan on ANY mismatch — a stale/cross-build seed is simply an fp MISS → scan, never wrong data. User cache wins (a locally-learned calib supersedes the seed). Distinct from the rejected "fixed-RVA class addresses" (heap/ASLR): the seed embeds NO absolute address (table_base/ga_base/instances re-derived live). `CACHE_FMT` unchanged by seed-calib (later bumped 8→9 for ACTBOSS x-10 stages — same calib shape).

**Freshness (per game build, at release).** `scripts/dump_calib_seed.py` extracts `calib[fp]` from the maintainer's learned `resolve_cache.json` (after one in-combat run on the build being shipped) → `config/calib_seed.json`, with the same persist-gate (non-empty catalogs) as `save_calib`. Commit the result; `--selftest` validates the bundled seed's shape at CI build time (seed-optional: a brand-new build with no seed yet still releases).

**Wiring:** `meter_windows.py` (`_seed_path` / `load_calib` seed fallback / `_read_calib`), `config/calib_seed.json` (v1.00.09 seed), `scripts/dump_calib_seed.py`, `release/promote-tbh-meter.yml` (`--add-data`), `tests/test_calib.py` (4 fallback tests + seed-isolation fixture; 259 reader tests green, ruff clean).

## scan-free-anchor (route c) — FALSIFIED (2026-06-06)

Goal was to find `s_TypeInfoTable` without `known_K`, killing the scan on EVERY build (incl. post-patch). Prototyped in `tbh-meter-dev/rva_probe8.py` and it FAILED on two axes: (1) **not decisive — 493 in-module pointers passed the class-density gate** (false_accept=492; the real table was selected only by lowest-value luck, not a principled rule); (2) **not faster — the sweep took 79.6s, SLOWER than the ~73s scan it would replace** (104,705 qwords density-tested). The probe's binding gold check (idx_ut by structure == value-scan oracle) and the 2nd-pointer diagnostic both PASSED — so gold-by-structure derivation is sound — but anchor LOCATION by class-density alone is neither unique nor cheap. **Dropped:** seed-calib already removes the first-run scan for the common (shipped-build) case; the residual one-time scan on a build AHEAD of the shipped seed is acceptable. Reviving route (c) needs a fundamentally stronger AND cheaper discriminator (open).

---

> Produced by a fan-out/verify workflow (6 startup-slice profilers → 6 ideation lenses + gap critic → 42 adversarial verifications). Every claim below was vetted against the domain invariants (name-free resolution, cache-correctness, ObscuredInt off-limits, dict strides, run lifecycle, unsigned/AV reality). Timings are mostly **estimates** — the repo has only a few measured numbers (#110 commit); see *Open questions* for what to instrument before committing effort.
>
> **NOTE (2026-06-06): this lower half is the ORIGINAL plan, partly OVERTAKEN by what shipped above.** C1 (atomic writes) shipped in `save_calib` (tmp + fsync + `os.replace`). The first-run gold value-scan now runs ONLY on a not-yet-calibrated build — RVA + seed-calib removed it for shipped/calibrated builds — so A1's "defer the gold scan" is largely moot. The `meter_windows.py:NNN` / `shared/memory.py:NNN` line numbers below predate the RVA refactor and no longer line up — treat them as descriptive, not exact. **B1** (C-extension `scan_i64_range`) and **D1** (module-span scoping) remain valid levers for the residual first-run-per-build scan.

## TL;DR — the 5 highest-leverage moves

1. **Defer the ~57-62s gold value-scan off the boot path.** Emit `ready` the moment class/instance resolve finishes (~21-30s) and serve run #1's gold from the save-delta fallback that *already exists*. Perceived cold start **~85s → ~25s**. No wall-clock saving — but it's the single biggest *felt* win, fully code-grounded, zero invariant risk.
2. **Rewrite `scan_i64_range` as a native (C-extension) inner loop.** The only real *wall-clock* lever on the ~57-62s scan: **~57s → ~2-5s** (I/O floor). The pure-Python per-qword range test is exactly the residual #110 could not touch (a range test can't use the `set.intersection` trick).
3. **Cut cold-restart *frequency*, not just duration.** The worst real-world symptom ("Starting up" forever) is AV killing the unsigned reader mid-resolve (~85× in 7 min on a real user box), never the duration of one resolve. Atomic cache writes + persist class-resolve *before* the gold scan + a freshly-built PyInstaller bootloader attack this.
4. **Scope the class-resolve passes to the `GameAssembly.dll` module span** (~2.6GB → ~96MB). **~16-17s off** pass1+pass2, byte-identical output, name-free, zero-dep.
5. **`--onefile` → `--onedir`** to kill per-launch self-extraction and shrink the AV trigger surface (~0.5-3s/spawn, compounded across the 5s no-game re-spawn poll).

The strategic split that the verification surfaced: **(1) and (5)/(3) cut *perceived* and *frequency* cost; (2) and (4) cut *wall-clock*.** They are orthogonal and stack. Do the cheap perceived/robustness wins first (days), then the C extension (the only thing that actually shrinks the 57s).

---

## Where the time goes — cold start ≈ 90-160s

| Stage | Est. cost (cold) | Blocks first-data? | Bottleneck |
|---|---|---|---|
| Electron boot + reader spawn | ~0.5-3s | yes | onefile re-extracts to `%TEMP%\_MEIxxxx` **every** launch; re-paid on the 5s no-game poll |
| `find_pid` + attach + `module_base` | <1s | yes | Toolhelp snapshot, not a scan |
| `load_cache` + `_managers_ok` | warm <1s / cold ~0 | yes | decides cold vs warm; any name-drift / ASLR mismatch → full cold |
| Class resolve **pass1** (name-strings) | ~8s | yes | O(needles×bytes) string loop, **unchanged by #110** |
| Class resolve **pass2** (ptr→name) | ~9s (was 305s) | yes | single-sweep since #110 |
| Class resolve **pass3** (ptr→class) | ~12s (was 52s) | yes | single-sweep since #110 |
| **Gold value-scan** (`scan_i64_range`) | **~57-62s** (up to ~106s) | **yes** | **`shared/memory.py:253-275` — pure-Python `for v in struct.unpack(...): if lo<=v<=hi` over the whole writable heap. The prime target.** |
| save/cache + first `meter_live.txt` write | ~1-1.4s | yes | needs 2 polls @700ms to see mtime advance |

Two compounding facts make the gold scan the prime target:
- It is a **range** test, so it cannot use the C-speed `set.intersection` that made the #110 pointer scan independent of needle count. The comparison stays interpreted, per-qword, over multi-GB.
- It is **gated behind the full class resolve** (the search band is centered on `combat_gold_save`, which needs `PlayerSaveData` resolved) and runs **unconditionally** inside `resolve_all` on every cold start — and a **second time** at `meter_windows.py:301-302` if the cached `gold_klass` goes stale.

---

## Recommended optimizations

Ranked within each group by impact/effort. `[verdict]` is the workflow's adversarial recommendation.

### A. Make the gold scan invisible — *do first, biggest perceived win*

- **A1. Defer the gold value-scan off the boot path; resolve `gold_klass` lazily on first run-start.** `[prototype · high impact · medium effort]`
  `gold_klass` is provably the **only** product of `resolve_all` that needs the value-scan (`meter_windows.py:243-245`), and it has **no consumer** until a run begins (`new_run()` baseline `:329`, `close_run()` delta `:389`). Everything the user watches live — DPS, mobs, party, stage — is already resolved without it. Split `resolve_all` into `resolve_core` (classes+managers) and a deferred `resolve_gold`; emit `ready` after core. Run #1's closing gold delta is served from `gold_save_start`, the save-delta fallback **already wired** at `:329-330`/`:389-394`. Net perceived: **~85s → ~25s**; wall-clock unchanged.
  *Stay safe:* this is pure ordering/protocol — no new cached or trusted value, so the cache-correctness invariant is untouched. `reader-process.ts:144-156` parses status lines forgivingly and the app already tolerates an older reader, so a new `gold-ready` phase is backward-safe both directions.

- **A2. Two-phase status: `ready` (live/DPS) then `gold-ready`.** `[prototype]` The protocol half of A1 — keep a distinct `gold-ready` marker so the app can show a subtle "gold resolving…" indicator without holding the splash.

### B. Make the gold scan actually faster — *the only real wall-clock lever*

- **B1. Ship a CI-compiled C extension for the `scan_i64_range` inner loop.** `[prototype · high impact · medium effort]`
  The syscall read is cheap; the **interpreted per-qword range filter is the ~57-62s residual**. A native loop (build in the existing Windows CI, bundle the `.pyd`) takes the scan to its I/O floor (**~2-5s**). numpy is disallowed (bundle/AV), so a tiny purpose-built extension is the route. **~50s off cold start.**
  *Risk:* adds a compiled artifact to an unsigned bundle (AV surface) and a CI build step; keep a pure-Python fallback if the `.pyd` fails to load so resolution never *breaks*, only slows.

### C. Cut cold-restart frequency — *attacks the "infinite Starting up" root cause*

- **C1. Atomic cache writes (`tmp` + `os.fsync` + `os.replace`).** `[ADOPT · small effort · low risk]`
  `meter_windows.py:283-285` writes the cache non-atomically; a kill inside the `json.dump` window leaves a truncated file that silently forces a full ~90-160s cold re-resolve. `os.replace` is atomic on `~/tbh-meter` (local volume). Cheap robustness hygiene — **not** a speed win, but a prerequisite that makes C2/checkpointing safe. Ship it.
- **C2. Persist the class/instance resolve to cache *before* the gold scan.** `[investigate]`
  The class portion is fully validated at that point (name + element/cast self-ref round-trips), so persisting it respects cache-correctness. A kill landing in the gold-scan window then yields a *classes-only warm* next start (skips ~21-30s) instead of a full cold redo. Bounded benefit (kills often land in the first ~5s, before class resolve completes) — pairs with A1, which shrinks the unprotected window.
- **C3. Freshly-built PyInstaller bootloader + pinned version.** `[prototype · small effort]`
  Most AV false-positives key off the byte-identical prebuilt bootloader stub in the pip wheel. Compiling it locally yields a unique stub that evades signature blocklists. Cuts kill *frequency* on AV-affected boxes; ~0 on clean machines.
- **C4. Code-sign the reader exe.** `[investigate — already evaluated/deferred 2026-06-04]`
  Correctly targets the dominant real-world cost (kill frequency), but conflicts with the prior cost/effort decision (Azure ~$10/mo + EV cert). Revisit only if the AV tail keeps dominating support load.

### D. Class-resolve scoping & packaging — *honest medium wins*

- **D1. Scope pass1+pass2 to the `GameAssembly.dll` module span.** `[prototype · medium effort]`
  Use the existing `module_base()` + `MODULEENTRY32.modBaseSize` to confine the name-string and ptr→name passes to the ~96MB image instead of all ~2.6GB / 1150-1540 readable regions. Byte-identical, name-free, zero-dep. **~16-17s off.** (pass3 still needs the full region set for instances.)
- **D2. `--onefile` → `--onedir`.** `[prototype · medium effort]`
  Kills the per-launch `%TEMP%` re-extraction (`release-tbh-meter.yml:127`) and the repeated churn across the 5s no-game re-spawn loop; also shrinks the AV trigger surface. ~0.5-3s/spawn.

### E. Perceived-progress polish — *0s wall-clock, real felt improvement*

- **E1. Determinate splash: per-phase progress + live elapsed timer + adaptive ETA.** `[prototype · low risk]`
  Today's splash (`SplashApp.tsx`) shows an indeterminate bar + a static "1-2 min" string over a ~90s wait, so it feels stalled/unbounded. Extend the `[[STATUS]]` protocol with the coarse milestones the reader already passes (`resolving 1/4 names … 4/4 gold`) and compute a machine-specific ETA from persisted past runs. Side benefit: an accurate bounded ETA reduces *user-initiated* kills that trigger the AV-churn loop.
- **E2. Fine-grained `[[STATUS]]` sub-phases** ("attached", "found StageManager", "building stage catalog", "resolving gold") rendered as a ticking checklist. `[prototype]`

---

## Suggested sequencing

1. **C1 atomic writes** — hours, pure robustness, unblocks C2. Ship immediately.
2. **A1 + A2 defer gold scan** — the biggest perceived win, no invariant risk, uses an already-wired fallback. This is the headline change.
3. **E1 splash progress/ETA** — pairs naturally with A1's new phase markers; cheap, reduces panic-kills.
4. **D1 module-span scoping** — clean ~16-17s off the part that *does* still block `ready` after A1.
5. **B1 C extension** — the only thing that shrinks the 57s itself; highest effort, do once the cheap wins are banked and you've **measured** the real scan cost.
6. **C2 / C3 / D2** — AV-resilience + packaging, as the support data justifies.

After 1-4, a clean cold start *feels* like ~25-30s and the AV-kill loop is far less likely to strand a user. B1 then makes the actual wall-clock match the feel.

---

## Rejected / deferred (so they aren't re-litigated)

All vetted against the code; rejected with reasons:

- **Coarse-prefix set-membership "range" scan (adapt the #110 trick)** — misunderstands why #110 was fast; a range test fundamentally can't be reduced to `set.intersection`.
- **Byte-signature / 2-byte-prefix chunk skipping before unpack** — discriminating power far too weak at heap scale; nearly every chunk survives the filter.
- **Two-stage band (tiny scan, widen on miss)** / **persist last-good gold band hints** — `scan_i64_range` reads the *entire* writable heap regardless of band; a narrower band doesn't reduce bytes swept.
- **Multi-threaded gold scan / run gold scan concurrently with pass1-3 / with the 10Hz loop / prefetch is the *only* win** — the scan is **GIL-bound compute**, not I/O-bound; threads don't overlap the interpreted loop. (Prefetch I/O double-buffering survives as a *minor* B-tier idea, single-digit seconds.)
- **Fuse the gold range-scan into the pass2/pass3 sweep** — different operation (range vs pointer equality); fusing doesn't remove the per-qword compute.
- **Batch per-candidate signature validation / pipeline pass1→2→3 / parallelize the 3 passes** — optimize the already-cheap (#110) class passes, not the 57s scan.
- **Embed an RVA seed cache to skip the *first* cold scan** / **fixed-RVA class addresses** — IL2CPP class/singleton addresses are **not** at fixed RVAs off `GameAssembly.dll` for this Unity 6000 build; premise false. (RVA *rebasing within a session/restart* survives as INVESTIGATE — see C2/cache-split.)
- **Lazy-resolve non-critical log classes to shrink the needle set** — pass1 is O(needles×bytes) but the needle count is already tiny; win doesn't survive the added complexity/risk.
- **`--runtime-tmpdir` on onefile** / **`-OO` + `--exclude-module` bundle trim** — wrong target (the ~1-4s packaging slice, not the 57s scan).
- **Optimistic warm-start shell before live data confirms** — misses the brief (cold scan is the target).
- **Background pre-attach warm thread / keep-resident across restarts / early-spawn at login** — masks/relocates the resolve (single-digit seconds of poll latency); doesn't shorten the scan. *Early-spawn-at-login* is the best of these as an optional later UX feature.

---

## Open questions / things to measure (do before B1/D1)

The repo has **estimates**, not a real per-phase breakdown. Instrument first:

1. **Per-phase timing in `meter.log`.** Wrap pass1/pass2/pass3, `scan_i64_range`, and the second gold-validation (`:301-302`) with elapsed logs. Confirm the ~57s is really the per-qword loop and not the per-candidate `_inner_array_of` validation (`gold.py:180`).
2. **How much of `scan_i64_range` is RPM vs compute?** Decides whether B1 (native loop) is worth it vs the cheaper prefetch idea. (Verification strongly predicts compute-dominated, but measure.)
3. **`GameAssembly.dll` RVA stability** across game restarts (same build) and across builds. Gates C2's RVA-rebasing and D1's confidence.
4. **GC-heap locality** — does the live gold cell co-locate with already-resolved managed objects in a small segment? If yes, a locality-ordered early-exit scan (`[investigate]`) could beat even the C extension on the common case.
5. **AV-kill frequency in the field** — the error-relay (#165) data should quantify how often kills land *before* class resolve vs *during* the gold scan, which decides C2/C3/C4 priority.
