"""game/save.py — live save-instance selection (pick_live_sm + pick_live_csd).

Regression for the "StageManager NOT found" sync / live-party bug: pick_live_sm only
returns a StageManager once a party is deployed (HeroList populated). It used to be
called once at attach, so attaching outside a stage left it None for the whole session.
The reader now re-picks lazily — these prove the recovery the re-pick relies on: the
SAME candidate address yields None before the party deploys and the address after.

1.00.20: the live party discriminator is the DEPLOYED heroKey resolving a real class in hero_cat
(the ACTk live-level decoy died, so the old lvl>0 gate would reject every real hero — see
docs/invariants/party-live-resolution + obscured-data-offlimits). These build the carrier with a
heroKey that IS in the catalog and a ghost with a heroKey that is NOT — the new ghost shape. The
HeroRuntime LEVEL_FAKE/EXP_FAKE offsets are DEAD (read 0) and no longer gate, so the mock no longer
sets them.
"""

from config.offsets import StageManager, Array, Unit, HeroRuntime, HeroInfoData, CommonSaveData
from game.build import hero_in_run, read_live_party, describe_sm_candidates
from game.save import pick_live_sm, pick_live_csd
from tests.conftest import MockReader

SM = 0x1000       # StageManager carrier address (stable for the session)
GHOST_SM = 0x7000  # a non-live StageManager slot (torn-down/template) the scan also returns

# The catalog (heroKey -> classId). Real deployed heroes carry one of these keys; ghosts don't.
HERO_CAT = {101: 1, 201: 2, 301: 3, 401: 4, 501: 5, 601: 6}


def _live_party_reader():
    """A reader whose StageManager SM has a valid deployed party (HeroList) — a hero whose heroKey
    resolves a real class in HERO_CAT, i.e. one read_live_party actually extracts."""
    hl, h0, uf, hi = 0x2000, 0x3000, 0x4000, 0x5000
    return MockReader(
        mem={
            SM + StageManager.HERO_LIST: hl,
            hl + Array.MAX_LENGTH: 3,  # 0 < n <= 12
            hl + Array.DATA: h0,
            h0 + Unit.CACHE: uf,
            uf + HeroRuntime.INFO: hi,
            hi + HeroInfoData.HERO_KEY: 101,    # 0 < hk < 10M AND in HERO_CAT
        }
    )


def test_pick_live_sm_none_when_no_party_deployed():
    # Not in a stage (town/transition): no HeroList -> not a live StageManager.
    assert pick_live_sm(MockReader(mem={}), [SM], HERO_CAT) is None


def test_pick_live_sm_finds_sm_once_party_deploys():
    # Same candidate address as the None case above -> re-picking recovers in-stage.
    assert pick_live_sm(_live_party_reader(), [SM], HERO_CAT) == SM


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
            hi + HeroInfoData.HERO_KEY: 201,   # in HERO_CAT
        }
    )
    assert pick_live_sm(reader, [SM], HERO_CAT) == SM


def test_pick_live_sm_rejects_garbage_hero_list_length():
    # HeroList present but a bogus length (>12) -> not a real party -> None.
    hl = 0x2000
    reader = MockReader(mem={SM + StageManager.HERO_LIST: hl, hl + Array.MAX_LENGTH: 9999})
    assert pick_live_sm(reader, [SM], HERO_CAT) is None


def test_pick_live_sm_none_for_empty_candidates():
    assert pick_live_sm(MockReader(mem={}), []) is None


def test_pick_live_sm_finds_carrier_beyond_600_candidates():
    # Regression for the [:600] cap: the backref can return MANY instances (1.00.11 = 1162), with the
    # party carrier BEYOND 600. The fixed cap dropped it -> 'StageManager NOT found' EVEN in
    # combat (the 1s re-try never reached it) -> party fell back to the roster. pick_live_sm now scans ALL.
    decoys = [0x900000 + i * 0x100 for i in range(700)]   # 700 candidates with no HeroList (skipped)
    assert pick_live_sm(_live_party_reader(), decoys + [SM], HERO_CAT) == SM   # carrier at index 700


