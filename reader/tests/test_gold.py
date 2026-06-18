"""Tests for metrics/gold.py.

Covers:
  run_gain       — pure function, zero dependencies
  combat_gold_save — reads from MockReader (stale-save fallback)
"""

import pytest

import metrics.gold as gold_mod
from config.offsets import (
    AggregateSaveData, EAggregateType, PlayerSaveData,
)
from il2cpp import typeinfo
from metrics.gold import (
    COMBAT_SUBKEY, TOTAL_SUBKEY, combat_gold_save,
    find_gold_index, gold_index_by_structure, resolve_combat_gold_klass_by_index, run_gain,
)
from tests.conftest import MockReader

# ---------------------------------------------------------------------------
# Fake addresses for the PlayerSaveData memory layout
# ---------------------------------------------------------------------------
PSD = 0x1000
AGG_LIST = 0x2000
E0 = 0x3000   # first entry
E1 = 0x3100   # second entry
E2 = 0x3200   # third entry


def _make_save_reader(*entries):
    """Build a MockReader with a PlayerSaveData holding the given entries.

    entries: sequence of (EAggregateType, subkey, value).
    """
    mem = {PSD + PlayerSaveData.AGGREGATES: AGG_LIST}
    entry_bases = [E0, E1, E2]
    entry_addrs = []
    for i, (agg_type, subkey, value) in enumerate(entries):
        base = entry_bases[i]
        mem[base + AggregateSaveData.TYPE] = int(agg_type)
        mem[base + AggregateSaveData.SUB_KEY] = subkey
        mem[base + AggregateSaveData.VALUE] = value
        entry_addrs.append(base)
    reader = MockReader(mem=mem, lists={AGG_LIST: entry_addrs})
    return reader


# ---------------------------------------------------------------------------
# run_gain — pure function
# ---------------------------------------------------------------------------

class TestRunGain:
    def test_normal_positive_gain(self):
        assert run_gain(100, 500) == 400

    def test_zero_gain_is_valid(self):
        """A run with no gold gain is still a valid run."""
        assert run_gain(100, 100) == 0

    def test_large_values(self):
        assert run_gain(999_000_000, 1_100_000_000) == 101_000_000

    def test_none_start_returns_none(self):
        """Baseline not read → don't report a bogus delta."""
        assert run_gain(None, 500) is None

    def test_none_end_returns_none(self):
        assert run_gain(100, None) is None

    def test_both_none_returns_none(self):
        assert run_gain(None, None) is None

    def test_non_monotonic_returns_none(self):
        """Cumulative DROPPED → corrupted read (GC moved the object). Don't invent gold."""
        assert run_gain(500, 100) is None

    @pytest.mark.parametrize("start,end", [
        (0, 0),
        (1, 1),
        (1_000_000, 1_000_000),
    ])
    def test_same_value_is_zero_gain(self, start, end):
        assert run_gain(start, end) == 0

    @pytest.mark.parametrize("start,end,expected", [
        (0, 1_000, 1_000),
        (500_000, 1_500_000, 1_000_000),
        (1, 2, 1),
    ])
    def test_parametrized_gains(self, start, end, expected):
        assert run_gain(start, end) == expected


# ---------------------------------------------------------------------------
# combat_gold_save — reads the stale save (fallback)
# ---------------------------------------------------------------------------

class TestCombatGoldSave:
    def test_finds_correct_subkey(self):
        """Must return the value of SubKey 1 (COMBAT), not 0 (total)."""
        reader = _make_save_reader(
            (EAggregateType.GoldEarn, COMBAT_SUBKEY, 5_000_000),
        )
        assert combat_gold_save(reader, PSD) == 5_000_000

    def test_ignores_total_subkey_zero(self):
        """SubKey 0 is the total rollup (includes sell/idle). NEVER use it as per-run gold.

        Ensures that even if SubKey 0 appears BEFORE SubKey 1, it returns the 1.
        """
        reader = _make_save_reader(
            (EAggregateType.GoldEarn, TOTAL_SUBKEY, 99_999_999),  # total — wrong
            (EAggregateType.GoldEarn, COMBAT_SUBKEY, 5_000_000),  # combat — right
        )
        assert combat_gold_save(reader, PSD) == 5_000_000

    def test_ignores_other_aggregate_types(self):
        """MonsterKill, HeroDeath etc. with SubKey 1 must not be mistaken for gold."""
        reader = _make_save_reader(
            (EAggregateType.MonsterKill, COMBAT_SUBKEY, 300),
            (EAggregateType.GoldEarn, COMBAT_SUBKEY, 7_500_000),
        )
        assert combat_gold_save(reader, PSD) == 7_500_000

    def test_returns_none_when_entry_not_found(self):
        reader = _make_save_reader(
            (EAggregateType.MonsterKill, 0, 500),
        )
        assert combat_gold_save(reader, PSD) is None

    def test_returns_none_for_null_psd(self):
        assert combat_gold_save(MockReader(), None) is None

    def test_returns_none_for_zero_psd(self):
        assert combat_gold_save(MockReader(), 0) is None

    def test_empty_aggregate_list(self):
        reader = MockReader(
            mem={PSD + PlayerSaveData.AGGREGATES: AGG_LIST},
            lists={AGG_LIST: []},
        )
        assert combat_gold_save(reader, PSD) is None


