"""game/save.py — live StageManager selection (pick_live_sm).

Regression for the "StageManager NOT found" sync / live-party bug: pick_live_sm only
returns a StageManager once a party is deployed (HeroList populated). It used to be
called once at attach, so attaching outside a stage left it None for the whole session.
The reader now re-picks lazily — these prove the recovery the re-pick relies on: the
SAME candidate address yields None before the party deploys and the address after.
"""

from config.offsets import StageManager, Array, Unit, HeroRuntime, HeroInfoData
from game.build import hero_in_run, read_live_party, describe_sm_candidates
from game.save import pick_live_sm
from tests.conftest import MockReader

SM = 0x1000       # StageManager carrier address (stable for the session)
GHOST_SM = 0x7000  # a non-live StageManager slot (torn-down/template) the scan also returns


def _live_party_reader():
    """A reader whose StageManager SM has a valid deployed party (HeroList) — a hero with a
    full live runtime (heroKey + nível + exp), i.e. one read_live_party actually extracts."""
    hl, h0, uf, hi = 0x2000, 0x3000, 0x4000, 0x5000
    return MockReader(
        mem={
            SM + StageManager.HERO_LIST: hl,
            hl + Array.MAX_LENGTH: 3,  # 0 < n <= 12
            hl + Array.DATA: h0,
            h0 + Unit.CACHE: uf,
            uf + HeroRuntime.INFO: hi,
            hi + HeroInfoData.HERO_KEY: 101,    # 0 < hk < 10_000_000
            uf + HeroRuntime.LEVEL_FAKE: 80,    # 0 < lvl <= 999
            uf + HeroRuntime.EXP_FAKE: 100.0,   # exp >= 0
        }
    )


def test_pick_live_sm_none_when_no_party_deployed():
    # Not in a stage (town/transition): no HeroList -> not a live StageManager.
    assert pick_live_sm(MockReader(mem={}), [SM]) is None


def test_pick_live_sm_finds_sm_once_party_deploys():
    # Same candidate address as the None case above -> re-picking recovers in-stage.
    assert pick_live_sm(_live_party_reader(), [SM]) == SM


def test_pick_live_sm_finds_solo_hero_outside_slot_zero():
    # HeroList is indexed by FORMATION position: a solo hero in slot 2 leaves slot 0
    # null. The old slot-0-only check skipped this SM -> live party off all session.
    hl, h, uf, hi = 0x2000, 0x3000, 0x4000, 0x5000
    reader = MockReader(
        mem={
            SM + StageManager.HERO_LIST: hl,
            hl + Array.MAX_LENGTH: 3,
            hl + Array.DATA + 2 * 8: h,  # slots 0 and 1 null
            h + Unit.CACHE: uf,
            uf + HeroRuntime.INFO: hi,
            hi + HeroInfoData.HERO_KEY: 201,
            uf + HeroRuntime.LEVEL_FAKE: 60,
            uf + HeroRuntime.EXP_FAKE: 0.0,
        }
    )
    assert pick_live_sm(reader, [SM]) == SM


def test_pick_live_sm_rejects_garbage_hero_list_length():
    # HeroList present but a bogus length (>12) -> not a real party -> None.
    hl = 0x2000
    reader = MockReader(mem={SM + StageManager.HERO_LIST: hl, hl + Array.MAX_LENGTH: 9999})
    assert pick_live_sm(reader, [SM]) is None


def test_pick_live_sm_none_for_empty_candidates():
    assert pick_live_sm(MockReader(mem={}), []) is None


def test_pick_live_sm_finds_carrier_beyond_600_candidates():
    # Regressão do cap [:600]: o backref pode devolver MUITAS instâncias (1.00.11 = 1162), com a
    # portadora-de-party ALÉM de 600. O cap fixo a perdia -> 'StageManager NOT found' MESMO em
    # combate (re-try 1s nunca alcançava) -> party caía no roster. pick_live_sm varre TODAS agora.
    decoys = [0x900000 + i * 0x100 for i in range(700)]   # 700 candidatas sem HeroList (puladas)
    assert pick_live_sm(_live_party_reader(), decoys + [SM]) == SM   # portadora no índice 700


