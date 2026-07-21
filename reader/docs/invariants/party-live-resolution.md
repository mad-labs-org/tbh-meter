---
type: invariant
description: "A run's party is the LIVE one (StageManager.HeroList via pick_live_sm, NO candidate cap) — the DEPLOYED heroes, not the save roster. With no live party, degrade honestly (`heroes: err` via hero_in_run, ⚠ in the log) — NEVER dump the roster (showed unplayed heroes with +0xp) NOR a proxy-guess by xp>0 (would catch idle xp)."
symptoms:
  - "wrong party"
  - "party with too many heroes"
  - "heroes with +0xp"
  - "roster instead of party"
  - "StageManager NOT found"
  - "party from save"
  - "playing solo but shows 6"
  - "live party off"
  - "StageManager ok but 0 heroes deployed"
  - "party off while run is in combat"
  - "ghost StageManager"
  - "invalid runs with no team"
  - "save-degraded"
  - "hero_in_run"
code_anchors:
  - game/save.py::pick_live_sm
  - game/build.py::read_live_party
  - game/build.py::_iter_party_slots
  - game/build.py::read_party_slots
  - game/build.py::resolve_party_slots
  - game/build.py::order_party_by_slot
  - game/build.py::hero_in_run
  - game/build.py::describe_sm_candidates
guarded_by:
  - tests/test_save.py::test_pick_live_sm_finds_carrier_beyond_600_candidates
  - tests/test_save.py::test_pick_live_sm_skips_ghost_and_picks_carrier
  - tests/test_save.py::test_pick_live_sm_real_hero_accepted_without_live_level
  - tests/test_save.py::test_describe_sm_candidates_classifies_carrier_vs_ghost
  - tests/test_save.py::TestHeroInRun::test_no_live_party_includes_nobody
  - tests/test_build.py::test_read_party_slots_preserves_gaps
  - tests/test_build.py::test_order_party_by_slot_slot_zero_sorts_first
  - tests/test_build.py::test_resolve_party_slots_drops_a_stale_slot_that_collides_with_a_live_one
  - tests/test_raw_record.py::test_party_off_makes_heroes_err
---

# Resolving a run's party (live, not roster)

A run's canonical party is the **DEPLOYED** heroes — their IDENTITY (the heroKeys) read LIVE from
`StageManager.HeroList` (`read_live_party`), on the instance chosen by `pick_live_sm`. The save lists the
**roster** (every hero above level 1): playing solo with the Ranger, the save lists all 6, but only the
Ranger is on the field. Confusing roster with party means showing unplayed heroes (the symptom: several
with `+0xp`).

**Identity AND level/exp are LIVE (1.00.20+).** Through 1.00.19, `read_live_party` read each deployed
hero's level/exp from the ACTk `fakeValue` PLAIN decoy (`HeroRuntime.LEVEL_FAKE`/`EXP_FAKE`). The 1.00.20
recompile ZEROED that decoy build-wide; rather than degrade to the lagging save (whose per-run delta jumps
~2× — the bug players reported), `read_live_party` now RECOVERS the values by decoding the ObscuredInt
level + ObscuredFloat xp in place (`game/obscured.py`; the algorithm was read from the binary, gated by
the validate_live oracle — see [[invariants/obscured-data-offlimits]]). The party stays fully LIVE
(membership is `StageManager.HeroList`); LEVEL falls back to the save on an unreadable cipher, and EXP
stays `None` on a bad read so the xp chain degrades HONESTLY (never the stale save exp masquerading as
`xp_source="live"`, [[invariants/metric-fallback-chains]]) — it NEVER lets the roster define the party.
Capped heroes → 0 xp, as ever.

## `pick_live_sm`: NO cap, and the SAME validation as `read_live_party`

`pick_live_sm` scans the StageManager instances and returns the first one from which `read_live_party`
extracts ≥1 valid DEPLOYED hero — it calls `read_live_party` **itself**, so pick and read use the
SAME validation. It has to scan **ALL** candidates (like `pick_live_csd`), with no fixed cap: the
carrier can be at ANY index. A fixed cap lost the carrier whenever the backref returned more than the
limit — nailed in 1.00.11: **1162 instances** of StageManager (vs ~450 in older builds), the carrier
beyond 600 → `StageManager NOT found` EVEN in combat → the party fell back to the roster.

**The ghost discriminator (and why it changed in 1.00.20).** Among the candidates there are **ghost**
instances — torn-down/template StageManagers, the SAME family as [[invariants/instance-selection]] (the
scan finds the K-class in dozens of slots that are not the live object). `read_live_party` must reject a
ghost while accepting every real deployed hero. The discriminator is the deployed **heroKey resolving a
real class in `hero_cat`**: a real hero carries one of the catalog keys; a ghost carries a stale/garbage
key that doesn't. (Through 1.00.19 the discriminator was a valid `heroKey` with `lvl>0`; 1.00.20 killed
the live level decoy, so a `lvl>0` gate would reject EVERY real hero — empty party → `sm` NOT found →
`hero-class`/`xp-live`/`stats` cascade-fail. Verified in 1.00.20: among ALL StageManager instances ONLY
the deployed ones carry a catalog heroKey, so the catalog check is a clean, name-free replacement.)
`pick_live_sm` takes `hero_cat` and applies the SAME discriminator.

