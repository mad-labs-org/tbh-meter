"""test_calib_safety.py — ADVERSARIAL: prova que o tripwire estático (scripts/diff_offsets_vs_dump.py)
PEGA cada classe de quebra "silenciosa por build" do reader, injetando a corrupção e exigindo que o
gate saia != 0 contra o dump.cs REAL do 1.00.12.

POR QUÊ (a diferença pro test_diff_offsets_vs_dump.py): aquele prova a LÓGICA do gate com dumps
SINTÉTICOS inline. ESTE prova, contra o BINÁRIO REAL do jogo (o dump fresco que o mantenedor já tem
em ~/tbh-dump), que se um offset/enum/índice de seed regredir do jeito que regrediu de verdade nos 3
bugs históricos, o gate VERMELHA. É o "teste do alarme com fumaça de verdade": cada teste reencena uma
quebra real — sobretudo o 1.00.12, em que o bucket-box inseriu campos no PlayerSaveData e a lista de
gold caiu p/ onde antes ficava CURRENCIES, com `BoxBucketUseBoxList` ocupando o offset velho (0x28),
e o check de só-presença passou VERDE e shipou a parada de upload fleet-wide.

O dump.cs vive FORA do repo (na máquina do mantenedor) — então estes testes PULAM (skip) onde ele não
existe (CI/contribuidor) e RODAM onde existe (o Mac do mantenedor + a skill meter-game-update). Isso
satisfaz "passa com o código correto" em qualquer lugar e dá o alarme-com-fumaça-real onde importa.
A regressão pura de offset (sem dump) é a do test_diff_offsets_vs_dump.py (dump sintético) e a do
test_offsets.py (pin de valor); aqui o foco é provar a DETECÇÃO contra o build real.

Mecanismo da injeção: o gate introspecta `config.offsets` AO VIVO (`offsets_classes`/`offsets_enums`
leem `vars(O)` a cada chamada de `main()`), então monkeypatchar um ATTR de classe de offsets (ou
`D.offsets_enums`) reescreve o que o gate enxerga — sem tocar no arquivo. O seed é lido de DISCO, então
a corrupção de seed escreve uma cópia mutada num tmp; o config/calib_seed.json COMITADO nunca é tocado.
"""

import copy
import importlib.util
import io
import json
import os
import sys
from contextlib import redirect_stdout

import pytest

from config import offsets as O

_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPT = os.path.normpath(os.path.join(_HERE, "..", "scripts", "diff_offsets_vs_dump.py"))
# Dump fresco do Il2CppDumper na máquina do mantenedor (NÃO vive no repo — ver cabeçalho).
_DUMP = os.path.expanduser("~/tbh-dump/tool/dump.cs")
_SEED = os.path.normpath(os.path.join(_HERE, "..", "config", "calib_seed.json"))

# Sem o dump real não dá p/ rodar o alarme-com-fumaça-real; pula em vez de falsear. RODA no Mac do
# mantenedor + na skill meter-game-update (onde o dump SEMPRE existe).
pytestmark = pytest.mark.skipif(
    not os.path.isfile(_DUMP),
    reason=f"dump.cs real ausente ({_DUMP}) — tripwire-vs-build roda só onde o dump existe",
)


