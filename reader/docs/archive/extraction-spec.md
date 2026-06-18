---
type: archive
status: superseded
description: "Historical SNAPSHOT (raw RE or delivered plan) — names/offsets/lines may be stale; the current truth lives in the live notes (see _index). Exempt from the code drift-test."
---

> **HISTORICAL (2026-06-02 RE spec).** Verified extraction spec — its offsets/enums are now codified in `config/offsets.py` (the live source of truth) and the implementation shipped (gold/xp/dps/build/stats/skills all live). Kept for provenance + the per-domain read-only viability/gotcha analysis. `dump.cs` line numbers are from the external Il2CppDumper output for GameAssembly.dll v1.00.07 (not committed in this repo). The preamble below is leftover from the generating workflow.

Final confirmations verbatim:
- **StageManager.HeroList@0x30** (Hero[]) — the foundational anchor. Confirmed.
- **`un` skill cache**: `begn@0x10` (SkillInfoData — the plain entry point), then ObscuredInt/Float fields. Confirmed. The findings' claim that `begn` is the non-obscured gateway is correct.

Note: the skills domain claimed `Unit.bcgl` is `Dictionary<int,ActiveSkill>` for skillKey→ActiveSkill — confirmed at 0x338. Also `MonsterList` is on a separate manager (MonsterSpawnManager) at @0x28 as `List<Unit>`, not on StageManager — the stats domain correctly noted this.

I have exhaustively verified every load-bearing enum and offset. Verification complete. Composing the final spec.

---

# EXTRACTION SPEC — TBH Run Meter (read-only)

## Skeptical-verification result (line-by-line against dump.cs)

I verified **all** load-bearing enums and offsets. Verdict: the 9 domains are **correct**. I found **3 attribution errors** (name/line, not offset) and **1 valuable omission**:

| # | Error found | Correction (verified against the dump) |
|---|---|---|
| E1 | Equip-domain called the save root **`SaveContainer` (class @328700)** | **No `SaveContainer` class exists** (empty grep). Line 328700 is the `// Fields` comment INSIDE `PlayerSaveData` (328698). The root is **`PlayerSaveData`**; the cited offsets (`itemSaveDatas@0x80`, `heroSaveDatas@0x30`) are **right**, only the class name was wrong. |
| E2 | Mode-domain cited `public static class ud.tv` at **dump.cs:333405** | `333405`/`333390` are the LINQ closures `ud.tv.tu`. The real static class `ud.tv` is at **333418** (verified). `bebq@0x88`, `bebk@0x40` confirmed. |
| E3 | Composition-domain: "EHeroType is an orphan enum, don't use it" | **CONFIRMED AND CORRECT** — but note that `arrangedHeroKey` (int[]) **does exist** and is genuinely used (see O1). EHeroType remains a trap; keep the warning. |
| O1 (omission) | No domain cited the **party's persistent composition** | `CommonSaveData.arrangedHeroKey@0x48` (int[], JsonProperty "arrangedHeroKey") — **persistent source of the slotted heroes**, a clean alternative to scanning `StageManager.HeroList`. Verified line 328598. |

Everything else (offset chains, Obscured layouts, the `yp` dicts, enums) matches the dump **verbatim**. Key items reconfirmed: `Hero.cache@0x3A0`→`uf.beew@0x30`→`HeroInfoData{HeroKey@0x30,ClassType@0x48}`; `StageManager.HeroList@0x30`; ObscuredInt/Float layouts (hidden@0x4,key@0x8) and ObscuredLong/ULong (hidden@0x8,key@0x10); `PlayerSaveData` (curreny@0x28/hero@0x30/pet@0x48/rune@0x50/item@0x80/aggregate@0x88).

---

## DOMAINS — viability, classes/offsets/enums (verified), resolution, gotchas

Convention: **PLAIN** = direct read; **OBSC** = needs XOR. Decrypt: `Int/Float real = read32(X+0x4) ^ read32(X+0x8)` (float via reinterpret); `Long/ULong real = read64(X+0x8) ^ read64(X+0x10)`.

