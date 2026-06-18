"""Orchestrator tests (pure functions). The bulk of meter_windows is memory I/O
(covered by live probes); only the helpers that are testable in isolation live here."""

import json

from config.offsets import Array, Class, EStageType, List, StageInfoData
from meter_windows import (BOX_KEY_BY_TIER, CACHE_FMT, PENDING_CLOSE_GRACE,
                           _absorb_drop, _drop_counts, _flush_pending_rec,
                           _new_pending, _pick_list_singleton, _read_calib,
                           _read_catalogs, _seed_path, _stage_info_ok,
                           _suffix_int, _valid_list_size)
from tests.conftest import MockReader

LIST_OFF = 0x20   # e.g. LogManager.LOG_LIST / MonsterSpawnManager.MONSTER_LIST


def _write_valid_list(mem, inst, ll, items, size, *, name="StageClearLog", maxlen=None):
    """Write a structurally VALID List<T> into `mem` at inst+LIST_OFF: readable items,
    capacity>=size, and `size` entries that are objects (a class with a readable name)."""
    maxlen = size + 4 if maxlen is None else maxlen
    k = items + 0x900000          # class address (any, >0x10000)
    name_ptr = k + 0x1000
    mem[inst + LIST_OFF] = ll
    mem[ll + List.SIZE] = size
    mem[ll + List.ITEMS] = items
    mem[items + Array.MAX_LENGTH] = maxlen
    mem[k + Class.NAME] = name_ptr
    mem[name_ptr] = name
    for i in range(size):
        e = items + 0x100000 + i * 0x100
        mem[items + Array.DATA + i * 8] = e
        mem[e] = k                # rptr(e) = K (the object's class)
    return mem


class TestPickListSingleton:
    """The pointer scan returns dozens of false positives for a singleton (LogManager had
    36 in a live probe, 35 garbage). The pick has to choose the structurally VALID List, not the
    first-in-range — otherwise a garbage slot with size=0 (zeroed memory) at a lower address beats
    the real singleton, the list never grows and NO run closes (the bug this PR fixes)."""

    def test_picks_real_over_first_garbage(self):
        garbage, real = 0x10000000, 0x10500000
        mem = {}
        mem[garbage + LIST_OFF] = 0x10001000          # valid ll...
        mem[0x10001000 + List.SIZE] = 0               # size=0 in range (passed the old pick)...
        mem[0x10001000 + List.ITEMS] = 0              # ...but not a real List (no items)
        _write_valid_list(mem, real, 0x10501000, 0x10502000, 3)
        r = MockReader(mem=mem)
        # garbage comes FIRST (lower address = scan-order); it still picks the real one
        assert _pick_list_singleton(r, [garbage, real], LIST_OFF, 100000) == real

    def test_valid_size_rejects_garbage_accepts_real(self):
        mem = {}
        garbage = 0x10000000
        mem[garbage + LIST_OFF] = 0x10001000
        mem[0x10001000 + List.SIZE] = 0
        mem[0x10001000 + List.ITEMS] = 0
        real = 0x10500000
        _write_valid_list(mem, real, 0x10501000, 0x10502000, 5)
        r = MockReader(mem=mem)
        assert _valid_list_size(r, garbage, LIST_OFF, 100000) is None
        assert _valid_list_size(r, real, LIST_OFF, 100000) == 5

    def test_rejects_size_over_cap(self):
        mem = {}
        inst = 0x10000000
        _write_valid_list(mem, inst, 0x10001000, 0x10002000, 50, maxlen=60)
        r = MockReader(mem=mem)
        assert _valid_list_size(r, inst, LIST_OFF, 10) is None      # size 50 >= cap 10

    def test_rejects_size_over_capacity(self):
        mem = {}
        inst = 0x10000000
        _write_valid_list(mem, inst, 0x10001000, 0x10002000, 20, maxlen=5)
        r = MockReader(mem=mem)
        assert _valid_list_size(r, inst, LIST_OFF, 100000) is None  # size 20 > maxlen 5

    def test_prefers_largest_valid_list(self):
        # among several structurally valid ones, keep the one with the MOST entries (the live log/list).
        mem = {}
        small, big = 0x10000000, 0x10500000
        _write_valid_list(mem, small, 0x10001000, 0x10002000, 2)
        _write_valid_list(mem, big, 0x10501000, 0x10502000, 40)
        r = MockReader(mem=mem)
        assert _pick_list_singleton(r, [small, big], LIST_OFF, 100000) == big

    def test_fallback_to_loose_pick_never_regresses_to_none(self):
        # no structurally valid candidate -> fall back to the loose pick (size in range),
        # so a resolve that USED to work never turns into None.
        mem = {}
        loose = 0x10000000
        mem[loose + LIST_OFF] = 0x10001000
        mem[0x10001000 + List.SIZE] = 7
        mem[0x10001000 + List.ITEMS] = 0
        r = MockReader(mem=mem)
        assert _pick_list_singleton(r, [loose], LIST_OFF, 100000) == loose


