"""Testes do orquestrador (funções puras). O grosso do meter_windows é I/O de memória
(coberto pelos probes ao vivo); aqui ficam só os helpers testáveis isoladamente."""

import json

from config.offsets import Array, Class, EStageType, List, StageInfoData
from meter_windows import (BOX_KEY_BY_TIER, CACHE_FMT, PENDING_CLOSE_GRACE,
                           _absorb_drop, _drop_counts, _flush_pending_rec,
                           _new_pending, _pick_list_singleton, _read_calib,
                           _read_catalogs, _seed_path, _stage_info_ok,
                           _suffix_int, _valid_list_size)
from tests.conftest import MockReader

LIST_OFF = 0x20   # ex.: LogManager.LOG_LIST / MonsterSpawnManager.MONSTER_LIST


def _write_valid_list(mem, inst, ll, items, size, *, name="StageClearLog", maxlen=None):
    """Escreve em `mem` um List<T> estruturalmente VÁLIDO em inst+LIST_OFF: items legível,
    capacidade>=size, e `size` entries que são objetos (classe com nome legível)."""
    maxlen = size + 4 if maxlen is None else maxlen
    k = items + 0x900000          # endereço da classe (qualquer, >0x10000)
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
        mem[e] = k                # rptr(e) = K (classe do objeto)
    return mem


class TestPickListSingleton:
    """O scan de ponteiros devolve dezenas de falsos-positivos p/ um singleton (LogManager teve
    36 num probe ao vivo, 35 lixo). O pick tem que escolher o List ESTRUTURALMENTE válido, não o
    1o-na-faixa — senão um slot de lixo com size=0 (memória zerada) num endereço menor vence o
    singleton real, a lista nunca cresce e NENHUMA run fecha (o bug deste PR)."""

    def test_picks_real_over_first_garbage(self):
        garbage, real = 0x10000000, 0x10500000
        mem = {}
        mem[garbage + LIST_OFF] = 0x10001000          # ll válido...
        mem[0x10001000 + List.SIZE] = 0               # size=0 na faixa (passava no pick antigo)...
        mem[0x10001000 + List.ITEMS] = 0              # ...mas não é List de verdade (sem items)
        _write_valid_list(mem, real, 0x10501000, 0x10502000, 3)
        r = MockReader(mem=mem)
        # garbage vem PRIMEIRO (endereço menor = scan-order); ainda assim escolhe o real
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
        # entre vários estruturalmente válidos, fica com o de MAIS entries (o log/lista vivo).
        mem = {}
        small, big = 0x10000000, 0x10500000
        _write_valid_list(mem, small, 0x10001000, 0x10002000, 2)
        _write_valid_list(mem, big, 0x10501000, 0x10502000, 40)
        r = MockReader(mem=mem)
        assert _pick_list_singleton(r, [small, big], LIST_OFF, 100000) == big

    def test_fallback_to_loose_pick_never_regresses_to_none(self):
        # nenhum candidato estruturalmente válido -> cai no pick frouxo (size na faixa),
        # pra um resolve que ANTES funcionava nunca virar None.
        mem = {}
        loose = 0x10000000
        mem[loose + LIST_OFF] = 0x10001000
        mem[0x10001000 + List.SIZE] = 7
        mem[0x10001000 + List.ITEMS] = 0
        r = MockReader(mem=mem)
        assert _pick_list_singleton(r, [loose], LIST_OFF, 100000) == loose


class TestSuffixInt:
    """Parse das name-keys dos logs de morte/revive ('HeroName_601' -> 601). Formato cravado
    ao vivo: 'HeroName_<heroKey>' / 'MonsterName_<monsterKey>'."""

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
        # 'HeroName_' -> tail vazio -> None (não estoura)
        assert _suffix_int("HeroName_") is None

    def test_multiple_underscores_takes_last_segment(self):
        # rsplit no último '_': pega o segmento final
        assert _suffix_int("Some_Prefix_42") == 42

    def test_plain_number(self):
        assert _suffix_int("777") == 777



