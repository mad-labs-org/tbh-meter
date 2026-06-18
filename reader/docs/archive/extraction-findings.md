---
type: archive
status: superseded
description: "Historical SNAPSHOT (raw RE or delivered plan) — names/offsets/lines may be stale; current truth lives in the living notes (see _index). Exempt from the code drift-test."
---

> **HISTORICAL — RAW 9-domain RE findings (2026-06-02).** This is the raw multi-agent output that fed `extraction-spec.md` (the verified consolidation) and ultimately `config/offsets.py` (the live source of truth). LLM generation chatter is interleaved between domain sections. Where this disagrees with `extraction-spec.md` / `offsets.py`, THEY win — notably the "`SaveContainer`" save-root claimed in the Equipment domain below does NOT exist; the root is `PlayerSaveData` (offsets confirmed: `itemSaveDatas@0x80`, `heroSaveDatas@0x30`). `dump.cs` line numbers are from the external Il2CppDumper output for GameAssembly.dll v1.00.07 (not committed).

The `nn<a>` singleton base has a `private static a bbwf @0x0` (the singleton instance, per-generic-instantiation static storage) and property `brca` (Instance getter). Since the meter already resolves StageManager (which extends `nn<StageManager>`) by scanning for instances via the class pointer, the **same instance-scan technique works for `yp`** — no need to read the static field. This is fully consistent with the established method.

I have everything verified. Let me compose the final answer.

## DOMAIN: Composition (party / active heroes and their classes)

**Read-only feasible:** yes — `StageManager.HeroList` gives the active `Hero`s; each `Hero` points to a data-model (`uf cache`) holding the `HeroInfoData`, which yields `HeroKey` (identity) and `ClassType`=`EEquipClassType` (the class/job). All pointers/ints/enums, uncrypted.

**Classes:**
- `Hero : Unit` (318755) — in-battle hero instance (comes from `StageManager.HeroList`)
- `Unit` (319277) — abstract base of Hero/Monster; `b_isHero@0x100` distinguishes them
- `uf : uo` (335005) — **hero data-model/context**; `Hero.cache@0x3A0` points here; links the instance to save+info
- `HeroInfoData : ze` (354702) — per-hero static data (identity + class + base stats); built from CSV (`ClassMap<HeroInfoData> zb`)
- `HeroSaveData` (342729) — per-hero save (heroKey, level, items); persisted to disk
- `yp : nn<yp>` (352341) — "Data manager" singleton; `heroKey -> HeroInfoData` table (alternate lookup route)
- `nn<a>` (315606) — singleton base (same pattern as StageManager): instance in `static a@0x0`, getter `brca`
- `EEquipClassType` (354930) — **the hero class/job enum** (verified)
- `EHeroType` (354688) — legacy enum Knight/Archer/Wizard/Priest/Hunter/Barbarian; **NOT used as a field anywhere** (grep empty) — ignore, not the real class

**Key fields:**
- `StageManager.HeroList` @0x30 (`Hero[]`) — array of the run's heroes (party 1–3) [already resolved]
- `Hero.cache` @0x3A0 (`uf`) — pointer to the hero data-model
- `uf.beew` @0x30 (`HeroInfoData`) — direct pointer to the hero's static info (private, but readable by offset)
- `uf.befh` @0x88 (`Hero`) — back-reference to the `Hero` (handy for matching instance↔model)
- `HeroInfoData.HeroKey` @0x30 (int) — **hero identity**
- `HeroInfoData.ClassType` @0x48 (`EEquipClassType`) — **the hero's CLASS/JOB**
- `HeroInfoData.HeroNameKey` @0x38 (string) — name localization key (not the literal name)
- `HeroInfoData.MainWeaponGearType` @0x4C / `SubWeaponGearType` @0x50 (`EGearType`) — weapons
- `HeroInfoData.SkillKey` @0x54 (int) — hero skill
- `HeroSaveData.heroKey` @0x10 (int) — identity in the save [already resolved]
- `yp.bfin` @0xA8 (`Dictionary<int,HeroInfoData>`) — heroKey->info map; getter `yp.jfg(int)` (352576)
- No field in this domain is OBSCURED. heroKey/ClassType are int/enum in cleartext. (The `Obscured*` fields on `uf` @0xC0+ and `Unit` @0x104+ are stats/flags, outside this domain.)

**Enums:**
- `EEquipClassType` (354930) — verified by grep: `All=0, Knight=1, Ranger=2, Sorcerer=3, Priest=4, Hunter=5, Slayer=6`
- `EHeroType` (354688) — verified: `Knight=0, Archer=1, Wizard=2, Priest=3, Hunter=4, Barbarian=5` — **orphan enum, mapped to no field; do NOT use**

**Read-only resolution:**
1. Resolve `StageManager` (singleton) as we already do → read `HeroList @0x30` (`Hero[]`): array header at `data@0x20`, `_size`/length in the Il2CppArray header; iterate the `Hero` pointers.
2. For each `Hero`: read `cache @0x3A0` → `uf` pointer. (Optional sanity-check: `Unit.b_isHero @0x100 == true`.)
3. From `uf`: read `beew @0x30` → `HeroInfoData` pointer.
4. From `HeroInfoData`: read `HeroKey @0x30` (int = identity) and `ClassType @0x48` (int = `EEquipClassType` → map to a name via the enum table above).
5. (Alternate validation route) find the `yp` singleton by instance-scan (same technique as StageManager, class `yp`), read `bfin @0xA8` and index by heroKey — should return the same `HeroInfoData`.

**Gotchas / confidence:**
- **High confidence** in the chain `Hero.cache(uf)@0x3A0 -> HeroInfoData@0x30 -> {HeroKey@0x30, ClassType@0x48}`. `cache@0x3A0` is explicit in the dump (318758); `uf.beew@0x30` is `HeroInfoData` (335008); HeroInfoData offsets read directly (354705/354708).
- The correct class/job is **`EEquipClassType`** (has Ranger/Sorcerer/Slayer), not `EHeroType`. Confirmed by grep that `EHeroType` is no class's field — don't fall into that trap.
- `HeroInfoData` is **STATIC data** (game table), not UI state nor history — reliable as the source of truth for identity+class.
- `HeroNameKey@0x38` is a **localization key**, not the displayed name; for a readable name you must resolve the string table (outside this domain). For the meter, `HeroKey`+`ClassType` already suffice for identity+job.
- `uf.beew` is `private` — irrelevant for reading by offset (we read memory directly), but confirms there's no simple public getter; use offset 0x30.
- Low residual risk: if some `Hero` shows up with `cache==null` (hero in transient spawn/death), fall back to Route B (heroKey via another source) or skip. Recommend a one-off runtime cross-check: for 1 known hero, confirm the read `ClassType` matches the class seen in-game before trusting it 100%.

=====================

Fully confirmed. `STAGEDIFFICULTY` is a plain `int32_t` at offset 0x44, no Obscured wrapper. The whole chain is readable. Note `ze_Fields` is the base (CsvHelper-mapped data base, likely empty/header) so the @0x30 start for `StageKey` lines up with the dump offsets. I have everything needed.

## DOMAIN: Difficulty-Mode (Normal / Nightmare / Hell / Torment)

**Read-only feasible:** yes — the in-game stage difficulty lives as a plain `int32_t` (NOT Obscured) in `StageInfoData.STAGEDIFFICULTY@0x44`, reachable from the static hub `ud.tv`, which is already the same kind of thing we've resolved.

**Classes:**
`ESTAGEDIFFICULTY` (dump.cs:355843) — the mode enum (TypeDefIndex 3265)
`ud.tv` (dump.cs:333405, static class) — stage-data hub; static field `bebq` points to the current StageCache
`ud.StageCache` (dump.cs:333851) — wrapper of one stage (wraps a `StageInfoData`); exposes difficulty via `izu()`/`brmv`
`StageInfoData` (dump.cs:355865) — raw stage data (CSV-mapped); contains a readable `STAGEDIFFICULTY`
`UI_Portal` (dump.cs:350337) — portal selection SCREEN; holds the difficulty CHOSEN in the dropdown (UI-state, see gotchas)
`ud.tv.tt`/`ud.tv.tu` (dump.cs:333387/333405) — LINQ closures that filter StageCache by difficulty; NOT state, ignore

**Key fields:**
`ud.tv.bebq` @0x88 (ud.StageCache*, **STATIC field** — in `static_fields`, il2cpp.h:88462) — the current stage's StageCache; may be null outside battle
`ud.StageCache.bebu` @0x10 (StageInfoData*) — the stage's StageInfoData; readonly, set in the .ctor
`StageInfoData.STAGEDIFFICULTY` @0x44 (int32 = ESTAGEDIFFICULTY) — **the difficulty. NOT OBSCURED** (confirmed in il2cpp.h:108288, `int32_t STAGEDIFFICULTY`)
`StageInfoData.StageKey` @0x30 (int32) — stage key; matches `CommonSaveData.currentStageKey@0x58` (alternate route)
`UI_Portal.m_currentStageDifficulty` @0xB8 (int32 = ESTAGEDIFFICULTY) — difficulty selected in the portal dropdown (UI-state, NOT authoritative during battle)

**Enums:**
`ESTAGEDIFFICULTY` (dump.cs:355843, TypeDefIndex 3265): NORMAL=0, NIGHTMARE=1, HELL=2, TORMENT=3, COUNT=4 [VERIFIED by grep — note the order: Nightmare(1) comes before Hell(2); and COUNT=4 is a sentinel, not a mode]

