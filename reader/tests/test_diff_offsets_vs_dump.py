"""Regressão do TRIPWIRE estático código↔jogo (scripts/diff_offsets_vs_dump.py).

POR QUÊ existe: o tripwire é o gate que deveria ter pego o 1.00.12 ANTES do ship — o bucket-box
inseriu campos no `PlayerSaveData` e deslocou as listas do save (+0x10), e o check ANTIGO (só
PRESENÇA de offset + uma lista curada de ~20 nomes) passou verde porque outro campo caiu no offset
velho. Estes testes provam que o tripwire endurecido:
  1. fica VERDE (exit 0) num layout correto;
  2. fica VERMELHO (exit != 0) quando uma INSERÇÃO desloca uma lista do save (a classe de bug do
     1.00.12), com uma linha `CAMPO ERRADO` E o relatório de inserção apontando o campo intruso;
  3. deriva o nome esperado por fuzzy (sem lista que apodrece) e PULA nomes ofuscados (que driftam
     por build — os `*Log`), sem falsos positivos.

NÃO depende do dump.cs real (que vive fora do repo, na máquina do mantenedor): monta um dump.cs
SINTÉTICO inline. A completude vs. o build real é trabalho do próprio script rodado na skill
meter-game-update; aqui garantimos a LÓGICA do gate por regressão de unidade.
"""

import importlib.util
import io
import os
from contextlib import redirect_stdout

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPT = os.path.normpath(os.path.join(_HERE, "..", "scripts", "diff_offsets_vs_dump.py"))


