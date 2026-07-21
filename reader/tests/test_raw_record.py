"""Tests for build_raw_record — the RAW v2 record the reader emits (raw/<id>.json).

Locks the contract the converter (app) parses: ok/err envelope per data field, raw meta, ZERO
derived fields, and — the point of the redesign — "didn't read" (err) never becomes "read zero".
Mirrors app/src/shared/raw-types.ts::RawRunV2 (same shape on both sides).

v2 (Redesign 2): run identity is the END TIMESTAMP in ms (`id = str(ts_ms)`), with NO session_id and
NO run — kills the run_num-reset bug class (colliding id → new run vanishes).
"""

import json
import struct

from config.offsets import Array, List, PlayerSaveData, RuneSaveData
from game.build import read_account_snapshot
from meter_windows import RAW_SCHEMA_VERSION, _absorb_drop, build_raw_record


def _rec(**over):
    base = dict(
        ts_ms=1717800000123, run_outcome="success",
        game_version="1.00.11", duration=92, stage_key=30901, act=3, stage_no=9,
        difficulty=2, total_mobs=120, mobs=118, total_damage=4500000.0, clear_time=90,
        gold=125000, gold_ok=True, gold_source="live",
        xp_gained=3400000.0, xp_ok=True, xp_source="live", drops=[], heroes=[], heroes_ok=True,
        runes=[], inventory=[], stash=[],
    )
    base.update(over)
    return build_raw_record(**base)


def test_stamps_raw_schema_version_and_identity():
    r = _rec()
    assert r["raw_schema_version"] == RAW_SCHEMA_VERSION == 2
    assert r["id"] == "1717800000123"                 # = str(ts_ms): the end timestamp in ms IS the identity
    # v2: NO session_id, NO run — the run no longer borrows the session's identity.
    assert "session_id" not in r
    assert "run" not in r


def test_metadata_is_plain_no_envelope():
    r = _rec()
    assert r["ts"] == 1717800000123                   # ms (v1 was seconds)
    assert r["duration"] == 92
    assert r["run_outcome"] == "success"
    assert r["game_version"] == "1.00.11"


def test_data_fields_are_enveloped_ok():
    r = _rec()
    assert r["gold_gained"] == {"ok": True, "value": 125000}
    assert r["total_damage"] == {"ok": True, "value": 4500000.0}
    assert r["stageKey"] == {"ok": True, "value": 30901}
    assert r["difficulty"] == {"ok": True, "value": 2}


def test_hero_dict_carries_the_exact_wire_keys_the_ts_mapHero_reads():
    # Producer↔consumer contract (Python build_raw_record -> TS convert.mapHero): the reader emits the
    # RAW hero inside ok(heroes), with the MIXED casing (snake+camel) that mapHero reads by key. A
    # rename on one side alone becomes a "missing"/lost field in the converter with green CI — so we
    # pin the keys HERE, on the producing side. Mirrors app/src/shared/__fixtures__/raw-v1.ts (the golden hero).
    hero = {
        "heroKey": 1001, "classId": 5, "class": "0x5", "level": 80, "exp": 1234567,
        "items": [{
            "slot": "weapon", "slotId": 0, "grade": "legendary", "gradeId": 4,
            "itemKey": 50012, "uniqueId": "1099511627776123", "level": 20,
            "mods": [{"recipeId": 11, "recipe": "atk", "statId": 3, "stat": "ATK",
                      "value": 1500, "tier": 3}],
        }],
        "skills": [{"key": 7001, "lv": 5}],
        "skillLevels": {"7001": 5},
        "stats": {"0": 1500, "1": 320},
        "exp_start": 1200000, "exp_end": 1234567, "xp_gained": 34567,
        "levelup": False, "deaths": 0, "revives": 0, "killed_by": [30102],
    }
    r = _rec(heroes=[hero])
    assert r["heroes"]["ok"] is True
    h = r["heroes"]["value"][0]
    # top-level hero keys (the exact casing the TS mapHero expects, snake + camel mixed)
    for k in ("heroKey", "classId", "class", "level", "exp", "items", "skills", "skillLevels",
              "stats", "exp_start", "exp_end", "xp_gained", "levelup", "deaths", "revives",
              "killed_by"):
        assert k in h, f"hero key {k!r} missing — breaks the Python↔TS contract (mapHero)"
    # item + mod keys (the sub-mapping mapHero also reads by key)
    item = h["items"][0]
    for k in ("slot", "slotId", "grade", "gradeId", "itemKey", "uniqueId", "level", "mods"):
        assert k in item, f"item key {k!r} missing"
    for k in ("recipeId", "recipe", "statId", "stat", "value", "tier"):
        assert k in item["mods"][0], f"mod key {k!r} missing"


