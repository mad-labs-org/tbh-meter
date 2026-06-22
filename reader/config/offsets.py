"""
offsets.py — the TBH OFFSET BIBLE, all in one place (single source of truth).

Where it came from: IL2CPP dump (re/dump/dump.cs) of GameAssembly.dll v1.00.07, Unity
6000.0.72f1, TesseractStudio. EVERY value here is VALIDATED live (the meter ran with
them; gold/xp nailed to ±0.1%, stats match the .es3 save).

Reconstructed from docs/run-data-map.md + tools/meter_windows.py + docs/damage-model.md.
There is NO "calibration" (no Cheat Engine): the managers are singletons found at runtime
by an auto-resolver (class-string scan → Il2CppClass → instances; see
il2cpp/resolver). Short-named singletons (ut/yp) via find_class_by_name + nn<T>.

⚠ NEVER confuse the TWO Dictionary entry geometries (see DictFloat vs Dict8B).
⚠ Business-rule constants (curve, filters) do NOT live here — offsets/enums only.
"""

from enum import IntEnum, IntFlag

# --------------------------------------------------------------------------- #
# Process / build
# --------------------------------------------------------------------------- #
PROCESS_NAME = "TaskBarHero.exe"
MODULE_NAME = "GameAssembly.dll"      # all the IL2CPP logic lives here
POINTER_SIZE = 8                      # x64 process
# GAME_VERSION and SCHEMA_VERSION live in meter_windows.py (the SINGLE source for runs.jsonl) — NOT here.
# They used to have dead, stale copies (=5 while the runtime emitted 11); the drift-test
# (test_docs_consistency::test_version_constants_unique) now fails if they reappear.
GOLD_KEY = 100001                     # CurrencySaveData.Key of gold


# --------------------------------------------------------------------------- #
# IL2CPP runtime layout (x64)
# --------------------------------------------------------------------------- #
class Obj:
    KLASS = 0x0                        # every managed object: pointer to Il2CppClass


class String:
    LENGTH = 0x10                      # System.String: int length
    CHARS = 0x14                       # utf-16


class Array:                           # Il2CppArray (T[])
    MAX_LENGTH = 0x18
    DATA = 0x20                        # elements start here (8B/ptr on x64)


class List:                            # System.Collections.Generic.List<T>
    ITEMS = 0x10                       # pointer to the backing array
    SIZE = 0x18


class Dict:                            # Dictionary<K,V>: common fields
    ENTRIES = 0x18                     # _entries (Entry[])
    COUNT = 0x20                       # _count
    DATA = 0x20                        # start of the entries-array data


class DictFloat:
    """Dict entry with a 4-byte VALUE (e.g. Dict<StatType,float> = 64 stats)."""
    STRIDE = 0x10
    HASH = 0x0                         # skip if < 0 (tombstone)
    NEXT = 0x4
    KEY = 0x8                          # int32
    VALUE = 0xC                        # float32


class Dict8B:
    """Dict entry with an 8-byte VALUE — long OR pointer (e.g. the gold Dict<int,long>;
    outer Dict<EAggregateType,Dict>). value@0x10 due to 8-byte alignment.
    *** Do NOT confuse with DictFloat (stride 0x10/val 0xC) — would corrupt gold/stats. ***"""
    STRIDE = 0x18
    HASH = 0x0
    NEXT = 0x4
    KEY = 0x8                          # int32
    VALUE = 0x10                       # int64 OR pointer


class Class:                           # Il2CppClass (il2cpp.h)
    NAME = 0x10                        # const char* (class name)
    ELEMENT_CLASS = 0x40               # == K for a normal class (resolver validation)
    CAST_CLASS = 0x48                  # == K likewise
    PARENT = 0x58                      # superclass (to reach nn<T>)
    STATIC_FIELDS = 0xB8               # static-fields block (sizeof Il2CppClass_1)


class Singleton:
    """nn<a> : MonoBehaviour (TypeDefIndex 2350) — generic singleton base.
    The live instance lives in `static a bbwf` @ STATIC_FIELDS + INSTANCE.
    For Foo:nn<Foo> -> klass(Foo).PARENT (= nn<Foo>) -> STATIC_FIELDS -> INSTANCE."""
    INSTANCE = 0x0                     # bbwf (the singleton)


# ACTk Obscured (this build): the REAL value is the PLAIN `fakeValue` at base+0xC
# (ObscuredInt/Float). hidden^key gives GARBAGE. ObscuredLong: fake probably @+0x18.
ACTK_FAKE = 0xC