def _load_script():
    """Importa o script como módulo (ele põe a raiz do reader no path no import)."""
    spec = importlib.util.spec_from_file_location("diff_offsets_vs_dump", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


D = _load_script()


# --------------------------------------------------------------------------- #
# Helpers puros (sem I/O) — o coração da derivação de nome anti-rot
# --------------------------------------------------------------------------- #
class TestObfuscationDetector:
    """`_is_obf_field` separa nome REAL (verificável) de nome OFUSCADO (drifta por build)."""

    @pytest.mark.parametrize("obf", ["bfge", "bffo", "ph", "bcqv", "uu", "ut", "bfgm"])
    def test_obfuscated_names_detected(self, obf):
        assert D._is_obf_field(obf) is True

    @pytest.mark.parametrize("real", [
        "StageKey", "heroSaveDatas", "MonsterList", "b_isHero", "playTime",
        "currentStageKey", "HeroLevel", "equippedItemIds", "BoxBucketUseBoxList",
    ])
    def test_real_names_not_obfuscated(self, real):
        assert D._is_obf_field(real) is False

    def test_empty_is_not_obfuscated(self):
        assert D._is_obf_field("") is False
        assert D._is_obf_field(None) is False


class TestFuzzyNameMatch:
    """`_name_matches` liga o ATTR de offsets.py ao nome do dump por substring normalizada."""

    @pytest.mark.parametrize("attr,dump", [
        ("HERO_KEY", "heroKey"), ("STAGE_KEY", "StageKey"), ("KEY", "Key"),
        ("QUANTITY", "Quantity"), ("RUNES", "RuneSaveData"), ("CLASS_TYPE", "ClassType"),
        ("LEVEL", "HeroLevel"), ("STAGE_NO", "StageNo"), ("VALUE", "Value"),
    ])
    def test_matches(self, attr, dump):
        assert D._name_matches(attr, dump) is True

    @pytest.mark.parametrize("attr,dump", [
        ("CURRENCIES", "heroSaveDatas"), ("HEROES", "BoxBucketUseBoxList"),
        ("ITEMS", "aggregateSaveDatas"), ("KEY", "Quantity"),
    ])
    def test_mismatches(self, attr, dump):
        assert D._name_matches(attr, dump) is False


class TestExpectedFieldName:
    """`_expected_field_name`: override > fuzzy > None(ofuscado). É a derivação anti-rot."""

    def test_override_wins(self):
        # HEROES↔heroSaveDatas só liga pelo override (fuzzy não liga "heroes" a "herosavedatas"? liga,
        # mas o override é a fonte canônica) — o override deve devolver o nome exato do dump.
        assert D._expected_field_name("PlayerSaveData", "CURRENCIES", "currenySaveDatas") == "currenySaveDatas"

    def test_fuzzy_ok_returns_empty_sentinel(self):
        # "" = casou por fuzzy, sem precisar de override nem de assert por nome.
        assert D._expected_field_name("HeroInfoData", "HERO_KEY", "HeroKey") == ""

    def test_fuzzy_mismatch_demands_attr(self):
        # nome do dump REAL mas não casa o ATTR → exige (devolve o ATTR p/ a comparação falhar).
        got = D._expected_field_name("PlayerSaveData", "ATTRIBUTES", "heroSaveDatas")
        assert got == "ATTRIBUTES"

    def test_obfuscated_returns_none(self):
        # nome ofuscado no dump (os *Log) → None = não-verificável por nome (live-gate cobre).
        assert D._expected_field_name("StageClearLog", "ACT", "bfge") is None


class TestInsertionReport:
    """`_insertion_report` lista campos do dump na janela rastreada que offsets.py NÃO conhece —
    o sinal direto de uma INSERÇÃO (a classe de bug do bucket-box)."""

    def test_flags_unexpected_field_in_window(self):
        own = {0x10: ("commonSaveData", "X"), 0x28: ("BoxBucketUseBoxList", "Y"),
               0x38: ("currenySaveDatas", "List")}
        # offsets.py rastreia 0x10 e 0x38; 0x28 (o intruso) está na janela e não é rastreado.
        ins = D._insertion_report(own, [0x10, 0x38])
        offs = [o for o, _ in ins]
        assert 0x28 in offs
        assert any("BoxBucketUseBoxList" in f for _, f in ins)

    def test_empty_when_contiguous(self):
        own = {0x10: ("a", "X"), 0x18: ("b", "Y")}
        assert D._insertion_report(own, [0x10, 0x18]) == []

    def test_empty_when_no_tracked(self):
        assert D._insertion_report({0x10: ("a", "X")}, []) == []


# --------------------------------------------------------------------------- #
# End-to-end: dump.cs SINTÉTICO → main() (exit 0 limpo, exit 1 com inserção)
# --------------------------------------------------------------------------- #
def _field(jsonp, cstype, name, off):
    return f'\t[JsonProperty("{jsonp}")]\n\tpublic {cstype} {name}; // 0x{off:X}\n'


def _synth_dump(player_save_lines):
    """Monta um dump.cs mínimo: só as classes que o tripwire confere por nome de campo +
    a prova de gold (idx_ut). `player_save_lines` = corpo de PlayerSaveData (varia por cenário)."""
    parts = []
    parts.append("// Namespace: TaskbarHero.EasySaveData\npublic class PlayerSaveData // TypeDefIndex: 2675\n{\n\t// Fields\n")
    parts.append(player_save_lines)
    parts.append("\n}\n")

    # CurrencySaveData / HeroSaveData / AggregateSaveData — campos NOMEADOS que o gate confere.
    parts.append("public class CurrencySaveData // TypeDefIndex: 3056\n{\n\t// Fields\n")
    parts.append(_field("Key", "int", "Key", 0x10))
    parts.append(_field("Quantity", "long", "Quantity", 0x18))
    parts.append("}\n")

    parts.append("public class HeroSaveData // TypeDefIndex: 3058\n{\n\t// Fields\n")
    parts.append(_field("heroKey", "int", "heroKey", 0x10))
    parts.append(_field("HeroLevel", "int", "HeroLevel", 0x14))
    parts.append(_field("HeroExp", "float", "HeroExp", 0x1C))
    parts.append(_field("equippedItemIds", "ulong[]", "equippedItemIds", 0x28))
    parts.append(_field("equippedSKillKey", "int[]", "equippedSKillKey", 0x30))
    parts.append("}\n")

    parts.append("public class AggregateSaveData // TypeDefIndex: 3054\n{\n\t// Fields\n")
    parts.append(_field("Type", "int", "Type", 0x10))
    parts.append(_field("SubKey", "int", "SubKey", 0x14))
    parts.append(_field("Value", "long", "Value", 0x18))
    parts.append("}\n")
    return "".join(parts)


# Corpo CORRETO do PlayerSaveData (offsets 1.00.12 = os que offsets.py tem hoje).
_PSD_OK = "".join([
    _field("commonSaveData", "CommonSaveData", "commonSaveData", 0x10),
    _field("currenySaveDatas", "List<CurrencySaveData>", "currenySaveDatas", 0x38),
    _field("heroSaveDatas", "List<HeroSaveData>", "heroSaveDatas", 0x40),
    _field("attributeSaveDatas", "List<AttributeSaveData>", "attributeSaveDatas", 0x50),
    _field("RuneSaveData", "List<RuneSaveData>", "RuneSaveData", 0x60),
    _field("inventorySaveDatas", "List<InventorySaveData>", "inventorySaveDatas", 0x68),
    _field("stashSaveDatas", "List<StashSaveData>", "stashSaveDatas", 0x70),
    _field("itemSaveDatas", "List<ItemSaveData>", "itemSaveDatas", 0x90),
    _field("aggregateSaveDatas", "List<AggregateSaveData>", "aggregateSaveDatas", 0x98),
])

# Corpo de um build com a INSERÇÃO do bucket-box NÃO acomodada por offsets.py: no offset que o
# offsets.py rastreia como CURRENCIES (0x38) o dump tem o campo INTRUSO `BoxBucketUseBoxList`, e a
# lista de currency real deslocou p/ 0x48 (não-rastreado). É a classe de bug EXATA do 1.00.12 — um
# campo presente no offset velho deixou o check de só-presença passar verde. Os demais offsets
# rastreados continuam com o campo certo (só CURRENCIES trips → prova o name-check, não um shift geral).
_PSD_SHIFTED = "".join([
    _field("commonSaveData", "CommonSaveData", "commonSaveData", 0x10),
    _field("BoxBucketUseBoxList", "List<int>", "BoxBucketUseBoxList", 0x38),  # intruso onde vai CURRENCIES
    _field("heroSaveDatas", "List<HeroSaveData>", "heroSaveDatas", 0x40),
    _field("currenySaveDatas", "List<CurrencySaveData>", "currenySaveDatas", 0x48),  # currency real, deslocada
    _field("attributeSaveDatas", "List<AttributeSaveData>", "attributeSaveDatas", 0x50),
    _field("RuneSaveData", "List<RuneSaveData>", "RuneSaveData", 0x60),
    _field("inventorySaveDatas", "List<InventorySaveData>", "inventorySaveDatas", 0x68),
    _field("stashSaveDatas", "List<StashSaveData>", "stashSaveDatas", 0x70),
    _field("itemSaveDatas", "List<ItemSaveData>", "itemSaveDatas", 0x90),
    _field("aggregateSaveDatas", "List<AggregateSaveData>", "aggregateSaveDatas", 0x98),
])


def _run_main(tmp_path, psd_body, with_seed=False):
    dump = tmp_path / "dump.cs"
    dump.write_text(_synth_dump(psd_body), encoding="utf-8")
    argv = ["--dump", str(dump)]
    seed_path = None
    if with_seed:
        import json
        seed_path = tmp_path / "seed.json"
        json.dump({"fmt": 9, "calib": {"fp": {
            "anchor_rva": 123456, "idx_ut": 7, "indices": {"PlayerSaveData": 2675}}}},
            open(seed_path, "w"))
        argv += ["--seed", str(seed_path)]
    import sys
    old = sys.argv
    sys.argv = ["diff_offsets_vs_dump.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = D.main()
    finally:
        sys.argv = old
    return rc, buf.getvalue()


class TestEndToEndSyntheticDump:
    def test_clean_layout_exits_zero(self, tmp_path):
        rc, out = _run_main(tmp_path, _PSD_OK)
        assert rc == 0, out
        # As três classes nomeadas batem (sem ✗).
        assert "✗" not in out
        assert "PlayerSaveData" in out and "CurrencySaveData" in out

    def test_bucketbox_insertion_exits_nonzero(self, tmp_path):
        # A regressão do 1.00.12: deve FALHAR (rc=1) com CAMPO ERRADO E o relatório de inserção.
        rc, out = _run_main(tmp_path, _PSD_SHIFTED)
        assert rc == 1, out
        assert "CAMPO ERRADO" in out
        assert "CURRENCIES" in out
        # O relatório de inserção tem que nomear o campo intruso do bucket-box.
        assert "INSERÇÃO" in out
        assert "BoxBucketUseBoxList" in out

    def test_seed_idx_ut_must_hold_gold_dict(self, tmp_path):
        # No dump sintético NENHUMA classe tem Dictionary<EAggregateType,…> → idx_ut não prova gold
        # → o gate de seed FALHA (a classe de bug "gold reindexou / value-scan pegou frozen=0").
        rc, out = _run_main(tmp_path, _PSD_OK, with_seed=True)
        assert rc == 1, out
        assert "idx_ut" in out