**Read-only resolution (from what we've already resolved):**
Unlike StageManager/CommonSaveData, the difficulty is NOT in an ordinary instance singleton — it lives in a static class field. Two routes:

Route A (authoritative, current stage in battle):
1. Find the Il2CppClass of `ud.tv` by scanning (but the name is just the obfuscated "ud/tv" and the class string is `tv` — hard to locate by name string). More robust: get `ud.tv` via an already-known reference — any instantiated StageCache points to its class; but the clean entry point is the static field.
2. From the Il2CppClass of `ud.tv`, read the `static_fields` pointer (in the class header; layout `Il2CppClass_1 _1; void* static_fields;` — `static_fields` sits right after the `_1` block). Inside `static_fields`, offset @0x88 = `bebq` (pointer to the current StageCache).
3. If `bebq != null`: read `bebu@0x10` (StageInfoData*).
4. Read `STAGEDIFFICULTY@0x44` of that StageInfoData → int → map via the enum above.

Route B (easier to implement, we already have the piece): start from `CommonSaveData.currentStageKey@0x58` (ALREADY resolved). The difficulty is NOT in the save, but the `StageKey` encodes/indexes the stage; `ud.tv.bebk` (Dictionary<int,StageCache>@0x40 in static_fields) and the methods `cmb(int)`/`hvd(int)` (dump.cs:333460/333466) map StageKey→StageCache. For pure read-only without calling methods, scan the `bebk` Dictionary for the entry whose StageInfoData.StageKey == currentStageKey and read its `STAGEDIFFICULTY@0x44`. (More work; Route A with `bebq` is direct when there's an active stage.)

**Gotchas / confidence:**
- `ud.tv` is a STATIC class — the difficulty is NOT in an instance object scannable by the class-pointer@0x0 like Hero/Unit. You must read the Il2CppClass's `static_fields` (same mechanism as any static-field read). Locating the `ud.tv` class by name string can be annoying (short obfuscated name "tv"); an alternative is reaching it via the `klass` of an instantiated `ud.StageCache` (the StageCache's castClass@0x48, then climb to the static field — or just resolve `ud.StageCache` by name and read its class, but `bebq` is static on `ud.tv`, not on StageCache).
- `bebq@0x88` may be **null** outside battle (in the menu/portal). When null, use Route B (currentStageKey → lookup) or read `UI_Portal.m_currentStageDifficulty@0xB8`.
- `UI_Portal.m_currentStageDifficulty@0xB8` is **UI STATE/HISTORY** — it's what the dropdown shows on the selection screen, not necessarily what's running. It's only reliable when the portal is open. Not a persistent counter. NOT Obscured.
- NO field in the difficulty domain is Obscured — `STAGEDIFFICULTY@0x44` and `m_currentStageDifficulty@0xB8` are plain int32. (The many `ObscuredInt/Float` fields neighboring `StageCache`/`StageInfoData` are balancing stats — HP/gold/exp multipliers etc. — NOT the difficulty.)
- The difficulty is NOT in `StageManager` nor `CommonSaveData` (both read and confirmed to have no difficulty field — dump.cs:327247 and 328578). Whoever gets this wrong and searches there won't find it.
- Confidence: **high** in the enum (verified), in the offsets (cross-checked dump.cs + il2cpp.h: bebq@0x88, bebu@0x10, STAGEDIFFICULTY@0x44, non-Obscured), and in UI_Portal being UI-state. **Medium** in the ergonomics of locating the static class `ud.tv` at runtime (not tested by us yet; it's the only new step vs. the already-working instance method).

=====================

Confirmed. Gold lives only in the currency list, not in CommonSaveData. I have everything needed for a complete, evidence-backed answer.

## DOMAIN: gold-currency (currency / Gold)

**Read-only feasible:** partial — persistent GOLD is readable in cleartext (`CurrencySaveData.Quantity`), but the "live" runtime GOLD is `ObscuredLong` (requires XOR); the GoldEarn aggregate is in cleartext in a singleton Dictionary.

**Classes:**
- `CurrencySaveData` (342713) — persistent {Key,Quantity} pair per currency; serialized to JSON
- `CurrencyInfoData : ze` (354239) — data-driven currency metadata (CurrencyKey, name, initial amount, icon); loaded from a table via `yv : ClassMap<CurrencyInfoData>` (354275)
- `PlayerSaveData` (328698) — save root; holds the currency list and the aggregate list
- `ud.su` (330322) — RUNTIME wrapper of a currency (value/key in Obscured fields); currency base
- `xg : ud.su` (342629) — CONCRETE GOLD subclass (the only one overriding `iko(long, EGoldCurrencySource)`, 342637) — runtime Gold discriminator
- `ud.st` (330276) — static registry of runtime currencies: `List<ud.su> bdwi` @0x0 and `Dictionary<int,ud.su> bdwj` @0x8 (key = CurrencyKey)
- `ut : nn<ut>` (336558) — **AggregateManager** (singleton `nn<>`, same pattern as StageManager); holds live GoldEarn
- `AggregateSaveData` (342642) — persistent aggregate entry {Type,SubKey,Value}
- `ry` (328384) — analytics string registry (`total_gold_earned`, etc.) — NOT a counter

**Key fields:**
- `CurrencySaveData.Key` @0x10 (int) — currency's CurrencyKey (data-driven; see Gotchas)
- `CurrencySaveData.Quantity` @0x18 (long) — persisted quantity of the currency — **clean source of current GOLD**
- `PlayerSaveData.currenySaveDatas` @0x28 (List<CurrencySaveData>) — persistent currency list (sic: "curreny")
- `PlayerSaveData.aggregateSaveDatas` @0x88 (List<AggregateSaveData>) — persisted aggregates
- `CurrencyInfoData.CurrencyKey` @0x30 (int) — currency id; `CurrencyNameStringKey` @0x38 (string)
- `ud.su.bdwk` @0x10 (CurrencyInfoData) — runtime currency metadata
- `ud.su.bdwn` @0x28 (ObscuredLong) **(OBSCURED)** — live currency value (getter `briy`/`ikl()`)
- `ud.su.bdwo` @0x48 (ObscuredInt) **(OBSCURED)** — live currency key (getter `briz`/`ikm()`)
- `ut.beid` @0x20 (Dictionary<EAggregateType, Dictionary<int,long>>) — live aggregate store; **GoldEarn = beid[2]** (cleartext long, NOT obscured)
- `ut.OnAggregateChanged` @0x28 (Action) — callback
- `AggregateSaveData.Type` @0x10 (int=EAggregateType), `.SubKey` @0x14 (int), `.Value` @0x18 (long) — persisted GoldEarn = entries with Type==2

**Enums:**
- `EAggregateType` (336661): MonsterKill=0, HeroDeath=1, **GoldEarn=2**, BoxObtain=3, ItemObtain=4, Synthesis=5, Alchemy=6, Crafting=7, Offering=8, Extraction=9, Decoration=10, Engraving=11, Inscription=12, StageClear=13, StageFail=14, PlayTime=15, BoxOpen=16 [VERIFIED]
- `EGoldCurrencySource` (334995): MonsterKill=1, CubeAlchemy=2, OfflineReward=3 [VERIFIED] (used only by the Gold currency `xg`)
- `ECurrencyType` does NOT exist: CurrencyKey is a data-driven int (`CurrencyInfoData` table), no constants enum [VERIFIED by grep — no ECurrency enum / gold-key literal]

**Read-only resolution:**
1. Persistent GOLD (recommended, cleartext): scan the `CurrencySaveData` class (string "CurrencySaveData" -> Il2CppClass), find the instance/list. The stable path is via `PlayerSaveData.currenySaveDatas` (List@0x28 -> items@0x10/_size@0x18). For each `CurrencySaveData`: read `Key`@0x10 and `Quantity`@0x18. Gold = the entry whose Key matches Gold's CurrencyKey (discover empirically: it's the large currency that grows on monster kills; typically the first/smallest Key).
2. GoldEarn (total earned, cleartext): resolve the `ut` singleton like StageManager (scan the "ut" class -> instance via klass@0x0). Read `beid`@0x20 (Dictionary). Take the bucket for enum key 2 (GoldEarn) -> inner `Dictionary<int,long>`; the `long`(s) are cleartext. Use `mbr`/`mgn(EAggregateType,int)` as the aggregation reference (they sum by SubKey).
3. Live GOLD (alternative, OBSCURED): scan the `xg` class (Gold subclass) -> instance -> `bdwn`@0x28 (ObscuredLong). For the real value apply the ACTk XOR (hiddenValue XOR currentCryptoKey from the instance itself). Same for `bdwo`@0x48 (ObscuredInt) = key.

**Gotchas / confidence:**
- **CRYPTO:** the runtime currency value (`ud.su.bdwn`/`bdwo`) is Obscured (ACTk) — reading the `ObscuredLong` directly gives garbage without the XOR. Prefer `CurrencySaveData.Quantity` (plain long), which gives the same number without crypto. The GoldEarn aggregate (`ut.beid[2]`) is a PLAIN long (not obscured). **High confidence.**
- **GOLD KEY is data-driven, not an enum:** there's no hardcoded constant for Gold's key (confirmed: zero gold-currency-key literals; `CurrencyInfoData` table via `ClassMap`). The robust runtime Gold discriminator is the TYPE `xg` (only currency with `iko(...,EGoldCurrencySource)`). In the save you identify the key empirically (1 read observing which Quantity rises on a monster kill). **Medium confidence** in the Key->Gold mapping until confirmed live.
- **UI vs persistent:** `ry.total_gold_earned` is an analytics event name (string), NOT a counter — ignore. The real persistent "gold earned" counter is `EAggregateType.GoldEarn=2` (live in `ut.beid` / `aggregateSaveDatas` Type==2 on disk). **High confidence.**
- CommonSaveData has NO gold field (verified) — gold exists only in the currency list. The save field name has a typo: `currenySaveDatas` (one "r"). **High confidence.**
- `ut` is an `nn<>` singleton (static instance @0x0 on the class); resolve by instance scan (klass@0x0) as already done for StageManager, don't try to read the static field directly.

=====================

I now have a complete, verified picture. `AccountSaveData` has NO account XP (only playerId, version, playTime, session). The other `Exp` JsonProperty belongs to `CubeLevelSaveData` (the Cube system — separate from hero XP, but worth noting). All data confirmed. Writing the final answer.

## DOMAIN: xp

**Read-only feasible:** yes — `HeroSaveData.HeroExp(float)@0x1C` and `HeroLevel(int)@0x14` are PLAIN fields (not Obscured), in the same save-root (`PlayerSaveData`) we already resolved for Common/Currency. The global curve is readable via master-data. Per-run XP delta = periodic read of the (level, exp) pair.

**Classes:**
- `PlayerSaveData` (328698) — persistent save-root; `heroSaveDatas: List<HeroSaveData>@0x30`, `commonSaveData@0x10`, `currenySaveDatas@0x28` (same object we already read Common/Currency from)
- `HeroSaveData` (342729) — persistent per-hero XP/level (PLAIN, JsonProperty)
- `yp : nn<yp>` (352341) — master-data MonoBehaviour singleton (InfoData tables); holds the XP curve
- `LevelInfoData` (355194) — row of the hero's global XP curve: `Level@0x10`, `ExpForLevelUp@0x14` (int)
- `HeroInfoData : ze` (354702) — hero base config (stats); does NOT contain XP/curve/maxlevel
- `uf : uo` (335005) — RUNTIME hero wrapper `.ctor(HeroSaveData, HeroInfoData)`; mirrors level/exp in Obscured fields (do NOT use)
- `AccountSaveData` (328529) — account; confirmed to have NO account XP/level
- `CubeLevelSaveData` (342679) — Cube system (separate): `Level@0x10`, `Exp(float)@0x14` — NOT hero XP
- `HeroLevelUpLog : LogData` (339447) — UI log only (heroNameKey, heroLevel); NOT a counter

**Key fields:**
- `HeroSaveData.heroKey` @0x10 (int) — which hero
- `HeroSaveData.HeroLevel` @0x14 (int) — current level **[PLAIN]**
- `HeroSaveData.HeroExp` @0x1C (float) — XP accumulated **within the current level** (resets on level-up; see curve) **[PLAIN]**
- `HeroSaveData.IsUnLock` @0x18 (bool), `AbilityPoint` @0x20 (int) — context
- `PlayerSaveData.heroSaveDatas` @0x30 (List<HeroSaveData>) — persistent list (items@0x10/_size@0x18)
- `LevelInfoData.Level` @0x10 (int) / `LevelInfoData.ExpForLevelUp` @0x14 (int) — XP needed to clear **that** level
- `yp.bfil` @0x88 (Dictionary<int,LevelInfoData>) — level→curve map; accessor `blm(int)`@352438
- `uf.befp/befq/befr/befs` @0xCC/0xDC/0xEC/0xFC (ObscuredInt) **(OBSCURED)** and `uf.beft` @0x10C (ObscuredFloat) **(OBSCURED)** — runtime mirror of level/exp; AVOID, use HeroSaveData

**Enums:** `EAccountStatus` (341805) [VERIFIED] — modifiers that affect XP gain (not XP itself): IncreaseExpAmount=2, AdditionalExp=3, CubeExpPercent=11, AdditionalExpStageBoss=22, AdditionalExpActBoss=23, AdditionalExpNormalMonster=24, OfflineRewardExpPercent=41. No "level" enum. `LevelInfoData`/`HeroSaveData` have no enums.

**Read-only resolution:**
1. Reuse the already-resolved `PlayerSaveData` pointer (same object as Common/Currency). If you don't have it yet: find the `PlayerSaveData` class by string -> find the instance -> it points to `commonSaveData@0x10` (sanity-check with the already-known currentStageKey).
2. `PlayerSaveData+0x30` -> `List<HeroSaveData>`. Read items@0x10 (Il2CppArray, data@0x20) and _size@0x18.
3. For each HeroSaveData element: `+0x10`=heroKey (int), `+0x14`=HeroLevel (int), `+0x1C`=HeroExp (float). Direct read, no XOR.
4. Curve (optional, for % and XP-to-next): find the `yp` singleton by instance scan (MonoBehaviour, klass@0x0 -> compare name "yp"; or use the already-resolved manager pointer if you have one). Read `yp+0x88` (Dictionary) or iterate the equivalent `List<LevelInfoData>`; map Level->ExpForLevelUp (offsets 0x10/0x14).
5. XP earned in a run = sample (HeroLevel, HeroExp) at t0 and t1. Same level: `gain = exp1 - exp0`. Crossed level(s): `gain = (ExpForLevelUp[lvl0] - exp0) + sum(ExpForLevelUp[lvl0+1..lvl1-1]) + exp1`.

**Gotchas / confidence:**
- HeroExp is **level-relative** XP (resets on level-up), not a running total — the delta must add the curve when crossing levels (step 5). Medium confidence in this "reset" semantics: inferred from the structure (per-level `ExpForLevelUp` curve + a Hero wrapper that consumes it) — VALIDATE at runtime by watching HeroExp drop when HeroLevel rises.
- There is NO persistent account/player XP (AccountSaveData 328529 verified: only playerId/version/playTime/session). XP is strictly per-hero.
- The runtime mirror on `uf` (befp..befs ObscuredInt, beft ObscuredFloat) is ENCRYPTED (ACTk: real = hiddenValue XOR cryptoKey per instance). Ignore it; HeroSaveData is plain and simpler.
- `ExpForLevelUp` is an **int** in LevelInfoData (355198) but HeroExp is a **float** (342739) — likely fractional accumulation from bonuses (EAccountStatus IncreaseExpAmount etc.); compare as float.
- `CubeLevelSaveData.Exp` (342684) is Cube-system XP, NOT hero — don't confuse them.
- Master-data `yp` is a MonoBehaviour singleton (`nn<a>`, static instance @0x0 but resolve by instance scan like StageManager). High confidence in the HeroSaveData/LevelInfoData offsets (read directly from the dump with JsonProperty); medium confidence in resolving the `yp` singleton (not yet resolved by you).

=====================

I have enough verified evidence to compile the domain report. The `xd` class has many `float xx(StatType)` getters reading from the two `Dictionary<StatType,float>` caches (`bets`@0x18 = final computed total per stat; `bett`@0x20 = a secondary cache, likely base-only or pre-mod). The values are PLAIN float — not obscured (the obscuring lives only in the raw `up` modifier sources via Unit's ObscuredFloats, but the aggregated cache is plaintext). 

Let me do a final sanity check on whether the two dicts are total-vs-base by examining the `up` value field type (plain float, confirmed) and confirm the entries data offset convention. I have everything. Writing the report.

## DOMAIN: Per-Hero Stats (64-stat sheet via StatType)

**Read-only feasible:** yes — the full sheet lives in a PLAIN (non-obscured) `Dictionary<StatType,float>` inside `xd` (the stat calculator), reachable from `Hero.cache`/`Monster.cache` by fixed offsets; no XOR needed to read the aggregated total.

**Classes:**
- `Hero : Unit` (dump.cs:318755) — hero; holds the stat-controller in `cache`.
- `Monster : Unit` (dump.cs:319084) — monster; same pattern, different controller.
- `uo` (dump.cs:336113, abstract) — stat-controller base; holds the calculator `xd` in `behg`.
- `uf : uo` (dump.cs:335005) — the HERO's stat-controller (HeroInfoData, Hero ref, equipped items).
- `ud.tl : uo` (dump.cs:332557) — the MONSTER's stat-controller (MonsterInfoData).
- `xd` (dump.cs:342026) — the calculator: 2x `Dictionary<StatType,float>` (computed-stat cache) + a ref to the mod registry `uq`.
- `uq` (dump.cs:336345) — modifier registry: `Dictionary<StatType,List<up>>` per source.
- `up` (dump.cs:336257) — ONE modifier: StatType + MODTYPE + value + MODSOURCE.
- `Unit` (dump.cs:319277) — holds 12 `ObscuredFloat` ("core" runtime stats, obfuscated mapping).

**Key fields:**
- `Hero.cache` @0x3A0 (uf) — hero stat-controller (dump.cs:318758).
- `Monster.cache` @0x3B0 (ud.tl) — monster stat-controller (dump.cs:319089).
- `uo.behg` @0x10 (xd*) — pointer to the calculator; inherited by uf and ud.tl (dump.cs:336117; il2cpp.h:88094 `_behg_k__BackingField`, 1st field of `uo_Fields`).
- `xd.bets` @0x18 (Dictionary<StatType,float>) — **TOTAL computed stat per StatType (the final sheet)** (dump.cs:342030; il2cpp.h:94904).
- `xd.bett` @0x20 (Dictionary<StatType,float>) — second stat cache (likely base/pre-mod or auxiliary cache) (dump.cs:342031; il2cpp.h:94905).
- `Dictionary<StatType,float>._entries` @0x18, `._count` @0x20 (Entry array) (il2cpp.h:837231-837232).
- Entry of `<StatType,float>` (canonical .NET): `hashCode` @0x0 (int), `next` @0x4 (int), `key` @0x8 (StatType=int32), `value` @0xC (float); stride 16 bytes. Array `_entries`: data starts @0x20.
- `up.behk` @0x10 (StatType), `up.behl` @0x14 (MODTYPE), `up.behm` @0x18 (float value), `up.behn` @0x1C (MODSOURCE) — **all PLAIN** (dump.cs:336261-336267; il2cpp.h:89776-89779).
- `ObscuredFloat`: `hiddenValue` @0x4 (int), `currentCryptoKey` @0x8 (int), `fakeValue` @0xC (float); `hash`@0x0 (il2cpp.h:79753-79758).
- `Unit.bcex..bcfi` @0x104,0x118,0x12C,0x140,0x154,0x168,0x17C,0x190,0x1A4,0x1B8,0x1CC,0x1E0 (12x **ObscuredFloat (OBSCURED)**) — core runtime stats (dump.cs:319321-319332); `bcfl`@0x214 (ObscuredFloat, OBSCURED).
- `ud.tl.bdzz..beae` @0x48,0x5C,0x70,0x84,0x98,0xAC (6x ObscuredFloat, OBSCURED) — monster core stats (dump.cs:332562-332567).

**Enums:**
- `StatType` (dump.cs:336161) [VERIFIED]: NONE=0, AttackDamage=1, AttackSpeed=2, CriticalChance=3, CriticalDamage=4, MaxHp=5, Armor=6, MovementSpeed=7, AreaOfEffect=8, BaseAttackCountReduction=9, CooldownReduction=10, SkillRangeExpansion=11, FireResistance=12, ColdResistance=13, LightningResistance=14, ChaosResistance=15, DodgeChance=16, BlockChance=17, MaxDodgeChance=18, MaxBlockChance=19, Multistrike=20, HpLeech=21, ProjectileCount=22, HpRegenPerSec=23, PhysicalDamagePercent=24, FireDamagePercent=25, ColdDamagePercent=26, LightningDamagePercent=27, ChaosDamagePercent=28, MaxFireResistance=29, MaxColdResistance=30, MaxLightningResistance=31, MaxChaosResistance=32, AddHpPerHit=33, DamageReduction=34, PhysicalDamageReduction=35, FireDamageReduction=36, ColdDamageReduction=37, LightningDamageReduction=38, ChaosDamageReduction=39, DamageAbsorption=40, DamageAddition=41, PhysicalDamageAddition=42, FireDamageAddition=43, ColdDamageAddition=44, LightningDamageAddition=45, ChaosDamageAddition=46, IncreaseExpAmount=47, AdditionalExp=48, CastSpeed=49, SkillHealIncrease=50, SkillDurationIncrease=51, AllElementalResistance=52, IncreaseProjectileDamage=53, IncreaseMeleeDamage=54, IncreaseAreaOfEffectDamage=55, IncreaseSummonDamage=56, IncreaseProjectileSpeed=57, AddHpPerKill=58, AddAllSkillLevel=59, ElementalBlockChance=60, ElementalDodgeChance=61, MaxElementalBlockChance=62, MaxElementalDodgeChance=63. (64 values, 0-63)
- `MODTYPE` (dump.cs:336232) [VERIFIED]: FLAT=0, ADDITIVE=1, MULTIPLICATIVE=2.
- `MODSOURCE` (dump.cs:336242) [VERIFIED]: BASE=0, ITEM=1, ATTRIBUTE=2, PASSIVE=3, AccountStatus=4, StatusEffect=5, BuffSkill=6, ENVIROUNMENT=7.

**Read-only resolution** (from the already-resolved `StageManager.HeroList: Hero[]@0x30`):
1. For each `Hero*` in `HeroList`: read the `uf* cache` pointer at `Hero+0x3A0`. (Monsters: `MonsterSpawnManager.MonsterList`→`Monster*`→`ud.tl* cache` at `Monster+0x3B0`.)
2. In the `uf`/`ud.tl` object (which is a `uo`): read `xd* = *(cache + 0x10)` (`uo.behg`).
3. In `xd`: read `Dictionary<StatType,float>* total = *(xd + 0x18)` (`bets`) — this is the final aggregated sheet. (Optional: `*(xd+0x20)` = `bett`.)
4. In the Dictionary: read `entriesArray = *(dict + 0x18)`; `count = *(int*)(dict + 0x20)`.
5. Iterate `i` from 0 to count-1 over `entriesArray` (data @ array_base+0x20, stride 16): `key = *(int*)(entry+0x8)` (=StatType), `value = *(float*)(entry+0xC)`. Skip entries with `hashCode<0` (free slots). Map `key`→name via the StatType enum above.
6. Result: the hero's complete {StatType: float} sheet, in plaintext.

**Gotchas / confidence:**
- **Where the question assumed wrong:** the 12 `ObscuredFloat` fields on `Unit@0x104` are NOT the 64 stats — they're a handful of "core" stats cached at runtime, with 100% obfuscated names (bcex..bcfi), impossible to map index→StatType with confidence from the dump alone (would require reading the RVA bodies of the getters brdy/brdz/...). The real sheet is indexed by StatType and lives in `xd.bets`. (HIGH CONFIDENCE in locating `xd.bets`; LOW confidence in mapping the individual ObscuredFloats — avoid them.)
- **Crypto:** the `Dictionary<StatType,float>` (bets/bett) is PLAIN (raw `float`), as are the modifiers `up.behm` (raw `float`) and their StatType/MODTYPE/MODSOURCE keys. You only need the XOR (`hiddenValue ^ currentCryptoKey` reinterpreted as float via a union, with `hash` validating anti-tamper) if you choose to read the `ObscuredFloat` fields on `Unit`/`ud.tl` instead of the dict — I recommend NOT doing that.
- **bets vs bett:** confirmed they're two distinct caches (il2cpp.h:94904-94905); given the system's pattern (the `uq` registry with mods per MODSOURCE BASE/ITEM/etc.) it's strongly likely `bets` = final total and `bett` = secondary cache (base or dirty-flag), but I did NOT verify the RVA bodies of `kg/kak/bnx` to prove which getter reads which. If you need absolute certainty about which dict is "the total", read both at runtime and compare with the UI. (MEDIUM CONFIDENCE in bets=total.)
- **State vs persistent:** this is RUNTIME STATE (stats computed for the live in-scene Unit instance), recomputed by mods (items/attributes/buffs). It is NOT a persistent save. The persistent progression source lives in `HeroSaveData` (heroKey/HeroLevel/exp/items), already resolved, and invested attributes probably in `AttributeSaveData` (not covered here) — `xd` derives the final number from those sources + level + equipment.
- **Dictionary may reorder/rehash:** entries have no stable order and there are free slots (hashCode<0 / freeList); always filter by hashCode and iterate up to `_count`+freeCount. Re-read the dict pointer each poll (it may be recreated on level-up/reequip).
- **Entry layout:** the struct `Dictionary.Entry<StatType,float>` doesn't appear named in the dump; I used the canonical .NET layout (key@0x8/value@0xC, stride 16) — HIGH CONFIDENCE (StatType and float are both 4 bytes, no extra padding), but confirm the stride at runtime by reading 2-3 known entries.

=====================

I now have everything needed. Let me confirm the `te` UniqueId backing field stride: `bdyr ObscuredULong@0x148` (16-byte fields: hash@0x148, hiddenValue@0x150, currentCryptoKey@0x158). And map the `ObscuredInt` level field. The getter `ipp()`→ulong is UniqueId reading `bdyr`. The 5 GearModData are the rolled stat mods (StatType/ModType/Value each ObscuredInt). 

One last verification: the `te` ObscuredInt fields (level/enchant counts) — confirm `ipu()` (level, ObscuredInt) maps to a backing field. The most likely candidate is `bdyw@0x198`. I have enough to write the report with appropriate confidence on the offsets I've directly read (field offsets are certain; getter→field mapping I'll mark medium). Let me do one final check to confirm there isn't a simpler plain ItemKey field on `te` and check what `irx` builds (to confirm te = ItemInfoData + ItemSaveData merge).

The field layout is fully read. I have all I need to produce the report.

## DOMAIN: Equipment (Items / Gear)

**Read-only feasible:** partial — the topology resolves 100% (static catalog + UniqueId->gear registry are plain pointers), but EVERY instance attribute (level, rolled mods/stats, enchants, even the UniqueId on the gear object itself) is ObscuredInt/ULong and requires the per-instance ACTk XOR.

**Classes:**
- `HeroSaveData` (342729) — hero save; `equippedItemIds` (ulong[]) lists the **UniqueId**s of equipped items (NOT ItemKeys)
- `ItemSaveData` (342805) — persistent save for each item (ItemKey, UniqueId, enchant counts/data); base of the serialized state
- `ItemEnchantSaveData` (342779, struct) — serialized enchant (plain ints): StatModKey/Tier/Value/RecipeType/ModType/MaterialKey/StatType
- `ItemInfoData` (354859, `: ze`) — static CATALOG keyed by ItemKey: GRADE/PARTS/GEARTYPE/Level/NameKey. Loaded from ScriptableObject/ClassMap, plain
- `GearTypeInfoData` (354545) — base-stats per EGearType (catalog)
- `GradeInfoData` (354635) — slots/weights per EGradeType (catalog)
- `ud.th.te` (331532) — **runtime gear model** (merge of ItemInfoData + ItemSaveData); instance fields Obscured
- `ud.th.GearModData` (331416, struct) — 1 rolled gear stat: StatType/ModType/Value (3x ObscuredInt)
- `ud.th.ItemEnchantData` (331439, struct) — runtime enchant: 6x ObscuredInt + MaterialKey(int)
- `ud.th` (332084, static) — **gear REGISTRY**: `Dictionary<ulong, ud.th.te> bdzo` @0x0 (UniqueId -> gear). Resolution point
- `ud.tc` (330997, static) — INVENTORY-SLOT registry (`ul`), don't confuse with gear
- `ul` (335698, `: zw, zv`) — InventorySaveData wrapper (bag slot), NOT the item/gear
- `PlayerSaveData` (328698) — save root: `List<ItemSaveData> itemSaveDatas` @0x80, `List<HeroSaveData> heroSaveDatas` @0x30 — ⚠ this domain wrongly called it `SaveContainer @328700`; corrected per extraction-spec.md E1 (@328700 is the `// Fields` comment INSIDE PlayerSaveData, not a class)

**Key fields:**
- `HeroSaveData.equippedItemIds` @0x28 (ulong[]) — equipped UniqueIds (slot by array index)
- `HeroSaveData.equippedSKillKey` @0x30 (int[]) — skills, outside the items scope
- `ItemSaveData.ItemKey` @0x10 (int, **PLAIN** — not Obscured here) — catalog key
- `ItemSaveData.UniqueId` @0x18 (ulong, **PLAIN**) — instance id
- `ItemSaveData.IsChaotic` @0x20 (bool) / `IsBlocked` @0x21 / `IsServerPendingItem` @0x22
- `ItemSaveData.EnchantCount` @0x28 (int[]) / `EnchantData` @0x30 (ItemEnchantSaveData[]) — persisted enchants (plain)
- `ItemSaveData.DecorationAppliedTotalCount` @0x38 / `EngravingAppliedTotalCount` @0x3C / `InscriptionAppliedTotalCount` @0x40 (int)
- `ItemInfoData.ItemKey` @0x30 (int) / `ITEMTYPE` @0x34 / `GRADE` @0x38 (EGradeType) / `PARTS` @0x3C (EItemParts) / `GEARTYPE` @0x40 (EGearType) / `GearGroup` @0x44 / `NameKey` @0x50 (string) / `Level` @0x6C (int) — ALL plain (catalog)
- `ud.th.te.bdyd` @0x10 (ItemInfoData, plain ref) — pointer to the catalog (read GRADE/PARTS/GEARTYPE/Level from here without crypto)
- `ud.th.te.bdym..bdyq` @0x58/0x88/0xB8/0xE8/0x118 (GearModData x5) — the 5 rolled stats (each 3x ObscuredInt) **(OBSCURED)**
- `ud.th.te.bdyr` @0x148 (ObscuredULong = UniqueId) **(OBSCURED)** — getter `ipp()`
- `ud.th.te.bdyv` @0x190 (ItemEnchantData[]) — runtime enchants **(OBSCURED in the elements)**
- `ud.th.te.bdyw` @0x198 / `bdyx[]` @0x1A8 / `bdyy` @0x1B0 / `bdyz` @0x1C0 / `bdza` @0x1D0 (ObscuredInt) — level/enchant counters **(OBSCURED)**; level getter `ipu()` returns ObscuredInt
- `ud.th.te.bdzd` @0x200 (ObscuredLong) **(OBSCURED)** — likely price/alchemy gold
- `GearModData.StatType` @0x0 / `ModType` @0x10 / `Value` @0x20 (ObscuredInt) **(OBSCURED)** — stride 16 bytes
- `ItemEnchantData.StatModKey`@0x0/`Tier`@0x10/`Value`@0x20/`RecipeType`@0x30/`ModType`@0x40/`StatType`@0x50 (ObscuredInt) **(OBSCURED)**; `MaterialKey`@0x60 (int, plain)
- `ud.th.bdzo` @0x0 (Dictionary<ulong, te>, **PLAIN**) — UniqueId->gear registry

**Enums (VERIFIED by grep):**
- `EGradeType` (354944): COMMON=0, UNCOMMON=1, RARE=2, LEGENDARY=3, IMMORTAL=4, ARCANA=5, BEYOND=6, CELESTIAL=7, DIVINE=8, COSMIC=9, NONE=10
- `EItemParts` (354962) [= the "slot"]: NONE=0, MAIN_WEAPON=1, SUB_WEAPON=2, HELMET=3, ARMOR=4, GLOVES=5, BOOTS=6, AMULET=7, EARING=8, RING=9, BRACER=10
- `EItemType` (354919): STAGEBOX=0, MATERIAL=1, GEAR=2, NONE=3
- `EGearType` (354992): NONE=0, SWORD=1, BOW=2, STAFF=3, SCEPTER=4, CROSSBOW=5, AXE=6, SHIELD=7, ARROW=8, ORB=9, TOME=10, BOLT=11, HATCHET=12, HELMET=13, ARMOR=14, GLOVES=15, BOOTS=16, AMULET=17, EARING=18, RING=19, BRACER=20
- `EGearGroup` (354980): NONE=0, WEAPON=1, ARMOR=2, ACCESSORY=3, COMMON=4
- `EEquipClassType` (354930): All=0, Knight=1, Ranger=2, Sorcerer=3, Priest=4, Hunter=5, Slayer=6
- `EEquipSlot` does NOT exist — the slot is `EItemParts`.

**Read-only resolution (from what we've already resolved):**
1. Hero -> `equippedItemIds` (ulong[] @0x28): resolve HeroSaveData (already done for CommonSaveData/HeroSaveData by offset). Each element is a **UniqueId**, position in the array = slot.
2. Find the Il2CppClass of the static registry `ud.th` (scan string `"ud.th"` -> class). In IL2CPP, `Dictionary<ulong,te> bdzo` is a **static** field -> it sits in the Il2CppClass's `static_fields` (Il2CppClass->static_fields @ the struct offset; you can already find the class via name@0x10). The dict is at static_fields+0x0.
3. Read the Dictionary<ulong, te>: standard .NET layout — `entries[]`@0x18 (array of Entry{int hashCode@0x0, int next@0x4, ulong key@0x8, te value@0x10}), `count`@0x38. Iterate entries, where key == UniqueId, take the `te value` pointer.
   - Simpler alternative (recommended for read-only): do NOT read the dict. Instead scan `te` instances on the heap (object with klass@0x0 == class `te`) and read `bdyr` (UniqueId, after XOR) to match against `equippedItemIds`. More expensive, but avoids walking the Dictionary's internal structure.
4. From `te`: read `bdyd`@0x10 (ItemInfoData ptr) and follow it to the catalog: `GRADE`@0x38, `PARTS`@0x3C, `GEARTYPE`@0x40, `Level`@0x6C, `NameKey`@0x50 — all **plain**, no crypto. That already gives the item's rarity/slot/type/base-level.
5. Rolled stats: read the 5 `GearModData` (@0x58..0x118). Each `StatType/ModType/Value` is an ObscuredInt -> apply XOR (step 6). The decoded StatType indexes the already-known StatType(64) enum; ModType -> MODTYPE.
6. **Decrypt ObscuredInt** (ACTk): real value = `hiddenValue XOR currentCryptoKey`. ObscuredInt layout: `hash`@0x0(int), `hiddenValue`@0x4(int), `currentCryptoKey`@0x8(int), `fakeValue`@0xC. So for an ObscuredInt at offset X: real = read_i32(X+0x4) ^ read_i32(X+0x8).
   **Decrypt ObscuredULong** (UniqueId `bdyr`): layout `hash`@0x0(int), `hiddenValue`@0x8(ulong), `currentCryptoKey`@0x10(ulong), `fakeValue`@0x18 -> real = read_u64(X+0x8) ^ read_u64(X+0x10). (ObscuredLong = same layout as ULong.)
7. Runtime enchants: `bdyv`@0x190 (ItemEnchantData[]) — each element has 6 ObscuredInt (XOR) + plain MaterialKey@0x60. Or use the persisted version `ItemSaveData.EnchantData`@0x30 (ItemEnchantSaveData, plain) by scanning `itemSaveDatas` for the UniqueId — no crypto, easier.

**Gotchas / confidence:**
- **CRYPTO (high confidence):** inside `te`, UniqueId/level/mods/enchants/price are Obscured (ObscuredInt/ULong/Long). Without the XOR you read garbage (fakeValue/hiddenValue). The field offsets are certain; the XOR formula is verified in the structs (lines 1117993, 1119060).
- **Crypto-free shortcut (high confidence):** rarity(GRADE), slot(PARTS), type(GEARTYPE), base-level(Level), name(NameKey) come from `ItemInfoData` (catalog, plain) via `te.bdyd`@0x10. And `ItemSaveData` (in `itemSaveDatas`@0x80) has **plain** ItemKey/UniqueId/EnchantData. So "which items are equipped and their rarities/slots/persisted enchants" is 100% readable WITHOUT XOR — only `te`'s live level/rolled-stats require XOR.
- **equippedItemIds = UniqueId, not ItemKey (high confidence):** confirmed the type ulong[] (342745) and the existence of the Dictionary<ulong,te> registry (332087). Mapping UniqueId->ItemKey goes through `te.bdyd.ItemKey` or `itemSaveDatas`.
- **Not UI-history:** `itemSaveDatas`/`equippedItemIds` are real PERSISTENT state (JsonProperty, save). The `ud.th.bdzo` registry is runtime state mirrored from the save (not UI history). `ud.tc`/`ul` are bag slots (InventorySaveData), a distinct domain — don't use them to resolve equipped gear.
- **Getter vs field (medium confidence):** getters like `ipp()`(UniqueId), `ipu()`(level), `ipg()`(PARTS), `ipf()`(GRADE) can't be called in read-only; I mapped them to backing fields by type/offset. UniqueId=`bdyr`@0x148 and the 5 GearModData@0x58.. are certain from the declared types. The exact identification of WHICH ObscuredInt (`bdyw`@0x198 vs `bdyy`@0x1B0...) is the level vs an enchant counter was not 100% isolated — confirm at runtime by decrypting the candidates @0x198/0x1B0/0x1C0/0x1D0 and comparing with the UI.
- **Internal Dictionary (medium confidence):** reading `bdzo` requires walking IL2CPP's internal Dictionary<TKey,TValue> layout; the shortcut of scanning `te` instances by klass is more robust and is already the method you use to find instances.

Key files/lines: `re/dump/dump.cs` (Il2CppDumper output, GameAssembly.dll v1.00.07; not committed) — HeroSaveData 342729, ItemSaveData 342805, ItemInfoData 354859, gear `ud.th.te` 331532, GearModData 331416, ItemEnchantData 331439, registry `ud.th` 332084, PlayerSaveData root 328698 (NOT "SaveContainer"), ObscuredInt 1117993, ObscuredULong 1119060, enums 354919-354989.

=====================

Confirmed definitively. `HeroSaveData` has no rune/pet field — runes and pets are global account-level, not per-hero. The `InventorySaveData.IsUnlockedByRune@0x21` confirms runes unlock account-wide features (inventory slots), consistent with the passive-tree model. I have everything needed.

## DOMAIN: runes-pets

**Read-only feasible:** yes — `PetSaveData` and `RuneSaveData` are plaintext classes (simple int/bool, no Obscured wrappers), reachable via `PlayerSaveData` (global lists) or `PetManager` (dictionary). Numeric stats require cross-referencing static CSV tables.

**Classes:**
- `PetSaveData` (line 342845) — saved state of 1 pet: key, unlock, viewed. Plaintext.
- `RuneSaveData` (line 342862) — saved state of 1 rune: key + level. Plaintext.
- `PlayerSaveData` (line ~328645, TypeDefIndex 2614) — root container; holds `List<PetSaveData>@0x48` and `List<RuneSaveData>@0x50` (account-GLOBAL lists).
- `PetManager` (line 343118, nn<PetManager> singleton) — runtime: `Dictionary<int,PetSaveData>@0x30`, `m_arrangedPetKeyRuntimeData(int)@0x38`.
- `PetInfoData` (line 355446, : ze) — static CSV table: PetKey→StatDataKey (links pet to stats).
- `PetStatInfoData` (line 355500, : ze) — static CSV table: pet stat row (StatType=EAccountStatus, MODTYPE, Value).
- `RuneInfoData` (line 355544, : ze) — static CSV table: rune definition (obfuscated fields, see gotchas).
- `RuneLevelInfoData` (line 355592, : ze) — static CSV table: stat per rune level (EAccountStatus@0x40).
- `AccountStatus` (line 341850) — aggregates pet+rune bonuses in `Dictionary<EAccountStatus,ObscuredInt>@0x10` (the aggregated value is OBSCURED).
- `RuneNode` (line 351402) / `RunePage` (line 351569) — rune-tree UI (not save state).

**Key fields:**
- `PetSaveData.PetKey` @0x10 (int) — pet key [JsonProperty "PetKey"]
- `PetSaveData.IsUnlock` @0x14 (bool) — pet unlocked
- `PetSaveData.IsViewed` @0x15 (bool) — UI flag (seen in the collection)
- `RuneSaveData.RuneKey` @0x10 (int) — rune key [JsonProperty "RuneKey"]
- `RuneSaveData.Level` @0x14 (int) — level invested in the rune [JsonProperty "Level"]
- `PlayerSaveData.PetSaveData` @0x48 (List<PetSaveData>) — global pet list
- `PlayerSaveData.RuneSaveData` @0x50 (List<RuneSaveData>) — global rune list
- `CommonSaveData.ArrangedPetKey` @0x40 (int) — the ONE currently active pet (only 1 pet equipped) [JsonProperty "ArrangedPetKey"]
- `PetManager.beur (Dictionary<int,PetSaveData>)` @0x30 — runtime mirror of pets by key
- `PetManager.m_arrangedPetKeyRuntimeData` @0x38 (int) — active pet at runtime (mirrors ArrangedPetKey)
- `PetInfoData.PetKey` @0x30 / `.StatDataKey` @0x48 (int) — links PetKey to the stat block
- `PetStatInfoData.StatType` @0x34 (EAccountStatus) / `.MODTYPE` @0x38 / `.Value` @0x3C (int) — stat granted by the pet
- `RuneLevelInfoData.bfob` @0x40 (EAccountStatus) / `.bfoc` @0x44 (int) — stat per rune level
- `AccountStatus.betp (Dictionary<EAccountStatus,ObscuredInt>)` @0x10 — **(OBSCURED)** aggregated sum of bonuses

No field inside Pet/RuneSaveData is Obscured. The domain's only Obscured value is the runtime aggregate in `AccountStatus`.

**Enums (VERIFIED by grep):**
- `EPetUnlockConditionType` (line 355435): NONE=0, KillMonster=1, DLC=2
- `MODTYPE` (line 336232): FLAT=0, ADDITIVE=1, MULTIPLICATIVE=2
- `EAccountStatus` (line 341801): 0..41 — IncreaseGoldAmount=0, AdditionalGold=1, IncreaseExpAmount=2, AdditionalExp=3, DropChanceNormalChest=4, DropChanceStageBossChest=5, WaveCountReduction=6, WaveMonsterAmount=7, MaxAmountNormalChest=8, MaxAmountStageBossChest=9, MaxAmountActBossChest=10, CubeExpPercent=11, CubeAlchemyGoldPercent=12, AllHeroMoveSpeed=13, AllHeroAttackSpeed=14, AllHeroAttackDamage=15, AllHeroAttackDamagePercent=16, AllHeroArmor=17, AllHeroArmorPercent=18, AdditionalGoldStageBoss=19, AdditionalGoldActBoss=20, AdditionalGoldNormalMonster=21, AdditionalExpStageBoss=22, AdditionalExpActBoss=23, AdditionalExpNormalMonster=24, MaxInventorySlot=25, UnlockStashPageCount=26, UnlockArrangeSlotCount=27, UnlockSkillSlotCount=28, DropChanceNormalChestPercent=29, DropChanceStageBossChestPercent=30, UnlockAutoOpenNormalChest=31, ReduceAutoOpenNormalChestTime=32, UnlockAutoOpenStageBossChest=33, ReduceAutoOpenStageBossChestTime=34, UnlockAutoOpenActBossChest=35, ReduceAutoOpenActBossChestTime=36, OpenOneTypeChestAllAtOnce=37, OpenAllTypeChestAllAtOnce=38, UnlockOfflineReward=39, OfflineRewardGoldPercent=40, OfflineRewardExpPercent=41

Note: pets/runes use `EAccountStatus` (economic/account-global buffs + AllHero*), NOT the per-unit combat `StatType(64)` enum.

**Read-only resolution:** Starting from what we've already resolved (find the class by name string → instances by klass@0x0 → read fields):
1. Pets: locate `PetManager` (singleton via nn<>) by the string "PetManager"; read `m_arrangedPetKeyRuntimeData@0x38` (int) = active pet. For the collection, read `beur@0x30` (Dictionary). Robust alternative: read `CommonSaveData.ArrangedPetKey@0x40` (already resolved) for the active pet. Only 1 pet is equipped.
2. Full saved list: resolve `PlayerSaveData` by string and read `List<PetSaveData>@0x48` and `List<RuneSaveData>@0x50` (standard List: items@0x10/_size@0x18; each element is an object with klass@0x0, read PetKey@0x10/IsUnlock@0x14 and RuneKey@0x10/Level@0x14).
3. Runes: they're a GLOBAL progression tree (RunePage/RuneNode chained via `m_nextRuneKey`), keyed by RuneKey with an invested Level — not equipped to a hero. Read key+level directly from each RuneSaveData.
4. Numeric stats (optional): RuneSaveData/PetSaveData do NOT hold stats, only key+level. The real value comes from the static tables: PetKey→PetInfoData.StatDataKey→PetStatInfoData(StatType/MODTYPE/Value); RuneKey+Level→RuneLevelInfoData(bfob=EAccountStatus, bfoc=Value). Those tables are CSV-loaded (`ze`/`ClassMap`), findable at runtime but laborious; easier to extract from the game's CSV.

**Gotchas / confidence:**
- **Hero/party link:** I VERIFIED that `HeroSaveData` (line 342729) has NO rune/pet field. Runes and pets are 100% account-wide, not per-hero/per-slot. Pets affect all heroes via `EAccountStatus` (incl. AllHeroAttackDamage etc.); runes unlock account features (e.g. `InventorySaveData.IsUnlockedByRune@0x21`, line 342768). Only 1 pet is active (`ArrangedPetKey`).
- **No slot field:** `RuneSaveData` has only RuneKey+Level — there is NO "slot" field. The "slot"/position is defined by the static tree table (RuneNode.m_nextRuneKey), not in the save. High confidence.
- **OBSCURED:** the raw SaveData are plaintext (no XOR). BUT the runtime aggregated stat value lives in `AccountStatus.betp` as `Dictionary<EAccountStatus,ObscuredInt>@0x10` — if you read from there, you need the XOR (hiddenValue XOR currentCryptoKey per ObscuredInt). Prefer reading RuneSaveData.Level + the static table and computing it yourself, avoiding crypto. High confidence.
- **IsViewed:** it's a UI flag (collection seen), not a gameplay counter/state. High confidence.
- **`PetManager` runtime vs save:** `m_arrangedPetKeyRuntimeData@0x38` and `beur@0x30` are a runtime mirror; the canonical persistent source is `PlayerSaveData`/`CommonSaveData`. Both reliable for live reads.
- **Gap (medium confidence):** the field names of `RuneInfoData` (bfnp..bfnw, @0x30-0x58) stayed obfuscated — they're not in stringliteral.json nor mapped in readable text; inferred by type: 2x int + key + 3 strings (NameKey/DescKey/IconKey) + 2 int, by analogy to PetInfoData. They're not needed to read player state (key+level suffice). `RuneLevelInfoData.bfob@0x40 (EAccountStatus)` and `.bfoc@0x44 (Value)` were identified by the field's concrete type.

=====================

The `List<ActiveSkill> bcgj @0x328` and `Dictionary<int, ActiveSkill> bcgl @0x338` live on the **`Unit` base class** (line 319277) — which Hero already extends and which we already resolve. This is the cleanest runtime path: each live Hero unit carries its instantiated ActiveSkill objects, each holding a `un skillCache @0x18` → `SkillInfoData begn @0x10`. I have a complete, verified picture. Writing the final report.

## DOMAIN: Skills (per-hero equipped skills, levels, static info, theoretical DPS)

**Read-only feasible:** yes — the whole chain resolves from Unit (already resolved) and a data singleton; `SkillInfoData` is 100% plain (no Obscured field), per-level values require reading a level-table dict but it too is plain.

**Classes:**
`HeroSaveData` (342729) — hero save; list of equipped skill keys (persistent)
`SkillInfoData : ze` (355677) — static skill record (key, name-key, params, damage attribute, slot). Plain fields
`PassiveSkillInfoData : ze` (355390) — passive-skill record (statType/modType/value)
`SkillLevelInfoData : ze` (355761) — per-level table entry (3 ints: bfod/bfoe/bfof @0x30/0x34/0x38)
`un` (335893) — runtime skill CACHE (wraps SkillInfoData; stats in Obscured*)
`um` (335807) — runtime passive-skill cache (wraps PassiveSkillInfoData)
`ActiveSkill` (abstract, 360548) — active skill instance in combat; holds `skillCache (un) @0x18`
`Unit : MonoBehaviour` (319277) — base of Hero/Monster; carries the runtime-instantiated ActiveSkills
`yp : nn<yp>` (352341) — master data-table singleton; skillKey->SkillInfoData dict
`ScriptableObjectDataContainer` (353756) — singleton (static Instance@0x0); skillKey->SkillSO dict (prefabs/anim/sprite)
`SkillStatusDescriptionPanel : MonoBehaviour` (349069) — tooltip UI; contains `m_DPS`
`SkillSO : ScriptableObject` (293630) — skill presentation/effects data (not balancing numbers)

**Key fields:**
`HeroSaveData.equippedSKillKey` @0x30 (int[]) — equipped skill keys (note the capital "K"); resolve via StageManager.HeroList or via the save
`SkillInfoData.SkillKey` @0x30 (int) — skill key (= the dict key in yp)
`SkillInfoData.SkillNameKey` @0x38 (string) — name localization key
`SkillInfoData.SkillDescriptionKey` @0x40 (string) — description localization key
`SkillInfoData.ActivationType` @0x48 (ACTIVATIONTYPE) — how it fires (BASEATTACK/COOLDOWN/CONTINUOUS)
`SkillInfoData.ActivationValue` @0x4C (int) — cooldown/count per ActivationType
`SkillInfoData.DamageAttribute` @0x50 (EDamageAttribute) — damage attribute
`SkillInfoData.DamageDeliveryType` @0x54 (EDamageType) — Melee/Projectile/AOE/DOT/...
`SkillInfoData.SlotType` @0x58 (SLOTTYPE) — BASEATTACK(0)/SKILL(1)
`SkillInfoData.SkillBuffType` @0x5C (SkillBuffType) — Normal(0)/Buff(1)
`SkillInfoData.Param1..Param5` @0x64/0x68/0x6C/0x70/0x74 (int) — balancing params
`SkillInfoData.Value` @0x80 (int) — base value
`SkillInfoData.SkillLevelKey` @0x84 (int) — key into the level-table (dict bfit in yp)
`PassiveSkillInfoData.bfnm` @0x40 (StatType), `.bfnn` @0x44 (MODTYPE), `.bfno` @0x48 (int value)
`SkillLevelInfoData.bfod/bfoe/bfof` @0x30/0x34/0x38 (int) — likely {level, key, per-level value} (obfuscated names; semantics not confirmed)
`Unit.bcgj` @0x328 (List<ActiveSkill>) — active skills instantiated on this Hero at runtime
`Unit.bcgl` @0x338 (Dictionary<int,ActiveSkill>) — skillKey->active ActiveSkill map
`ActiveSkill.skillCache` @0x18 (un) — runtime skill cache; `ActiveSkill.skillSo` @0x10 (SkillSO)
`un.begn` @0x10 (SkillInfoData) — ref to the static record (the NON-obscured entry point)
`un.bego/begp/begq/begr` @0x18/0x28/0x38/0x48 (ObscuredInt) (OBSCURED) — cached runtime params
`un.begs` @0x58 (ObscuredFloat) (OBSCURED), `un.begt` @0x6C (ObscuredFloat) (OBSCURED) — runtime floats (likely damage/scale)
`un.begu..begy` @0x80/0x90/0xA0/0xB0/0xC0 (ObscuredInt) (OBSCURED)
`un.begz` @0xD0 (SkillSO) — ref to the SkillSO
`yp.bfim` @0x90 (Dictionary<int,SkillInfoData>) — skillKey -> SkillInfoData (primary lookup)
`yp.passiveSkillInfoDatas` @0x98 (List<PassiveSkillInfoData>)
`yp.bfit` @0x120 (Dictionary<int,Dictionary<int,SkillLevelInfoData>>) — [skillLevelKey][level] -> SkillLevelInfoData
`ScriptableObjectDataContainer.bflb` @0x50 (Dictionary<int,SkillSO>) — skillKey -> SkillSO; `.SkillData` @0x48 (List<SkillSO>)
`SkillStatusDescriptionPanel.m_DPS` @0xB0 (TextMeshProUGUI) — **UI text label, NOT numeric**; likewise `m_coolTime`@0xA8

**Enums (VERIFIED by grep):**
`ACTIVATIONTYPE` (355741): BASEATTACK=0, BASEATTACK_COUNT=1, COOLDOWN=2, CONTINUOUS=3
`SLOTTYPE` (355752): BASEATTACK=0, SKILL=1
`SkillBuffType` (355667): Normal=0, Buff=1
`SKILLTYPE` [Flags] (335878): None=0, Direct=1, Projectile=4, Aoe=8, SpawnTurret=16, SpawnTrap=32, SpawnSomething=64, SpawnRandomMonster=128
`EDamageType` [Flags] (~355650): None=0, Melee=1, Projectile=2, AOE=4, Summon=8, DOT=16, Trap=32

**Read-only resolution:**
1. Equipped skills (persistent): from the already-resolved CommonSaveData/HeroSaveData -> `HeroSaveData.equippedSKillKey` @0x30 (int[], Il2CppArray layout: data@0x20, _size). Each element is a skillKey.
2. Active in-combat skills (runtime, preferred): from StageManager.HeroList -> each Hero (extends Unit) -> `Unit.bcgj` @0x328 (List<ActiveSkill>, items@0x10/_size@0x18). Each ActiveSkill -> `skillCache (un)` @0x18 -> `un.begn (SkillInfoData)` @0x10.
3. skillKey -> static info: locate the `yp` singleton (scan the class string "yp" and/or find the MonoBehaviour instance whose klass points to it; nn<a> holds the singleton in static `bbwf`, so it's more robust to find the live instance by the already-used method). Read `yp.bfim` @0x90 (Dictionary<int,SkillInfoData>), find the entry with `SkillInfoData.SkillKey` @0x30 == skillKey. (IL2CPP Dictionary layout: entries array + count; iterate buckets/entries.)
4. Name/description: `SkillInfoData.SkillNameKey`@0x38 / `SkillDescriptionKey`@0x40 are localization keys (strings) — run them through the game's i18n table for final text; raw, you already have the key.
5. Per-level skill level: use `SkillInfoData.SkillLevelKey`@0x84 + current level -> `yp.bfit` @0x120 (nested dict [levelKey][level]) -> `SkillLevelInfoData` (3 ints). The skill's "current level" isn't in HeroSaveData (only heroKey/HeroLevel) — it comes from the runtime cache `un` (ObscuredInt) or is derived from HeroLevel; needs further investigation to confirm the level's origin.
6. SkillSO (sprite/anim/effects): `ScriptableObjectDataContainer.Instance` (static@0x0) -> `bflb` @0x50 (skillKey->SkillSO dict). Useful only for presentation, not for damage.

**Gotchas / confidence:**
- **m_DPS is UI, not a counter.** `SkillStatusDescriptionPanel.m_DPS`@0xB0 is a `TextMeshProUGUI` — formatted tooltip text (the displayed theoretical DPS), not a persistent number nor the real combat DPS. Reading it gives an already-rendered string and it only exists when the panel is open. For real/empirical DPS, use your meter (Monster HP delta via UnitHealthController + LogManager), not this field. High confidence.
- **SkillInfoData/PassiveSkillInfoData/SkillLevelInfoData are 100% plain (no Obscured)** — direct read by offset. High confidence (I checked block 355677-355704, zero Obscured occurrences).
- **The runtime cache `un` is heavily Obscured** (bego..begy = ObscuredInt/Float = CodeStage ACTk): real value = hiddenValue XOR cryptoKey per instance. Avoid it; prefer the path via `un.begn -> SkillInfoData` (plain) for everything you need. High confidence.
- **Skill level: gap.** HeroSaveData has NO skill level (only equippedSKillKey + HeroLevel). The effective level probably lives in the `un` cache (Obscured) or is a function of HeroLevel; I haven't confirmed the persistent source. Medium-low confidence on this specific point.
- **The semantics of SkillLevelInfoData.bfod/bfoe/bfof and Param1..5 are obfuscated names** — offsets certain, meaning inferred. Cross-reference with in-game data to map them. Medium confidence.
- **equippedSKillKey** has the capital "K" in the middle (dev typo) — mind the string match. High confidence (line 342746-342747).
- **`yp` singleton**: `nn<a>` holds the singleton in a static field (`bbwf`@0x0 in the class's static storage, not in the object). Resolving via static requires reading the Il2CppClass's static pointer; simpler is finding the live instance by the scan method you already use. Medium confidence in the mechanics of locating the singleton, high in the dict offsets.

Reference file: `re/dump/dump.cs` (Il2CppDumper output, GameAssembly.dll v1.00.07; external, not committed) — lines cited above.

=====================

Confirmed: `ut` derives from `MonoBehaviour` (via `nn<ut>`), so the dump's `// 0x20`, `// 0x28` are absolute object offsets — directly readable. The aggregate holder `ut` is layout-identical in resolution to StageManager (both `nn<T>` MonoBehaviour singletons). 

I have everything needed. Here is the domain analysis.

## DOMAIN: stage-info-aggregates

**Read-only feasible:** yes — all fields are primitive types (int/long), zero `Obscured*`; the holder `ut` is an `nn<ut>` singleton, layout-identical to the StageManager we already resolved.

**Classes:**
- `ut : nn<ut>` (dump.cs:336558) — runtime holder of the live aggregates (kills/gold/playtime). MonoBehaviour singleton. **Do NOT confuse** with a namespace; it's an obfuscated 2-letter class.
- `nn<a> : MonoBehaviour` (dump.cs:315606) — generic singleton base; instance in static field `bbwf@0x0`.
- `yp : nn<yp>` (dump.cs:352341) — master DataManager (TypeDefIndex 3132); holds the stage-definition tables. Singleton.
- `StageInfoData : ze` (dump.cs:355865) — static definition of one stage (waves, mobs per wave, boss, drops).
- `StageLevelInfoData : ze` (dump.cs:355932) — per-level stage scaling (all fields obfuscated `bfog`..`bfok`, not mapped here).
- `ze` (dump.cs:355114) — abstract base of the *InfoData; occupies 0x10-0x2F, which is why StageInfoData fields start at 0x30.
- `CommonSaveData` (dump.cs:328578) — source of the live CURRENT wave/stage (already resolved).
- `StageManager : nn<StageManager>` (dump.cs:327247) — does NOT cache StageInfoData; only battle state. Use as the singleton-resolution template.

**Key fields:**
- `ut.beid` @0x20 (`Dictionary<EAggregateType, Dictionary<int,long>>`) — **the aggregate dict**. Outer key=EAggregateType; inner key=stageKey (int); value=counter (long). E.g.: accumulated kills, gold, playtime.
- `ut.OnAggregateChanged` @0x28 (`Action<EAggregateType,int,long>`) — event; ignore for reading.
- `nn<ut>.bbwf` @0x0 of `static_fields` (`ut_o*`) — **singleton instance pointer** (il2cpp.h:89926).
- `yp.stageInfoData` @0x80 (`List<StageInfoData>`) — **table of all stages** (dump.cs:352356).
- `yp.stageLevelinfoDatas` @0x110 (`List<StageLevelInfoData>`) — scaling table (dump.cs:352375).
- `yp` (nn<yp>) instance @0x0 of static_fields (same `bbwf`, il2cpp.h:102227).
- `StageInfoData.StageKey` @0x30 (int) — key; matches `CommonSaveData.currentStageKey`.
- `StageInfoData.WaveAmount` @0x54 (int) — **TOTAL waves** of the stage (the "29" in "1/29").
- `StageInfoData.WaveMonsterAmount` @0x58 (int) — **monsters per wave**. Total stage mobs = `WaveAmount * WaveMonsterAmount` (the "512" in "15/512"; see gotcha).
- `StageInfoData.STAGETYPE` @0x40 (EStageType), `.STAGEDIFFICULTY` @0x44 (ESTAGEDIFFICULTY), `.Act` @0x48, `.StageNo` @0x4C, `.StageLevel` @0x50, `.BossMonsterKey` @0x7C, `.NextStageKey` @0xA0 (all int) — useful metadata.
- `CommonSaveData.currentStageKey` @0x58 (int) — current stage. **Plain int, NOT Obscured.**
- `CommonSaveData.currentStageWave` @0x5C (int) — **live current wave** (the "1" in "1/29"). **Plain int.**
- `CommonSaveData.maxCompletedStage` @0x54 (int) — max progress.
- Internal layout of the inner `Dictionary<int,long>`: `_buckets`@0x10, `_entries`@0x18, `_count`@0x20, `_freeList`@0x24, `_freeCount`@0x28, `_version`@0x2C, `_comparer`@0x30. Entry (stride **24 bytes**, 8-aligned): `hashCode`@0x0, `next`@0x4, `key`@0x8, `value(long)`@0x10 (il2cpp.h:787129 + int64 alignment).

**Enums:**
- `EAggregateType` (dump.cs:336661) **[VERIFIED]**: MonsterKill=0, HeroDeath=1, GoldEarn=2, BoxObtain=3, ItemObtain=4, Synthesis=5, Alchemy=6, Crafting=7, Offering=8, Extraction=9, Decoration=10, Engraving=11, Inscription=12, StageClear=13, StageFail=14, PlayTime=15, BoxOpen=16.
- `EStageType` (dump.cs:355855) **[VERIFIED]**: NORMAL=0, ACTBOSS=1.
- `ESTAGEDIFFICULTY` (dump.cs:355843) **[VERIFIED]**: NORMAL=0, NIGHTMARE=1, HELL=2, TORMENT=3, COUNT=4.

**Read-only resolution:**

*For current-stage totals (WaveAmount / WaveMonsterAmount):*
1. Read `CommonSaveData.currentStageKey@0x58` (already resolved) and `currentStageWave@0x5C`.
2. Resolve the `yp` singleton: scan the `yp` class by name (obfuscated — see gotcha; better to anchor by some known field's string or by the table) -> `Il2CppClass.static_fields` -> read ptr @0x0 (`bbwf`) = the `yp` instance.
3. In the `yp` instance, read `List<StageInfoData> @0x80`: items@0x10, _size@0x18. For each element (object ptr), read `StageKey@0x30`; when `StageKey == currentStageKey`, you've found the `StageInfoData`.
4. In that `StageInfoData` read `WaveAmount@0x54` and `WaveMonsterAmount@0x58`.
5. UI: wave = `currentStageWave / WaveAmount`. Stage mobs = `WaveAmount * WaveMonsterAmount` (validate — see gotcha).

*For live aggregates (kills/gold/playtime):*
1. Resolve the `ut` singleton (same mechanics as StageManager): class `ut` -> `static_fields` -> ptr @0x0 = instance.
2. In the instance read `beid@0x20` = outer `Dictionary<EAggregateType,Dictionary<int,long>>`.
3. Walk the outer dict by entries (`_entries@0x18`, `_count@0x20`): each entry key=EAggregateType(int)@0x8, value=inner dict ptr@0x10.
4. Select the desired aggregate (e.g.: MonsterKill=0, GoldEarn=2, PlayTime=15), take the inner `Dictionary<int,long>`.
5. In the inner dict, walk entries (stride 24B): key(stageKey)@0x8, value(long)@0x10. Filter by `key==currentStageKey` for the current stage's value; or sum/iterate all for global totals.

**Gotchas / confidence:**
- **Obfuscated 2-letter names (`ut`, `yp`):** scanning by the class name string is fragile for such short names (high false-positive risk on the heap). Mitigation: anchor by the instantiated generic BASE class (`nn<ut>`/`nn<yp>` have distinct derived type names in the metadata) or validate the candidate by checking the expected field shape (e.g.: `ut` has exactly 2 fields: a Dictionary@0x20 + an Action@0x28; `yp` has ~60 List/Dictionary). **Medium confidence** only in the singleton-locating step; **high** once the instance is in hand.
- **"15/512" — formula not 100% confirmed:** `WaveMonsterAmount` is clearly *mobs per wave*; the total `WaveAmount*WaveMonsterAmount` is the natural interpretation but there's NO readable UI code proving it (the `StageWaveIconSliderController@348331` has only a float `Slider`, no counter). The "15" (current mob) probably comes from a live kill count in the stage — candidate: `ut.beid[MonsterKill][currentStageKey]` (long). **Medium confidence** in the formula; validate at runtime against the UI.
- **`currentStageWave` base (0 vs 1):** I didn't determine whether it's 0-based or 1-based. To display "1/29" you may need `+1`. **Medium confidence** — check empirically.
- **NOTHING is Obscured in this domain** (verified in il2cpp.h and the dump): the aggregate dict is plain `long`, StageInfoData/CommonSaveData fields are plain `int`. No XOR needed. **High confidence.**
- **State vs history:** `ut.beid` is a real PERSISTENT COUNTER (accumulated, saved aggregates), not UI-history. `CommonSaveData.currentStage*` is real persistent state. StageInfoData is a static DEFINITION (data-loaded table), immutable at runtime. **High confidence.**
- **`StageLevelInfoData`** has all fields obfuscated (`bfog`@0x30..`bfok`@0x40, all int) — I didn't map their meaning; probably not needed for wave/mob counts. Known gap.
- StageInfoData lookup is by **List iteration** (there's no `Dictionary<int,StageInfoData>` exposed on `yp`; there is a method `iue(int)` in dump.cs:332726 that does this internally). Iterating ~hundreds of entries is cheap. **High confidence.**