def test_unread_gold_is_err_not_zero():
    # The gold:0 bug — "didn't read" has to be distinguishable from "gained zero".
    r = _rec(gold=0, gold_ok=False)
    assert r["gold_gained"] == {"ok": False, "error": "gold unread (live+save failed)"}
    # contrast: gold genuinely read as ZERO is ok(0), NOT err.
    assert _rec(gold=0, gold_ok=True)["gold_gained"] == {"ok": True, "value": 0}


def test_unread_xp_is_err():
    assert _rec(xp_gained=0.0, xp_ok=False)["xp_gained"] == {
        "ok": False, "error": "xp unread (live+save failed)"}


def test_party_off_makes_heroes_err():
    # Live party off the whole run: the reader passes heroes_ok=False -> heroes becomes err (not a silent
    # [] nor the save's roster). The converter flags issues.heroes and — heroes ∈ CRITICAL_FIELDS — seals
    # the run degraded: does NOT count, but shows in the app, flagged.
    assert _rec(heroes=[], heroes_ok=False)["heroes"] == {
        "ok": False, "error": "party live off (StageManager unresolved)"}
    # contrast: live party OK -> ok(heroes), even an empty list (heroes_ok distinguishes "off" from content).
    assert _rec(heroes=[], heroes_ok=True)["heroes"] == {"ok": True, "value": []}


def test_unresolved_stage_fields_are_err():
    r = _rec(act=None, stage_no=None, difficulty=None, total_mobs=None)
    assert r["act"]["ok"] is False
    assert r["stageNo"]["ok"] is False
    assert r["difficulty"]["ok"] is False
    assert r["total_mobs"]["ok"] is False
    # stageKey with a real value stays ok (the input was read).
    assert r["stageKey"]["ok"] is True


def test_unread_stage_key_is_err_not_ok_none():
    # stageKey=None is a FAILED read of the ranking key (not "no stage"): becomes err -> the converter
    # flags issues.stageKey -> degrades the run. A silent ok(None) here would repeat the gold:0 bug.
    assert _rec(stage_key=None)["stageKey"] == {"ok": False, "error": "stageKey unread"}


def test_source_tag_rides_alongside_the_envelope():
    # 3 degrees: clean (live) / stale (save) / didn't read (err). source rides alongside the ok.
    assert _rec(gold_source="live")["gold_source"] == "live"
    assert _rec(gold_source="save")["gold_source"] == "save"


def test_no_derived_or_legacy_fields():
    # RAW: the converter derives dps/rates/partial/status/mode/"3-9"/totals — they don't come from the reader.
    r = _rec()
    for k in ("dps", "gold_per_sec", "xp_per_sec", "partial", "status", "mode", "stage",
              "schema_version", "deaths", "revives", "session_id", "run"):
        assert k not in r, f"{k!r} is derived/legacy/v1 — must NOT be in the raw v2 record"


