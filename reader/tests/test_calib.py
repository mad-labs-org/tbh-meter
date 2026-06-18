"""Testes do cache de calibração build-estável (load_calib/save_calib).

Funções puras de I/O em arquivo (não tocam memória do jogo) → rodam no mac. Cobrem:
  - round-trip save→load (anchor_rva, indices, idx_ut, catálogos preservados c/ tipos certos);
  - persist-gate de completude (catálogo vazio → NÃO persiste);
  - escrita atômica (tmp+os.replace, sem .tmp residual; merge preserva outros fps);
  - tolerância a JSON antigo (fmt != CACHE_FMT → None → caller recalibra);
  - sanidade do stage_info nos dois gates (_stage_info_ok: save não persiste catálogo com
    diff inválido; load rejeita cache envenenado → auto-cura via seed/scan);
  - completude-vs-seed nos dois gates (amendment R3, _covers_seed_keys: catálogo com BURACO
    — key que o seed do mesmo fp tem e o candidato não — não persiste nem sombreia o seed;
    SÓ presença de key, valor local sempre vence quando presente).
"""

import json
import os

import pytest

import meter_windows
from meter_windows import CACHE_FMT, _read_calib, load_calib, save_calib

FP = "1.00.07-0x6a203f51-0x62ea000"
ANCHOR_RVA = 0x5B070E0
INDICES = {"StageManager": 2592, "LogManager": 2831, "MonsterSpawnManager": 2931}
IDX_UT = 2744
# rows = (act, stage_no, horda, diff); diff tem que ser EStageDifficulty real (0..3).
# POISONED = a shape do bug do modo "?" (diff -1 gravado quando a leitura falhava): tem que ser
# REJEITADA pelos dois gates (_stage_info_ok no save E no load).
STAGE_INFO = {1001: (1, 1, 50, 0), 1002: (1, 2, 60, 3)}
POISONED_STAGE_INFO = {1001: (1, 1, 50, 0), 1002: (1, 2, 60, -1)}
ITEM_CAT = {30001: (3, 2, 5), 30002: (1, 0, 0)}
HERO_CAT = {601: 1, 602: None}
# Catálogos com BURACO: subconjunto ESTRITO dos do seed — toda row é VÁLIDA (passam nos
# gates de VALOR, _stage_info_ok/len>0); só o gate de COMPLETUDE-vs-seed os pega.
HOLEY_STAGE_INFO = {1001: (1, 1, 50, 0)}                  # falta a 1002 que o seed tem
HOLEY_ITEM_CAT = {30001: (3, 2, 5)}                       # falta a 30002 que o seed tem
HOLEY_HERO_CAT = {601: 1}                                 # falta a 602 que o seed tem
SUPERSET_STAGE_INFO = {**STAGE_INFO, 1003: (1, 3, 70, 2)}  # key EXTRA além do seed
SEED_ANCHOR = 0x5EED   # anchor DISTINTO do do cache → os asserts provam a procedência


def _path(tmp_path):
    return os.path.join(str(tmp_path), "resolve_cache.json")


@pytest.fixture(autouse=True)
def _seed_isolated(tmp_path, monkeypatch):
    """Isola TODOS os testes do SEED embarcado (config/calib_seed.json): por padrão aponta
    _seed_path p/ um arquivo inexistente, então estes testes exercitam o cache PURO de forma
    DETERMINÍSTICA (sem depender de qual fp o seed commitado cobre). TestSeedFallback sobrescreve
    isto explicitamente p/ provar o fallback."""
    monkeypatch.setattr(meter_windows, "_seed_path",
                        lambda: os.path.join(str(tmp_path), "_absent_seed.json"))


