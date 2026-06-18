"""Testes do build_live_record — o snapshot LIVE CRU (live.json, sobrescrito ~1x/s).

Garante o contrato do redesign do live (progress.md "Live-meter"): o reader DEIXOU de cozinhar o
overlay (sem dps/label/format) — emite só números/ids vivos e o APP cozinha (computeDps/resolveStage/
modeName) com os MESMOS helpers do record. Espelha app/src/shared/live-types.ts::RawLive (mesma forma
nos dois lados). Diferente do raw/<id>.json por-run: o live é efêmero → SEM envelope, SEM run_outcome
(é sempre a run em andamento), gold/xp viram `null` quando não resolvem (somem no overlay).
"""

from meter_windows import RAW_SCHEMA_VERSION, build_live_record


def _live(**over):
    base = dict(
        run=7, stage_key=30901, act=3, stage_no=9,
        difficulty=2, mobs=68, total_mobs=601, damage_now=2830000.0, elapsed=34,
        gold_now=14500, xp_now=19800.0, party=[101, 201, 301], drops=[4, 1, 0],
    )
    base.update(over)
    return build_live_record(**base)


def test_stamps_raw_schema_version_and_run():
    r = _live()
    assert r["raw_schema_version"] == RAW_SCHEMA_VERSION == 2  # constante compartilhada bumpou (Redesign 2)
    assert r["run"] == 7                  # contador local do console (não é id nem session)
    assert "session_id" not in r          # Redesign 2: o reader não emite session (o app deriva)


def test_stage_fields_are_raw_not_cooked():
    # act/stageNo/difficulty/stageKey vão CRUS — o app formata "3-9" e o nome do mode no render.
    r = _live()
    assert r["stageKey"] == 30901
    assert r["act"] == 3
    assert r["stageNo"] == 9
    assert r["difficulty"] == 2  # enum int, NÃO "Hell"


def test_damage_and_elapsed_are_raw_no_dps():
    # damage_now/elapsed crus: o app deriva o dps com o MESMO computeDps do record (uma fórmula só).
    r = _live()
    assert r["damage_now"] == 2830000.0
    assert r["elapsed"] == 34
    assert isinstance(r["elapsed"], int)


def test_gold_xp_pass_through():
    r = _live()
    assert r["gold_now"] == 14500
    assert r["xp_now"] == 19800.0


def test_unresolved_gold_xp_are_null_not_zero():
    # gold/xp vivos que não resolveram viram null (somem no overlay) — NÃO 0 (que parece ganho real).
    r = _live(gold_now=None, xp_now=None)
    assert r["gold_now"] is None
    assert r["xp_now"] is None
    # contraste: ganho zero de verdade fica 0.
    assert _live(gold_now=0)["gold_now"] == 0


def test_party_and_drops_pass_through():
    r = _live()
    assert r["party"] == [101, 201, 301]
    assert r["drops"] == [4, 1, 0]
    # vazio é vazio (sem party deployada / sem loot) — o app omite o frame.
    assert _live(party=[], drops=[0, 0, 0])["party"] == []


def test_party_stats_pass_through_and_default_empty():
    # 64 stats FINAIS vivos por herói {heroKey: {statId: valor}} — alimenta o tooltip de
    # resistência efetiva no overlay. Default {} (reader sem o param / sem leitura) = sem tooltip.
    assert _live()["party_stats"] == {}
    stats = {201: {52: 27.0, 12: 10.0}, 101: {52: 0.0}}
    assert _live(party_stats=stats)["party_stats"] == stats


def test_no_envelope_no_outcome_no_cooked_fields():
    # CRU: SEM envelope (efêmero, não auditado), SEM run_outcome (run em andamento), e ZERO
    # apresentação cozida (dps/label/mode/stage-string) — o app cozinha.
    r = _live()
    # nenhum campo é um envelope {ok,...}
    for k, v in r.items():
        assert not (isinstance(v, dict) and "ok" in v), f"{k!r} is enveloped — live is raw, no ok/err"
    for k in ("run_outcome", "dps", "DPS", "stage", "mode", "label", "goldPerSec", "xpPerSec"):
        assert k not in r, f"{k!r} is derived/cooked or N/A for live — must NOT be in the live record"
