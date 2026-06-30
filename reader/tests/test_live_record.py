"""Tests for build_live_record — the RAW LIVE snapshot (live.json, overwritten ~1x/s).

Enforces the Live-meter redesign contract: the reader STOPPED cooking the overlay (no dps/label/
format) — it emits only live numbers/ids and the APP cooks them (computeDps/resolveStage/modeName)
with the SAME helpers as the record. Mirrors app/src/shared/live-types.ts::RawLive (same shape on
both sides). Unlike the per-run raw/<id>.json: live is ephemeral → NO envelope, NO run_outcome
(it's always the in-progress run), gold/xp become `null` when they don't resolve (vanish in the
overlay).
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
    assert r["raw_schema_version"] == RAW_SCHEMA_VERSION == 2  # shared constant bumped (Redesign 2)
    assert r["run"] == 7                  # local console counter (not an id nor a session)
    assert "session_id" not in r          # Redesign 2: the reader emits no session (the app derives it)


def test_stage_fields_are_raw_not_cooked():
    # act/stageNo/difficulty/stageKey go out RAW — the app formats "3-9" and the mode name at render.
    r = _live()
    assert r["stageKey"] == 30901
    assert r["act"] == 3
    assert r["stageNo"] == 9
    assert r["difficulty"] == 2  # enum int, NOT "Hell"


def test_damage_and_elapsed_are_raw_no_dps():
    # damage_now/elapsed raw: the app derives dps with the SAME computeDps as the record (one formula only).
    r = _live()
    assert r["damage_now"] == 2830000.0
    assert r["elapsed"] == 34
    assert isinstance(r["elapsed"], int)


def test_gold_xp_pass_through():
    r = _live()
    assert r["gold_now"] == 14500
    assert r["xp_now"] == 19800.0


def test_unresolved_gold_xp_are_null_not_zero():
    # live gold/xp that didn't resolve become null (vanish in the overlay) — NOT 0 (which looks like a real gain).
    r = _live(gold_now=None, xp_now=None)
    assert r["gold_now"] is None
    assert r["xp_now"] is None
    # contrast: a genuine zero gain stays 0.
    assert _live(gold_now=0)["gold_now"] == 0


def test_party_and_drops_pass_through():
    r = _live()
    assert r["party"] == [101, 201, 301]
    assert r["drops"] == [4, 1, 0]
    # empty is empty (no party deployed / no loot) — the app omits the frame.
    assert _live(party=[], drops=[0, 0, 0])["party"] == []


def test_party_stats_pass_through_and_default_empty():
    # 64 live FINAL stats per hero {heroKey: {statId: value}} — feeds the effective-resistance
    # tooltip in the overlay. Default {} (reader without the param / no read) = no tooltip.
    assert _live()["party_stats"] == {}
    stats = {201: {52: 27.0, 12: 10.0}, 101: {52: 0.0}}
    assert _live(party_stats=stats)["party_stats"] == stats


def test_party_progress_pass_through_and_default_empty():
    # {heroKey: {level, exp, gain}} per-hero live leveling snapshot — powers the overlay's
    # time-to-level. Default {} (reader without the param / no live party) = no ETA shown.
    assert _live()["party_progress"] == {}
    prog = {101: {"level": 91, "exp": 1234.0, "gain": 56789.0},
            301: {"level": 93, "exp": 50.0, "gain": 60000.0}}
    assert _live(party_progress=prog)["party_progress"] == prog


def test_party_slots_pass_through_and_default_empty():
    # {heroKey: slot} = each deployed hero's formation position (0/1/2). `party` is already ordered
    # by it; this rides alongside so the overlay can place by EXACT position (gaps included). Default
    # {} (reader without the param / no live party) — the overlay falls back to array order.
    assert _live()["party_slots"] == {}
    slots = {101: 0, 301: 2}   # a 2-hero team with a gap at slot 1
    assert _live(party_slots=slots)["party_slots"] == slots


def test_no_envelope_no_outcome_no_cooked_fields():
    # RAW: NO envelope (ephemeral, not audited), NO run_outcome (run in progress), and ZERO
    # cooked presentation (dps/label/mode/stage-string) — the app cooks it.
    r = _live()
    # no field is an envelope {ok,...}
    for k, v in r.items():
        assert not (isinstance(v, dict) and "ok" in v), f"{k!r} is enveloped — live is raw, no ok/err"
    for k in ("run_outcome", "dps", "DPS", "stage", "mode", "label", "goldPerSec", "xpPerSec"):
        assert k not in r, f"{k!r} is derived/cooked or N/A for live — must NOT be in the live record"