class TestRoundTrip:
    def test_save_then_load_preserves_everything(self, tmp_path):
        path = _path(tmp_path)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        out = load_calib(path, FP)
        assert out is not None
        assert out["anchor_rva"] == ANCHOR_RVA
        assert out["idx_ut"] == IDX_UT
        assert out["indices"] == INDICES
        assert out["stage_info"] == STAGE_INFO
        assert out["item_cat"] == ITEM_CAT
        assert out["hero_cat"] == HERO_CAT

    def test_load_reconstructs_int_keys_and_tuple_values(self, tmp_path):
        path = _path(tmp_path)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        out = load_calib(path, FP)
        # catálogos: chaves int, valores tuple (não str/list) — pronto p/ consumo direto
        assert all(isinstance(k, int) for k in out["stage_info"])
        assert all(isinstance(v, tuple) for v in out["stage_info"].values())
        assert all(isinstance(k, int) for k in out["item_cat"])
        assert all(isinstance(v, tuple) for v in out["item_cat"].values())
        assert all(isinstance(k, int) for k in out["hero_cat"])
        # indices: valores int
        assert all(isinstance(v, int) for v in out["indices"].values())

    def test_hero_cat_none_value_survives(self, tmp_path):
        path = _path(tmp_path)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        out = load_calib(path, FP)
        assert out["hero_cat"][602] is None


class TestPersistGate:
    def test_empty_stage_info_not_persisted(self, tmp_path):
        path = _path(tmp_path)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, {}, ITEM_CAT, HERO_CAT)
        assert not os.path.exists(path)
        assert load_calib(path, FP) is None

    def test_empty_item_cat_not_persisted(self, tmp_path):
        path = _path(tmp_path)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, {}, HERO_CAT)
        assert load_calib(path, FP) is None

    def test_empty_hero_cat_not_persisted(self, tmp_path):
        path = _path(tmp_path)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, {})
        assert load_calib(path, FP) is None

    def test_incomplete_does_not_clobber_existing(self, tmp_path):
        path = _path(tmp_path)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        # uma calibração incompleta posterior NÃO pode apagar a boa
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, {}, {}, {})
        out = load_calib(path, FP)
        assert out is not None
        assert out["anchor_rva"] == ANCHOR_RVA

    def test_invalid_diff_stage_info_not_persisted(self, tmp_path):
        # amendment R2: stage_info com row de diff inválido (-1) NÃO persiste — um misread
        # do scan nunca vira calibração servida pra sempre (modo "?" permanente)
        path = _path(tmp_path)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT,
                   POISONED_STAGE_INFO, ITEM_CAT, HERO_CAT)
        assert not os.path.exists(path)
        assert load_calib(path, FP) is None


class TestAtomicityAndMerge:
    def test_no_tmp_left_behind(self, tmp_path):
        path = _path(tmp_path)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        assert not os.path.exists(path + ".tmp")

    def test_merge_preserves_other_fingerprints(self, tmp_path):
        path = _path(tmp_path)
        fp2 = "1.00.08-0xdeadbeef-0x63ea000"
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        save_calib(path, fp2, 0x999, {"StageManager": 100}, 200, STAGE_INFO, ITEM_CAT, HERO_CAT)
        a = load_calib(path, FP)
        b = load_calib(path, fp2)
        assert a["anchor_rva"] == ANCHOR_RVA
        assert b["anchor_rva"] == 0x999
        assert b["indices"]["StageManager"] == 100

    def test_resave_same_fp_overwrites(self, tmp_path):
        path = _path(tmp_path)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        save_calib(path, FP, 0x111, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        out = load_calib(path, FP)
        assert out["anchor_rva"] == 0x111

    def test_written_file_has_current_fmt(self, tmp_path):
        path = _path(tmp_path)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        doc = json.load(open(path, encoding="utf-8"))
        assert doc["fmt"] == CACHE_FMT
        assert FP in doc["calib"]


class TestTolerateOldJson:
    def test_old_fmt_returns_none(self, tmp_path):
        path = _path(tmp_path)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"fmt": 7, "sc_class": 123}, f)
        assert load_calib(path, FP) is None

    def test_missing_fp_returns_none(self, tmp_path):
        path = _path(tmp_path)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        assert load_calib(path, "unknown-fp") is None

    def test_missing_file_returns_none(self, tmp_path):
        assert load_calib(_path(tmp_path), FP) is None

    def test_corrupt_json_returns_none(self, tmp_path):
        path = _path(tmp_path)
        with open(path, "w", encoding="utf-8") as f:
            f.write("{not valid json")
        assert load_calib(path, FP) is None

    def test_non_dict_json_returns_none(self, tmp_path):
        # JSON VÁLIDO mas de shape errado (top-level não-dict, ou calib não-dict): o
        # c.get/.get(fp) levantava AttributeError FORA do try. _read_calib tem que ser
        # TOTAL (nunca levantar) — o gate de completude-vs-seed do save_calib o chama
        # ANTES do try do save_calib, e _calibrate promete "NUNCA quebra o fluxo".
        path = _path(tmp_path)
        for doc in ([], {"fmt": CACHE_FMT, "calib": []}):
            with open(path, "w", encoding="utf-8") as f:
                json.dump(doc, f)
            assert _read_calib(path, FP) is None, f"doc={doc!r}"
            assert load_calib(path, FP) is None, f"doc={doc!r}"

    def test_save_over_old_fmt_resets_to_current(self, tmp_path):
        path = _path(tmp_path)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"fmt": 7, "sc_class": 123}, f)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        doc = json.load(open(path, encoding="utf-8"))
        assert doc["fmt"] == CACHE_FMT
        assert "sc_class" not in doc   # stale legado descartado ao trocar de fmt
        assert load_calib(path, FP) is not None


