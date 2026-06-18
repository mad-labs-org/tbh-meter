---
type: invariant
description: "Managers (LogManager/MonsterSpawnManager) are picked from the scan by STRUCTURAL VALIDATION of List<T>, never by first-in-range — otherwise the dead list becomes the chosen one and no run closes."
symptoms:
  - "runs not closing"
  - "runs not appearing"
  - "runs not resetting"
  - "dead list"
  - "meter stuck at #1"
  - "recent-runs empty"
code_anchors:
  - meter_windows.py::_pick_list_singleton
  - meter_windows.py::_valid_list_size
  - il2cpp/resolver.py::_manager_inst_ok
guarded_by:
  - tests/test_meter_windows.py::TestPickListSingleton::test_picks_real_over_first_garbage
  - tests/test_meter_windows.py::TestPickListSingleton::test_prefers_largest_valid_list
  - tests/test_meter_windows.py::TestPickListSingleton::test_fallback_to_loose_pick_never_regresses_to_none
---

# Singleton instance selection (managers)

The pointer scan finds a manager's class-K (`LogManager`, `MonsterSpawnManager`) in **dozens of
slots** that are NOT the live object — vtables, copies, metadata. Picking the **first candidate
in range** `[0, cap)` grabs a garbage slot whose `List<T>` never grows (`size=0` from zeroed
memory passes a naive range check) → the list stays dead → **NO run closes** (non-deterministic
launch bug: the `StageClearLog` lands in a list the reader isn't even watching, so the run
lifecycle never sees the end).

**The rule:** the real singleton is the only one whose list offset is a **structurally valid**
`List<T>` — readable `items`, `capacity >= size`, and entries that are objects with a readable
class. Among the valid ones, pick the one with the **largest `size`** (the live list has entries;
the garbage doesn't). Structural validation in `_valid_list_size`; the pick in
`_pick_list_singleton` (with a fallback to the in-range pick just so a good resolve never regresses
to `None` in a degenerate state). The instance from the fast-path (RVA/bbwf) goes through the SAME
sanity check in `_manager_inst_ok` (`LogManager`: `size` in `[0, 100000)` — grows the whole
session; `MonsterSpawnManager`: `[0, 2000)`).

**Why this is NOT "name-free-resolution":** the class name here is STABLE (`LogManager` is not
obfuscated). The problem isn't finding the right class among names that drift — it's picking the
live **instance** among the false positives of the scan of the SAME class. These are distinct
invariants; don't confuse the two.

## Related
See also: [[invariants/run-lifecycle]] (run end depends on this live list) · [[invariants/rva-index-resolution]] (the fast-path that reuses the validated instance)