def _ghost_then_carrier_reader():
    """sm_list com um GHOST (StageManager torn-down/template: HeroList com heroKey VÁLIDO mas
    lvl=0 -> read_live_party REJEITA) e a CARRIER viva (hk+lvl+exp válidos), em endereços distintos.
    Espelha o bug de campo do 1.00.13 (game 1.00.13, log do usuário): entre as ~453 instâncias o
    backref devolvia um ghost ANTES da carrier; pick_live_sm só checava o hk -> agarrava o ghost ->
    read_live_party lia {} -> 'StageManager ok — 0 heroes deployed' a sessão inteira (heroes:err em
    toda run). [[invariants/party-live-resolution]]"""
    g_hl, g_h, g_uf, g_hi = 0x2000, 0x3000, 0x4000, 0x5000   # GHOST: hk ok, lvl=0
    c_hl, c_h, c_uf, c_hi = 0x9000, 0xA000, 0xB000, 0xC000   # CARRIER: hk+lvl+exp ok
    return MockReader(mem={
        GHOST_SM + StageManager.HERO_LIST: g_hl,
        g_hl + Array.MAX_LENGTH: 1,
        g_hl + Array.DATA: g_h,
        g_h + Unit.CACHE: g_uf,
        g_uf + HeroRuntime.INFO: g_hi,
        g_hi + HeroInfoData.HERO_KEY: 101,        # passa no check fraco (hk)
        g_uf + HeroRuntime.LEVEL_FAKE: 0,         # reprova no read_live_party (exige 0 < lvl)
        g_uf + HeroRuntime.EXP_FAKE: 0.0,
        SM + StageManager.HERO_LIST: c_hl,
        c_hl + Array.MAX_LENGTH: 1,
        c_hl + Array.DATA: c_h,
        c_h + Unit.CACHE: c_uf,
        c_uf + HeroRuntime.INFO: c_hi,
        c_hi + HeroInfoData.HERO_KEY: 201,
        c_uf + HeroRuntime.LEVEL_FAKE: 80,
        c_uf + HeroRuntime.EXP_FAKE: 1234.0,
    })


def test_pick_live_sm_skips_ghost_and_picks_carrier():
    # Regressão do 1.00.13: o ghost (hk válido, lvl=0) vem ANTES da carrier no scan. pick_live_sm
    # tem que PULAR o ghost (read_live_party=={}) e devolver a CARRIER — senão congela no ghost
    # (`if not sm` no loop) e a party fica off a sessão inteira. A instância escolhida tem que ser
    # SEMPRE legível por read_live_party (pick<->read NÃO podem discordar — a raiz do bug).
    reader = _ghost_then_carrier_reader()
    picked = pick_live_sm(reader, [GHOST_SM, SM])     # ghost no índice 0
    assert picked == SM                                # não o ghost (GHOST_SM)
    assert read_live_party(reader, picked) != {}       # acordo pick<->read


def test_pick_live_sm_none_when_only_ghosts():
    # Só ghosts (nenhuma carrier legível): degrada honesto -> None (party off, igual hoje), NUNCA
    # devolve um ghost que read_live_party não consegue ler. Garante que o fix não inventa carrier.
    reader = _ghost_then_carrier_reader()
    assert pick_live_sm(reader, [GHOST_SM]) is None


def test_describe_sm_candidates_classifies_carrier_vs_ghost():
    # Diagnóstico de infra (reader-diag.log): separa carrier de ghost — o dado que FALTOU no debug
    # do 1.00.13. Com [ghost, carrier]: 2 candidatas, ambas hk-accept (têm heroKey válido), mas só
    # 1 carrier (a ghost tem lvl=0 → read_live_party vazio). A ghost vira amostra. hk_accept>carriers
    # é a assinatura do bug.
    reader = _ghost_then_carrier_reader()
    d = describe_sm_candidates(reader, [GHOST_SM, SM], picked=SM)
    assert d["total"] == 2
    assert d["hk_accept"] == 2                          # as duas passam no check fraco (hk)
    assert d["carriers"] == 1                           # só a carrier é read_live_party-legível
    assert d["picked"] == SM
    assert len(d["ghosts"]) == 1 and d["ghosts"][0][0] == GHOST_SM


# ---------------------------------------------------------------------------
# hero_in_run — regra de inclusão no artefato da run (fallback honesto da party)
# ---------------------------------------------------------------------------

class TestHeroInRun:
    """SÓ os heróis da party VIVA (live_keys) entram no artefato. SEM party viva (live_keys vazio),
    NINGUÉM entra — o caller emite heroes:err (run degradada), nunca o roster cru nem um chute."""

    def test_live_keys_are_authoritative(self):
        assert hero_in_run(201, {201}) is True               # deployado entra
        assert hero_in_run(101, {201}) is False              # não-deployado fora

    def test_no_live_party_includes_nobody(self):
        # live_keys vazio = party viva off a run inteira -> ninguém entra (heroes vira err -> degraded);
        # NUNCA o roster do save, e sem proxy xp>0 (chute que poderia pegar um herói com xp idle).
        assert hero_in_run(201, set()) is False
        assert hero_in_run(101, set()) is False