class TestSeedFallback:
    """SEED embarcado (seed-calib): load_calib cai no config/calib_seed.json quando o cache do
    usuário não cobre o fp. Invariantes: zero confiança nova (cache do usuário tem PRIORIDADE),
    fp-gated (seed de outro build = MISS → None → scan), ausente = None."""

    def test_seed_used_when_user_cache_misses(self, tmp_path, monkeypatch):
        # cache do usuário ausente; seed cobre o fp -> usa o seed (skip do scan no 1o launch)
        _write_seed(tmp_path, monkeypatch, FP)
        out = load_calib(_path(tmp_path), FP)
        assert out is not None
        assert out["anchor_rva"] == ANCHOR_RVA and out["idx_ut"] == IDX_UT
        assert out["stage_info"] == STAGE_INFO   # catálogos vêm do seed, tipos reconstruídos

    def test_user_cache_wins_over_seed(self, tmp_path, monkeypatch):
        # seed e cache cobrem o MESMO fp com anchors diferentes -> cache do usuário tem prioridade
        # (cache cobre toda key do seed → o gate de completude-vs-seed NÃO interfere)
        _write_seed(tmp_path, monkeypatch, FP, anchor_rva=0xBADBAD)
        save_calib(_path(tmp_path), FP, 0x111, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        out = load_calib(_path(tmp_path), FP)
        assert out["anchor_rva"] == 0x111   # do cache aprendido, NÃO do seed

    def test_seed_fp_miss_returns_none(self, tmp_path, monkeypatch):
        # seed só cobre OUTRO fp -> miss no fp pedido -> None (degrada pro scan, nunca envenena)
        _write_seed(tmp_path, monkeypatch, "1.00.99-0x0-0x0")
        assert load_calib(_path(tmp_path), FP) is None

    def test_missing_seed_file_returns_none(self, tmp_path, monkeypatch):
        monkeypatch.setattr(meter_windows, "_seed_path",
                            lambda: os.path.join(str(tmp_path), "nope.json"))
        assert load_calib(_path(tmp_path), FP) is None


def _write_calib_raw(path, fp, stage_info, anchor_rva=ANCHOR_RVA,
                     item_cat=None, hero_cat=None):
    """Grava um calib[fp] DIRETO no JSON (bypass do persist-gate do save_calib) — simula o
    cache que uma versão antiga do reader gravou (ex.: stage_info com diff -1, o bug do
    modo \"?\"; ou catálogo com BURACO, persistido antes do gate de completude-vs-seed)."""
    item_cat = ITEM_CAT if item_cat is None else item_cat
    hero_cat = HERO_CAT if hero_cat is None else hero_cat
    entry = {"anchor_rva": anchor_rva, "indices": INDICES, "idx_ut": IDX_UT,
             "stage_info": {str(k): list(v) for k, v in stage_info.items()},
             "item_cat": {str(k): list(v) for k, v in item_cat.items()},
             "hero_cat": {str(k): v for k, v in hero_cat.items()}}
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"fmt": CACHE_FMT, "calib": {fp: entry}}, f)