# ---------------------------------------------------------------------------
# resolve_combat_gold_klass_by_index — fast path via TypeDefIndex (RVA)
# ---------------------------------------------------------------------------

TBASE = 0x50000          # fake TypeInfoTable base
IDX_UT = 2744            # proven TypeDefIndex (v1.00.07) of the gold AggregateManager
GOLD_KLASS = 0xABCDE0    # klass that table[IDX_UT] resolves to


def _table_reader(*, entries):
    """MockReader whose .mem exposes a TypeInfoTable: entries = {idx: klass}.
    typeinfo.class_by_index reads rptr(tbase + idx*8)."""
    mem = {TBASE + idx * 8: klass for idx, klass in entries.items()}
    return MockReader(mem=mem)


class TestResolveCombatGoldKlassByIndex:
    def test_returns_klass_when_gate_ok(self, monkeypatch):
        """correct idx → table[idx] = live klass → gate ok → returns the klass."""
        reader = _table_reader(entries={IDX_UT: GOLD_KLASS})
        monkeypatch.setattr(gold_mod, "combat_gold_klass_ok",
                            lambda r, k: k == GOLD_KLASS)
        assert resolve_combat_gold_klass_by_index(reader, TBASE, IDX_UT) == GOLD_KLASS

    def test_returns_none_when_gate_rejects_klass(self, monkeypatch):
        """bad idx (stale calib / build changed) → klass doesn't resolve a live AggregateManager →
        gate fails → None → caller falls back to the value-scan."""
        reader = _table_reader(entries={IDX_UT: 0xBADBAD0})
        monkeypatch.setattr(gold_mod, "combat_gold_klass_ok", lambda r, k: False)
        assert resolve_combat_gold_klass_by_index(reader, TBASE, IDX_UT) is None

    def test_returns_none_when_table_slot_empty(self, monkeypatch):
        """table[idx] null (index out of range or anchor uninitialized) → None without calling the gate."""
        reader = _table_reader(entries={})
        called = {"gate": False}

        def _gate(r, k):
            called["gate"] = True
            return True

        monkeypatch.setattr(gold_mod, "combat_gold_klass_ok", _gate)
        assert resolve_combat_gold_klass_by_index(reader, TBASE, IDX_UT) is None
        assert called["gate"] is False    # K falsy → short-circuit, gate doesn't run

    def test_returns_none_for_null_tbase(self, monkeypatch):
        monkeypatch.setattr(gold_mod, "combat_gold_klass_ok", lambda r, k: True)
        assert resolve_combat_gold_klass_by_index(MockReader(), 0, IDX_UT) is None


# ---------------------------------------------------------------------------
# find_gold_index — calibration 1×/build (value-scan → locates the index in the table)
# ---------------------------------------------------------------------------