class TestSuffixInt:
    """Parses the name-keys from the death/revive logs ('HeroName_601' -> 601). Format confirmed
    live: 'HeroName_<heroKey>' / 'MonsterName_<monsterKey>'."""

    def test_hero_name_key(self):
        assert _suffix_int("HeroName_601") == 601

    def test_monster_name_key(self):
        assert _suffix_int("MonsterName_30102") == 30102

    def test_none_input(self):
        assert _suffix_int(None) is None

    def test_empty_string(self):
        assert _suffix_int("") is None

    def test_no_numeric_suffix(self):
        assert _suffix_int("NoNumberHere") is None

    def test_trailing_underscore_no_digits(self):
        # 'HeroName_' -> empty tail -> None (doesn't blow up)
        assert _suffix_int("HeroName_") is None

    def test_multiple_underscores_takes_last_segment(self):
        # rsplit on the last '_': takes the final segment
        assert _suffix_int("Some_Prefix_42") == 42

    def test_plain_number(self):
        assert _suffix_int("777") == 777



def _write_stage_row(mem, a, *, sk=None, st=None, wa=None, wm=None, act=None, sno=None, diff=None):
    """Write a fake StageInfoData instance at `a` (None fields = read failure)."""
    for off, v in ((StageInfoData.STAGE_KEY, sk), (StageInfoData.STAGE_TYPE, st),
                   (StageInfoData.WAVE_AMOUNT, wa), (StageInfoData.WAVE_MOB_AMOUNT, wm),
                   (StageInfoData.ACT, act), (StageInfoData.STAGE_NO, sno),
                   (StageInfoData.DIFFICULTY, diff)):
        if v is not None:
            mem[a + off] = v
    return mem


