"""
offsets.py — A BÍBLIA DE OFFSETS do TBH, num lugar só (fonte única de verdade).

De onde veio: dump IL2CPP (re/dump/dump.cs) do GameAssembly.dll v1.00.07, Unity
6000.0.72f1, estúdio TesseractStudio. TODOS os valores aqui são VALIDADOS ao vivo
(o meter rodou com eles; gold/xp cravados ±0.1%, stats batem com o save .es3).

Reconstruído de docs/run-data-map.md + tools/meter_windows.py + docs/damage-model.md.
NÃO há "calibração" (sem Cheat Engine): os managers são singletons achados em runtime
por um auto-resolver (scan de string-de-classe → Il2CppClass → instâncias; ver
il2cpp/resolver). Singletons de nome curto (ut/yp) via find_class_by_name + nn<T>.

⚠ NUNCA confundir as DUAS geometrias de entry de Dictionary (ver DictFloat vs Dict8B).
⚠ As constantes de regra de negócio (curva, filtros) NÃO moram aqui — só offsets/enums.
"""

from enum import IntEnum, IntFlag

# --------------------------------------------------------------------------- #
# Processo / build
# --------------------------------------------------------------------------- #
PROCESS_NAME = "TaskBarHero.exe"
MODULE_NAME = "GameAssembly.dll"      # toda a lógica IL2CPP vive aqui
POINTER_SIZE = 8                      # processo x64
# GAME_VERSION e SCHEMA_VERSION moram em meter_windows.py (fonte ÚNICA do runs.jsonl) — NÃO aqui.
# Tinham cópias mortas e defasadas (=5 enquanto o runtime emitia 11); o drift-test
# (test_docs_consistency::test_version_constants_unique) agora falha se reaparecerem.
GOLD_KEY = 100001                     # CurrencySaveData.Key do ouro


# --------------------------------------------------------------------------- #
# Layout de runtime IL2CPP (x64)
# --------------------------------------------------------------------------- #
class Obj:
    KLASS = 0x0                        # todo objeto gerenciado: ponteiro p/ Il2CppClass


class String:
    LENGTH = 0x10                      # System.String: int length
    CHARS = 0x14                       # utf-16


class Array:                           # Il2CppArray (T[])
    MAX_LENGTH = 0x18
    DATA = 0x20                        # elementos começam aqui (8B/ptr no x64)


class List:                            # System.Collections.Generic.List<T>
    ITEMS = 0x10                       # ponteiro p/ array interno
    SIZE = 0x18


class Dict:                            # Dictionary<K,V>: campos comuns
    ENTRIES = 0x18                     # _entries (Entry[])
    COUNT = 0x20                       # _count
    DATA = 0x20                        # início dos dados do array de entries


class DictFloat:
    """Entry de Dict com VALOR de 4 bytes (ex.: Dict<StatType,float> = 64 stats)."""
    STRIDE = 0x10
    HASH = 0x0                         # skip se < 0 (tombstone)
    NEXT = 0x4
    KEY = 0x8                          # int32
    VALUE = 0xC                        # float32


class Dict8B:
    """Entry de Dict com VALOR de 8 bytes — long OU ponteiro (ex.: Dict<int,long>
    do gold; Dict<EAggregateType,Dict> externo). value@0x10 por alinhamento de 8.
    *** NÃO confundir com DictFloat (stride 0x10/val 0xC) — corromperia gold/stats. ***"""
    STRIDE = 0x18
    HASH = 0x0
    NEXT = 0x4
    KEY = 0x8                          # int32
    VALUE = 0x10                       # int64 OU ponteiro


class Class:                           # Il2CppClass (il2cpp.h)
    NAME = 0x10                        # const char* (nome da classe)
    ELEMENT_CLASS = 0x40               # == K p/ classe normal (validação do resolver)
    CAST_CLASS = 0x48                  # == K idem
    PARENT = 0x58                      # superclasse (p/ chegar em nn<T>)
    STATIC_FIELDS = 0xB8               # bloco de campos estáticos (sizeof Il2CppClass_1)


class Singleton:
    """nn<a> : MonoBehaviour (TypeDefIndex 2350) — base de singleton genérico.
    A instância viva mora em `static a bbwf` @ STATIC_FIELDS + INSTANCE.
    Pra Foo:nn<Foo> -> klass(Foo).PARENT (= nn<Foo>) -> STATIC_FIELDS -> INSTANCE."""
    INSTANCE = 0x0                     # bbwf (o singleton)