class TestFindGoldIndex:
    def test_locates_known_klass_index(self, monkeypatch):
        """value-scan finds the live klass; find_gold_index locates its TypeDefIndex in the table."""
        reader = _table_reader(entries={100: 0x111, IDX_UT: GOLD_KLASS, 5000: 0x222})
        monkeypatch.setattr(gold_mod, "resolve_combat_gold_klass",
                            lambda r, psd_list: GOLD_KLASS)
        assert find_gold_index(reader, TBASE, psd_list=["psd"]) == IDX_UT

    def test_returns_first_matching_index(self, monkeypatch):
        """Klass duplicated in the table → returns the SMALLEST index (ascending scan)."""
        reader = _table_reader(entries={50: GOLD_KLASS, IDX_UT: GOLD_KLASS})
        monkeypatch.setattr(gold_mod, "resolve_combat_gold_klass",
                            lambda r, psd_list: GOLD_KLASS)
        assert find_gold_index(reader, TBASE, psd_list=["psd"]) == 50

    def test_returns_none_when_value_scan_fails(self, monkeypatch):
        """value-scan didn't converge → no klass to locate → None (caller keeps scanning)."""
        reader = _table_reader(entries={IDX_UT: GOLD_KLASS})
        monkeypatch.setattr(gold_mod, "resolve_combat_gold_klass",
                            lambda r, psd_list: None)
        assert find_gold_index(reader, TBASE, psd_list=["psd"]) is None

    def test_returns_none_when_klass_absent_from_table(self, monkeypatch):
        """Live klass found but not in the scanned table → None, no crash."""
        reader = _table_reader(entries={100: 0x111, 5000: 0x222})
        monkeypatch.setattr(gold_mod, "resolve_combat_gold_klass",
                            lambda r, psd_list: GOLD_KLASS)
        assert find_gold_index(reader, TBASE, psd_list=["psd"]) is None

    def test_returns_none_for_null_tbase(self, monkeypatch):
        """No table_base (anchor didn't resolve) → None without running the value-scan."""
        called = {"scan": False}

        def _scan(r, psd_list):
            called["scan"] = True
            return GOLD_KLASS

        monkeypatch.setattr(gold_mod, "resolve_combat_gold_klass", _scan)
        assert find_gold_index(MockReader(), 0, psd_list=["psd"]) is None
        assert called["scan"] is False

    def test_respects_table_cap(self, monkeypatch):
        """The klass lives beyond the _MAX_TABLE_ENTRIES cap → not reached → None."""
        beyond = typeinfo._MAX_TABLE_ENTRIES + 10
        reader = _table_reader(entries={beyond: GOLD_KLASS})
        monkeypatch.setattr(gold_mod, "resolve_combat_gold_klass",
                            lambda r, psd_list: GOLD_KLASS)
        assert find_gold_index(reader, TBASE, psd_list=["psd"]) is None


# ---------------------------------------------------------------------------
# gold_index_by_structure — idx_ut by STRUCTURE, NO value-scan (unblocked 1.00.11)
# ---------------------------------------------------------------------------

class TestGoldIndexByStructure:
    """idx_ut via the structural walk (name-free): the SMALLEST idx whose table[idx] passes
    combat_gold_klass_ok. Independent of the value-scan (which returned gold_klass None on 1.00.11)."""

    def test_finds_index_passing_gate(self, monkeypatch):
        """Finds the index whose table[idx] passes the gate — without touching the obfuscated name."""
        reader = _table_reader(entries={100: 0x111, IDX_UT: GOLD_KLASS})
        monkeypatch.setattr(gold_mod, "combat_gold_klass_ok", lambda r, k: k == GOLD_KLASS)
        assert gold_index_by_structure(reader, TBASE) == IDX_UT

    def test_returns_first_matching_index(self, monkeypatch):
        """Tie (gate passes for two) → returns the SMALLEST index (ascending scan)."""
        reader = _table_reader(entries={50: GOLD_KLASS, IDX_UT: GOLD_KLASS})
        monkeypatch.setattr(gold_mod, "combat_gold_klass_ok", lambda r, k: k == GOLD_KLASS)
        assert gold_index_by_structure(reader, TBASE) == 50

    def test_returns_none_when_no_index_passes(self, monkeypatch):
        """No slot passes the gate (e.g. ran outside combat) → None → caller keeps scanning."""
        reader = _table_reader(entries={100: 0x111, IDX_UT: 0x222})
        monkeypatch.setattr(gold_mod, "combat_gold_klass_ok", lambda r, k: False)
        assert gold_index_by_structure(reader, TBASE) is None

    def test_returns_none_for_null_tbase(self, monkeypatch):
        """No table_base (anchor didn't resolve) → None without running the gate."""
        called = {"gate": False}
        monkeypatch.setattr(gold_mod, "combat_gold_klass_ok",
                            lambda r, k: called.__setitem__("gate", True) or True)
        assert gold_index_by_structure(MockReader(), 0) is None
        assert called["gate"] is False

    def test_respects_table_cap(self, monkeypatch):
        """Gold lives beyond the _MAX_TABLE_ENTRIES cap → not reached → None."""
        beyond = typeinfo._MAX_TABLE_ENTRIES + 10
        reader = _table_reader(entries={beyond: GOLD_KLASS})
        monkeypatch.setattr(gold_mod, "combat_gold_klass_ok", lambda r, k: k == GOLD_KLASS)
        assert gold_index_by_structure(reader, TBASE) is None