class TestReadCatalogs:
    """stage_info from _read_catalogs. The wave filter (1<=wa/wm<=200) dropped ACTBOSS stages
    (x-10, boss-only fight, no horde waves) -> the key fell out of the catalog and EVERYTHING
    that depends on stage_info degraded on x-10: "?" mode in the run record/overlay, blind stage
    adoption and blind change detection in the loop."""

    def _catalogs(self, mem, addrs):
        r = MockReader(mem=mem)
        si, _, _ = _read_catalogs(r, {"StageInfoData": addrs})
        return si

    def test_normal_stage_total_is_waves_times_mobs(self):
        mem = _write_stage_row({}, 0x1000, sk=1001, st=EStageType.NORMAL,
                               wa=10, wm=5, act=3, sno=4, diff=2)
        assert self._catalogs(mem, [0x1000]) == {1001: (3, 4, 50, 2)}

    def test_actboss_without_waves_is_kept_with_zero_horde(self):
        # the bug: x-10 has wa/wm out of range -> hit the filter and the mode turned into "?"
        mem = _write_stage_row({}, 0x1000, sk=4310, st=EStageType.ACTBOSS,
                               wa=0, wm=0, act=3, sno=10, diff=3)
        assert self._catalogs(mem, [0x1000]) == {4310: (3, 10, 0, 3)}

    def test_actboss_with_valid_waves_keeps_wave_total(self):
        # if a build gives the boss-stage valid waves, the real total wins over the 0
        mem = _write_stage_row({}, 0x1000, sk=4310, st=EStageType.ACTBOSS,
                               wa=2, wm=3, act=3, sno=10, diff=1)
        assert self._catalogs(mem, [0x1000]) == {4310: (3, 10, 6, 1)}

    def test_garbage_row_rejected(self):
        # garbage instance: type out of the enum and no waves -> not entered
        mem = _write_stage_row({}, 0x1000, sk=999, st=7, wa=0, wm=0, act=3, sno=10, diff=2)
        assert self._catalogs(mem, [0x1000]) == {}

    def test_actboss_with_implausible_fields_rejected(self):
        # ACTBOSS only enters with plausible act/sno/diff (guards against misread)
        bad_diff = _write_stage_row({}, 0x1000, sk=4310, st=EStageType.ACTBOSS,
                                    wa=0, wm=0, act=3, sno=10, diff=9)
        assert self._catalogs(bad_diff, [0x1000]) == {}
        no_act = _write_stage_row({}, 0x2000, sk=4310, st=EStageType.ACTBOSS,
                                  wa=0, wm=0, sno=10, diff=2)
        assert self._catalogs(no_act, [0x2000]) == {}

    def test_missing_stage_key_rejected(self):
        mem = _write_stage_row({}, 0x1000, st=EStageType.ACTBOSS, wa=0, wm=0,
                               act=3, sno=10, diff=2)
        assert self._catalogs(mem, [0x1000]) == {}

    def test_horde_row_with_invalid_diff_rejected(self):
        # the persistent "?" mode bug: a horde row with an unreadable DIFFICULTY (None) or
        # outside EStageDifficulty got cataloged with diff -1 → DIFF_NAMES.get(-1) = "?" on
        # EVERY run of that stage, and the calib persisted the poisoned catalog. A suspect row
        # does NOT enter (degrades: the stage stays OUT of the catalog — "?" mode in the
        # close/overlay and blind stage adoption/change in the loop; the completeness-vs-seed
        # gate keeps the hole from persisting/shadowing the seed when the seed covers the fp).
        for diff in (None, -1, 4, 99):
            mem = _write_stage_row({}, 0x1000, sk=1001, st=EStageType.NORMAL,
                                   wa=10, wm=5, act=3, sno=4, diff=diff)
            assert self._catalogs(mem, [0x1000]) == {}, f"diff={diff} should be rejected"

    def test_horde_row_with_each_valid_diff_kept(self):
        # symmetry with boss_ok: every real EStageDifficulty (0..3) still enters
        for diff in (0, 1, 2, 3):
            mem = _write_stage_row({}, 0x1000, sk=2001, st=EStageType.NORMAL,
                                   wa=2, wm=3, act=1, sno=1, diff=diff)
            assert self._catalogs(mem, [0x1000]) == {2001: (1, 1, 6, diff)}

    def test_actboss_with_invalid_diff_still_rejected(self):
        # boss_ok already validated diff (the x-10 fix); the symmetry can't have loosened it
        for diff in (None, -1, 4):
            mem = _write_stage_row({}, 0x1000, sk=4310, st=EStageType.ACTBOSS,
                                   wa=0, wm=0, act=3, sno=10, diff=diff)
            assert self._catalogs(mem, [0x1000]) == {}, f"diff={diff} should be rejected"

    def test_horde_row_with_invalid_act_or_sno_rejected(self):
        # full symmetry with boss_ok: an unreadable ACT/STAGE_NO (None) or one outside 1..200
        # drops the HORDE row too — it used to enter as `act or 0`/`sno or 0`,
        # writing a (0, 0, ...) misread into the persisted catalog
        for field in ("act", "sno"):
            for bad in (None, 0, 201):
                kw = dict(sk=1001, st=EStageType.NORMAL, wa=10, wm=5, act=3, sno=4, diff=2)
                kw[field] = bad
                mem = _write_stage_row({}, 0x1000, **kw)
                assert self._catalogs(mem, [0x1000]) == {}, \
                    f"{field}={bad} should be rejected"

    def test_actboss_with_invalid_act_or_sno_still_rejected(self):
        # boss_ok already validated act/sno; the refactor (actsno_ok) can't have loosened it
        for field, bad in (("act", 0), ("act", 201), ("sno", 0), ("sno", 201)):
            kw = dict(sk=4310, st=EStageType.ACTBOSS, wa=0, wm=0, act=3, sno=10, diff=2)
            kw[field] = bad
            mem = _write_stage_row({}, 0x1000, **kw)
            assert self._catalogs(mem, [0x1000]) == {}, f"{field}={bad} should be rejected"

    def test_horde_row_with_act_sno_at_bounds_kept(self):
        # valid edges (1 and 200) still enter — the gate is 1 <= x <= 200, inclusive
        mem = _write_stage_row({}, 0x1000, sk=1001, st=EStageType.NORMAL,
                               wa=10, wm=5, act=1, sno=200, diff=2)
        assert self._catalogs(mem, [0x1000]) == {1001: (1, 200, 50, 2)}
        mem = _write_stage_row({}, 0x2000, sk=2001, st=EStageType.NORMAL,
                               wa=10, wm=5, act=200, sno=1, diff=2)
        assert self._catalogs(mem, [0x2000]) == {2001: (200, 1, 50, 2)}