def test_account_snapshot_fields_are_enveloped():
    # runes/inventory/stash = RAW account snapshot (SAVE), recorded on EVERY run, in an ok() envelope.
    # Additive with NO RAW_SCHEMA_VERSION bump (the converter ignores unknown keys); the wiki derives
    # later (real drop-rate, wave correction). id-only on items (the app resolves the name from itemKey).
    runes = [{"key": 101, "level": 5}, {"key": 1171, "level": 3}]
    inv = [{"itemKey": 315171, "uniqueId": "501734348895521012", "slotId": 1, "gradeId": 4,
            "level": 80, "mods": [{"recipeId": 1, "recipe": "x", "statId": 24, "stat": "PhysDmg%",
                                   "value": 700, "tier": 6}]}]
    stash = [{"itemKey": 910251, "uniqueId": "501734348921858848", "slotId": None,
              "gradeId": None, "level": None, "mods": []}]
    r = _rec(runes=runes, inventory=inv, stash=stash)
    assert r["runes"] == {"ok": True, "value": runes}
    assert r["inventory"] == {"ok": True, "value": inv}
    assert r["stash"] == {"ok": True, "value": stash}


def test_account_snapshot_empty_list_is_ok_not_err():
    # GENUINELY EMPTY (the read ran and found nothing — new account with no rune, clean inventory) -> ok([]).
    # It's the valid "read zero" state, distinct from "didn't read" (next test). An [] list enters as ok([]).
    r = _rec(runes=[], inventory=[], stash=[])
    assert r["runes"] == {"ok": True, "value": []}
    assert r["inventory"] == {"ok": True, "value": []}
    assert r["stash"] == {"ok": True, "value": []}


def test_account_snapshot_unread_is_err_not_empty():
    # DIDN'T READ (read_account_snapshot returns None: null psd, unreadable list, offset broken by a patch)
    # -> err, NEVER ok([]). It's the envelope invariant (the same rule that killed the gold:0 bug): the
    # app/wiki has to distinguish "the account has no rune" from "I failed to read the runes". ok([]) on a
    # failure would resurrect the silent-error. read_account_snapshot signals failure with None; here is the contract.
    r = _rec(runes=None, inventory=None, stash=None)
    assert r["runes"] == {"ok": False, "error": "runes unread (save/list unreadable)"}
    assert r["inventory"] == {"ok": False, "error": "inventory unread (save/list unreadable)"}
    assert r["stash"] == {"ok": False, "error": "stash unread (save/list unreadable)"}


def test_absorbed_boss_box_lands_inside_drops_envelope_without_shape_change():
    # Pending-close (the box-in-the-next-run bug): the boss box the game logs ~0.6s AFTER the
    # clear is absorbed into the ALREADY-BUILT record via _absorb_drop. The contract: it shows up INSIDE
    # the ok envelope of drops, in the SAME wire shape as always ({"box_key", "monster_type"}),
    # with NO new key in the record and NO bump (shape unchanged — only the list's content grows,
    # just like a normal drop). The json round-trip is what the flush writes to disk.
    gray = {"box_key": 910011, "monster_type": 0}
    blue = {"box_key": 920001, "monster_type": 1}
    r = _rec(drops=[gray])
    assert _absorb_drop(r, blue) is True
    flushed = json.loads(json.dumps(r))
    assert flushed["drops"] == {"ok": True, "value": [gray, blue]}
    assert set(flushed.keys()) == set(_rec().keys())   # NO new key: zero additions, no bump
    assert flushed["raw_schema_version"] == RAW_SCHEMA_VERSION == 2
    assert flushed["id"] == "1717800000123"            # id follows the CLOSE ts_ms, not the flush


def test_raw_record_keys_are_the_documented_contract():
    # The EXACT set of keys build_raw_record emits — MIRROR of
    # app/src/shared/raw-types.ts::RawRunV2. Adding/removing a field here WITHOUT updating
    # raw-types.ts (and this set) breaks the Python↔TS contract with green CI — so we lock the
    # COMPLETE set on the PRODUCING side. (test_no_derived_or_legacy_fields locks what does NOT enter;
    # this locks what DOES enter.) NB: runes/inventory/stash are ALWAYS emitted (ok([]) at minimum); they're
    # optional in raw-types.ts ONLY because OLD raw (pre-snapshot) doesn't have them.
    expected = {
        "raw_schema_version", "id", "ts", "run_outcome", "game_version",
        "duration", "stageKey", "act", "stageNo", "difficulty", "total_mobs", "mobs",
        "total_damage", "clear_time", "gold_gained", "gold_source", "xp_gained", "xp_source",
        "drops", "heroes", "runes", "inventory", "stash",
    }
    assert set(_rec().keys()) == expected


