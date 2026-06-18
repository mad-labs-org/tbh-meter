"""Testes para metrics/gold.py.

Cobre:
  run_gain       — função pura, zero dependências
  combat_gold_save — lê do MockReader (fallback do save defasado)
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
# Endereços fictícios para o layout de memória do PlayerSaveData
# ---------------------------------------------------------------------------
PSD = 0x1000
AGG_LIST = 0x2000
E0 = 0x3000   # primeiro entry
E1 = 0x3100   # segundo entry
E2 = 0x3200   # terceiro entry


def _make_save_reader(*entries):
    """Monta um MockReader com um PlayerSaveData contendo as entries fornecidas.

    entries: sequência de (EAggregateType, subkey, value).
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
# run_gain — função pura
# ---------------------------------------------------------------------------

class TestRunGain:
    def test_normal_positive_gain(self):
        assert run_gain(100, 500) == 400

    def test_zero_gain_is_valid(self):
        """Rodada sem ganho de gold ainda é uma rodada válida."""
        assert run_gain(100, 100) == 0

    def test_large_values(self):
        assert run_gain(999_000_000, 1_100_000_000) == 101_000_000

    def test_none_start_returns_none(self):
        """Baseline não lida → não reportar delta falso."""
        assert run_gain(None, 500) is None

    def test_none_end_returns_none(self):
        assert run_gain(100, None) is None

    def test_both_none_returns_none(self):
        assert run_gain(None, None) is None

    def test_non_monotonic_returns_none(self):
        """Cumulativo CAIU → leitura corrompida (GC moveu objeto). Não inventar gold."""
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
# combat_gold_save — leitura do save defasado (fallback)
# ---------------------------------------------------------------------------

class TestCombatGoldSave:
    def test_finds_correct_subkey(self):
        """Deve retornar o valor do SubKey 1 (COMBATE), não o 0 (total)."""
        reader = _make_save_reader(
            (EAggregateType.GoldEarn, COMBAT_SUBKEY, 5_000_000),
        )
        assert combat_gold_save(reader, PSD) == 5_000_000

    def test_ignores_total_subkey_zero(self):
        """SubKey 0 é o rollup total (inclui venda/idle). NUNCA usar como gold por run.

        Garante que mesmo que o SubKey 0 apareça ANTES do SubKey 1, retorna o 1.
        """
        reader = _make_save_reader(
            (EAggregateType.GoldEarn, TOTAL_SUBKEY, 99_999_999),  # total — errado
            (EAggregateType.GoldEarn, COMBAT_SUBKEY, 5_000_000),  # combate — certo
        )
        assert combat_gold_save(reader, PSD) == 5_000_000

    def test_ignores_other_aggregate_types(self):
        """MonsterKill, HeroDeath etc. com SubKey 1 não devem ser confundidos com gold."""
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
# resolve_combat_gold_klass_by_index — fast path por TypeDefIndex (RVA)
# ---------------------------------------------------------------------------

TBASE = 0x50000          # base fictícia da TypeInfoTable
IDX_UT = 2744            # TypeDefIndex provado (v1.00.07) do AggregateManager de gold
GOLD_KLASS = 0xABCDE0    # klass que table[IDX_UT] resolve


def _table_reader(*, entries):
    """MockReader cuja .mem expõe uma TypeInfoTable: entries = {idx: klass}.
    typeinfo.class_by_index lê rptr(tbase + idx*8)."""
    mem = {TBASE + idx * 8: klass for idx, klass in entries.items()}
    return MockReader(mem=mem)


class TestResolveCombatGoldKlassByIndex:
    def test_returns_klass_when_gate_ok(self, monkeypatch):
        """idx correto → table[idx] = klass vivo → gate ok → devolve o klass."""
        reader = _table_reader(entries={IDX_UT: GOLD_KLASS})
        monkeypatch.setattr(gold_mod, "combat_gold_klass_ok",
                            lambda r, k: k == GOLD_KLASS)
        assert resolve_combat_gold_klass_by_index(reader, TBASE, IDX_UT) == GOLD_KLASS

    def test_returns_none_when_gate_rejects_klass(self, monkeypatch):
        """idx ruim (calib velha/build trocou) → klass não resolve AggregateManager vivo →
        gate falha → None → caller cai no value-scan."""
        reader = _table_reader(entries={IDX_UT: 0xBADBAD0})
        monkeypatch.setattr(gold_mod, "combat_gold_klass_ok", lambda r, k: False)
        assert resolve_combat_gold_klass_by_index(reader, TBASE, IDX_UT) is None

    def test_returns_none_when_table_slot_empty(self, monkeypatch):
        """table[idx] nulo (índice fora ou anchor não inicializado) → None sem chamar o gate."""
        reader = _table_reader(entries={})
        called = {"gate": False}

        def _gate(r, k):
            called["gate"] = True
            return True

        monkeypatch.setattr(gold_mod, "combat_gold_klass_ok", _gate)
        assert resolve_combat_gold_klass_by_index(reader, TBASE, IDX_UT) is None
        assert called["gate"] is False    # K falsy → curto-circuito, gate não roda

    def test_returns_none_for_null_tbase(self, monkeypatch):
        monkeypatch.setattr(gold_mod, "combat_gold_klass_ok", lambda r, k: True)
        assert resolve_combat_gold_klass_by_index(MockReader(), 0, IDX_UT) is None


# ---------------------------------------------------------------------------
# find_gold_index — calibração 1×/build (value-scan → localiza o índice na tabela)
# ---------------------------------------------------------------------------