class TestStageInfoOk:
    """_stage_info_ok = the sanity gate for the stage_info catalog, used on LOAD (_read_calib
    rejects a poisoned calib → falls back to seed/scan, self-heals) and on PERSIST (save_calib
    doesn't write a bad catalog). Rows = (act, stage_no, horde, diff) with diff ∈ EStageDifficulty
    and act/stage_no in 1..200 (mirrors _read_catalogs's row gate); horde has NO range-check
    (boss x-10 legitimately has horde=0)."""

    def test_valid_catalog_ok(self):
        assert _stage_info_ok({1001: (1, 1, 50, 0), 4310: (4, 10, 0, 3)})

    def test_empty_rejected(self):
        assert not _stage_info_ok({})

    def test_invalid_diff_rejected(self):
        # diff -1 is exactly the shape of the pre-fix poisoned cache
        assert not _stage_info_ok({1001: (1, 1, 50, 0), 1002: (1, 2, 60, -1)})
        assert not _stage_info_ok({1001: (1, 1, 50, 4)})

    def test_act_or_stage_no_out_of_range_rejected(self):
        # (0, 0, ...) is exactly the shape of the pre-fix `act or 0`/`sno or 0` fallback
        # (a horde misread entered zeroed); outside 1..200 = a misread too
        assert not _stage_info_ok({1001: (0, 1, 50, 0)})
        assert not _stage_info_ok({1001: (1, 0, 50, 0)})
        assert not _stage_info_ok({1001: (0, 0, 50, 0)})
        assert not _stage_info_ok({1001: (201, 1, 50, 0)})
        assert not _stage_info_ok({1001: (1, 201, 50, 0)})

    def test_zero_horde_not_range_checked(self):
        # horde=0 is LEGITIMATE (boss x-10, no horde waves) — row[2] has no range-check
        assert _stage_info_ok({4310: (4, 10, 0, 3)})

    def test_wrong_shape_rejected(self):
        assert not _stage_info_ok({1001: (1, 1, 50)})            # 3-tuple
        assert not _stage_info_ok({1001: (1, 1, 50, "0")})       # non-int diff
        assert not _stage_info_ok({1001: [1, 1, 50, 0]})         # list (not reconstructed)

    def test_bool_rejected(self):
        # bool is a subclass of int: a `true` in a hand-edited cache would pass as diff=1
        assert not _stage_info_ok({1001: (1, 1, 50, True)})      # bool diff
        assert not _stage_info_ok({1001: (1, True, 50, 0)})      # any bool field