# ACTk Obscured (esta build): o valor REAL é o `fakeValue` PLANO em base+0xC
# (ObscuredInt/Float). hidden^key dá LIXO. ObscuredLong: fake provavelmente @+0x18.
ACTK_FAKE = 0xC


# --------------------------------------------------------------------------- #
# Offsets de campos por classe (dump.cs) — todos VALIDADOS ao vivo
# --------------------------------------------------------------------------- #
class Unit:                            # base de Hero/Monster (dump.cs ~319277)
    HEALTH_CONTROLLER = 0xB0           # -> UnitHealthController
    IS_HERO = 0x100                    # bool b_isHero
    CACHE = 0x3A8                      # Hero.cache -> uf (wrapper de progressão). 1.00.14 inseriu
                                       # `Action OnCrowdControlAppliedAction` @0x3A0 no FIM de Unit
                                       # (base cresceu +0x8) -> Hero.cache 0x3A0->0x3A8; TODO campo de
                                       # subclasse de Unit deslocou +0x8 (Monster idem, abaixo).
    CORE_STATS_OBSCURED = 0x104        # 12 stats core: ObscuredFloat (XOR) — NÃO LER (lixo); use
                                       # xd.FINAL_STATS (Dict<StatType,float> PLAIN). Marcador p/
                                       # docs/invariants/obscured-data-offlimits (test_obscured_markers).


class UnitHealthController:            # HP em float PURO (dump.cs ~319894)
    HP_CURRENT = 0x40                  # VALIDADO (cai ao tomar dano); dano = Σ quedas
    HP_MAX = 0x4C


class Monster:                         # extends Unit -> herdou o +0x8 do 1.00.14 (ver Unit.CACHE)
    STAGE_KEY = 0x3D4                  # stageKey VIVO (o do save congela na troca). 1.00.14: 0x3CC->0x3D4.
                                       # ⚠ diff_offsets deu FALSO-OK (campo nome-ofuscado, só checa
                                       # adjacência -> deslocamento +0x8 uniforme passa) — pego no dump.cs
                                       # vs baseline 1.00.13; confirmar no validate_live (stage).
    CACHE_OBSCURED = 0x3B8             # cache Obscured — NÃO LER; use os campos PLAIN do Monster.
                                       # 1.00.14: 0x3B0->0x3B8. Marcador p/ docs/invariants/obscured-data-offlimits.


class StageManager:                    # singleton (dump.cs ~327247)
    HERO_LIST = 0x30                   # Hero[] = party deployada ao vivo


class MonsterSpawnManager:             # singleton (dump.cs ~343052)
    MONSTER_LIST = 0x28               # List<Unit> vivos
    DEAD_MONSTER_LIST = 0x30          # List<Unit> mortos (cai no reload do mesmo stage)
    SUMMONED_LIST = 0x38


class LogManager:                      # singleton (dump.cs ~339652)
    LOG_LIST = 0x20                    # List<LogData> (boundary de run = size cresce)
    LOG_BY_TYPE = 0x28                 # Dictionary<ELogType, List<LogData>>


class StageClearLog:                   # sucesso
    ACT = 0x40
    STAGE = 0x44
    CLEAR_TIME = 0x48                  # int (segundos oficiais)
    IS_BOSS = 0x4C


class StageFailedLog:                  # falha
    ACT = 0x40
    STAGE = 0x44
    NOW_WAVE = 0x48
    TOTAL_WAVE = 0x4C
    IS_ACT_BOSS = 0x50


class GetBoxLog:                       # drop de baú (ELogType=3). LIVE-CRACKED 2026-06-06.
    BOX_KEY      = 0x40               # System.String* do TIPO: "TreasureChest_Monster|StageBoss|
                                       # ActBoss" (NÃO é item key!). Classifique o tier por MONSTER_TYPE.
    MONSTER_KEY  = 0x48               # System.String* "MonsterName_<key>" (bicho que dropou)
    MONSTER_TYPE = 0x50               # int (EMonsterLogType: Monster=0, Boss=1, ActBoss=2) = tier do baú