class TestFindGoldIndex:
    def test_locates_known_klass_index(self, monkeypatch):
        """value-scan acha o klass vivo; find_gold_index localiza seu TypeDefIndex na tabela."""
        reader = _table_reader(entries={100: 0x111, IDX_UT: GOLD_KLASS, 5000: 0x222})
        monkeypatch.setattr(gold_mod, "resolve_combat_gold_klass",
                            lambda r, psd_list: GOLD_KLASS)
        assert find_gold_index(reader, TBASE, psd_list=["psd"]) == IDX_UT

    def test_returns_first_matching_index(self, monkeypatch):
        """Klass duplicado na tabela → devolve o MENOR índice (varredura crescente)."""
        reader = _table_reader(entries={50: GOLD_KLASS, IDX_UT: GOLD_KLASS})
        monkeypatch.setattr(gold_mod, "resolve_combat_gold_klass",
                            lambda r, psd_list: GOLD_KLASS)
        assert find_gold_index(reader, TBASE, psd_list=["psd"]) == 50

    def test_returns_none_when_value_scan_fails(self, monkeypatch):
        """value-scan não convergiu → sem klass p/ localizar → None (caller mantém o scan)."""
        reader = _table_reader(entries={IDX_UT: GOLD_KLASS})
        monkeypatch.setattr(gold_mod, "resolve_combat_gold_klass",
                            lambda r, psd_list: None)
        assert find_gold_index(reader, TBASE, psd_list=["psd"]) is None

    def test_returns_none_when_klass_absent_from_table(self, monkeypatch):
        """Klass vivo achado mas não está na tabela varrida → None, sem crash."""
        reader = _table_reader(entries={100: 0x111, 5000: 0x222})
        monkeypatch.setattr(gold_mod, "resolve_combat_gold_klass",
                            lambda r, psd_list: GOLD_KLASS)
        assert find_gold_index(reader, TBASE, psd_list=["psd"]) is None

    def test_returns_none_for_null_tbase(self, monkeypatch):
        """Sem table_base (anchor não resolveu) → None sem rodar o value-scan."""
        called = {"scan": False}

        def _scan(r, psd_list):
            called["scan"] = True
            return GOLD_KLASS

        monkeypatch.setattr(gold_mod, "resolve_combat_gold_klass", _scan)
        assert find_gold_index(MockReader(), 0, psd_list=["psd"]) is None
        assert called["scan"] is False

    def test_respects_table_cap(self, monkeypatch):
        """O klass mora além do cap _MAX_TABLE_ENTRIES → não é alcançado → None."""
        beyond = typeinfo._MAX_TABLE_ENTRIES + 10
        reader = _table_reader(entries={beyond: GOLD_KLASS})
        monkeypatch.setattr(gold_mod, "resolve_combat_gold_klass",
                            lambda r, psd_list: GOLD_KLASS)
        assert find_gold_index(reader, TBASE, psd_list=["psd"]) is None


# ---------------------------------------------------------------------------
# gold_index_by_structure — idx_ut por ESTRUTURA, SEM value-scan (destravou o 1.00.11)
# ---------------------------------------------------------------------------

class TestGoldIndexByStructure:
    """idx_ut pelo walk estrutural (name-free): o MENOR idx cujo table[idx] passa
    combat_gold_klass_ok. Independe do value-scan (que devolvia gold_klass None no 1.00.11)."""

    def test_finds_index_passing_gate(self, monkeypatch):
        """Acha o índice cujo table[idx] passa o gate — sem tocar no nome ofuscado."""
        reader = _table_reader(entries={100: 0x111, IDX_UT: GOLD_KLASS})
        monkeypatch.setattr(gold_mod, "combat_gold_klass_ok", lambda r, k: k == GOLD_KLASS)
        assert gold_index_by_structure(reader, TBASE) == IDX_UT

    def test_returns_first_matching_index(self, monkeypatch):
        """Empate (gate passa em dois) → devolve o MENOR índice (varredura crescente)."""
        reader = _table_reader(entries={50: GOLD_KLASS, IDX_UT: GOLD_KLASS})
        monkeypatch.setattr(gold_mod, "combat_gold_klass_ok", lambda r, k: k == GOLD_KLASS)
        assert gold_index_by_structure(reader, TBASE) == 50

    def test_returns_none_when_no_index_passes(self, monkeypatch):
        """Nenhum slot passa o gate (ex.: rodou fora de combate) → None → caller mantém o scan."""
        reader = _table_reader(entries={100: 0x111, IDX_UT: 0x222})
        monkeypatch.setattr(gold_mod, "combat_gold_klass_ok", lambda r, k: False)
        assert gold_index_by_structure(reader, TBASE) is None

    def test_returns_none_for_null_tbase(self, monkeypatch):
        """Sem table_base (anchor não resolveu) → None sem rodar o gate."""
        called = {"gate": False}
        monkeypatch.setattr(gold_mod, "combat_gold_klass_ok",
                            lambda r, k: called.__setitem__("gate", True) or True)
        assert gold_index_by_structure(MockReader(), 0) is None
        assert called["gate"] is False

    def test_respects_table_cap(self, monkeypatch):
        """Gold mora além do cap _MAX_TABLE_ENTRIES → não é alcançado → None."""
        beyond = typeinfo._MAX_TABLE_ENTRIES + 10
        reader = _table_reader(entries={beyond: GOLD_KLASS})
        monkeypatch.setattr(gold_mod, "combat_gold_klass_ok", lambda r, k: k == GOLD_KLASS)
        assert gold_index_by_structure(reader, TBASE) is None
