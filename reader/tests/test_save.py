"""game/save.py — live save-instance selection (pick_live_sm + pick_live_csd).

Regression for the "StageManager NOT found" sync / live-party bug: pick_live_sm only
returns a StageManager once a party is deployed (HeroList populated). It used to be
called once at attach, so attaching outside a stage left it None for the whole session.
The reader now re-picks lazily — these prove the recovery the re-pick relies on: the
SAME candidate address yields None before the party deploys and the address after.
"""

from config.offsets import StageManager, Array, Unit, HeroRuntime, HeroInfoData, CommonSaveData
from game.build import hero_in_run, read_live_party, describe_sm_candidates
from game.save import pick_live_sm, pick_live_csd
from tests.conftest import MockReader

SM = 0x1000       # StageManager carrier address (stable for the session)
GHOST_SM = 0x7000  # a non-live StageManager slot (torn-down/template) the scan also returns


def _live_party_reader():
    """A reader whose StageManager SM has a valid deployed party (HeroList) — a hero with a
    full live runtime (heroKey + level + exp), i.e. one read_live_party actually extracts."""
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
    # Regression for the [:600] cap: the backref can return MANY instances (1.00.11 = 1162), with the
    # party carrier BEYOND 600. The fixed cap dropped it -> 'StageManager NOT found' EVEN in
    # combat (the 1s re-try never reached it) -> party fell back to the roster. pick_live_sm now scans ALL.
    decoys = [0x900000 + i * 0x100 for i in range(700)]   # 700 candidates with no HeroList (skipped)
    assert pick_live_sm(_live_party_reader(), decoys + [SM]) == SM   # carrier at index 700


