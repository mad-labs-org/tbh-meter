"""Testes do build_raw_record — o record RAW v2 que o reader emite (raw/<id>.json).

Garante o contrato que o conversor (app) parseia: envelope ok/err por campo de dado, meta crua,
ZERO campos derivados, e — o ponto do redesign — "não-li" (err) nunca vira "li zero". Espelha
app/src/shared/raw-types.ts::RawRunV2 (mesma forma nos dois lados).

v2 (Redesign 2): a identidade da run é o HORÁRIO DE FIM em ms (`id = str(ts_ms)`), SEM session_id
nem run — mata a classe de bug do run_num-reset (id colidido → run nova sumida). Ver progress.md.
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
    assert r["id"] == "1717800000123"                 # = str(ts_ms): o horário de fim em ms É a identidade
    # v2: SEM session_id, SEM run — a run não pega mais emprestada a identidade da session.
    assert "session_id" not in r
    assert "run" not in r


def test_metadata_is_plain_no_envelope():
    r = _rec()
    assert r["ts"] == 1717800000123                   # ms (v1 era segundos)
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
    # Contrato produtor↔consumidor (Python build_raw_record -> TS convert.mapHero): o reader emite o
    # hero CRU dentro de ok(heroes), com a casing MISTA (snake+camel) que mapHero lê por chave. Um
    # rename de um lado só vira "missing"/campo perdido no conversor com CI verde — então fixamos as
    # chaves AQUI, no lado que produz. Espelha app/src/shared/__fixtures__/raw-v1.ts (o hero do golden).
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
    # top-level hero keys (a casing exata que o mapHero do TS espera, snake + camel misturados)
    for k in ("heroKey", "classId", "class", "level", "exp", "items", "skills", "skillLevels",
              "stats", "exp_start", "exp_end", "xp_gained", "levelup", "deaths", "revives",
              "killed_by"):
        assert k in h, f"hero key {k!r} ausente — quebra o contrato Python↔TS (mapHero)"
    # item + mod keys (o sub-mapeamento que mapHero também lê por chave)
    item = h["items"][0]
    for k in ("slot", "slotId", "grade", "gradeId", "itemKey", "uniqueId", "level", "mods"):
        assert k in item, f"item key {k!r} ausente"
    for k in ("recipeId", "recipe", "statId", "stat", "value", "tier"):
        assert k in item["mods"][0], f"mod key {k!r} ausente"


def test_unread_gold_is_err_not_zero():
    # O bug do gold:0 — "não-li" tem que ser distinguível de "ganhei zero".
    r = _rec(gold=0, gold_ok=False)
    assert r["gold_gained"] == {"ok": False, "error": "gold unread (live+save failed)"}
    # contraste: gold lido ZERO de verdade é ok(0), NÃO err.
    assert _rec(gold=0, gold_ok=True)["gold_gained"] == {"ok": True, "value": 0}


def test_unread_xp_is_err():
    assert _rec(xp_gained=0.0, xp_ok=False)["xp_gained"] == {
        "ok": False, "error": "xp unread (live+save failed)"}


def test_party_off_makes_heroes_err():
    # Party viva off a run inteira: o reader passa heroes_ok=False -> heroes vira err (não [] silencioso
    # nem o roster do save). O conversor marca issues.heroes e — heroes ∈ CRITICAL_FIELDS — sela a run
    # degraded: NÃO sobe pro leaderboard, mas aparece no app, marcada.
    assert _rec(heroes=[], heroes_ok=False)["heroes"] == {
        "ok": False, "error": "party live off (StageManager unresolved)"}
    # contraste: party viva OK -> ok(heroes), mesmo a lista (heroes_ok distingue "off" de conteúdo).
    assert _rec(heroes=[], heroes_ok=True)["heroes"] == {"ok": True, "value": []}


def test_unresolved_stage_fields_are_err():
    r = _rec(act=None, stage_no=None, difficulty=None, total_mobs=None)
    assert r["act"]["ok"] is False
    assert r["stageNo"]["ok"] is False
    assert r["difficulty"]["ok"] is False
    assert r["total_mobs"]["ok"] is False
    # stageKey com um valor real segue ok (o input foi lido).
    assert r["stageKey"]["ok"] is True


def test_unread_stage_key_is_err_not_ok_none():
    # stageKey=None é leitura FALHA da chave de ranking (não "sem stage"): vira err -> o conversor
    # marca issues.stageKey -> degrada a run. ok(None) silencioso aqui repetia o bug do gold:0.
    assert _rec(stage_key=None)["stageKey"] == {"ok": False, "error": "stageKey unread"}


def test_source_tag_rides_alongside_the_envelope():
    # 3 graus: limpo (live) / defasado (save) / não-li (err). source vive ao lado do ok.
    assert _rec(gold_source="live")["gold_source"] == "live"
    assert _rec(gold_source="save")["gold_source"] == "save"


def test_no_derived_or_legacy_fields():
    # CRU: o conversor deriva dps/taxas/partial/status/mode/"3-9"/totais — não saem do reader.
    r = _rec()
    for k in ("dps", "gold_per_sec", "xp_per_sec", "partial", "status", "mode", "stage",
              "schema_version", "deaths", "revives", "session_id", "run"):
        assert k not in r, f"{k!r} is derived/legacy/v1 — must NOT be in the raw v2 record"


def test_account_snapshot_fields_are_enveloped():
    # runes/inventory/stash = snapshot CRU da conta (SAVE), gravado em TODA run, em envelope ok().
    # Aditivo SEM bump de RAW_SCHEMA_VERSION (o conversor ignora chave desconhecida); o wiki deriva
    # depois (drop-rate real, correção de wave). id-only nos itens (o app resolve nome pelo itemKey).
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
    # VAZIO GENUÍNO (a leitura rolou e não achou nada — conta nova sem runa, inventário limpo) -> ok([]).
    # É o estado válido "li zero", distinto de "não-li" (próximo teste). A lista [] entra como ok([]).
    r = _rec(runes=[], inventory=[], stash=[])
    assert r["runes"] == {"ok": True, "value": []}
    assert r["inventory"] == {"ok": True, "value": []}
    assert r["stash"] == {"ok": True, "value": []}


def test_account_snapshot_unread_is_err_not_empty():
    # NÃO-LI (read_account_snapshot devolve None: psd nulo, lista ilegível, offset quebrado num patch)
    # -> err, NUNCA ok([]). É o invariante do envelope (a mesma regra que matou o bug do gold:0): o
    # app/wiki tem que distinguir "a conta não tem runa" de "falhei em ler as runas". ok([]) numa falha
    # ressuscitaria o silent-error. read_account_snapshot sinaliza falha com None; aqui é o contrato.
    r = _rec(runes=None, inventory=None, stash=None)
    assert r["runes"] == {"ok": False, "error": "runes unread (save/list unreadable)"}
    assert r["inventory"] == {"ok": False, "error": "inventory unread (save/list unreadable)"}
    assert r["stash"] == {"ok": False, "error": "stash unread (save/list unreadable)"}


def test_absorbed_boss_box_lands_inside_drops_envelope_without_shape_change():
    # Pending-close (o bug do baú-na-run-seguinte): o boss box que o jogo loga ~0.6s APÓS o
    # clear é absorvido no record JÁ MONTADO via _absorb_drop. O contrato: ele aparece DENTRO
    # do envelope ok de drops, no MESMO wire shape de sempre ({"box_key", "monster_type"}),
    # SEM chave nova no record e SEM bump (forma inalterada — só o conteúdo da lista cresce,
    # igual a um drop normal). O round-trip por json é o que o flush grava em disco.
    gray = {"box_key": 910011, "monster_type": 0}
    blue = {"box_key": 920001, "monster_type": 1}
    r = _rec(drops=[gray])
    assert _absorb_drop(r, blue) is True
    flushed = json.loads(json.dumps(r))
    assert flushed["drops"] == {"ok": True, "value": [gray, blue]}
    assert set(flushed.keys()) == set(_rec().keys())   # NENHUMA chave nova: aditivo zero, sem bump
    assert flushed["raw_schema_version"] == RAW_SCHEMA_VERSION == 2
    assert flushed["id"] == "1717800000123"            # id segue o ts_ms do CLOSE, não do flush


def test_raw_record_keys_are_the_documented_contract():
    # O conjunto EXATO de chaves que o build_raw_record emite — ESPELHO de
    # app/src/shared/raw-types.ts::RawRunV2. Adicionar/remover um campo aqui SEM atualizar o
    # raw-types.ts (e este set) quebra o contrato Python↔TS com CI verde — então travamos o
    # conjunto COMPLETO no lado que PRODUZ. (test_no_derived_or_legacy_fields trava o que NÃO entra;
    # este trava o que ENTRA.) NB: runes/inventory/stash são SEMPRE emitidos (ok([]) no mínimo); são
    # opcionais no raw-types.ts SÓ porque raw ANTIGO (pré-snapshot) não os tem.
    expected = {
        "raw_schema_version", "id", "ts", "run_outcome", "game_version",
        "duration", "stageKey", "act", "stageNo", "difficulty", "total_mobs", "mobs",
        "total_damage", "clear_time", "gold_gained", "gold_source", "xp_gained", "xp_source",
        "drops", "heroes", "runes", "inventory", "stash",
    }
    assert set(_rec().keys()) == expected


# ---- read_account_snapshot: a camada de LEITURA distingue NÃO-LI (None) de VAZIO ([]) ----
# (o build_raw_record acima vira None->err / lista->ok; estes provam que o PRODUTOR de fato devolve
#  None na falha e [] só no vazio genuíno — senão um ok([]) silencioso voltaria pelo gold:0).

class _SnapStub:
    """Stub mínimo p/ read_account_snapshot (o MockReader do conftest não tem read()/ru64()):
    rptr/ri32/ru64 leem de `mem`; read(items+DATA, n) empacota os ponteiros de `arrays`."""
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
    # Sem save vivo (psd None) -> NÃO-LI em tudo (None,None,None) -> o caller emite err nos 3.
    assert read_account_snapshot(_SnapStub(), None, {}) == (None, None, None)


def test_read_snapshot_unreadable_lists_are_none_not_empty():
    # psd válido mas NADA resolve (offset quebrado/leitura falha): RUNES ptr None, ITEMS ptr None ->
    # runes None, e inventory/stash None (uid2item não montou). NUNCA [] — senão viraria ok([]) silencioso.
    runes, inv, stash = read_account_snapshot(_SnapStub(), 0x100, {})
    assert runes is None and inv is None and stash is None


def test_read_snapshot_empty_runes_list_is_empty_not_none():
    # RUNES resolve numa lista REAL de size 0 (conta nova, nenhuma runa) -> [] (li-zero), NÃO None.
    psd, rl = 0x100, 0x200
    runes, _, _ = read_account_snapshot(
        _SnapStub(mem={psd + PlayerSaveData.RUNES: rl, rl + List.SIZE: 0}), psd, {})
    assert runes == []


def test_read_snapshot_reads_populated_runes():
    # RUNES com 2 nós -> lista [{key, level}] (prova o caminho feliz da leitura, incl. o read() em lote).
    psd, rl, arr, e1, e2 = 0x100, 0x200, 0x300, 0x1000, 0x1010
    mem = {
        psd + PlayerSaveData.RUNES: rl, rl + List.SIZE: 2, rl + List.ITEMS: arr,
        e1 + RuneSaveData.KEY: 101, e1 + RuneSaveData.LEVEL: 5,
        e2 + RuneSaveData.KEY: 1171, e2 + RuneSaveData.LEVEL: 1,
    }
    runes, _, _ = read_account_snapshot(_SnapStub(mem, {arr + Array.DATA: [e1, e2]}), psd, {})
    assert runes == [{"key": 101, "level": 5}, {"key": 1171, "level": 1}]


def test_read_snapshot_never_raises_even_if_reader_raises():
    # NEVER-RAISES é contrato de vida-ou-morte: um throw em close_run mata o reader (o loop só
    # captura KeyboardInterrupt -> run perdida + sessão derrubada). O Reader REAL devolve None em
    # leitura ruim (nunca levanta), mas o snapshot não pode DEPENDER disso: cada bloco é guardado
    # (try/except) e um reader que LEVANTA em qualquer primitivo vira NÃO-LI (None,None,None) ->
    # err nos 3 — nunca propaga. Este teste trava o contrato do docstring ("cada bloco guardado").
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