def test_bundled_seed_passes_load_validation():
    """The bundled seed (config/calib_seed.json) has to pass the runtime's load gate —
    otherwise every FIRST launch of the shipped build would degrade to a cold scan (the
    'scan every time' class of bug). Same check that --selftest runs in CI."""
    doc = json.load(open(_seed_path(), encoding="utf-8"))
    assert doc["fmt"] == CACHE_FMT
    assert doc["calib"], "seed has no fp at all"
    for fp in doc["calib"]:
        entry = _read_calib(_seed_path(), fp)
        assert entry is not None, f"seed fp {fp} rejected by the load-gate"
        assert _stage_info_ok(entry["stage_info"])


class TestBoxKeyByTier:
    """GetBoxLog @0x40 is the TYPE ("TreasureChest_<Type>"), NOT an item key (confirmed live).
    The tier (monster_type 0/1/2) maps to that tier's canonical box item key."""

    def test_three_tiers_map_to_canonical_box_keys(self):
        assert BOX_KEY_BY_TIER == {0: 910011, 1: 920001, 2: 930101}

    def test_unknown_tier_returns_none(self):
        assert BOX_KEY_BY_TIER.get(3) is None
        assert BOX_KEY_BY_TIER.get(None) is None


class TestNewPending:
    """SHARED constructor of the pending-close state (_new_pending): close_run and these
    tests use the same one — a hand-rolled mirror here would let the shape drift silently."""

    def test_deadline_is_now_plus_grace(self):
        p = _new_pending({"id": "1"}, "x.json", 100.0)
        assert p["deadline"] == 100.0 + PENDING_CLOSE_GRACE
        assert p["rec"] == {"id": "1"}
        assert p["path"] == "x.json"

    def test_absorbed_starts_fresh_per_instance(self):
        # a NEW list per close: inheriting absorbed boxes from a prior pending would reattribute a
        # chest (the bug itself) and inflate the next window's live count.
        a = _new_pending({}, "a.json", 0.0)
        a["absorbed"].append({"box_key": 920001, "monster_type": 1})
        b = _new_pending({}, "b.json", 0.0)
        assert b["absorbed"] == []


class TestAbsorbDrop:
    """Absorbing the late boss box into the PENDING record: mutates the value INSIDE the drops
    ok envelope (build_raw_record doesn't copy the list — ok() references it — so that's what goes
    out in the flush JSON). An out-of-shape record → False and the caller keeps the chest on the
    current run."""

    def test_absorbs_into_drops_ok_envelope(self):
        rec = {"drops": {"ok": True, "value": [{"box_key": 910011, "monster_type": 0}]}}
        d = {"box_key": 920001, "monster_type": 1}
        assert _absorb_drop(rec, d) is True
        assert rec["drops"]["value"] == [{"box_key": 910011, "monster_type": 0}, d]

    def test_multiple_trailing_boxes_all_absorbed(self):
        # an x-10 clear can drop StageBoss AND ActBoss in sequence: all enter, in order.
        rec = {"drops": {"ok": True, "value": []}}
        assert _absorb_drop(rec, {"box_key": 920001, "monster_type": 1})
        assert _absorb_drop(rec, {"box_key": 930101, "monster_type": 2})
        assert [d["monster_type"] for d in rec["drops"]["value"]] == [1, 2]

    def test_malformed_record_refuses_without_raising(self):
        # never happens (drops is always ok(list) in build_raw_record), but the clean refusal is
        # what guarantees the "stays on the current run" fallback instead of losing the chest or
        # blowing up the tick.
        d = {"box_key": 920001, "monster_type": 1}
        assert _absorb_drop({}, d) is False                                  # no drops
        assert _absorb_drop({"drops": {"ok": False, "error": "x"}}, d) is False   # err envelope
        assert _absorb_drop({"drops": {"ok": True, "value": None}}, d) is False   # non-list value
        assert _absorb_drop(None, d) is False                                # non-dict rec


