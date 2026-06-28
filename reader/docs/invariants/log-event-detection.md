---
type: invariant
description: "LogManager events are detected by KLASS-POINTER (kl == sc_class/sf_class/gb_class/...), NEVER by an ELogType field — that field was stripped from the IL2CPP dump. New event: class in TARGETS + klass in the cache + fields by offsets.py constant + per-entry exception-safety."
symptoms:
  - "new log event"
  - "detect event"
  - "ELogType"
  - "klass pointer"
  - "class pointer"
  - "GetBoxLog"
  - "StageClearLog"
  - "HeroDieLog"
  - "event not detected"
  - "log event not detected"
code_anchors:
  - meter_windows.py::TARGETS
  - meter_windows.py::run
  - meter_windows.py::BOX_KEY_BY_TIER
  - meter_windows.py::LogScanCursor
  - config/offsets.py::GetBoxLog
  - config/offsets.py::ELogType
  - metrics/events.py::EventFeed
asserts:
  - config.offsets.GetBoxLog.MONSTER_TYPE == 0x50
guarded_by:
  - tests/test_meter_windows.py::TestBoxKeyByTier::test_three_tiers_map_to_canonical_box_keys
  - tests/test_meter_windows.py::TestSuffixInt::test_no_numeric_suffix
  - tests/test_events.py::TestEventFeed::test_first_update_is_baseline_no_events
  - tests/test_log_scan.py::TestCapRotation::test_repeated_rotation_each_new_tail_detected_once
---

# Log event detection (by klass-pointer, not by ELogType)

`LogManager` keeps a `List<LogData>` (`LogManager.LOG_LIST`) where the game pushes **one
entry per event** — stage end (success/failure), box drop, hero death/revive. The loop
in `run` asks `LogScanCursor` for the **new entries** each tick and decides what each one is.
Each `LogData` is a managed object, so its **first field (offset 0) is the pointer to the
Il2CppClass** — the "K-class" of the log's concrete type — which is also the cursor's stable
**identity** for that entry.

The list is **capped at 2000** and evicts from the HEAD when full, so a `[previous_size, size)`
absolute-index scan desyncs once the cap saturates (it stops firing — every event then missed; see
the boundary section of [[invariants/run-lifecycle]]). `LogScanCursor` therefore tracks the
last-processed entry by its **object pointer**, scanning the tail backward and stopping at the first
already-seen pointer — rotation-aware, immune to head-eviction. Detection (which entries are new) is
the cursor's job; **labeling** (what each one is) is the klass-pointer comparison below.

**The hard rule: the event type is decided by KLASS-POINTER EQUALITY, never by a type
field.** The loop does `kl = reader.rptr(e)` (the entry's klass) and compares `kl == sc_class`,
`elif kl == sf_class`, `elif kl == gb_class`, `elif kl == die_class`, `elif kl == res_class`.
Each `*_class` is the Il2CppClass the resolver found for `StageClearLog`/`StageFailedLog`/
`GetBoxLog`/`HeroDieLog`/`ResurrectionLog`. **There is NO read of an `ELogType` field on the entry**
to label the event — the `ELogType` enum still lives in `config/offsets.py` (a catalog of the values),
but the *field* inside `LogData` was stripped from this build's IL2CPP dump, so there is no offset
to read. The `Dictionary<ELogType, List<LogData>>` (`LogManager.LOG_BY_TYPE`) is also **not used**
in the loop — only the flat `LOG_LIST`. Detecting by class type is what makes the read immune to the
missing type field.

(Detection ≠ **routing**: deciding WHICH run an event lands in belongs to the lifecycle. The real
case: a boss `GetBoxLog` is logged ~0.6s AFTER the `StageClearLog` and belongs to the PENDING
success, not to the run the close just opened — see [[invariants/run-lifecycle]], pending-close.)

## How to add a new event

1. **Resolve the class.** Put the log name in `TARGETS` (the list of classes the resolver
   scans/indexes). Without it, the resolver never learns that type's K and `kl ==` never matches.
2. **Store/validate the klass.** Pull the `*_class` from the dict of resolved classes (like
   `gb_class`/`die_class`/`res_class`); the index fast-path validates each class by a
   name round-trip before serving the K (any mismatch → falls back to the scan), so the klass that
   reaches the loop is trustworthy.
3. **Read the fields by `offsets.py` CONSTANT, never a magic number.** Define an offsets
   class (in the style of `GetBoxLog`/`HeroDieLog`/`ResurrectionLog`) and read through it — e.g. the
   box tier comes from `GetBoxLog.MONSTER_TYPE` (and maps via `BOX_KEY_BY_TIER`), the victim/killer from
   `HeroDieLog.VICTIM_HERO`/`KILLER_MONSTER`, the revived one from `ResurrectionLog.HERO`. Strings are
   name-keys `"Name_<key>"` → use the suffix parser, never `int()` on the whole string.
4. **Per-entry exception-safety.** A bad entry must **skip, not crash** the loop. The loop
   already has `if not e: continue`, and the `Reader` primitives (`rptr`/`ri32`/`read_string`)
   return `None` on unreadable memory (they never raise); the suffix parser also returns `None`
   on invalid input. Keep that contract in the new field — read defensively, handle `None`,
   and leave the whole tick covered by the `try/except` already in the loop. Garbage in an entry
   becomes a silent no-op, not a crash that kills the session.

**Changed the field? That's schema.** Adding the new entry to the run's `rec` is a shape change to
`runs.jsonl` → it requires bumping `SCHEMA_VERSION` and normalizing in the app (see the versioning note).

## metrics/events.py is COUNTING only (v1)

`metrics.events.EventFeed` is independent of the labeling loop above: it only counts **how many new
entries** appeared (delta of `size`, re-anchoring when the list truncates), without looking at any
type. It is not the event-detection path — it is a counter, and its size-delta is NOT how the run-close
path survives the 2000-cap: that path uses `LogScanCursor` (pointer identity, above), because a
size-delta on a head-evicting list pinned at the cap reads zero new entries and misses the clear.
**Labeling** (knowing WHICH event it is) requires the klass-pointer, as described above; the "read each
event's type" TODO in the `events.py` header was resolved in the `run` loop precisely by klass-pointer,
not by dumping the `ELogType` field.

## Related
- [[invariants/offsets-single-source]]
See also: [[invariants/run-lifecycle]] (StageClear/Failed close the run off this detection) · [[invariants/rva-index-resolution]] (the index that serves the *_class with a round-trip gate) · [[reference/run-data-map]] (the fields of each *Log) · [[invariants/schema-versioning]] (new field = bump) · [[guides/add-log-event]] (step-by-step)