# ---- read_account_snapshot: the READ layer distinguishes DIDN'T-READ (None) from EMPTY ([]) ----
# (build_raw_record above turns None->err / list->ok; these prove the PRODUCER actually returns
#  None on failure and [] only on genuinely empty — otherwise a silent ok([]) would come back via gold:0).

class _SnapStub:
    """Minimal stub for read_account_snapshot (conftest's MockReader has no read()/ru64()):
    rptr/ri32/ru64 read from `mem`; read(items+DATA, n) packs the pointers from `arrays`."""
    def __init__(self, mem=None, arrays=None):
        self._mem = dict(mem or {})
        self._arrays = dict(arrays or {})

    def rptr(self, a):
        return self._mem.get(a)

    def ri32(self, a):
        return self._mem.get(a)

    def ru64(self, a):
        return self._mem.get(a)

    def read(self, a, n):
        ptrs = self._arrays.get(a)
        return struct.pack(f"<{len(ptrs)}Q", *ptrs) if ptrs is not None else None


def test_read_snapshot_none_psd_is_all_none():
    # No live save (psd None) -> DIDN'T-READ on everything (None,None,None) -> the caller emits err on all 3.
    assert read_account_snapshot(_SnapStub(), None, {}) == (None, None, None)


def test_read_snapshot_unreadable_lists_are_none_not_empty():
    # valid psd but NOTHING resolves (broken offset/failed read): RUNES ptr None, ITEMS ptr None ->
    # runes None, and inventory/stash None (uid2item didn't build). NEVER [] — else it'd become a silent ok([]).
    runes, inv, stash = read_account_snapshot(_SnapStub(), 0x100, {})
    assert runes is None and inv is None and stash is None


def test_read_snapshot_empty_runes_list_is_empty_not_none():
    # RUNES resolves to a REAL list of size 0 (new account, no rune) -> [] (read-zero), NOT None.
    psd, rl = 0x100, 0x200
    runes, _, _ = read_account_snapshot(
        _SnapStub(mem={psd + PlayerSaveData.RUNES: rl, rl + List.SIZE: 0}), psd, {})
    assert runes == []


def test_read_snapshot_reads_populated_runes():
    # RUNES with 2 nodes -> list [{key, level}] (proves the happy path of the read, incl. the batched read()).
    psd, rl, arr, e1, e2 = 0x100, 0x200, 0x300, 0x1000, 0x1010
    mem = {
        psd + PlayerSaveData.RUNES: rl, rl + List.SIZE: 2, rl + List.ITEMS: arr,
        e1 + RuneSaveData.KEY: 101, e1 + RuneSaveData.LEVEL: 5,
        e2 + RuneSaveData.KEY: 1171, e2 + RuneSaveData.LEVEL: 1,
    }
    runes, _, _ = read_account_snapshot(_SnapStub(mem, {arr + Array.DATA: [e1, e2]}), psd, {})
    assert runes == [{"key": 101, "level": 5}, {"key": 1171, "level": 1}]


def test_read_snapshot_never_raises_even_if_reader_raises():
    # NEVER-RAISES is a life-or-death contract: a throw in close_run kills the reader (the loop only
    # catches KeyboardInterrupt -> run lost + session torn down). The REAL Reader returns None on a
    # bad read (never raises), but the snapshot can't DEPEND on that: each block is guarded
    # (try/except) and a reader that RAISES on any primitive becomes DIDN'T-READ (None,None,None) ->
    # err on all 3 — never propagates. This test locks the docstring's contract ("each block guarded").
    class _Raising:
        def rptr(self, a):
            raise RuntimeError("boom")

        def ri32(self, a):
            raise RuntimeError("boom")

        def ru64(self, a):
            raise RuntimeError("boom")

        def read(self, a, n):
            raise RuntimeError("boom")

    assert read_account_snapshot(_Raising(), 0x100, {}) == (None, None, None)