class TestDropCounts:
    """[Monster, Boss, ActBoss] count for live.json: CURRENT run + the pending's absorbed boxes.
    The late boss box RAISES the live count (a rising-edge the app's cooldown-tracker/drop-notifier
    detect); post-flush it drops (a baseline on the app, no event)."""

    def test_counts_current_run_by_tier(self):
        # parity with the inline loop this replaced (no pending = the old behavior).
        drops = [{"monster_type": 0}, {"monster_type": 0}, {"monster_type": 1}]
        assert _drop_counts(drops) == [2, 1, 0]

    def test_includes_pending_absorbed_boxes(self):
        # the gray is from the NEW run; the absorbed boss box (from the closed run) still counts in live.
        assert _drop_counts([{"monster_type": 0}],
                            [{"monster_type": 1}, {"monster_type": 2}]) == [1, 1, 1]

    def test_after_flush_count_falls_back_to_current_run(self):
        # flush clears the pending → the count returns to the current run (the drop = baseline, no event).
        assert _drop_counts([{"monster_type": 0}], None) == [1, 0, 0]
        assert _drop_counts([], None) == [0, 0, 0]

    def test_unknown_or_unread_tier_ignored(self):
        assert _drop_counts([{"monster_type": 7}, {"monster_type": None}, {}]) == [0, 0, 0]


class TestFlushPendingRec:
    """The flush writes the pending record to disk (the same atomic write as the immediate close) —
    the FLUSHED JSON is the contract: the absorbed boxes have to be in there inside the ok envelope."""

    def test_flushed_json_contains_absorbed_boxes(self, tmp_path):
        path = str(tmp_path / "raw" / "1717800000123.json")
        (tmp_path / "raw").mkdir()
        rec = {"id": "1717800000123",
               "drops": {"ok": True, "value": [{"box_key": 910011, "monster_type": 0}]}}
        d = {"box_key": 920001, "monster_type": 1}
        assert _absorb_drop(rec, d)
        p = _new_pending(rec, path, now=0.0)   # the SAME constructor as close_run (single shape)
        p["absorbed"].append(d)                # mirrors the loop's post-absorption tracking
        _flush_pending_rec(p)
        flushed = json.loads(open(path, encoding="utf-8").read())
        # the same wire shape as always ({"box_key", "monster_type"}), absorbed box included, in order.
        assert flushed["drops"] == {"ok": True, "value": [
            {"box_key": 910011, "monster_type": 0}, {"box_key": 920001, "monster_type": 1}]}

    def test_none_pending_is_noop(self, tmp_path):
        _flush_pending_rec(None)   # no pending: nothing to write, nothing raises

    def test_never_raises_on_unserializable_record(self, tmp_path, capsys):
        # never-raise in the tick loop: a non-serializable rec (impossible in practice — the record
        # is all primitive) becomes a WARN line in meter.log, never a session crash.
        path = str(tmp_path / "x.json")
        _flush_pending_rec(_new_pending({"id": "9", "bad": {1, 2}}, path, 0.0))
        assert "WARN flush failed" in capsys.readouterr().out
        assert not (tmp_path / "x.json").exists()

    def test_grace_constant_is_three_seconds(self):
        # 5x the observed trail (~0.6s) and ≥2-3 live.json snapshots. The run-lifecycle note
        # anchors this value by assert; changing it here means rethinking the app's rising-edge.
        assert PENDING_CLOSE_GRACE == 3.0