def _write_stage_row(mem, a, *, sk=None, st=None, wa=None, wm=None, act=None, sno=None, diff=None):
    """Escreve uma instância StageInfoData fake em `a` (campos None = leitura falha)."""
    for off, v in ((StageInfoData.STAGE_KEY, sk), (StageInfoData.STAGE_TYPE, st),
                   (StageInfoData.WAVE_AMOUNT, wa), (StageInfoData.WAVE_MOB_AMOUNT, wm),
                   (StageInfoData.ACT, act), (StageInfoData.STAGE_NO, sno),
                   (StageInfoData.DIFFICULTY, diff)):
        if v is not None:
            mem[a + off] = v
    return mem


class TestReadCatalogs:
    """stage_info do _read_catalogs. O filtro de waves (1<=wa/wm<=200) derrubava os stages
    ACTBOSS (x-10, luta só de boss, sem waves de horda) -> a key ficava fora do catálogo e
    TUDO que depende de stage_info degradava no x-10: modo "?" no run record/overlay,
    adoção de stage e detecção de troca cegas no loop."""

    def _catalogs(self, mem, addrs):
        r = MockReader(mem=mem)
        si, _, _ = _read_catalogs(r, {"StageInfoData": addrs})
        return si

    def test_normal_stage_total_is_waves_times_mobs(self):
        mem = _write_stage_row({}, 0x1000, sk=1001, st=EStageType.NORMAL,
                               wa=10, wm=5, act=3, sno=4, diff=2)
        assert self._catalogs(mem, [0x1000]) == {1001: (3, 4, 50, 2)}

    def test_actboss_without_waves_is_kept_with_zero_horde(self):
        # o bug: x-10 tem wa/wm fora da faixa -> caía no filtro e o modo virava "?"
        mem = _write_stage_row({}, 0x1000, sk=4310, st=EStageType.ACTBOSS,
                               wa=0, wm=0, act=3, sno=10, diff=3)
        assert self._catalogs(mem, [0x1000]) == {4310: (3, 10, 0, 3)}

    def test_actboss_with_valid_waves_keeps_wave_total(self):
        # se um build der waves válidas pro boss-stage, o total real vence o 0
        mem = _write_stage_row({}, 0x1000, sk=4310, st=EStageType.ACTBOSS,
                               wa=2, wm=3, act=3, sno=10, diff=1)
        assert self._catalogs(mem, [0x1000]) == {4310: (3, 10, 6, 1)}

    def test_garbage_row_rejected(self):
        # instância lixo: tipo fora do enum e sem waves -> não entra
        mem = _write_stage_row({}, 0x1000, sk=999, st=7, wa=0, wm=0, act=3, sno=10, diff=2)
        assert self._catalogs(mem, [0x1000]) == {}

    def test_actboss_with_implausible_fields_rejected(self):
        # ACTBOSS só entra com act/sno/diff plausíveis (guarda contra misread)
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
        # o bug do modo "?" persistente: linha de horda com DIFFICULTY ilegível (None) ou
        # fora do EStageDifficulty era catalogada com diff -1 → DIFF_NAMES.get(-1) = "?" em
        # TODA run desse stage, e a calib persistia o catálogo envenenado. Linha suspeita
        # NÃO entra (degrada: o stage fica FORA do catálogo — modo "?" no fechamento/overlay
        # e adoção/troca de stage cegas no loop; o gate de completude-vs-seed impede o
        # buraco de persistir/sombrear o seed quando o seed cobre o fp).
        for diff in (None, -1, 4, 99):
            mem = _write_stage_row({}, 0x1000, sk=1001, st=EStageType.NORMAL,
                                   wa=10, wm=5, act=3, sno=4, diff=diff)
            assert self._catalogs(mem, [0x1000]) == {}, f"diff={diff} deveria ser rejeitado"

    def test_horde_row_with_each_valid_diff_kept(self):
        # simetria com boss_ok: todo EStageDifficulty real (0..3) continua entrando
        for diff in (0, 1, 2, 3):
            mem = _write_stage_row({}, 0x1000, sk=2001, st=EStageType.NORMAL,
                                   wa=2, wm=3, act=1, sno=1, diff=diff)
            assert self._catalogs(mem, [0x1000]) == {2001: (1, 1, 6, diff)}

    def test_actboss_with_invalid_diff_still_rejected(self):
        # boss_ok já validava diff (fix do x-10); a simetria não pode tê-lo afrouxado
        for diff in (None, -1, 4):
            mem = _write_stage_row({}, 0x1000, sk=4310, st=EStageType.ACTBOSS,
                                   wa=0, wm=0, act=3, sno=10, diff=diff)
            assert self._catalogs(mem, [0x1000]) == {}, f"diff={diff} deveria ser rejeitado"

    def test_horde_row_with_invalid_act_or_sno_rejected(self):
        # simetria completa com boss_ok: ACT/STAGE_NO ilegível (None) ou fora de 1..200
        # derruba a linha de HORDA também — antes entrava como `act or 0`/`sno or 0`,
        # gravando (0, 0, ...) misread no catálogo persistido
        for field in ("act", "sno"):
            for bad in (None, 0, 201):
                kw = dict(sk=1001, st=EStageType.NORMAL, wa=10, wm=5, act=3, sno=4, diff=2)
                kw[field] = bad
                mem = _write_stage_row({}, 0x1000, **kw)
                assert self._catalogs(mem, [0x1000]) == {}, \
                    f"{field}={bad} deveria ser rejeitado"

    def test_actboss_with_invalid_act_or_sno_still_rejected(self):
        # boss_ok já validava act/sno; a fatoração (actsno_ok) não pode tê-lo afrouxado
        for field, bad in (("act", 0), ("act", 201), ("sno", 0), ("sno", 201)):
            kw = dict(sk=4310, st=EStageType.ACTBOSS, wa=0, wm=0, act=3, sno=10, diff=2)
            kw[field] = bad
            mem = _write_stage_row({}, 0x1000, **kw)
            assert self._catalogs(mem, [0x1000]) == {}, f"{field}={bad} deveria ser rejeitado"

    def test_horde_row_with_act_sno_at_bounds_kept(self):
        # bordas válidas (1 e 200) continuam entrando — o gate é 1 <= x <= 200, inclusivo
        mem = _write_stage_row({}, 0x1000, sk=1001, st=EStageType.NORMAL,
                               wa=10, wm=5, act=1, sno=200, diff=2)
        assert self._catalogs(mem, [0x1000]) == {1001: (1, 200, 50, 2)}
        mem = _write_stage_row({}, 0x2000, sk=2001, st=EStageType.NORMAL,
                               wa=10, wm=5, act=200, sno=1, diff=2)
        assert self._catalogs(mem, [0x2000]) == {2001: (200, 1, 50, 2)}