# --------------------------------------------------------------------------- #
# Per-class field offsets (dump.cs) — all VALIDATED live
# --------------------------------------------------------------------------- #
class Unit:                            # base of Hero/Monster (dump.cs ~319277)
    HEALTH_CONTROLLER = 0xB0           # -> UnitHealthController
    IS_HERO = 0x100                    # bool b_isHero
    CACHE = 0x3A8                      # Hero.cache -> uf (progression wrapper). 1.00.14 inserted
                                       # `Action OnCrowdControlAppliedAction` @0x3A0 at the END of Unit
                                       # (base grew +0x8) -> Hero.cache 0x3A0->0x3A8; EVERY Unit
                                       # subclass field shifted +0x8 (Monster likewise, below).
    CORE_STATS_OBSCURED = 0x104        # 12 core stats: ObscuredFloat (XOR) — DO NOT READ (garbage); use
                                       # xd.FINAL_STATS (Dict<StatType,float> PLAIN). Marker for
                                       # docs/invariants/obscured-data-offlimits (test_obscured_markers).


class UnitHealthController:            # HP in PURE float (dump.cs ~319894)
    HP_CURRENT = 0x40                  # VALIDATED (drops when taking damage); damage = Σ drops
    HP_MAX = 0x4C


class Monster:                         # extends Unit -> inherited the 1.00.14 +0x8 (see Unit.CACHE)
    STAGE_KEY = 0x3D4                  # LIVE stageKey (the save's freezes on a stage change). 1.00.14: 0x3CC->0x3D4.
                                       # ⚠ diff_offsets gave a FALSE-OK (obfuscated-name field, only checks
                                       # adjacency -> a uniform +0x8 shift passes) — caught in dump.cs
                                       # vs the 1.00.13 baseline; confirm in validate_live (stage).
    CACHE_OBSCURED = 0x3B8             # Obscured cache — DO NOT READ; use the Monster PLAIN fields.
                                       # 1.00.14: 0x3B0->0x3B8. Marker for docs/invariants/obscured-data-offlimits.


class StageManager:                    # singleton (dump.cs ~327247)
    HERO_LIST = 0x30                   # Hero[] = the live deployed party


class MonsterSpawnManager:             # singleton (dump.cs ~343052)
    MONSTER_LIST = 0x28               # List<Unit> alive
    DEAD_MONSTER_LIST = 0x30          # List<Unit> dead (clears on a reload of the same stage)
    SUMMONED_LIST = 0x38


class LogManager:                      # singleton (dump.cs ~339652)
    LOG_LIST = 0x20                    # List<LogData> (run boundary = size grows)
    LOG_BY_TYPE = 0x28                 # Dictionary<ELogType, List<LogData>>


class StageClearLog:                   # success
    ACT = 0x40
    STAGE = 0x44
    CLEAR_TIME = 0x48                  # int (official seconds)
    IS_BOSS = 0x4C


class StageFailedLog:                  # failure
    ACT = 0x40
    STAGE = 0x44
    NOW_WAVE = 0x48
    TOTAL_WAVE = 0x4C
    IS_ACT_BOSS = 0x50


class GetBoxLog:                       # chest drop (ELogType=3). LIVE-CRACKED 2026-06-06.
    BOX_KEY      = 0x40               # System.String* of the TYPE: "TreasureChest_Monster|StageBoss|
                                       # ActBoss" (NOT an item key!). Classify the tier by MONSTER_TYPE.
    MONSTER_KEY  = 0x48               # System.String* "MonsterName_<key>" (the mob that dropped it)
    MONSTER_TYPE = 0x50               # int (EMonsterLogType: Monster=0, Boss=1, ActBoss=2) = chest tier


class HeroDieLog:                      # hero death (ELogType=4). Fields LIVE-CRACKED 2026-06-06:
                                       # the doc (run-data-map.md:145-146) had them SWAPPED. Confirmed
                                       # over 32 live events. Strings in the "Name_<key>" format.
    KILLER_MONSTER = 0x40            # System.String* "MonsterName_<monsterKey>" (who KILLED)
    VICTIM_HERO    = 0x48            # System.String* "HeroName_<heroKey>" (who DIED)