class HeroDieLog:                      # morte de herói (ELogType=4). Campos LIVE-CRACKED 2026-06-06:
                                       # a doc (run-data-map.md:145-146) os tinha TROCADOS. Confirmado
                                       # em 32 eventos ao vivo. Strings no formato "Nome_<key>".
    KILLER_MONSTER = 0x40            # System.String* "MonsterName_<monsterKey>" (quem MATOU)
    VICTIM_HERO    = 0x48            # System.String* "HeroName_<heroKey>" (quem MORREU)


class ResurrectionLog:                 # revive de herói (ELogType=5). LIVE-CRACKED: @0x40 = revivido
                                       # (5 eventos confirmados; @0x48/@0x50 vazios). Auto-revive ~115s
                                       # se houver outro herói vivo; Priest tb tem skill de ress.
    HERO = 0x40                      # System.String* "HeroName_<heroKey>" (revivido)


class CommonSaveData:
    PLAYTIME = 0x20                    # float
    CURRENT_STAGE_KEY = 0x58          # DEFASADO/snapshot (preferir Monster.STAGE_KEY)
    CURRENT_STAGE_WAVE = 0x5C


class PlayerSaveData:                  # save plaintext, snapshot (NÃO vivo)
    # 1.00.12 inseriu BoxBucketUseBoxList/BoxBucketGetBoxList (feature bucket-box, IsBucketBox)
    # entre settingSaveData e currenySaveDatas → TODAS as listas do save deslocaram +0x10. Sem isto
    # read_gold/read_heroes liam a lista ERRADA → pick_live_psd None → run com heroes=[] → não subia
    # (confirmado vivo + dump 1.00.12; ver offsets do dump).
    CURRENCIES = 0x38                  # List<CurrencySaveData>   (currenySaveDatas)
    HEROES = 0x40                      # List<HeroSaveData>       (heroSaveDatas)
    ATTRIBUTES = 0x50                  # List<AttributeSaveData> (árvore de skills/passivas investida)
    RUNES = 0x60                       # List<RuneSaveData> — runas account-wide (LIVE-CRACKED 2026-06-09)
    INVENTORY_SLOTS = 0x68             # List<InventorySaveData> — slot do inventário -> item uniqueId
    STASH = 0x70                       # List<StashSaveData> — slot do stash -> item uniqueId (separado do inv)
    ITEMS = 0x90                       # List<ItemSaveData> (dados dos itens; slots acima referenciam por uniqueId)
    AGGREGATES = 0x98                  # List<AggregateSaveData> (oráculo gold/xp, defasado)


class RuneSaveData:                    # nó de runa investido (account-wide). Classe NAME-legível no save.
    KEY = 0x10                         # int runeKey (casa com data/runes.json -> efeito/statType por nível)
    LEVEL = 0x14                       # int nível investido


class InventorySaveData:               # slot do inventário -> item (muitos slots vazios = uniqueId 0)
    UNIQUE_ID = 0x18                   # ulong: aponta pro ItemSaveData.UNIQUE_ID em PlayerSaveData.ITEMS


class StashSaveData:                   # slot do stash -> item (mesma geometria do InventorySaveData)
    UNIQUE_ID = 0x18


class AttributeSaveData:               # nó investido da árvore (run-data-map.md: @0x40, account-wide)
    KEY = 0x10                         # int attributeKey (casa com a skill via skill-tree refKey)
    LEVEL = 0x14                       # int nível investido = nível da skill/passiva


class CurrencySaveData:
    KEY = 0x10                         # int (OURO = GOLD_KEY)
    QUANTITY = 0x18                    # long


class AggregateSaveData:               # dump.cs:342642
    TYPE = 0x10                        # int (EAggregateType; GoldEarn=2)
    SUB_KEY = 0x14
    VALUE = 0x18                       # long (cumulativo)


class HeroSaveData:
    HERO_KEY = 0x10
    LEVEL = 0x14
    EXP = 0x1C                         # float (zera no level-up; defasado)
    EQUIPPED_ITEMS = 0x28             # ulong[] de UniqueIds
    EQUIPPED_SKILLS = 0x30           # int[] de SkillKeys (dump:342747)


class ItemSaveData:
    ITEM_KEY = 0x10
    UNIQUE_ID = 0x18
    ENCHANT_DATA = 0x30              # ItemEnchantSaveData[] (struct, ver ItemEnchant)


class ItemEnchant:                     # struct dentro de ItemSaveData.ENCHANT_DATA
    STRIDE = 0x1C
    TIER = 0x4
    VALUE = 0x8
    RECIPE = 0xC                       # ERecipeType
    STAT_TYPE = 0x18                   # StatType