def _write_seed(tmp_path, monkeypatch, fp, **over):
    """Grava um calib_seed.json fake cobrindo `fp` e aponta _seed_path pra ele (sobrescreve
    o _seed_isolated). `over` sobrepõe keys do entry (ex.: anchor_rva=SEED_ANCHOR p/ provar
    procedência, stage_info/item_cat já serializados quando passados crus)."""
    seed = os.path.join(str(tmp_path), "calib_seed.json")
    entry = {"anchor_rva": ANCHOR_RVA, "indices": INDICES, "idx_ut": IDX_UT,
             "stage_info": {str(k): list(v) for k, v in STAGE_INFO.items()},
             "item_cat": {str(k): list(v) for k, v in ITEM_CAT.items()},
             "hero_cat": {str(k): v for k, v in HERO_CAT.items()}}
    entry.update(over)
    with open(seed, "w", encoding="utf-8") as f:
        json.dump({"fmt": CACHE_FMT, "calib": {fp: entry}}, f)
    monkeypatch.setattr(meter_windows, "_seed_path", lambda: seed)
    return seed


class TestPoisonedCatalogSelfHeal:
    """Auto-cura do cache envenenado (o bug real: reader antigo gravou stage_info com diff -1
    no resolve_cache.json → modo \"?\" em toda run, sobrevivendo a restarts). O load-gate
    (_stage_info_ok no _read_calib) REJEITA o bloco → load_calib cai pro seed embarcado; sem
    seed, None → scan, que re-calibra e SOBRESCREVE o calib[fp]. Sem deletar cache na mão e
    sem bump de CACHE_FMT (o shape não mudou; é validação de VALOR). A variante BURACO
    (catálogo válido mas incompleto vs o seed) cura pelo gate de completude-vs-seed."""

    def test_poisoned_user_cache_rejected(self, tmp_path):
        path = _path(tmp_path)
        _write_calib_raw(path, FP, POISONED_STAGE_INFO)
        # sem seed (fixture _seed_isolated): rejeita → None → caller degrada pro scan
        assert load_calib(path, FP) is None

    def test_poisoned_user_cache_falls_through_to_seed(self, tmp_path, monkeypatch):
        # o caso do player do report: cache envenenado + seed BOM do mesmo build →
        # o seed serve o catálogo são no MESMO launch (modo volta sem cold scan)
        path = _path(tmp_path)
        _write_calib_raw(path, FP, POISONED_STAGE_INFO, anchor_rva=0xBADBAD)
        _write_seed(tmp_path, monkeypatch, FP)
        out = load_calib(path, FP)
        assert out is not None
        assert out["anchor_rva"] == ANCHOR_RVA          # veio do SEED, não do cache podre
        assert out["stage_info"] == STAGE_INFO

    def test_holey_user_cache_healed_by_seed_same_load(self, tmp_path, monkeypatch):
        # a RECORRÊNCIA na máquina do usuário: um misread futuro no scan agora DROPA a
        # linha (gate de linha do _read_catalogs) → catálogo com BURACO que passa em TODOS
        # os gates de valor; servido, sombrearia o seed bom pra sempre (nada re-dispara
        # scan → modo "?" naquele stage até deletar cache na mão). O gate de
        # completude-vs-seed (amendment R3) cura NO MESMO load: serve o seed são.
        path = _path(tmp_path)
        _write_calib_raw(path, FP, HOLEY_STAGE_INFO, anchor_rva=0xBADBAD)
        _write_seed(tmp_path, monkeypatch, FP, anchor_rva=SEED_ANCHOR)
        out = load_calib(path, FP)
        assert out is not None
        assert out["anchor_rva"] == SEED_ANCHOR         # veio do SEED, não do cache com buraco
        assert out["stage_info"] == STAGE_INFO          # catálogo completo, sem buraco

    def test_rescan_overwrites_poisoned_entry(self, tmp_path):
        # o scan re-calibra (save_calib) por cima do fp envenenado → próximo launch volta
        # ao fast path com catálogo são
        path = _path(tmp_path)
        _write_calib_raw(path, FP, POISONED_STAGE_INFO)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        out = load_calib(path, FP)
        assert out is not None
        assert out["stage_info"] == STAGE_INFO

    def test_empty_stage_info_in_cache_rejected(self, tmp_path):
        # catálogo vazio vindo de arquivo (gravado fora do persist-gate) também não é servido
        path = _path(tmp_path)
        _write_calib_raw(path, FP, {})
        assert load_calib(path, FP) is None