class ResurrectionLog:                 # hero revive (ELogType=5). LIVE-CRACKED: @0x40 = the revived hero
                                       # (5 events confirmed; @0x48/@0x50 empty). Auto-revive ~115s
                                       # if another hero is alive; Priest also has a res skill.
    HERO = 0x40                      # System.String* "HeroName_<heroKey>" (the revived hero)


class CommonSaveData:
    PLAYTIME = 0x20                    # float
    CURRENT_STAGE_KEY = 0x58          # STALE/snapshot (prefer Monster.STAGE_KEY)
    CURRENT_STAGE_WAVE = 0x5C


class PlayerSaveData:                  # plaintext save, snapshot (NOT live)
    # 1.00.12 inserted BoxBucketUseBoxList/BoxBucketGetBoxList (bucket-box feature, IsBucketBox)
    # between settingSaveData and currenySaveDatas → ALL save lists shifted +0x10. Without this,
    # read_gold/read_heroes read the WRONG list → pick_live_psd None → run with heroes=[] → never closed
    # (confirmed live + dump 1.00.12; see the dump offsets).
    # 1.00.19 did it AGAIN (same break class): inserted AlchemyPendingIdList (0x38) + AlchemyReceiptList
    # (0x40) — the alchemy feature — between BoxBucketGetBoxList and currenySaveDatas, so ALL save lists
    # below shifted +0x10 once more. Offsets are PlayerSaveData TypeDefIndex 2675 in dump.cs (1.00.19).
    CURRENCIES = 0x48                  # List<CurrencySaveData>   (currenySaveDatas)
    HEROES = 0x50                      # List<HeroSaveData>       (heroSaveDatas)
    ATTRIBUTES = 0x60                  # List<AttributeSaveData> (invested skill/passive tree)
    RUNES = 0x70                       # List<RuneSaveData> — account-wide runes (LIVE-CRACKED 2026-06-09)
    INVENTORY_SLOTS = 0x78             # List<InventorySaveData> — inventory slot -> item uniqueId
    STASH = 0x80                       # List<StashSaveData> — stash slot -> item uniqueId (separate from the inv)
    ITEMS = 0xA0                       # List<ItemSaveData> (item data; the slots above reference by uniqueId)
    AGGREGATES = 0xA8                  # List<AggregateSaveData> (gold/xp oracle, stale)


class RuneSaveData:                    # invested rune node (account-wide). NAME-readable class in the save.
    KEY = 0x10                         # int runeKey (matches data/runes.json -> effect/statType per level)
    LEVEL = 0x14                       # int invested level


class InventorySaveData:               # inventory slot -> item (many empty slots = uniqueId 0)
    UNIQUE_ID = 0x18                   # ulong: points to ItemSaveData.UNIQUE_ID in PlayerSaveData.ITEMS


class StashSaveData:                   # stash slot -> item (same geometry as InventorySaveData)
    UNIQUE_ID = 0x18


class AttributeSaveData:               # invested tree node (run-data-map.md: @0x40, account-wide)
    KEY = 0x10                         # int attributeKey (matches the skill via skill-tree refKey)
    LEVEL = 0x14                       # int invested level = skill/passive level


class CurrencySaveData:
    KEY = 0x10                         # int (GOLD = GOLD_KEY)
    QUANTITY = 0x18                    # long


class AggregateSaveData:               # dump.cs:342642
    TYPE = 0x10                        # int (EAggregateType; GoldEarn=2)
    SUB_KEY = 0x14
    VALUE = 0x18                       # long (cumulative)


class HeroSaveData:
    HERO_KEY = 0x10
    LEVEL = 0x14
    EXP = 0x1C                         # float (resets on level-up; stale)
    EQUIPPED_ITEMS = 0x28             # ulong[] of UniqueIds
    EQUIPPED_SKILLS = 0x30           # int[] of SkillKeys (dump:342747)


class ItemSaveData:
    ITEM_KEY = 0x10
    UNIQUE_ID = 0x18
    ENCHANT_DATA = 0x30              # ItemEnchantSaveData[] (struct, see ItemEnchant)


class ItemEnchant:                     # struct inside ItemSaveData.ENCHANT_DATA
    STRIDE = 0x1C
    TIER = 0x4
    VALUE = 0x8
    RECIPE = 0xC                       # ERecipeType
    STAT_TYPE = 0x18                   # StatType


class ItemInfoData:                    # catalog
    ITEM_KEY = 0x30
    ITEM_TYPE = 0x34
    GRADE = 0x38                       # EGradeType
    PARTS = 0x3C                       # EItemParts (slot)
    LEVEL = 0x6C