### 1. MODE / Difficulty — **VIABLE (yes)**
- **Enum** `ESTAGEDIFFICULTY` (355843): NORMAL=0, NIGHTMARE=1, HELL=2, TORMENT=3, COUNT=4 (sentinel).
- **PLAIN path (recommended):** `ud.tv` (static, 333418) → `static_fields+0x88` (`bebq`, StageCache*) → `+0x10` (`bebu`, StageInfoData*) → `+0x44` (`STAGEDIFFICULTY`, int32 PLAIN).
- **Resolution:** read `static_fields` of the Il2CppClass `ud.tv`; if `bebq==null` (outside battle) → fall back to Route B (currentStageKey → scan `ud.tv.bebk@0x40` Dict<int,StageCache>) or read `UI_Portal.m_currentStageDifficulty@0xB8`.
- **Gotchas:** `bebq` is null in the menu; `UI_Portal` is UI-state (only reliable with the portal open); finding the short-named static class "tv" is the only new step (medium risk) — anchor by shape (2 Dicts + StageCache*) or via the `klass` of a live StageCache.

### 2. COMPOSITION (party + classes) — **VIABLE (yes)** — all PLAIN
- **Classes:** `StageManager.HeroList@0x30` (Hero[]); `Hero.cache@0x3A0`→`uf`; `uf.beew@0x30`→`HeroInfoData`.
- **Fields:** `HeroInfoData.HeroKey@0x30` (int), `ClassType@0x48` (`EEquipClassType`), `MainWeaponGearType@0x4C`/`SubWeaponGearType@0x50` (EGearType), `SkillKey@0x54`.
- **Enum** `EEquipClassType` (354930): All=0, Knight=1, Ranger=2, Sorcerer=3, Priest=4, Hunter=5, Slayer=6.
- **Resolution:** HeroList → each Hero → `+0x3A0`(uf) → `+0x30`(HeroInfoData) → read HeroKey+ClassType. Optional validation via `yp.bfin@0xA8` (Dict<int,HeroInfoData>).
- **Alt. persistent source:** `CommonSaveData.arrangedHeroKey@0x48` (int[]) = slotted heroes (O1).
- **Gotchas:** use **EEquipClassType**, NEVER EHeroType (orphan, verified). `cache==null` during transient spawn/death → skip or use arrangedHeroKey. `HeroNameKey` is an i18n key, not a name.

### 3. GOLD — **PARTIAL** (persistent PLAIN; runtime OBSC; aggregate PLAIN)
- **Current GOLD (PLAIN, best):** `PlayerSaveData.currenySaveDatas@0x28` (List<CurrencySaveData>) → each `CurrencySaveData{Key@0x10 int, Quantity@0x18 long}`. Gold = the entry whose Key = the gold's CurrencyKey (discover empirically).
- **Gold/s:** derive from the `Quantity` delta between polls; OR use the aggregate.
- **Accumulated GoldEarn (PLAIN):** `ut` (singleton nn<ut>, 336558) → `beid@0x20` (Dict<EAggregateType,Dict<int,long>>) → bucket `GoldEarn=2` → long PLAIN.
- **Runtime GOLD (OBSC, avoid):** class `xg : ud.su` → `bdwn@0x28` (ObscuredLong) [XOR].
- **Enums:** `EAggregateType`(336661): MonsterKill=0,HeroDeath=1,**GoldEarn=2**,…PlayTime=15,BoxOpen=16. `EGoldCurrencySource`(334995): MonsterKill=1,CubeAlchemy=2,OfflineReward=3.
- **Gotchas:** runtime is Obscured (prefer the save Quantity = same number); the gold's CurrencyKey is **data-driven, no enum** (discover once by watching which Quantity rises on a mob kill; the robust runtime discriminator = the `xg` type); `ry.total_gold_earned` is an analytics string, NOT a counter. CommonSaveData does NOT carry gold. Typo: `currenySaveDatas`.