class TestStageInfoOk:
    """_stage_info_ok = gate de sanidade do catálogo stage_info, usado no LOAD (_read_calib
    rejeita calib envenenado → cai pro seed/scan, auto-cura) e no PERSIST (save_calib não
    grava catálogo ruim). Rows = (act, stage_no, horda, diff) com diff ∈ EStageDifficulty
    e act/stage_no em 1..200 (espelha o gate de linha do _read_catalogs); horda SEM
    range-check (boss x-10 legitimamente tem horda=0)."""

    def test_valid_catalog_ok(self):
        assert _stage_info_ok({1001: (1, 1, 50, 0), 4310: (4, 10, 0, 3)})

    def test_empty_rejected(self):
        assert not _stage_info_ok({})

    def test_invalid_diff_rejected(self):
        # diff -1 é exatamente a shape do cache envenenado pré-fix
        assert not _stage_info_ok({1001: (1, 1, 50, 0), 1002: (1, 2, 60, -1)})
        assert not _stage_info_ok({1001: (1, 1, 50, 4)})

    def test_act_or_stage_no_out_of_range_rejected(self):
        # (0, 0, ...) é exatamente a shape do fallback `act or 0`/`sno or 0` pré-fix
        # (misread de horda entrava zerado); fora de 1..200 = misread também
        assert not _stage_info_ok({1001: (0, 1, 50, 0)})
        assert not _stage_info_ok({1001: (1, 0, 50, 0)})
        assert not _stage_info_ok({1001: (0, 0, 50, 0)})
        assert not _stage_info_ok({1001: (201, 1, 50, 0)})
        assert not _stage_info_ok({1001: (1, 201, 50, 0)})

    def test_zero_horde_not_range_checked(self):
        # horda=0 é LEGÍTIMO (boss x-10, sem waves de horda) — row[2] não tem range-check
        assert _stage_info_ok({4310: (4, 10, 0, 3)})

    def test_wrong_shape_rejected(self):
        assert not _stage_info_ok({1001: (1, 1, 50)})            # 3-tupla
        assert not _stage_info_ok({1001: (1, 1, 50, "0")})       # diff não-int
        assert not _stage_info_ok({1001: [1, 1, 50, 0]})         # lista (não reconstruída)

    def test_bool_rejected(self):
        # bool é subclasse de int: um `true` num cache editado à mão passaria como diff=1
        assert not _stage_info_ok({1001: (1, 1, 50, True)})      # diff bool
        assert not _stage_info_ok({1001: (1, True, 50, 0)})      # qualquer campo bool