def _ghost_then_carrier_reader():
    """sm_list with a GHOST (torn-down/template StageManager: HeroList with a heroKey that is NOT a
    catalog hero -> read_live_party REJECTS it via the hero_cat discriminator) and the live CARRIER
    (heroKey in HERO_CAT), at distinct addresses. Same bug FAMILY as the 1.00.13 field bug (game
    1.00.13, user log): among the ~453 instances the backref returned a ghost BEFORE the carrier; a
    pick that disagreed with read grabbed the ghost -> read_live_party read {} -> 'StageManager ok — 0
    heroes deployed' for the whole session (heroes:err on every run). The discriminator changed in
    1.00.20 (lvl>0 -> heroKey-in-catalog, since the live level died), but pick<->read agreement is the
    same invariant. [[invariants/party-live-resolution]]"""
    g_hl, g_h, g_uf, g_hi = 0x2000, 0x3000, 0x4000, 0x5000   # GHOST: hk present but NOT in HERO_CAT
    c_hl, c_h, c_uf, c_hi = 0x9000, 0xA000, 0xB000, 0xC000   # CARRIER: hk in HERO_CAT
    return MockReader(mem={
        GHOST_SM + StageManager.HERO_LIST: g_hl,
        g_hl + Array.MAX_LENGTH: 1,
        g_hl + Array.DATA: g_h,
        g_h + Unit.CACHE: g_uf,
        g_uf + HeroRuntime.INFO: g_hi,
        g_hi + HeroInfoData.HERO_KEY: 999_999,    # plausible hk (0<hk<10M) but NOT a catalog hero -> ghost
        SM + StageManager.HERO_LIST: c_hl,
        c_hl + Array.MAX_LENGTH: 1,
        c_hl + Array.DATA: c_h,
        c_h + Unit.CACHE: c_uf,
        c_uf + HeroRuntime.INFO: c_hi,
        c_hi + HeroInfoData.HERO_KEY: 201,        # in HERO_CAT -> real carrier (no level needed)
    })


def test_pick_live_sm_skips_ghost_and_picks_carrier():
    # The ghost (heroKey not in catalog) comes BEFORE the carrier in the scan. pick_live_sm must SKIP it
    # (read_live_party=={}) and return the CARRIER — otherwise it freezes on the ghost (`if not sm` in the
    # loop) and the party stays off the whole session. The chosen instance must ALWAYS be readable by
    # read_live_party (pick<->read MUST NOT disagree — the root of the 1.00.13 bug).
    reader = _ghost_then_carrier_reader()
    picked = pick_live_sm(reader, [GHOST_SM, SM], HERO_CAT)     # ghost at index 0
    assert picked == SM                                         # not the ghost (GHOST_SM)
    assert read_live_party(reader, picked, HERO_CAT) != {}      # pick<->read agreement


def test_pick_live_sm_none_when_only_ghosts():
    # Only ghosts (no catalog carrier): degrades honestly -> None (party off), NEVER returns a ghost that
    # read_live_party can't read. Ensures the discriminator doesn't invent a carrier from a stale heroKey.
    reader = _ghost_then_carrier_reader()
    assert pick_live_sm(reader, [GHOST_SM], HERO_CAT) is None


def test_pick_live_sm_real_hero_accepted_without_live_level():
    # 1.00.20 core regression: a REAL deployed hero (heroKey in catalog) must be accepted even though the
    # live level/exp decoy is DEAD (LEVEL_FAKE/EXP_FAKE absent/0). The old lvl>0 gate rejected it -> empty
    # party -> sm NOT found -> hero-class/xp-live/stats cascade-fail. The carrier sets NO level offsets.
    reader = _ghost_then_carrier_reader()
    assert pick_live_sm(reader, [SM], HERO_CAT) == SM
    party = read_live_party(reader, SM, HERO_CAT)
    assert party == {201: (None, None)}                # identity present; level/exp unavailable live


def test_describe_sm_candidates_classifies_carrier_vs_ghost():
    # Infra diagnostic (reader-diag.log): separates carrier from ghost. With [ghost, carrier]: 2
    # candidates, both hk-accept (they have a plausible heroKey 0<hk<10M), but only 1 carrier (the ghost's
    # key isn't a catalog hero → read_live_party empty). The ghost becomes a sample. hk_accept>carriers is
    # the signature of a ghost in the loose universe.
    reader = _ghost_then_carrier_reader()
    d = describe_sm_candidates(reader, [GHOST_SM, SM], picked=SM, hero_cat=HERO_CAT)
    assert d["total"] == 2
    assert d["hk_accept"] == 2                          # both have a plausible heroKey
    assert d["carriers"] == 1                           # only the catalog hero is read_live_party-readable
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