**Why pick and read MUST agree (the 1.00.13 regression).** `pick_live_sm` returns the first candidate
`read_live_party` extracts a party from — it CALLS `read_live_party`, so pick and read use the SAME
validation by construction. The 1.00.13 bug was a pick that used a WEAKER check than read: it accepted a
ghost, the meter FROZE on it (`if not sm` in the loop) and `read_live_party` read `{}` the whole session →
`StageManager ok — 0 heroes deployed`, every run `heroes:err`, invalid runs with no team. It only hit
anyone who had a ghost BEFORE the carrier in memory order (hence "worked on the dev's machine" and passed
`validate_live`). The fix is that pick and read share the discriminator (today: heroKey + `hero_cat`); the
level/exp source NEVER gates — it only fills values — so the two can't drift apart again.
`describe_sm_candidates` (in `reader-diag.log`) logs candidates / carriers-vs-ghosts / chosen — the data
the debug was missing. With no readable candidate → `None` (degrade honestly, NEVER a ghost that read
can't read).

## Honest degradation: party off becomes `err`, NEVER the roster

`hero_in_run(hero_key, live_keys)` is the single inclusion rule: **only** whoever is in the LIVE party
gets in (`live_keys` = HeroList ∪ party_seen). When the live party doesn't resolve the WHOLE run (sm
null), **nobody gets in** — the reader emits `heroes: err("party live off")` in the `raw/<id>.json`
envelope. NEVER the save roster (the bug of 5 heroes with +0xp) nor a proxy-guess by xp>0 (would catch a
hero who only gained idle xp, re-introducing the bug): unknown party ≠ guessed party.

`heroes` is a **CRITICAL** field in the converter ([[process/data-contract-id-based]]): `heroes: err` →
`issues["heroes"]` → the run is sealed **`degraded`**. By the #262 rule: **it doesn't count** but it
**shows in the app**, marked and filterable (`hideNonCounted`, "Skip != hide"). The `meter.log` line still carries `⚠` for the maintainer, and the `validate_live` gate
catches it live — the degradation is never silent.

## The formation slot (team position 0/1/2)

The party's IDENTITY is a set of heroKeys, but the player also ARRANGES them in a 3-slot formation,
and that POSITION carries meaning. `StageManager.HeroList` is a fixed-size-3 array indexed BY that
position — an empty slot is null (a solo hero parked in slot 2 leaves 0 and 1 null; verified live).
`_iter_party_slots` walks it ONCE and is the SHARED source for both `read_live_party` (membership +
live level/exp) and `read_party_slots` (`{heroKey: slot}`); the single walk keeps the slot map and the
party in lockstep — the same pick<->read agreement, now extended to the slot.

`close_run` stamps each hero's `slot` via `resolve_party_slots` and emits the party via
`order_party_by_slot` — in FORMATION order, NOT the SAVE-ROSTER order `read_build`
(PlayerSaveData.HEROES) happens to iterate. Before this the slot index was DISCARDED and the run
record's order WAS the save roster's, so the in-game team order/position was lost through the app.
`slot` is ADDITIVE (no `RAW_SCHEMA_VERSION` bump,
[[invariants/schema-versioning]]); the live overlay emits it too (`party_slots` in live.json)
alongside the already-slot-ordered `party`.

**Resolve from ONE coherent read, not the merged accumulator.** The slot is stamped by
`resolve_party_slots(hero_keys, slots_now, slots_seen)`: `slots_now` is a SINGLE at-close (or
per-tick) `read_party_slots`, UNIQUE by construction (each deployed hero at a distinct index); the
run-long accumulator (`party_slots`) is only the FALLBACK for a hero dead/dropped before close, and a
stale fallback slot that collides with a live one is dropped to `None` (it trails). This guarantees
UNIQUE slots, so `order_party_by_slot` can't tie into the surface-dependent insertion order — and the
run record AND the live overlay both resolve this way, so they can't disagree ("live ok, saved
wrong"). Reusing the merged accumulator directly was the risk #89's review flagged: a mid-run
re-index (death/revive) could leave a stale or duplicate index.

## Related
- [[invariants/instance-selection]] — picking the right live instance of a class (same bug family)
- [[process/live-validation-gate]] — the live gate that catches a degraded party (+ gold/xp/stage) before ship
- [[invariants/metric-fallback-chains]] — the source tag (live/save) that preserves the degradation, same as gold/xp