def _ghost_then_carrier_reader():
    """sm_list with a GHOST (torn-down/template StageManager: HeroList with a VALID heroKey but
    lvl=0 -> read_live_party REJECTS it) and the live CARRIER (valid hk+lvl+exp), at distinct addresses.
    Mirrors the 1.00.13 field bug (game 1.00.13, user log): among the ~453 instances the
    backref returned a ghost BEFORE the carrier; pick_live_sm only checked hk -> grabbed the ghost ->
    read_live_party read {} -> 'StageManager ok — 0 heroes deployed' for the whole session (heroes:err on
    every run). [[invariants/party-live-resolution]]"""
    g_hl, g_h, g_uf, g_hi = 0x2000, 0x3000, 0x4000, 0x5000   # GHOST: hk ok, lvl=0
    c_hl, c_h, c_uf, c_hi = 0x9000, 0xA000, 0xB000, 0xC000   # CARRIER: hk+lvl+exp ok
    return MockReader(mem={
        GHOST_SM + StageManager.HERO_LIST: g_hl,
        g_hl + Array.MAX_LENGTH: 1,
        g_hl + Array.DATA: g_h,
        g_h + Unit.CACHE: g_uf,
        g_uf + HeroRuntime.INFO: g_hi,
        g_hi + HeroInfoData.HERO_KEY: 101,        # passes the weak check (hk)
        g_uf + HeroRuntime.LEVEL_FAKE: 0,         # fails read_live_party (requires 0 < lvl)
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
    # Regression for 1.00.13: the ghost (valid hk, lvl=0) comes BEFORE the carrier in the scan. pick_live_sm
    # must SKIP the ghost (read_live_party=={}) and return the CARRIER — otherwise it freezes on the ghost
    # (`if not sm` in the loop) and the party stays off the whole session. The chosen instance must
    # ALWAYS be readable by read_live_party (pick<->read MUST NOT disagree — the root of the bug).
    reader = _ghost_then_carrier_reader()
    picked = pick_live_sm(reader, [GHOST_SM, SM])     # ghost at index 0
    assert picked == SM                                # not the ghost (GHOST_SM)
    assert read_live_party(reader, picked) != {}       # pick<->read agreement


def test_pick_live_sm_none_when_only_ghosts():
    # Only ghosts (no readable carrier): degrades honestly -> None (party off, as today), NEVER
    # returns a ghost that read_live_party can't read. Ensures the fix doesn't invent a carrier.
    reader = _ghost_then_carrier_reader()
    assert pick_live_sm(reader, [GHOST_SM]) is None


def test_describe_sm_candidates_classifies_carrier_vs_ghost():
    # Infra diagnostic (reader-diag.log): separates carrier from ghost — the data that was MISSING in the
    # 1.00.13 debug. With [ghost, carrier]: 2 candidates, both hk-accept (they have a valid heroKey), but only
    # 1 carrier (the ghost has lvl=0 → read_live_party empty). The ghost becomes a sample. hk_accept>carriers
    # is the signature of the bug.
    reader = _ghost_then_carrier_reader()
    d = describe_sm_candidates(reader, [GHOST_SM, SM], picked=SM)
    assert d["total"] == 2
    assert d["hk_accept"] == 2                          # both pass the weak check (hk)
    assert d["carriers"] == 1                           # only the carrier is read_live_party-readable
    assert d["picked"] == SM
    assert len(d["ghosts"]) == 1 and d["ghosts"][0][0] == GHOST_SM


# ---------------------------------------------------------------------------
# hero_in_run — inclusion rule for the run artifact (honest party fallback)
# ---------------------------------------------------------------------------

class TestHeroInRun:
    """ONLY heroes from the LIVE party (live_keys) enter the artifact. With NO live party (empty live_keys),
    NOBODY enters — the caller emits heroes:err (degraded run), never the raw roster nor a guess."""

    def test_live_keys_are_authoritative(self):
        assert hero_in_run(201, {201}) is True               # deployed -> in
        assert hero_in_run(101, {201}) is False              # not deployed -> out

    def test_no_live_party_includes_nobody(self):
        # empty live_keys = live party off the whole run -> nobody enters (heroes becomes err -> degraded);
        # NEVER the save's roster, and no xp>0 proxy (a guess that could pick up a hero with idle xp).
        assert hero_in_run(201, set()) is False
        assert hero_in_run(101, set()) is False


# ---------------------------------------------------------------------------
# pick_live_csd — the LIVE save among false-positive type matches
# ---------------------------------------------------------------------------

class TestPickLiveCsd:
    """The CommonSaveData type scan also returns GARBAGE instances (memory whose first qword matches
    the type). 1.00.17: a false positive read playTime=3.77e19, currentStageKey=6775040 — and the old
    'highest playTime among 0<key<10M' rule PICKED IT over the real save (playTime=1.76e6, key=4309),
    which made the validate_live `stage` check spuriously red on a correctly-calibrated seed. The
    picker now requires a SANE playTime AND prefers an in-catalog stage key. [[meter-game-update]]"""

    REAL = 0x1000          # the real save (sane playTime, in-catalog key)
    GARBAGE = 0x7FFB0000   # a false-positive type match (insane playTime, sub-10M garbage key)
    CATALOG = {4309: (3, 9, 50, 4)}   # int-keyed, like load_calib's stage_info

    def _reader(self, real_pt=1_755_888.375, real_key=4309, garb_pt=3.77e19, garb_key=6_775_040):
        return MockReader(mem={
            self.REAL + CommonSaveData.PLAYTIME: real_pt,
            self.REAL + CommonSaveData.CURRENT_STAGE_KEY: real_key,
            self.GARBAGE + CommonSaveData.PLAYTIME: garb_pt,
            self.GARBAGE + CommonSaveData.CURRENT_STAGE_KEY: garb_key,
        })

    def test_rejects_garbage_playtime_even_without_catalog(self):
        # The playTime sanity bound alone (no stage_info) rejects the 3.77e19 false positive.
        assert pick_live_csd(self._reader(), [self.GARBAGE, self.REAL]) == self.REAL

    def test_prefers_in_catalog_key(self):
        # With the catalog, the real save (key in catalog) wins outright over the garbage instance.
        assert pick_live_csd(self._reader(), [self.GARBAGE, self.REAL], self.CATALOG) == self.REAL

    def test_in_catalog_key_beats_higher_playtime(self):
        # A decoy with a SANE-but-higher playTime and an out-of-catalog key must NOT beat the real
        # save: catalog membership is the stronger fingerprint (ranks above playTime).
        reader = self._reader(real_pt=1000.0, real_key=4309, garb_pt=9e8, garb_key=5000)
        assert pick_live_csd(reader, [self.GARBAGE, self.REAL], self.CATALOG) == self.REAL

    def test_highest_playtime_when_no_catalog_signal(self):
        # No stage_info, both keys plausible -> falls back to highest playTime (legacy behavior kept).
        reader = MockReader(mem={
            0x1000 + CommonSaveData.PLAYTIME: 100.0, 0x1000 + CommonSaveData.CURRENT_STAGE_KEY: 1101,
            0x2000 + CommonSaveData.PLAYTIME: 500.0, 0x2000 + CommonSaveData.CURRENT_STAGE_KEY: 2202,
        })
        assert pick_live_csd(reader, [0x1000, 0x2000]) == 0x2000

    def test_none_when_all_garbage(self):
        # Only false positives (insane playTime) -> None: degrades honestly, never returns a garbage base.
        reader = MockReader(mem={
            self.GARBAGE + CommonSaveData.PLAYTIME: 3.77e19,
            self.GARBAGE + CommonSaveData.CURRENT_STAGE_KEY: 6_775_040,
        })
        assert pick_live_csd(reader, [self.GARBAGE], self.CATALOG) is None

    def test_empty_candidates(self):
        assert pick_live_csd(MockReader(mem={}), []) is None