class TestSeedCoverageGateLoad:
    """Gate de COMPLETUDE-vs-seed no LOAD (amendment R3): pro MESMO fp, o seed shipado é
    ground truth de QUAIS keys existem (catálogos são constantes do build). Cache cujos
    catálogos perderam key que o seed tem = BURACO → load_calib serve o SEED (com log).
    SÓ presença de key: key extra local passa; valor local nunca é comparado (cache bom
    com valores diferentes vence — protege contra seed hipoteticamente stale)."""

    def test_cache_missing_seed_stage_key_serves_seed(self, tmp_path, monkeypatch, capsys):
        _write_seed(tmp_path, monkeypatch, FP, anchor_rva=SEED_ANCHOR)
        _write_calib_raw(_path(tmp_path), FP, HOLEY_STAGE_INFO)
        out = load_calib(_path(tmp_path), FP)
        assert out is not None
        assert out["anchor_rva"] == SEED_ANCHOR     # serviu o SEED, não o cache com buraco
        assert out["stage_info"] == STAGE_INFO
        # o log nomeia O catálogo com buraco (triagem remota via meter.log)
        assert "missing seed keys: stage_info=1" in capsys.readouterr().out

    def test_cache_missing_seed_item_key_serves_seed(self, tmp_path, monkeypatch):
        # o gate cobre os TRÊS catálogos — buraco no item_cat também rejeita
        _write_seed(tmp_path, monkeypatch, FP, anchor_rva=SEED_ANCHOR)
        _write_calib_raw(_path(tmp_path), FP, STAGE_INFO, item_cat=HOLEY_ITEM_CAT)
        out = load_calib(_path(tmp_path), FP)
        assert out["anchor_rva"] == SEED_ANCHOR
        assert out["item_cat"] == ITEM_CAT

    def test_cache_missing_seed_hero_key_serves_seed(self, tmp_path, monkeypatch):
        # ...e buraco no hero_cat também (fecha o trio)
        _write_seed(tmp_path, monkeypatch, FP, anchor_rva=SEED_ANCHOR)
        _write_calib_raw(_path(tmp_path), FP, STAGE_INFO, hero_cat=HOLEY_HERO_CAT)
        out = load_calib(_path(tmp_path), FP)
        assert out["anchor_rva"] == SEED_ANCHOR
        assert out["hero_cat"] == HERO_CAT

    def test_cache_with_extra_keys_beyond_seed_served(self, tmp_path, monkeypatch):
        # key EXTRA local sempre passa (presença-apenas): cobre o seed e tem mais → cache vence
        _write_seed(tmp_path, monkeypatch, FP, anchor_rva=SEED_ANCHOR)
        _write_calib_raw(_path(tmp_path), FP, SUPERSET_STAGE_INFO)
        out = load_calib(_path(tmp_path), FP)
        assert out["anchor_rva"] == ANCHOR_RVA      # cache do usuário, NÃO o seed
        assert out["stage_info"] == SUPERSET_STAGE_INFO

    def test_no_seed_serves_cache_as_is(self, tmp_path):
        # sem seed (fixture _seed_isolated) não há referência → sem restrição: cache com
        # buraco é servido como hoje (não dá pra provar que é pior sem ground truth)
        _write_calib_raw(_path(tmp_path), FP, HOLEY_STAGE_INFO)
        out = load_calib(_path(tmp_path), FP)
        assert out is not None
        assert out["anchor_rva"] == ANCHOR_RVA

    def test_seed_not_covering_fp_serves_cache_as_is(self, tmp_path, monkeypatch):
        # seed cobre OUTRO fp → miss de referência pro fp pedido → cache servido como está
        _write_seed(tmp_path, monkeypatch, "1.00.99-0x0-0x0")
        out_missing = load_calib(_path(tmp_path), FP)
        assert out_missing is None                  # sem cache também: ambos None → None
        _write_calib_raw(_path(tmp_path), FP, HOLEY_STAGE_INFO)
        out = load_calib(_path(tmp_path), FP)
        assert out is not None
        assert out["anchor_rva"] == ANCHOR_RVA