def test_bundled_seed_passes_load_validation():
    """O seed embarcado (config/calib_seed.json) tem que passar o gate de load do runtime —
    senão todo PRIMEIRO launch do build shipado degradaria pro cold scan (a classe de bug
    'scan toda vez'). Mesmo check que o --selftest roda no CI."""
    doc = json.load(open(_seed_path(), encoding="utf-8"))
    assert doc["fmt"] == CACHE_FMT
    assert doc["calib"], "seed sem nenhum fp"
    for fp in doc["calib"]:
        entry = _read_calib(_seed_path(), fp)
        assert entry is not None, f"seed fp {fp} rejeitado pelo load-gate"
        assert _stage_info_ok(entry["stage_info"])


class TestBoxKeyByTier:
    """GetBoxLog @0x40 é o TIPO ("TreasureChest_<Type>"), NÃO item key (cravado ao vivo).
    O tier (monster_type 0/1/2) mapeia pra box item key canônica daquele tier."""

    def test_three_tiers_map_to_canonical_box_keys(self):
        assert BOX_KEY_BY_TIER == {0: 910011, 1: 920001, 2: 930101}

    def test_unknown_tier_returns_none(self):
        assert BOX_KEY_BY_TIER.get(3) is None
        assert BOX_KEY_BY_TIER.get(None) is None


class TestNewPending:
    """Construtor COMPARTILHADO do estado de pending-close (_new_pending): close_run e estes
    testes usam o mesmo — um espelho de mão aqui deixaria a forma driftar em silêncio."""

    def test_deadline_is_now_plus_grace(self):
        p = _new_pending({"id": "1"}, "x.json", 100.0)
        assert p["deadline"] == 100.0 + PENDING_CLOSE_GRACE
        assert p["rec"] == {"id": "1"}
        assert p["path"] == "x.json"

    def test_absorbed_starts_fresh_per_instance(self):
        # lista NOVA por close: herdar absorvidos de um pendente anterior re-atribuiria baú
        # (o próprio bug) e inflaria a contagem do live da janela seguinte.
        a = _new_pending({}, "a.json", 0.0)
        a["absorbed"].append({"box_key": 920001, "monster_type": 1})
        b = _new_pending({}, "b.json", 0.0)
        assert b["absorbed"] == []


class TestAbsorbDrop:
    """Absorção do boss box atrasado no record PENDENTE: muta o value DENTRO do envelope ok
    de drops (build_raw_record não copia a lista — ok() referencia — então é isso que sai no
    JSON do flush). Record fora da forma → False e o caller mantém o baú na run atual."""

    def test_absorbs_into_drops_ok_envelope(self):
        rec = {"drops": {"ok": True, "value": [{"box_key": 910011, "monster_type": 0}]}}
        d = {"box_key": 920001, "monster_type": 1}
        assert _absorb_drop(rec, d) is True
        assert rec["drops"]["value"] == [{"box_key": 910011, "monster_type": 0}, d]

    def test_multiple_trailing_boxes_all_absorbed(self):
        # clear de x-10 pode soltar StageBoss E ActBoss em sequência: todos entram, em ordem.
        rec = {"drops": {"ok": True, "value": []}}
        assert _absorb_drop(rec, {"box_key": 920001, "monster_type": 1})
        assert _absorb_drop(rec, {"box_key": 930101, "monster_type": 2})
        assert [d["monster_type"] for d in rec["drops"]["value"]] == [1, 2]

    def test_malformed_record_refuses_without_raising(self):
        # nunca acontece (drops é sempre ok(list) no build_raw_record), mas a recusa limpa é o
        # que garante o fallback "fica na run atual" em vez de perder o baú ou estourar o tick.
        d = {"box_key": 920001, "monster_type": 1}
        assert _absorb_drop({}, d) is False                                  # sem drops
        assert _absorb_drop({"drops": {"ok": False, "error": "x"}}, d) is False   # envelope err
        assert _absorb_drop({"drops": {"ok": True, "value": None}}, d) is False   # value não-lista
        assert _absorb_drop(None, d) is False                                # rec não-dict