### 4. XP — **VIABLE (yes)** — PLAIN
- **Fields:** `PlayerSaveData.heroSaveDatas@0x30` (List<HeroSaveData>) → `HeroSaveData{heroKey@0x10, HeroLevel@0x14 int, HeroExp@0x1C float}` (PLAIN).
- **Curve (optional for xp-to-next):** `yp.bfil@0x88` (Dict<int,LevelInfoData>) → `LevelInfoData{Level@0x10, ExpForLevelUp@0x14 int}`.
- **XP/s and run-total XP:** sample (HeroLevel,HeroExp) at t0/t1. Same level: `exp1-exp0`. Crossed a level: `(ExpForLevelUp[lvl0]-exp0) + Σ(intermediate levels) + exp1`.
- **Gotchas:** HeroExp is **relative to the level** (resets on level-up) — VALIDATE at runtime. There is NO account XP (AccountSaveData has no XP — verified). The runtime mirror in `uf` (befp..beft) is Obscured — ignore it. `CubeLevelSaveData.Exp` belongs to the Cube, not the hero.

### 5. PER-HERO STATS (64 stats) — **VIABLE (yes)** — PLAIN dict
- **Path:** Hero `+0x3A0`(uf, which is a `uo`) → `uo.<behg>@0x10` (xd*) → `xd.bets@0x18` (Dict<StatType,float> = **final aggregated sheet**, PLAIN). (`bett@0x20` = secondary cache.)
- **Dict<StatType,float>:** `_entries@0x18`, `_count@0x20`. Entry stride 16: hashCode@0x0,next@0x4,key@0x8(StatType),value@0xC(float). Iterate count, skip hashCode<0.
- **Enum** `StatType` (336161): 64 values 0-63 (NONE=0, AttackDamage=1, … MaxElementalDodgeChance=63). Mods: `MODTYPE`(FLAT=0,ADDITIVE=1,MULTIPLICATIVE=2), `MODSOURCE`(BASE=0,ITEM=1,…).
- **Gotchas:** do **NOT** use the 12 ObscuredFloat on `Unit@0x104` (obfuscated names, uncertain index→StatType mapping). `bets`=total is **medium confidence** (I didn't prove the getter RVA; compare against the UI). The dict can rehash → re-read the pointer every poll, filter free slots. Runtime state, not persistent.

### 6. EQUIPMENT — **PARTIAL** (topology+catalog PLAIN; instance OBSC)
- **Equipped:** `HeroSaveData.equippedItemIds@0x28` (ulong[] = **UniqueId**, position=slot).
- **Catalog (PLAIN):** via `ud.th.te.bdyd@0x10`→`ItemInfoData{ItemKey@0x30, GRADE@0x38, PARTS@0x3C, GEARTYPE@0x40, Level@0x6C, NameKey@0x50}`. Or `PlayerSaveData.itemSaveDatas@0x80`→`ItemSaveData{ItemKey@0x10, UniqueId@0x18, EnchantData@0x30}` (PLAIN).
- **Instance (OBSC):** `ud.th.te` (331532): 5×GearModData@0x58/88/B8/E8/118 (stride 0x30; each = StatType/ModType/Value ObscuredInt), UniqueId `bdyr@0x148`(ObscuredULong), enchants `bdyv@0x190`, level/counters `bdyw@0x198`/`bdyy@0x1B0`/`bdyz@0x1C0`/`bdza@0x1D0` (ObscuredInt).
- **Enums:** EGradeType(0-10), EItemParts(NONE=0..BRACER=10), EGearType(0-20), EGearGroup(0-4), EItemType(STAGEBOX=0,MATERIAL=1,GEAR=2,NONE=3).
- **Resolution:** equippedItemIds(UniqueId) → match against `te` (scan instances by klass, read `bdyr` after XOR) or against `itemSaveDatas` by UniqueId (PLAIN). Catalog via `te.bdyd`.
- **Gotchas:** rarity/slot/type/base-level/persisted-enchants = **100% PLAIN**; ONLY live-level/rolled-mods need XOR. equippedItemIds = UniqueId (NOT ItemKey). Which ObscuredInt is the "level" (bdyw vs bdyy…) is **not isolated** — confirm at runtime. The internal `bdzo` dict is a pain → prefer the instance scan.

### 7. DECORATIONS-ENGRAVINGS — **PARTIAL** (UI-history, no run-id) — ALREADY MAPPED
- `LogManager.bepn@0x28` (Dict<ELogType,List<LogData>>); cube logs carry EGradeType/ERecipeType PLAIN; **ItemKey/ItemUniqueId (CubeItemData) are Obscured**; logs are **UI history** (no run-id → use `DateTime@0x30` + per-tick deltas).
- EGradeType(354944) and ERecipeType(354174) per the summary.
- **Gotchas:** attributing log↔run is only by timestamp/time window (heuristic). For the "per-hero sheet", APPLIED decorations come better from `ItemSaveData.DecorationAppliedTotalCount@0x38`/`Engraving@0x3C`/`Inscription@0x40` (PLAIN, per item) than from the logs.

### 8. RUNES-PETS — **VIABLE (yes)** — account-wide, PLAIN
- `PlayerSaveData.PetSaveData@0x48` (List<PetSaveData{PetKey@0x10,IsUnlock@0x14,IsViewed@0x15}>); `RuneSaveData@0x50` (List<RuneSaveData{RuneKey@0x10,Level@0x14}>). Active pet: `CommonSaveData.ArrangedPetKey@0x40` (only 1).
- Numeric stats: static tables (PetInfoData→PetStatInfoData; RuneLevelInfoData) using `EAccountStatus` (0-41).
- **Gotchas:** runes/pets are **account-wide, NOT per-hero** (HeroSaveData has no rune/pet field — verified). The runtime aggregate in `AccountStatus.betp@0x10` is Obscured (prefer SaveData+table). No "slot" field in RuneSaveData. **For a RUN meter, low priority** (doesn't change per run).

### 9. SKILLS — **VIABLE (yes)** — SkillInfoData PLAIN; `un` cache OBSC
- **Equipped (persist):** `HeroSaveData.equippedSKillKey@0x30` (int[] — note the capital "K").
- **Runtime:** Hero(Unit) `bcgj@0x328` (List<ActiveSkill>) → `ActiveSkill.skillCache@0x18`(un) → `un.begn@0x10`(SkillInfoData PLAIN).
- **Static info:** `yp.bfim@0x90` (Dict<int,SkillInfoData>) by SkillKey → `SkillInfoData{SkillKey@0x30, ActivationType@0x48, DamageAttribute@0x50, DamageDeliveryType@0x54, SlotType@0x58, Param1-5@0x64-74, Value@0x80, SkillLevelKey@0x84}` (all PLAIN).
- **Enums:** ACTIVATIONTYPE(BASEATTACK=0..CONTINUOUS=3), SLOTTYPE(BASEATTACK=0,SKILL=1), SkillBuffType(Normal=0,Buff=1).
- **Gotchas:** the tooltip's `m_DPS` is **TextMeshPro (a UI string)**, NOT a number/real DPS — for DPS use the meter (Monsters' HP-delta). The `un` cache is Obscured → enter via `begn`(SkillInfoData PLAIN). **Skill level: a gap** (not in HeroSaveData; lives in the Obscured `un` or derives from HeroLevel — investigate). The semantics of Param1-5/SkillLevelInfoData are obfuscated.

### 10. AGGREGATES-STAGE-INFO — **VIABLE (yes)** — PLAIN
- **Stage totals:** `CommonSaveData.currentStageKey@0x58`/`currentStageWave@0x5C`/`maxCompletedStage@0x54` (PLAIN). `yp.stageInfoData@0x80` (List<StageInfoData>) → match StageKey@0x30 → `WaveAmount@0x54`, `WaveMonsterAmount@0x58`.
- **Live aggregates:** `ut.beid@0x20` → bucket by EAggregateType → Dict<int,long> (inner Entry stride **24**: key@0x8,value(long)@0x10).
- **Gotchas:** "15/512" (WaveAmount×WaveMonsterAmount) is the natural reading but **not proven against the UI** (medium); `currentStageWave` 0-vs-1-based is uncertain (medium). StageInfoData lookup is by iteration (no exposed Dict). All PLAIN.

---

## IMPLEMENTATION PLAN (easiest/highest-value to hardest)

Single anchor already resolved: **StageManager** (singleton nn<>) + **PlayerSaveData** (by string). Everything below hangs off these two.

### PHASE 1 — Trivial + high value (just pointer/int reads, zero crypto)
1. **MODE** — `ud.tv.static_fields+0x88→+0x10→+0x44` (int). **[trivial; low-medium risk: locating the static class "tv"]**
2. **COMPOSITION/CLASS** — `HeroList@0x30`→`Hero+0x3A0`→`+0x30`→`{HeroKey@0x30, ClassType@0x48}`. **[trivial; low risk]** — the heart of "hero composition/class".
3. **Total GOLD (persistent)** — `PlayerSaveData+0x28`→CurrencySaveData.Quantity@0x18 (long). **[trivial; gotcha: find the gold-key once, empirically]**
4. **GoldEarn + GOLD/s** — `ut.beid@0x20`[GoldEarn=2] (long PLAIN) for total earned; gold/s = Quantity or GoldEarn delta per tick. **[trivial once the ut singleton is resolved — same technique as StageManager]**
5. **Total XP + XP/s** — `heroSaveDatas@0x30`→{HeroLevel@0x14, HeroExp@0x1C}; XP/s by delta. **[trivial; gotcha: sum the curve when crossing a level — VALIDATE the reset at runtime]**
6. **STAGE/WAVE counters** — CommonSaveData currentStageKey/Wave + StageInfoData WaveAmount/WaveMonsterAmount. **[trivial; gotcha: validate the "x/y" formula and wave-base at runtime]**

### PHASE 2 — Easy-medium (PLAIN, more hops/dict iteration)
7. **Per-hero STATS (64)** — `Hero+0x3A0→+0x10(xd)→+0x18(bets)` iterate Dict<StatType,float>. **[medium; needs light RE: confirm bets=total and stride at runtime; no crypto]**
8. **EQUIP — PLAIN sheet (rarity/slot/type/base-level/persisted-enchants)** — equippedItemIds@0x28 → match against itemSaveDatas@0x80 (UniqueId) → ItemInfoData via the catalog. **[medium; PLAIN; gotcha: map UniqueId→ItemKey]**
9. **Equipped SKILLS + static info** — equippedSKillKey@0x30 (or bcgj@0x328 runtime) → yp.bfim@0x90 → SkillInfoData (PLAIN). **[medium; gotcha: walking the yp Dict]**
10. **Applied DECORATIONS/ENGRAVINGS (per item)** — ItemSaveData.{Decoration/Engraving/Inscription}AppliedTotalCount@0x38/3C/40 (PLAIN). **[medium; preferable to the UI logs]**

### PHASE 3 — Hard (requires XOR or extra RE)
11. **EQUIP — live-level + rolled mods/stats + UniqueId in `te`** — `ud.th.te` GearModData@0x58.. are ObscuredInt/ULong → XOR per instance. **[needs-RE/risky: which ObscuredInt is the "level" is not isolated — confirm at runtime by decrypting the candidates @0x198/0x1B0/0x1C0/0x1D0]**
12. **Skill LEVEL** — a gap; lives in the Obscured `un` or derives from HeroLevel. **[needs-RE: investigate the source; XOR if it comes from `un`]**
13. **RUNES/PETS (stat sheet)** — SaveData PLAIN (key+level easy), but the numeric stats require cross-referencing static CSV tables. **[medium-low priority for a run: account-wide, doesn't change per run]**

### NOT VIABLE read-only (or only via weak heuristics)
- **"Official" per-skill DPS** — `SkillStatusDescriptionPanel.m_DPS` is a rendered UI string (exists only with the panel open); NOT a number. Real DPS only via our own meter (Monsters' HP-delta).
- **Attributing logged decorations/engravings to a specific RUN** — `LogManager` logs are **UI history with no run-id**; you can only correlate by timestamp/window (heuristic, unreliable). The per-item count (item #10) is the correct read-only output.
- **Readable name (hero/skill/item)** — only i18n keys (HeroNameKey/NameKey); needs string-table resolution (out of scope for offsets; a different subsystem).
- **`Unit`'s individual "core" stats (12 ObscuredFloat @0x104)** — the index→StatType mapping is not recoverable from the dump alone; use `xd.bets` (#7), which already gives all 64 by StatType.

Reference file (all verified): `re/dump/dump.cs` (Il2CppDumper output of GameAssembly.dll v1.00.07; external RE artifact, not committed in this repo).