class TestSeedCoverageGatePersist:
    """Gate de COMPLETUDE-vs-seed no PERSIST (amendment R3): com seed cobrindo o fp, um scan
    cujos catálogos não têm toda key do seed NÃO persiste (um misread com linha dropada nunca
    vira calibração; o seed segue servindo nos próximos launches). Sem seed pro fp, persiste
    exatamente como antes."""

    def test_holey_stage_info_not_persisted_when_seed_covers_fp(self, tmp_path, monkeypatch):
        _write_seed(tmp_path, monkeypatch, FP)
        save_calib(_path(tmp_path), FP, ANCHOR_RVA, INDICES, IDX_UT,
                   HOLEY_STAGE_INFO, ITEM_CAT, HERO_CAT)
        assert not os.path.exists(_path(tmp_path))

    def test_holey_item_cat_not_persisted_when_seed_covers_fp(self, tmp_path, monkeypatch):
        _write_seed(tmp_path, monkeypatch, FP)
        save_calib(_path(tmp_path), FP, ANCHOR_RVA, INDICES, IDX_UT,
                   STAGE_INFO, HOLEY_ITEM_CAT, HERO_CAT)
        assert not os.path.exists(_path(tmp_path))

    def test_holey_hero_cat_not_persisted_when_seed_covers_fp(self, tmp_path, monkeypatch):
        # o gate cobre os TRÊS catálogos no persist também (fecha o trio)
        _write_seed(tmp_path, monkeypatch, FP)
        save_calib(_path(tmp_path), FP, ANCHOR_RVA, INDICES, IDX_UT,
                   STAGE_INFO, ITEM_CAT, HOLEY_HERO_CAT)
        assert not os.path.exists(_path(tmp_path))

    def test_save_calib_with_malformed_seed_never_raises(self, tmp_path, monkeypatch):
        # a reachability nova do _read_calib: o gate de completude o chama FORA do try do
        # save_calib — um seed malformado (top-level não-dict) não pode quebrar o
        # _calibrate ("NUNCA quebra o fluxo"); vira None → sem referência → persiste
        seed = os.path.join(str(tmp_path), "calib_seed.json")
        with open(seed, "w", encoding="utf-8") as f:
            json.dump([], f)
        monkeypatch.setattr(meter_windows, "_seed_path", lambda: seed)
        save_calib(_path(tmp_path), FP, ANCHOR_RVA, INDICES, IDX_UT,
                   STAGE_INFO, ITEM_CAT, HERO_CAT)
        out = load_calib(_path(tmp_path), FP)
        assert out is not None
        assert out["anchor_rva"] == ANCHOR_RVA

    def test_holey_persist_does_not_clobber_good_seed_serving(self, tmp_path, monkeypatch):
        # o ciclo completo da recusa: persist recusado → load serve o seed são
        _write_seed(tmp_path, monkeypatch, FP, anchor_rva=SEED_ANCHOR)
        save_calib(_path(tmp_path), FP, ANCHOR_RVA, INDICES, IDX_UT,
                   HOLEY_STAGE_INFO, ITEM_CAT, HERO_CAT)
        out = load_calib(_path(tmp_path), FP)
        assert out["anchor_rva"] == SEED_ANCHOR
        assert out["stage_info"] == STAGE_INFO

    def test_no_seed_for_fp_persists_as_today(self, tmp_path, monkeypatch):
        # seed cobre OUTRO fp → sem referência → persiste como sempre (build novo pré-seed)
        _write_seed(tmp_path, monkeypatch, "1.00.99-0x0-0x0")
        save_calib(_path(tmp_path), FP, ANCHOR_RVA, INDICES, IDX_UT,
                   HOLEY_STAGE_INFO, ITEM_CAT, HERO_CAT)
        out = load_calib(_path(tmp_path), FP)
        assert out is not None
        assert out["stage_info"] == HOLEY_STAGE_INFO

    def test_superset_of_seed_persists(self, tmp_path, monkeypatch):
        # key extra além do seed passa (presença-apenas) → calibração local persiste e vence
        _write_seed(tmp_path, monkeypatch, FP, anchor_rva=SEED_ANCHOR)
        save_calib(_path(tmp_path), FP, 0x111, INDICES, IDX_UT,
                   SUPERSET_STAGE_INFO, ITEM_CAT, HERO_CAT)
        out = load_calib(_path(tmp_path), FP)
        assert out["anchor_rva"] == 0x111
        assert out["stage_info"] == SUPERSET_STAGE_INFO