class HeroInfoData:                    # catalog
    HERO_KEY = 0x30
    CLASS_TYPE = 0x48                  # EEquipClassType


class StageInfoData:                   # catalog (currentStageKey encodes the mode)
    STAGE_KEY = 0x30
    STAGE_TYPE = 0x40                  # EStageType (x-10 = ACTBOSS, no horde waves)
    DIFFICULTY = 0x44                  # EStageDifficulty (mode)
    ACT = 0x48
    STAGE_NO = 0x4C
    WAVE_AMOUNT = 0x54
    WAVE_MOB_AMOUNT = 0x58


# ----- hero progression runtime (reached via Unit.CACHE) -----
class HeroRuntime:                     # `uf` (uf : uo)
    INFO = 0x30                        # beew -> HeroInfoData (for HeroKey/class)
    STATS_HOLDER = 0x10                # behg -> xd (holder of the 64 stats)
    LEVEL_FAKE = 0xD8                  # befp.fakeValue = LIVE HeroLevel (PLAIN)
    EXP_FAKE = 0x118                   # beft.fakeValue = HeroExp within the level (LIVE)


class StatsHolder:                     # `xd` (dump.cs:342026)
    MODIFIER_MGR = 0x10                # betr -> uq (raw list of modifiers)
    FINAL_STATS = 0x18                # bets -> Dict<StatType,float> (64 FINAL stats; DictFloat)
    SECOND = 0x20                      # bett -> 2nd cache


class AggregateManager:                # LIVE GOLD. dump.cs:336558 named it `ut`; the obfuscated name
                                       # DRIFTS per build (nailed: became `uu`, and `ut` is now a different
                                       # class) -> do NOT resolve by name. metrics/gold.py finds it by
                                       # STRUCTURE (name-free); this OFFSET is stable. See docs/value-mapping-plan.md.
    AGGREGATES = 0x20                  # beid -> Dict<EAggregateType, Dict<SubKey,long>> (Dict8B)
    # GoldEarn[SubKey 1] = COMBAT gold (cumulative). Do NOT sum the SubKeys: SubKey 0 is the
    # TOTAL (rollup = 1+2+3) and 2/3 are noise (sale/idle/quest). Logic in metrics/gold.py.


# ----- stat-modifier system (docs/damage-model.md) -----
class StatModifier:                    # `up` (dump.cs:336258)
    STAT_TYPE = 0x10
    MOD_TYPE = 0x14                    # MODTYPE (FLAT/ADDITIVE/MULTIPLICATIVE)
    VALUE = 0x18                       # float
    MOD_SOURCE = 0x1C                  # MODSOURCE
    # fold (gbm @RVA 0x936E20): stat = (base+Σflat) × (1+Σadditive) × Π(multiplicative)


class DamageInfo:                      # struct (dump.cs:319209) — per-hit damage (transient)
    ATTACKER = 0x0
    ORIGIN_DAMAGE = 0x8
    IS_CRITICAL = 0xC
    DAMAGE_ATTRIBUTE = 0x10            # EDamageAttribute
    DAMAGE_TYPE = 0x14                 # EDamageType
    HIT_EFFECTS = 0x20


# --------------------------------------------------------------------------- #
# Enums (verbatim from dump.cs)
# --------------------------------------------------------------------------- #
class StatType(IntEnum):
    NONE = 0; AttackDamage = 1; AttackSpeed = 2; CriticalChance = 3; CriticalDamage = 4
    MaxHp = 5; Armor = 6; MovementSpeed = 7; AreaOfEffect = 8; BaseAttackCountReduction = 9
    CooldownReduction = 10; SkillRangeExpansion = 11; FireResistance = 12; ColdResistance = 13
    LightningResistance = 14; ChaosResistance = 15; DodgeChance = 16; BlockChance = 17
    MaxDodgeChance = 18; MaxBlockChance = 19; Multistrike = 20; HpLeech = 21; ProjectileCount = 22
    HpRegenPerSec = 23; PhysicalDamagePercent = 24; FireDamagePercent = 25; ColdDamagePercent = 26
    LightningDamagePercent = 27; ChaosDamagePercent = 28; MaxFireResistance = 29
    MaxColdResistance = 30; MaxLightningResistance = 31; MaxChaosResistance = 32; AddHpPerHit = 33
    DamageReduction = 34; PhysicalDamageReduction = 35; FireDamageReduction = 36
    ColdDamageReduction = 37; LightningDamageReduction = 38; ChaosDamageReduction = 39
    DamageAbsorption = 40; DamageAddition = 41; PhysicalDamageAddition = 42; FireDamageAddition = 43
    ColdDamageAddition = 44; LightningDamageAddition = 45; ChaosDamageAddition = 46
    IncreaseExpAmount = 47; AdditionalExp = 48; CastSpeed = 49; SkillHealIncrease = 50
    SkillDurationIncrease = 51; AllElementalResistance = 52; IncreaseProjectileDamage = 53
    IncreaseMeleeDamage = 54; IncreaseAreaOfEffectDamage = 55; IncreaseSummonDamage = 56
    IncreaseProjectileSpeed = 57; AddHpPerKill = 58; AddAllSkillLevel = 59
    ElementalBlockChance = 60; ElementalDodgeChance = 61; MaxElementalBlockChance = 62
    MaxElementalDodgeChance = 63