class TestDropCounts:
    """Contagem [Monster, Boss, ActBoss] do live.json: run ATUAL + absorvidos do pendente.
    O boss box atrasado SOBE a contagem viva (rising-edge que o cooldown-tracker/drop-notifier
    do app detectam); pós-flush ela cai (baseline no app, sem evento)."""

    def test_counts_current_run_by_tier(self):
        # paridade com o loop inline que isto substituiu (sem pendente = comportamento antigo).
        drops = [{"monster_type": 0}, {"monster_type": 0}, {"monster_type": 1}]
        assert _drop_counts(drops) == [2, 1, 0]

    def test_includes_pending_absorbed_boxes(self):
        # o gray é da run NOVA; o boss box absorvido (da run fechada) ainda conta no live.
        assert _drop_counts([{"monster_type": 0}],
                            [{"monster_type": 1}, {"monster_type": 2}]) == [1, 1, 1]

    def test_after_flush_count_falls_back_to_current_run(self):
        # flush limpa o pendente → a contagem volta à run atual (queda = baseline, sem evento).
        assert _drop_counts([{"monster_type": 0}], None) == [1, 0, 0]
        assert _drop_counts([], None) == [0, 0, 0]

    def test_unknown_or_unread_tier_ignored(self):
        assert _drop_counts([{"monster_type": 7}, {"monster_type": None}, {}]) == [0, 0, 0]


class TestFlushPendingRec:
    """O flush escreve o record pendente em disco (mesma escrita atômica do close imediato) —
    o JSON FLUSHADO é o contrato: os boxes absorvidos têm que estar lá dentro do envelope ok."""

    def test_flushed_json_contains_absorbed_boxes(self, tmp_path):
        path = str(tmp_path / "raw" / "1717800000123.json")
        (tmp_path / "raw").mkdir()
        rec = {"id": "1717800000123",
               "drops": {"ok": True, "value": [{"box_key": 910011, "monster_type": 0}]}}
        d = {"box_key": 920001, "monster_type": 1}
        assert _absorb_drop(rec, d)
        p = _new_pending(rec, path, now=0.0)   # o MESMO construtor do close_run (forma única)
        p["absorbed"].append(d)                # espelha o tracking do loop pós-absorção
        _flush_pending_rec(p)
        flushed = json.loads(open(path, encoding="utf-8").read())
        # mesmo wire shape de sempre ({"box_key", "monster_type"}), absorvido incluso, em ordem.
        assert flushed["drops"] == {"ok": True, "value": [
            {"box_key": 910011, "monster_type": 0}, {"box_key": 920001, "monster_type": 1}]}

    def test_none_pending_is_noop(self, tmp_path):
        _flush_pending_rec(None)   # sem pendente: nada a escrever, nada levanta

    def test_never_raises_on_unserializable_record(self, tmp_path, capsys):
        # never-raise no tick loop: um rec não-serializável (impossível na prática — o record é
        # todo primitivo) vira uma linha de WARN no meter.log, nunca um crash de sessão.
        path = str(tmp_path / "x.json")
        _flush_pending_rec(_new_pending({"id": "9", "bad": {1, 2}}, path, 0.0))
        assert "WARN flush failed" in capsys.readouterr().out
        assert not (tmp_path / "x.json").exists()

    def test_grace_constant_is_three_seconds(self):
        # 5x o trail observado (~0.6s) e ≥2-3 snapshots do live.json. A nota run-lifecycle
        # ancora este valor por assert; mudar aqui exige re-pensar o rising-edge do app.
        assert PENDING_CLOSE_GRACE == 3.0
