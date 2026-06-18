---
type: guide
description: "Recipe for capturing a NEW LogManager event: put the class in TARGETS → grab the resolved klass (round-trip-validated) → detect by klass-pointer equality in the loop → read the fields by offsets.py constant with defensive reads. Detection is by klass, NEVER by an ELogType field (it was stripped from the dump)."
code_anchors:
  - meter_windows.py::TARGETS
  - meter_windows.py::run
  - meter_windows.py::_suffix_int
  - config/offsets.py::GetBoxLog
  - il2cpp/resolver.py::resolve_via_rva
  - metrics/events.py::EventFeed
asserts:
  - config.offsets.GetBoxLog.MONSTER_TYPE == 0x50
guarded_by:
  - tests/test_meter_windows.py::TestBoxKeyByTier::test_three_tiers_map_to_canonical_box_keys
  - tests/test_meter_windows.py::TestSuffixInt::test_no_numeric_suffix
---

# Guide: capturing a new log event

The `LogManager` keeps **one** flat `List<LogData>` (offset `LogManager.LOG_LIST`) where the game
pushes one entry per event — stage end, box drop, hero death/revive. The loop in `run` reads the
entries that appeared **from the previous `size` to the current one** each tick. Each `LogData` is a
managed object, so its **first field (offset 0) is the pointer to the Il2CppClass** — it's by THAT
pointer that you find out WHICH event it is (see [[invariants/log-event-detection]]). Capturing a
new event touches **4 places in order**; skip one and either the klass never matches, or the reader
reads garbage, or a malformed field takes down the session. Do it in this sequence.

## 0. Confirm a dedicated log exists (and discover the fields)

Detection needs a **K-class of its own** for the event (`StageClearLog`, `GetBoxLog`,
`HeroDieLog`…). If the game doesn't emit a distinct `*Log` for what you want, there's no klass to
match — that's RE work (finding the class and the field offsets live), not part of this recipe. A
log's fields are name-keys or raw ints; map them live first (the gating method for a mapped value is
in [[process/value-mapping-method]]).

## 1. Put the class in `TARGETS`

`TARGETS` (in `meter_windows.py`) is the list of class names whose K the resolver **learns** —
by RVA index in the fast-path and by scan in the fallback. **Without the name here, the resolver
never resolves that K**, and the `kl ==` of step 3 never matches: the event goes unnoticed forever.
The log's class name has to be **stable** (>= 3 letters, non-obfuscated) — `StageClearLog` and co.
are; an obfuscated 2-letter singleton does NOT go in `TARGETS` (that one resolves by structure, a
different path — see [[invariants/gold-singleton-resolution]]).

## 2. Grab the resolved klass (already round-trip-validated)

The resolver returns `classes = {name: {K}}`. Extract your K like the neighbors do
(`sc_class`/`gb_class`/`die_class`/`res_class` come from `next(iter(classes["<Name>"]))` in the
fast-path, or `next(iter(classes.get("<Name>", [])), None)` in the scan — tolerant of absence). **No
extra instance validation needed**: logs are class-only (the resolver doesn't look for an instance
of them), and the index fast-path already **validates each K by name round-trip** in `resolve_via_rva`
(`class_name(K) != name` → returns `None` → falls to the scan; NEVER serves a wrong K). So the klass
that reaches the loop is trustworthy. (The **instance** sanity check via `_manager_inst_ok` is for
*singletons* — `LogManager`/`MonsterSpawnManager` — not for logs; see [[invariants/instance-selection]].)

> If the new event enters the run record, that K also becomes part of the calibrated shape
> → read [[invariants/cache-management]] before touching the cache shape (a `CACHE_FMT` bump
> requires re-capturing the `calib_seed`).

## 3. Detect by KLASS-POINTER equality in the loop

Inside the block that scans the new entries in `run`, add an `elif` branch:

- read the entry's klass with `reader.rptr(e)` (the first field);
- compare by **equality** with your `*_class` (`elif <new>_class and kl == <new>_class:`),
  keeping the `and <new>_class` guard so it doesn't match against `None` when the resolver didn't
  find that class (degrades cleanly on a build without it).

**Never read a type field on the entry to label the event.** The `ELogType` field was **stripped**
from this build's IL2CPP dump (the `ELogType` enum stays in `offsets.py` as a value catalog, but
there's no offset for the *field* inside `LogData`), and the `Dictionary<ELogType, List<LogData>>`
isn't used either — only the flat `LOG_LIST`. Klass-pointer equality is what makes detection immune
to the absent type field.

## 4. Read the fields by `offsets.py` CONSTANT, with defensive reads

Define an offsets class in the style of `GetBoxLog`/`HeroDieLog`/`ResurrectionLog` in
`config/offsets.py` (the single source — see [[invariants/offsets-single-source]]) and read the
fields **by symbol**, never by an `@0x` literal hardcoded into the logic:

- **raw int** → `reader.ri32(e + <Class>.<FIELD>)` (e.g. the box tier comes from
  `GetBoxLog.MONSTER_TYPE`, then mapped by `BOX_KEY_BY_TIER` — the old loose `int(bk_str)` number
  swallowed every drop; this guide's `assert` anchors `MONSTER_TYPE == 0x50`);
- **name-key string** (`"HeroName_<heroKey>"`, `"MonsterName_<monsterKey>"`) →
  `_suffix_int(reader.read_string(reader.rptr(e + <Class>.<FIELD>)))`. **Use the suffix parser,
  never `int()` on the whole string** — it does `rsplit("_", 1)` and only converts if the tail is a
  digit, returning `None` for any unexpected format (see the `HeroDieLog`/`ResurrectionLog` fields).

**Why this doesn't take down the session:** the `Reader` primitives (`rptr`/`ri32`/`read_string`)
**never raise** — they return `None` on unreadable memory (an address can free mid-fight). The loop
already has `if not e: continue` per entry, and `_suffix_int` returns `None` on invalid input.
**Keep that contract on the new field**: read defensively and treat `None` as "no data", never as a
lying `0`/default. (The loop's outer `try/except` only catches `KeyboardInterrupt`/game death — it's
**not** a net that swallows per-tick exceptions. The safety comes from the never-raise reads + the
per-entry guards, not from a generic catch; see [[invariants/memory-safety]].)
Garbage in an entry becomes a silent no-op, not a crash that kills the whole session.

## Changed the run record? That's schema.

If the new event adds data to `runs.jsonl` (a field in `close_run`'s `rec`/`heroes_out`, or an
accumulator started in `new_run`), that's a **shape change** → bump `SCHEMA_VERSION` and normalize
defensively in the app. The end-to-end field recipe is in [[guides/add-runs-field]]; the why of the
bump in [[invariants/schema-versioning]].

## `metrics/events.py` is COUNTING only — don't confuse it

`metrics.events.EventFeed` is an independent **counter**: it only measures **how many** new entries
appeared (the `size` delta, re-anchoring when the list truncates), without looking at any type. **It
is not the detection path** — labeling WHICH event it is requires the klass-pointer (step 3). The
TODO of "read each event's type" in the header of `events.py` was already solved in the `run` loop
precisely by klass-pointer, not by dumping the `ELogType` field. Don't try to reopen that door.

## Related
- [[invariants/log-event-detection]] — the invariant: why klass-pointer and not `ELogType`.
- [[invariants/offsets-single-source]] — where the new log's offsets class lives (single source).
- [[invariants/memory-safety]] — the never-raise read contract and the per-entry guards.
- [[invariants/schema-versioning]] — if the event enters the record: why bump `SCHEMA_VERSION`.
See also: [[reference/run-data-map]] (each *Log's fields mapped by symbol) · [[invariants/run-lifecycle]] (StageClear/Failed close the run off this detection)