def _load_script():
    """Importa o script como módulo (ele põe a raiz do reader no path no import)."""
    spec = importlib.util.spec_from_file_location("diff_offsets_vs_dump", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


D = _load_script()


def _run_main(argv):
    """Roda D.main() com argv dado, capturando (rc, stdout)."""
    old = sys.argv
    sys.argv = ["diff_offsets_vs_dump.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = D.main()
    finally:
        sys.argv = old
    return rc, buf.getvalue()


def _run_dump():
    return _run_main(["--dump", _DUMP])


def _run_dump_seed(seed_path=None):
    return _run_main(["--dump", _DUMP, "--seed", seed_path or _SEED])


def _corrupt_seed(tmp_path, mutate):
    """Escreve uma CÓPIA do seed comitado com a 1ª (única) entry de calib mutada por `mutate(entry)`.
    Devolve o caminho do tmp. O seed comitado NUNCA é tocado."""
    doc = json.load(open(_SEED, encoding="utf-8"))
    fp = next(iter(doc["calib"]))
    doc = copy.deepcopy(doc)
    mutate(doc["calib"][fp])
    p = tmp_path / "seed_corrupt.json"
    json.dump(doc, open(p, "w", encoding="utf-8"))
    return str(p)


# --------------------------------------------------------------------------- #
# BASELINE — o build real + seed comitado têm que estar VERDES, senão os adversariais
# (que corrompem um estado sabidamente-bom) não provam nada.
# --------------------------------------------------------------------------- #
class TestBaselineRealDumpIsGreen:
    def test_offsets_and_enums_clean(self):
        rc, out = _run_dump()
        assert rc == 0, out
        assert "DRIFT DETECTADO" not in out

    def test_with_seed_clean(self):
        rc, out = _run_dump_seed()
        assert rc == 0, out
        # idx_ut do seed comitado tem que resolver a classe (ofuscada) com o dict de gold.
        assert "gold OK" in out


# --------------------------------------------------------------------------- #
# OFFSETS — cada teste reencena um SHIFT real e exige VERMELHO (rc != 0).
# Monkeypatch no ATTR da classe de offsets (auto-restaurado pelo fixture).
# --------------------------------------------------------------------------- #
class TestOffsetCorruptionCaught:
    """Cada injeção = uma forma do offsets.py regredir num patch; o gate TEM que pegar."""

    def test_the_1_00_12_break_exact(self, monkeypatch):
        """A QUEBRA REAL do 1.00.12, byte-a-byte: antes do fix CURRENCIES era 0x28; no build 1.00.12 o
        bucket-box pôs `BoxBucketUseBoxList` EXATAMENTE em 0x28 e empurrou a currency real p/ 0x38. O
        check de só-presença passava verde (havia ALGO em 0x28). O gate endurecido tem que VERMELHAR
        com CAMPO ERRADO nomeando o intruso real do dump."""
        monkeypatch.setattr(O.PlayerSaveData, "CURRENCIES", 0x28)
        rc, out = _run_dump()
        assert rc == 1, out
        assert "CAMPO ERRADO" in out
        assert "CURRENCIES" in out
        # Tem que nomear o campo intruso EXATO que o dump real do 1.00.12 tem em 0x28.
        assert "BoxBucketUseBoxList" in out
        # E o resumo tem que listar o deslocamento como motivo de falha.
        assert "DRIFT DETECTADO" in out

    def test_wrong_field_at_offset_currency_quantity(self, monkeypatch):
        """'offset PRESENTE, CAMPO ERRADO' fora do PlayerSaveData: QUANTITY apontando p/ 0x10 cai no
        campo `Key` (existe, mas é o errado). Era um gap (QUANTITY não era name-checada) — agora pega."""
        monkeypatch.setattr(O.CurrencySaveData, "QUANTITY", O.CurrencySaveData.KEY)
        rc, out = _run_dump()
        assert rc == 1, out
        assert "CAMPO ERRADO" in out
        assert "QUANTITY" in out

    def test_offset_shift_to_empty_slot_is_missing(self, monkeypatch):
        """SHIFT p/ um offset SEM campo no dump (0x44 não existe no PlayerSaveData real) → SEM CAMPO.
        É o sinal de um campo que sumiu/encolheu (a outra metade da classe de bug de shift)."""
        monkeypatch.setattr(O.PlayerSaveData, "ATTRIBUTES", 0x44)
        rc, out = _run_dump()
        assert rc == 1, out
        assert "SEM CAMPO" in out
        assert "ATTRIBUTES" in out

    def test_hero_list_shift_caught_on_named_class(self, monkeypatch):
        """A lista de heróis do save (HEROES) é a raiz da parada de upload (heroes=[] → eligible() pula).
        Deslocá-la p/ 0x48 cai em `mailSaveDatas` (um campo NÃO-lista) → CAMPO ERRADO."""
        monkeypatch.setattr(O.PlayerSaveData, "HEROES", 0x48)
        rc, out = _run_dump()
        assert rc == 1, out
        assert "HEROES" in out
        assert "DRIFT DETECTADO" in out

    def test_item_enchant_stride_field_shift_caught(self, monkeypatch):
        """A iteração de enchant (ItemEnchant, alias p/ ItemEnchantSaveData no dump) é silenciosa se
        desalinhar. Mover STAT_TYPE p/ um offset com outro campo nomeado tem que VERMELHAR."""
        # 0x4 no struct de enchant = TIER (nomeado) — STAT_TYPE caindo aqui é CAMPO ERRADO.
        monkeypatch.setattr(O.ItemEnchant, "STAT_TYPE", O.ItemEnchant.TIER)
        rc, out = _run_dump()
        assert rc == 1, out
        assert "ItemEnchant" in out


# --------------------------------------------------------------------------- #
# ENUMS — renumerar um membro (o jogo reordenou um enum) tem que VERMELHAR.
# Monkeypatch em D.offsets_enums (IntEnum não dá p/ remapear membro em runtime).
# --------------------------------------------------------------------------- #
class TestEnumCorruptionCaught:
    def test_stattype_renumber_caught(self, monkeypatch):
        """Reordenar um StatType (ex.: MaxHp 5→999) desalinha os 64 stats por herói (silencioso)."""
        real = D.offsets_enums

        def patched():
            e = real()
            e["StatType"] = dict(e["StatType"])
            e["StatType"]["MAXHP"] = 999
            return e

        monkeypatch.setattr(D, "offsets_enums", patched)
        rc, out = _run_dump()
        assert rc == 1, out
        assert "StatType" in out
        assert "DRIFT DETECTADO" in out

    def test_gold_aggregate_type_renumber_caught(self, monkeypatch):
        """GoldEarn é o membro load-bearing do gold (combat_gold lê GoldEarn[SubKey1]). Renumerá-lo
        (2→7) tem que VERMELHAR — é a leitura de gold inteira que quebraria."""
        real = D.offsets_enums

        def patched():
            e = real()
            e["EAggregateType"] = dict(e["EAggregateType"])
            e["EAggregateType"]["GOLDEARN"] = 7
            return e

        monkeypatch.setattr(D, "offsets_enums", patched)
        rc, out = _run_dump()
        assert rc == 1, out
        assert "EAggregateType.GOLDEARN" in out


# --------------------------------------------------------------------------- #
# SEED — TypeDefIndex / anchor_rva / idx_ut. Corrompe uma CÓPIA do seed num tmp.
# --------------------------------------------------------------------------- #
class TestSeedCorruptionCaught:
    def test_wrong_typedef_index_caught(self, tmp_path):
        """Um TypeDefIndex do seed que não bate com o dump (build reindexou) → ✗ índice."""
        p = _corrupt_seed(tmp_path, lambda e: e["indices"].__setitem__(
            "PlayerSaveData", e["indices"]["PlayerSaveData"] + 1))
        rc, out = _run_dump_seed(p)
        assert rc == 1, out
        assert "índice PlayerSaveData" in out
        assert "DRIFT DETECTADO" in out

    def test_bad_anchor_rva_caught(self, tmp_path):
        """anchor_rva ausente/zero (discover_anchor deu false-pass e gravou lixo) tem que VERMELHAR —
        o RVA não é diffável, mas um valor inválido é detectável e nunca era re-validado (gap do plano)."""
        p = _corrupt_seed(tmp_path, lambda e: e.__setitem__("anchor_rva", 0))
        rc, out = _run_dump_seed(p)
        assert rc == 1, out
        assert "anchor_rva" in out

    def test_idx_ut_not_holding_gold_dict_caught(self, tmp_path):
        """idx_ut tem que apontar p/ a classe que TEM Dictionary<EAggregateType,…> (o AggregateManager
        ofuscado). Apontá-lo p/ outra classe (ex.: o índice do PlayerSaveData) = a classe de bug
        'gold reindexou / value-scan pegou frozen=0/1.97T'. Tem que VERMELHAR com idx_ut."""
        p = _corrupt_seed(tmp_path, lambda e: e.__setitem__("idx_ut", e["indices"]["PlayerSaveData"]))
        rc, out = _run_dump_seed(p)
        assert rc == 1, out
        assert "idx_ut" in out
        assert "NÃO tem" in out

    def test_missing_seed_index_key_is_surfaced(self, tmp_path):
        """Tirar uma classe das `indices` do seed (catálogo do seed incompleto) NÃO pode passar como
        verde-com-tudo-OK: o total de índices cai e o gate reporta menos do que o build espera. Aqui
        provamos que remover uma chave não introduz um falso ✓ silencioso — o resumo reflete a queda."""
        _rc_full, full = _run_dump_seed()
        # remove uma chave de índice e confirma que a contagem '/N TypeDefIndex' DIMINUI no relatório.
        p = _corrupt_seed(tmp_path, lambda e: e["indices"].pop("StageManager", None))
        rc, out = _run_dump_seed(p)
        # rc segue 0 (as chaves restantes batem), mas o relatório tem que mostrar 1 índice a MENOS —
        # senão uma chave faltando passaria invisível. Compara o "/N" do total de índices.
        import re
        n_full = int(re.search(r"(\d+)/(\d+) TypeDefIndex", full).group(2))
        n_part = int(re.search(r"(\d+)/(\d+) TypeDefIndex", out).group(2))
        assert n_part == n_full - 1, f"full={n_full} part={n_part}\n{out}"


# --------------------------------------------------------------------------- #
# CONSISTÊNCIA INTERNA — todo campo que o reader DESREFERENCIA no caminho de save PLAINTEXT
# tem que ser COBERTO pelo name-check do tripwire (não pode ser name-unverifiable/silencioso).
# Assim, adicionar uma leitura nova SEM um guard de nome no dump FALHA o CI aqui.
# --------------------------------------------------------------------------- #

# Campos PLAINTEXT (nome real no dump) que o reader lê — espelha game/save.py, game/build.py,
# metrics/gold.py, game/models.py e os catálogos. NÃO inclui os singletons OFUSCADOS (AggregateManager/
# HeroRuntime/StatsHolder/UnitHealthController/StatModifier): esses são name-free por design e o gate
# os reporta como UNVERIFIABLE de propósito — quem os valida é o gate AO VIVO (validate_live.py), não
# este name-check. Se você adicionar uma leitura PLAINTEXT nova, adicione o campo aqui: se o nome no
# dump não for verificável (fuzzy/override), este teste falha — exatamente o ponto (sem guard, sem CI).
_CONSUMED_PLAINTEXT = {
    "PlayerSaveData": ["CURRENCIES", "HEROES", "ATTRIBUTES", "RUNES",
                       "INVENTORY_SLOTS", "STASH", "ITEMS", "AGGREGATES"],
    "CurrencySaveData": ["KEY", "QUANTITY"],
    "HeroSaveData": ["HERO_KEY", "LEVEL", "EXP", "EQUIPPED_ITEMS", "EQUIPPED_SKILLS"],
    "AttributeSaveData": ["KEY", "LEVEL"],
    "RuneSaveData": ["KEY", "LEVEL"],
    "InventorySaveData": ["UNIQUE_ID"],
    "StashSaveData": ["UNIQUE_ID"],
    "ItemSaveData": ["ITEM_KEY", "UNIQUE_ID", "ENCHANT_DATA"],
    "ItemEnchant": ["TIER", "VALUE", "RECIPE", "STAT_TYPE"],
    "AggregateSaveData": ["TYPE", "SUB_KEY", "VALUE"],
    "HeroInfoData": ["HERO_KEY", "CLASS_TYPE"],
    "StageInfoData": ["STAGE_KEY", "STAGE_TYPE", "DIFFICULTY", "ACT",
                      "STAGE_NO", "WAVE_AMOUNT", "WAVE_MOB_AMOUNT"],
    "ItemInfoData": ["ITEM_KEY", "ITEM_TYPE", "GRADE", "PARTS", "LEVEL"],
    "CommonSaveData": ["PLAYTIME", "CURRENT_STAGE_KEY", "CURRENT_STAGE_WAVE"],
}


class TestConsumedFieldsAreNameGuarded:
    """O tripwire só pega 'CAMPO ERRADO' nos campos que ele NAME-CHECA. Se uma leitura de save nova
    cair num campo cujo nome no dump não dá p/ verificar (nem fuzzy nem override), ela é silenciosa —
    a classe de bug do 1.00.12. Este teste prova que TODO campo plaintext consumido é name-guardado
    contra o dump real; adicionar um read sem guard FALHA aqui (a rede de segurança do plano)."""

    def test_every_consumed_plaintext_field_is_name_verifiable(self):
        dclasses, _denums, _dtdi, dbases = D.parse_dump(_DUMP)
        dclass_ci = {k.lower(): k for k in dclasses}

        # mesma descida de subclasse que o main() faz (um campo da base pode estar numa subclasse).
        children = {}
        for c, b in dbases.items():
            children.setdefault(b, []).append(c)

        def descend(dname):
            seen, stack, merged = set(), [dname], {}
            while stack:
                c = stack.pop()
                if c in seen:
                    continue
                seen.add(c)
                for o, f in (dclasses.get(c) or {}).items():
                    merged.setdefault(o, f)
                stack.extend(children.get(c, []))
            return merged

        unguarded = []
        for cls, attrs in _CONSUMED_PLAINTEXT.items():
            dname = (cls if cls in dclasses
                     else D.CLASS_ALIAS.get(cls) if D.CLASS_ALIAS.get(cls) in dclasses
                     else dclass_ci.get(cls.lower()))
            if dname is None:
                unguarded.append(f"{cls}: classe não achada por nome no dump")
                continue
            own = dclasses[dname]
            merged = descend(dname)
            for attr in attrs:
                off = getattr(getattr(O, cls), attr)
                df = own.get(off)
                if df is None:
                    df = merged.get(off)
                if df is None:
                    unguarded.append(f"{cls}.{attr}@0x{off:X}: sem campo no offset (dump mudou?)")
                    continue
                got = df[0] if isinstance(df, tuple) else df
                exp = D._expected_field_name(cls, attr, got)
                if exp is None:
                    unguarded.append(f"{cls}.{attr}@0x{off:X}: nome `{got}` é UNVERIFIABLE (sem guard)")

        assert not unguarded, (
            "campos plaintext consumidos pelo reader SEM guard de nome no tripwire — "
            "uma leitura nova precisa de fuzzy-match ou _NAME_OVERRIDE em diff_offsets_vs_dump.py:\n  "
            + "\n  ".join(unguarded))

    def test_consumed_classes_exist_in_offsets(self):
        """Sanidade barata (roda mesmo sem o dump no path de import): os símbolos do _CONSUMED_PLAINTEXT
        existem em config.offsets — pega um rename de classe/ATTR que tornaria o mapa acima mentira."""
        for cls, attrs in _CONSUMED_PLAINTEXT.items():
            obj = getattr(O, cls, None)
            assert obj is not None, f"config.offsets sem a classe {cls}"
            for attr in attrs:
                assert isinstance(getattr(obj, attr, None), int), f"{cls}.{attr} não é um offset int"
