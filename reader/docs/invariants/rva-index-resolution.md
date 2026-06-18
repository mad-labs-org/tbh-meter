---
type: invariant
description: "Classes (>= 3 letters, stable) are resolved PRIMARILY via TypeDefIndex + calibration (fast path, ~ms), with a round-trip gate (class_name == name) + instance size; ANY sanity-fail falls back to scan. The scan is the fallback, not the primary."
symptoms:
  - "resolve new class"
  - "add target class"
  - "fast path"
  - "fast path doesn't activate"
  - "calib"
  - "calibration"
  - "wrong index"
  - "TypeDefIndex"
  - "anchor RVA"
  - "never speeds up"
code_anchors:
  - il2cpp/resolver.py::resolve_via_rva
  - il2cpp/typeinfo.py::class_by_index
  - il2cpp/resolver.py::_manager_inst_ok
  - meter_windows.py::TARGETS
guarded_by:
  - tests/test_resolver_rva.py::test_name_mismatch_returns_none
  - tests/test_resolver_rva.py::test_happy_path_shape
  - tests/test_resolver_rva.py::test_msm_size_out_of_range_returns_none
  - tests/test_typeinfo.py::test_class_by_index
---

# Resolving classes by RVA index (fast path) vs. scan (fallback)

The PRIMARY path today is resolving classes via **`TypeDefIndex` + calibration**, not via the
scan. The chain (in `typeinfo.py`): `[ga_base + anchor_rva]` → live base of `s_TypeInfoTable`
(rewritten by the runtime every launch — re-read via the anchor because `ga_base` moves under
ASLR), and `class_by_index` does the raw deref `[tbase + idx*8]` → `Il2CppClass*`. The indices
are build constants, learned during a calibration and persisted in the cache by build-fingerprint.
This **kills the cold-start scan** (scanning ~GBs looking for the name strings). `resolve`
(the 3-pass scan, `il2cpp/resolver.py`) **still exists as a permanent FALLBACK** — always works,
on any build, and is what feeds the calibration the first time.

**This note is NOT "generic name-free-resolution".** Mind the historical drift: the old rule
said "classes come via scan". The scan is the fallback; the path that runs on a calibrated build
is the index. (Gold/`AggregateManager` has the obfuscated name `uu` and is handled by STRUCTURE
in its own module — it does NOT go through `resolve_via_rva`; see the gold note.)

## The rule (the anti-poisoning gate)

`resolve_via_rva` returns `(classes, instances)` in the SAME shape as the scan, or **`None` on
ANY sanity-fail** — never partial data. For each name in `targets`:

1. **CLASS — round-trip gate.** `class_by_index(idx[name])` gives a raw `Il2CppClass*`
   (`class_by_index` **validates nothing** — it's just the table deref). The validation is to
   require `typeinfo.class_name(K) == name`. `class_name` checks bounds + 8-alignment + the
   round-trip of `element_class`/`cast_class` pointing to itself. **Mismatch → `None` → scan.**
   This is why the index is never trusted on its own: a poisoned anchor/index (or build drift
   without recalibrating) reads another class in that slot, the name doesn't match, and
   resolution degrades to the scan instead of serving garbage.
2. **Singleton INSTANCE — size gate.** For the names in `SINGLETONS`
   (`MonsterSpawnManager`, `LogManager`, `StageManager`) the instance comes via `bbwf_from_klass(K)`
   and passes through `_manager_inst_ok` — the SAME sanity check as the slow path: `MonsterSpawnManager`
   requires `MONSTER_LIST` size in `[0, 2000)`; `LogManager` requires `LOG_LIST` size in `[0, 100000)`
   (the `LOG_LIST` grows for the whole session); `StageManager` is accepted as-is (the
   party-carrier check is deferred to the live pick, it does not fail here). Absurd size = menu
   garbage → `None` → scan. Class-only classes (logs, `*SaveData`, catalogs) come out with
   `instances[name] = []` — the caller resolves those instances by another path.

`class_name` **only validates, never picks** the class — the choice is by index. That's why it
returns even an obfuscated name if you hand it one (seen in `test_typeinfo`): the fast path's
stability comes from the index, the name only identifies/confirms the slot.

## Adding a new target class

Put the name (>= 3 letters, stable/non-obfuscated) in **`TARGETS`** (in `meter_windows.py`) and
**let the scan find it** — the calibration learns its `TypeDefIndex` from the K the scan resolved
and persists it in the cache; from the next calibrated launch onward it comes out via the fast
path. There's no place to hard-code an index: it is discovered and VERIFIED against the build, and
even when already cached it passes through the round-trip gate every time. **NEVER trust the index
without the gate** — an index without `class_name == name` is exactly the "wrong index / swapped
class" class of bug.

If the calibration fails (can't find the anchor/indices), the reader **never speeds up** but stays
correct via the scan; a build that doesn't speed up must be observable in the log — so prefer
seeing a "never speeds up" symptom over silencing the failure.

## Related
- [[invariants/instance-selection]] — the `_manager_inst_ok` size-gate is the SAME `_pick_list_singleton`/`_valid_list_size` as the scan; the fast path reuses the validated instance.
- [[invariants/gold-singleton-resolution]] — the obfuscated `uu` stays OUT of here (resolved by STRUCTURE, not by index).
- [[invariants/cache-management]] — the calib indices are persisted by build-fingerprint; a `CACHE_FMT` bump invalidates them.