class ItemInfoData:                    # catálogo
    ITEM_KEY = 0x30
    ITEM_TYPE = 0x34
    GRADE = 0x38                       # EGradeType
    PARTS = 0x3C                       # EItemParts (slot)
    LEVEL = 0x6C


class HeroInfoData:                    # catálogo
    HERO_KEY = 0x30
    CLASS_TYPE = 0x48                  # EEquipClassType


class StageInfoData:                   # catálogo (currentStageKey codifica o modo)
    STAGE_KEY = 0x30
    STAGE_TYPE = 0x40                  # EStageType (x-10 = ACTBOSS, sem waves de horda)
    DIFFICULTY = 0x44                  # EStageDifficulty (modo)
    ACT = 0x48
    STAGE_NO = 0x4C
    WAVE_AMOUNT = 0x54
    WAVE_MOB_AMOUNT = 0x58


# ----- runtime de progressão do herói (chegado via Unit.CACHE) -----
class HeroRuntime:                     # `uf` (uf : uo)
    INFO = 0x30                        # beew -> HeroInfoData (p/ HeroKey/classe)
    STATS_HOLDER = 0x10                # behg -> xd (holder dos 64 stats)
    LEVEL_FAKE = 0xD8                  # befp.fakeValue = HeroLevel VIVO (PLANO)
    EXP_FAKE = 0x118                   # beft.fakeValue = HeroExp dentro do nível (VIVO)


class StatsHolder:                     # `xd` (dump.cs:342026)
    MODIFIER_MGR = 0x10                # betr -> uq (lista crua de modificadores)
    FINAL_STATS = 0x18                # bets -> Dict<StatType,float> (64 stats FINAIS; DictFloat)
    SECOND = 0x20                      # bett -> 2º cache


class AggregateManager:                # GOLD VIVO. dump.cs:336558 nomeava `ut`; o nome ofuscado
                                       # DRIFTA por build (cravado: virou `uu`, e `ut` agora é outra
                                       # classe) -> NÃO resolver por nome. metrics/gold.py acha por
                                       # ESTRUTURA (name-free); este OFFSET é estável. Ver docs/value-mapping-plan.md.
    AGGREGATES = 0x20                  # beid -> Dict<EAggregateType, Dict<SubKey,long>> (Dict8B)
    # GoldEarn[SubKey 1] = gold de COMBATE (cumulativo). NÃO somar os SubKeys: o SubKey 0 é o
    # TOTAL (rollup = 1+2+3) e 2/3 são ruído (venda/idle/quest). Lógica em metrics/gold.py.


# ----- sistema de modificadores de stat (docs/damage-model.md) -----
class StatModifier:                    # `up` (dump.cs:336258)
    STAT_TYPE = 0x10
    MOD_TYPE = 0x14                    # MODTYPE (FLAT/ADDITIVE/MULTIPLICATIVE)
    VALUE = 0x18                       # float
    MOD_SOURCE = 0x1C                  # MODSOURCE
    # fold (gbm @RVA 0x936E20): stat = (base+Σflat) × (1+Σaditivo) × Π(multiplicativo)


class DamageInfo:                      # struct (dump.cs:319209) — dano por hit (transiente)
    ATTACKER = 0x0
    ORIGIN_DAMAGE = 0x8
    IS_CRITICAL = 0xC
    DAMAGE_ATTRIBUTE = 0x10            # EDamageAttribute
    DAMAGE_TYPE = 0x14                 # EDamageType
    HIT_EFFECTS = 0x20


# --------------------------------------------------------------------------- #
# Enums (verbatim do dump.cs)
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


class EMonsterLogType(IntEnum):         # dump.cs — quem dropou o baú (GetBoxLog.beox @0x50)
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


class MODTYPE(IntEnum):                # dump.cs:336237 — como o modificador entra no fold
    FLAT = 0; ADDITIVE = 1; MULTIPLICATIVE = 2


class MODSOURCE(IntEnum):              # dump.cs:336246
    BASE = 0; ITEM = 1; ATTRIBUTE = 2; PASSIVE = 3; AccountStatus = 4; StatusEffect = 5
    BuffSkill = 6; ENVIRONMENT = 7


def name_map(enum_cls):
    """{valor: nome} de um IntEnum — pra exportar catálogos pro front (--dump-catalogs)."""
    return {m.value: m.name for m in enum_cls}