class EAggregateType(IntEnum):
    MonsterKill = 0; HeroDeath = 1; GoldEarn = 2; BoxObtain = 3; ItemObtain = 4; Synthesis = 5
    Alchemy = 6; Crafting = 7; Offering = 8; Extraction = 9; Decoration = 10; Engraving = 11
    Inscription = 12; StageClear = 13; StageFail = 14; PlayTime = 15; BoxOpen = 16


class ELogType(IntEnum):
    NONE = 0; StageClear = 1; GetItemWithBoxOpen = 2; GetBox = 3; HeroDie = 4; HeroResurrection = 5
    HeroLevelUp = 6; StageFailed = 7; SynthesisResult = 8; AlchemyResult = 9; DecorationResult = 10
    EngravingResult = 11; InscriptionResult = 12; OfferingResult = 13; CraftingResult = 14
    ExtractionResult = 15


class EMonsterLogType(IntEnum):         # dump.cs — who dropped the chest (GetBoxLog.beox @0x50)
    Monster = 0; Boss = 1; ActBoss = 2


class EDamageAttribute(IntEnum):       # dump.cs:355638
    Physical = 0; Fire = 1; Cold = 2; Lightning = 3; Chaos = 4; AllElement = 5; NONE = 6


class EDamageType(IntFlag):            # dump.cs:355651 ([Flags])
    NONE = 0; Melee = 1; Projectile = 2; AOE = 4; Summon = 8; DOT = 16; Trap = 32


class EEquipClassType(IntEnum):        # dump.cs:354930
    All = 0; Knight = 1; Ranger = 2; Sorcerer = 3; Priest = 4; Hunter = 5; Slayer = 6


class EGradeType(IntEnum):
    COMMON = 0; UNCOMMON = 1; RARE = 2; LEGENDARY = 3; IMMORTAL = 4; ARCANA = 5; BEYOND = 6
    CELESTIAL = 7; DIVINE = 8; COSMIC = 9; NONE = 10


class EItemParts(IntEnum):
    NONE = 0; MAIN_WEAPON = 1; SUB_WEAPON = 2; HELMET = 3; ARMOR = 4; GLOVES = 5; BOOTS = 6
    AMULET = 7; EARING = 8; RING = 9; BRACER = 10


class ERecipeType(IntEnum):
    ALCHEMY = 0; SYNTHESIS = 1; CRAFTING = 2; DECORATION = 3; ENGRAVING = 4; INSCRIPTION = 5
    OFFERING = 6; EXTRACTION = 7; NONE = 8


class EStageDifficulty(IntEnum):       # currentStageKey: 1xxx/2xxx/3xxx/4xxx
    Normal = 0; Nightmare = 1; Hell = 2; Torment = 3


class EStageType(IntEnum):             # StageInfoData.STAGE_TYPE (run-data-map.md:119)
    NORMAL = 0; ACTBOSS = 1


class MODTYPE(IntEnum):                # dump.cs:336237 — how the modifier enters the fold
    FLAT = 0; ADDITIVE = 1; MULTIPLICATIVE = 2


class MODSOURCE(IntEnum):              # dump.cs:336246
    BASE = 0; ITEM = 1; ATTRIBUTE = 2; PASSIVE = 3; AccountStatus = 4; StatusEffect = 5
    BuffSkill = 6; ENVIRONMENT = 7


def name_map(enum_cls):
    """{value: name} of an IntEnum — for exporting catalogs to the front (--dump-catalogs)."""
    return {m.value: m.name for m in enum_cls}
