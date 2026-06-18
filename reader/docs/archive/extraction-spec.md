---
type: archive
status: superseded
description: "SNAPSHOT histórico (RE cru ou plano entregue) — nomes/offsets/linhas podem estar obsoletos; a verdade atual está nas notas vivas (ver _index). Isento do drift-test de código."
---

> **HISTORICAL (2026-06-02 RE spec).** Verified extraction spec — its offsets/enums are now codified in `config/offsets.py` (the live source of truth) and the implementation shipped (gold/xp/dps/build/stats/skills all live). Kept for provenance + the per-domain read-only viability/gotcha analysis. `dump.cs` line numbers are from the external Il2CppDumper output for GameAssembly.dll v1.00.07 (not committed in this repo). The preamble below is leftover from the generating workflow.

Final confirmations verbatim:
- **StageManager.HeroList@0x30** (Hero[]) — the foundational anchor. Confirmed.
- **`un` skill cache**: `begn@0x10` (SkillInfoData — the plain entry point), then ObscuredInt/Float fields. Confirmed. The findings' claim that `begn` is the non-obscured gateway is correct.

Note: the skills domain claimed `Unit.bcgl` is `Dictionary<int,ActiveSkill>` for skillKey→ActiveSkill — confirmed at 0x338. Also `MonsterList` is on a separate manager (MonsterSpawnManager) at @0x28 as `List<Unit>`, not on StageManager — the stats domain correctly noted this.

I have exhaustively verified every load-bearing enum and offset. Verification complete. Composing the final spec.

---

# SPEC DE EXTRACAO — TBH Run Meter (read-only)

## Resultado da verificacao cetica (linha-a-linha no dump.cs)

Verifiquei **todos** os enums e offsets load-bearing. Veredito: os 9 dominios estao **corretos**. Encontrei **3 erros de atribuicao** (nome/linha, nao offset) e **1 omissao valiosa**:

| # | Erro encontrado | Correcao (verificada no dump) |
|---|---|---|
| E1 | Equip-domain chamou a raiz do save de **`SaveContainer` (classe @328700)** | **NAO existe classe `SaveContainer`** (grep vazio). Linha 328700 e o comentario `// Fields` DENTRO de `PlayerSaveData` (328698). A raiz e **`PlayerSaveData`**; os offsets citados (`itemSaveDatas@0x80`, `heroSaveDatas@0x30`) estao **certos**, so o nome da classe estava trocado. |
| E2 | Mode-domain citou `public static class ud.tv` em **dump.cs:333405** | `333405`/`333390` sao as closures LINQ `ud.tv.tu`. A classe estatica `ud.tv` real esta em **333418** (verificado). `bebq@0x88`, `bebk@0x40` confirmados. |
| E3 | Composition-domain: "EHeroType e enum orfao, nao usar" | **CONFIRMADO E CORRETO** — porem note que **existe** `arrangedHeroKey` (int[]) usado de verdade (ver O1). EHeroType segue sendo armadilha; manter o aviso. |
| O1 (omissao) | Nenhum dominio citou a **composicao persistente da party** | `CommonSaveData.arrangedHeroKey@0x48` (int[], JsonProperty "arrangedHeroKey") — **fonte persistente dos herois slotados**, alternativa limpa a varrer `StageManager.HeroList`. Verificado linha 328598. |

Tudo o mais (cadeias de offset, layouts Obscured, dicts do `yp`, enums) bate **verbatim** com o dump. Itens-chave reconfirmados: `Hero.cache@0x3A0`→`uf.beew@0x30`→`HeroInfoData{HeroKey@0x30,ClassType@0x48}`; `StageManager.HeroList@0x30`; layouts ObscuredInt/Float (hidden@0x4,key@0x8) e ObscuredLong/ULong (hidden@0x8,key@0x10); `PlayerSaveData` (curreny@0x28/hero@0x30/pet@0x48/rune@0x50/item@0x80/aggregate@0x88).

---

## DOMINIOS — viabilidade, classes/offsets/enums (verificados), resolucao, gotchas

Convencao: **PLAIN** = leitura direta; **OBSC** = precisa XOR. Decrypt: `Int/Float real = read32(X+0x4) ^ read32(X+0x8)` (float via reinterpret); `Long/ULong real = read64(X+0x8) ^ read64(X+0x10)`.

### 1. MODO / Dificuldade — **VIAVEL (sim)**
- **Enum** `ESTAGEDIFFICULTY` (355843): NORMAL=0, NIGHTMARE=1, HELL=2, TORMENT=3, COUNT=4(sentinela).
- **Caminho PLAIN (recomendado):** `ud.tv` (static, 333418) → `static_fields+0x88` (`bebq`, StageCache*) → `+0x10` (`bebu`, StageInfoData*) → `+0x44` (`STAGEDIFFICULTY`, int32 PLAIN).
- **Resolucao:** ler `static_fields` da Il2CppClass `ud.tv`; se `bebq==null` (fora de batalha) → fallback Rota B (currentStageKey → varrer `ud.tv.bebk@0x40` Dict<int,StageCache>) ou ler `UI_Portal.m_currentStageDifficulty@0xB8`.
- **Gotchas:** `bebq` null no menu; `UI_Portal` e UI-state (so confiavel com portal aberto); achar classe estatica de nome curto "tv" e o unico passo novo (medio risco) — ancore por shape (2 Dicts + StageCache*) ou via `klass` de um StageCache vivo.

### 2. COMPOSICAO (party + classes) — **VIAVEL (sim)** — tudo PLAIN
- **Classes:** `StageManager.HeroList@0x30` (Hero[]); `Hero.cache@0x3A0`→`uf`; `uf.beew@0x30`→`HeroInfoData`.
- **Campos:** `HeroInfoData.HeroKey@0x30` (int), `ClassType@0x48` (`EEquipClassType`), `MainWeaponGearType@0x4C`/`SubWeaponGearType@0x50` (EGearType), `SkillKey@0x54`.
- **Enum** `EEquipClassType` (354930): All=0, Knight=1, Ranger=2, Sorcerer=3, Priest=4, Hunter=5, Slayer=6.
- **Resolucao:** HeroList → cada Hero → `+0x3A0`(uf) → `+0x30`(HeroInfoData) → ler HeroKey+ClassType. Validacao opcional via `yp.bfin@0xA8` (Dict<int,HeroInfoData>).
- **Fonte persistente alt.:** `CommonSaveData.arrangedHeroKey@0x48` (int[]) = herois slotados (O1).
- **Gotchas:** usar **EEquipClassType**, NUNCA EHeroType (orfao, verificado). `cache==null` em spawn/morte transitoria → pular ou usar arrangedHeroKey. `HeroNameKey` e chave de i18n, nao nome.

### 3. GOLD — **PARCIAL** (persistente PLAIN; runtime OBSC; agregado PLAIN)
- **GOLD atual (PLAIN, melhor):** `PlayerSaveData.currenySaveDatas@0x28` (List<CurrencySaveData>) → cada `CurrencySaveData{Key@0x10 int, Quantity@0x18 long}`. Gold = entry cujo Key = CurrencyKey do gold (descobrir empiricamente).
- **Gold/s:** derivar de delta de `Quantity` entre polls; OU usar agregado.
- **GoldEarn acumulado (PLAIN):** `ut` (singleton nn<ut>, 336558) → `beid@0x20` (Dict<EAggregateType,Dict<int,long>>) → bucket `GoldEarn=2` → long PLAIN.
- **GOLD runtime (OBSC, evitar):** classe `xg : ud.su` → `bdwn@0x28` (ObscuredLong) [XOR].
- **Enums:** `EAggregateType`(336661): MonsterKill=0,HeroDeath=1,**GoldEarn=2**,…PlayTime=15,BoxOpen=16. `EGoldCurrencySource`(334995): MonsterKill=1,CubeAlchemy=2,OfflineReward=3.
- **Gotchas:** runtime e Obscured (preferir save Quantity = mesmo numero); CurrencyKey do gold e **data-driven, sem enum** (descobrir 1x observando qual Quantity sobe ao matar mob; discriminador robusto runtime = tipo `xg`); `ry.total_gold_earned` e string de analytics, NAO contador. CommonSaveData NAO tem gold. Typo: `currenySaveDatas`.

### 4. XP — **VIAVEL (sim)** — PLAIN
- **Campos:** `PlayerSaveData.heroSaveDatas@0x30` (List<HeroSaveData>) → `HeroSaveData{heroKey@0x10, HeroLevel@0x14 int, HeroExp@0x1C float}` (PLAIN).
- **Curva (opcional p/ xp-to-next):** `yp.bfil@0x88` (Dict<int,LevelInfoData>) → `LevelInfoData{Level@0x10, ExpForLevelUp@0x14 int}`.
- **XP/s e XP total da run:** amostrar (HeroLevel,HeroExp) em t0/t1. Mesmo nivel: `exp1-exp0`. Cruzou nivel: `(ExpForLevelUp[lvl0]-exp0) + Σ(niveis intermediarios) + exp1`.
- **Gotchas:** HeroExp e **relativo ao nivel** (zera no level-up) — VALIDAR em runtime. NAO ha XP de conta (AccountSaveData sem XP — verificado). Espelho runtime em `uf` (befp..beft) e Obscured — ignorar. `CubeLevelSaveData.Exp` e do Cube, nao heroi.

### 5. STATS-POR-HEROI (64 stats) — **VIAVEL (sim)** — dict PLAIN
- **Caminho:** Hero `+0x3A0`(uf, e um `uo`) → `uo.<behg>@0x10` (xd*) → `xd.bets@0x18` (Dict<StatType,float> = **ficha final agregada**, PLAIN). (`bett@0x20` = cache secundario.)
- **Dict<StatType,float>:** `_entries@0x18`, `_count@0x20`. Entry stride 16: hashCode@0x0,next@0x4,key@0x8(StatType),value@0xC(float). Iterar count, pular hashCode<0.
- **Enum** `StatType` (336161): 64 valores 0-63 (NONE=0, AttackDamage=1, … MaxElementalDodgeChance=63). Mods: `MODTYPE`(FLAT=0,ADDITIVE=1,MULTIPLICATIVE=2), `MODSOURCE`(BASE=0,ITEM=1,…).
- **Gotchas:** **NAO** usar os 12 ObscuredFloat de `Unit@0x104` (nomes ofuscados, mapeamento indice→StatType incerto). `bets`=total e **confianca media** (nao provei o getter RVA; comparar com UI). Dict pode rehash → reler ponteiro a cada poll, filtrar slots livres. Estado runtime, nao persistente.

### 6. EQUIPAMENTOS — **PARCIAL** (topologia+catalogo PLAIN; instancia OBSC)
- **Equipados:** `HeroSaveData.equippedItemIds@0x28` (ulong[] = **UniqueId**, posicao=slot).
- **Catalogo (PLAIN):** via `ud.th.te.bdyd@0x10`→`ItemInfoData{ItemKey@0x30, GRADE@0x38, PARTS@0x3C, GEARTYPE@0x40, Level@0x6C, NameKey@0x50}`. Ou `PlayerSaveData.itemSaveDatas@0x80`→`ItemSaveData{ItemKey@0x10, UniqueId@0x18, EnchantData@0x30}` (PLAIN).
- **Instancia (OBSC):** `ud.th.te` (331532): 5×GearModData@0x58/88/B8/E8/118 (stride 0x30; cada = StatType/ModType/Value ObscuredInt), UniqueId `bdyr@0x148`(ObscuredULong), enchants `bdyv@0x190`, nivel/contadores `bdyw@0x198`/`bdyy@0x1B0`/`bdyz@0x1C0`/`bdza@0x1D0` (ObscuredInt).
- **Enums:** EGradeType(0-10), EItemParts(NONE=0..BRACER=10), EGearType(0-20), EGearGroup(0-4), EItemType(STAGEBOX=0,MATERIAL=1,GEAR=2,NONE=3).
- **Resolucao:** equippedItemIds(UniqueId) → casar com `te` (scan instancias por klass, ler `bdyr` apos XOR) ou com `itemSaveDatas` por UniqueId (PLAIN). Catalogo via `te.bdyd`.
- **Gotchas:** raridade/slot/tipo/nivel-base/enchants-persistidos = **100% PLAIN**; SO nivel-vivo/mods-rolados exigem XOR. equippedItemIds = UniqueId (NAO ItemKey). Qual ObscuredInt e o "nivel" (bdyw vs bdyy…) **nao isolado** — confirmar runtime. Dict interno `bdzo` chato → preferir scan de instancias.

### 7. DECORATIONS-ENGRAVINGS — **PARCIAL** (UI-history, sem run-id) — JA MAPEADO
- `LogManager.bepn@0x28` (Dict<ELogType,List<LogData>>); cube logs carregam EGradeType/ERecipeType PLAIN; **ItemKey/ItemUniqueId (CubeItemData) sao Obscured**; logs sao **historico de UI** (sem run-id → usar `DateTime@0x30` + deltas por tick).
- EGradeType(354944) e ERecipeType(354174) conforme summary.
- **Gotchas:** atribuir log↔run so por timestamp/janela temporal (heuristico). Para a "ficha por heroi", decorations APLICADAS vem melhor de `ItemSaveData.DecorationAppliedTotalCount@0x38`/`Engraving@0x3C`/`Inscription@0x40` (PLAIN, por item) do que dos logs.

### 8. RUNES-PETS — **VIAVEL (sim)** — account-wide, PLAIN
- `PlayerSaveData.PetSaveData@0x48` (List<PetSaveData{PetKey@0x10,IsUnlock@0x14,IsViewed@0x15}>); `RuneSaveData@0x50` (List<RuneSaveData{RuneKey@0x10,Level@0x14}>). Pet ativo: `CommonSaveData.ArrangedPetKey@0x40` (so 1).
- Stats numericos: tabelas estaticas (PetInfoData→PetStatInfoData; RuneLevelInfoData) usando `EAccountStatus` (0-41).
- **Gotchas:** runes/pets sao **account-wide, NAO por-heroi** (HeroSaveData sem campo rune/pet — verificado). Agregado runtime em `AccountStatus.betp@0x10` e Obscured (preferir SaveData+tabela). Sem campo "slot" em RuneSaveData. **Para um meter de RUN, baixa prioridade** (nao muda por run).

### 9. SKILLS — **VIAVEL (sim)** — SkillInfoData PLAIN; cache `un` OBSC
- **Equipadas (persist):** `HeroSaveData.equippedSKillKey@0x30` (int[] — note "K" maiusculo).
- **Runtime:** Hero(Unit) `bcgj@0x328` (List<ActiveSkill>) → `ActiveSkill.skillCache@0x18`(un) → `un.begn@0x10`(SkillInfoData PLAIN).
- **Info estatica:** `yp.bfim@0x90` (Dict<int,SkillInfoData>) por SkillKey → `SkillInfoData{SkillKey@0x30, ActivationType@0x48, DamageAttribute@0x50, DamageDeliveryType@0x54, SlotType@0x58, Param1-5@0x64-74, Value@0x80, SkillLevelKey@0x84}` (todos PLAIN).
- **Enums:** ACTIVATIONTYPE(BASEATTACK=0..CONTINUOUS=3), SLOTTYPE(BASEATTACK=0,SKILL=1), SkillBuffType(Normal=0,Buff=1).
- **Gotchas:** `m_DPS` do tooltip e **TextMeshPro (UI string)**, NAO numero/DPS real — para DPS use o meter (HP-delta dos Monsters). Cache `un` e Obscured → entrar por `begn`(SkillInfoData PLAIN). **Nivel da skill: lacuna** (nao esta em HeroSaveData; vive no `un` Obscured ou deriva de HeroLevel — investigar). Semantica de Param1-5/SkillLevelInfoData ofuscada.

### 10. AGREGADOS-STAGE-INFO — **VIAVEL (sim)** — PLAIN
- **Totais do stage:** `CommonSaveData.currentStageKey@0x58`/`currentStageWave@0x5C`/`maxCompletedStage@0x54` (PLAIN). `yp.stageInfoData@0x80` (List<StageInfoData>) → casar StageKey@0x30 → `WaveAmount@0x54`, `WaveMonsterAmount@0x58`.
- **Agregados vivos:** `ut.beid@0x20` → bucket por EAggregateType → Dict<int,long> (inner Entry stride **24**: key@0x8,value(long)@0x10).
- **Gotchas:** "15/512" (WaveAmount×WaveMonsterAmount) e interpretacao natural mas **nao provada por UI** (medio); `currentStageWave` 0-vs-1-based incerto (medio). Lookup de StageInfoData e por iteracao (sem Dict exposto). Tudo PLAIN.

---

## PLANO DE IMPLEMENTACAO (do mais facil/valioso ao mais dificil)

Anchor unico ja resolvido: **StageManager** (singleton nn<>) + **PlayerSaveData** (por string). Tudo abaixo pendura nesses dois.

### FASE 1 — Trivial + alto valor (so leitura de ponteiro/int, zero cripto)
1. **MODO** — `ud.tv.static_fields+0x88→+0x10→+0x44` (int). **[trivial; risco baixo-medio: localizar classe estatica "tv"]**
2. **COMPOSICAO/CLASSE** — `HeroList@0x30`→`Hero+0x3A0`→`+0x30`→`{HeroKey@0x30, ClassType@0x48}`. **[trivial; risco baixo]** — o coracao do "composicao/classe dos herois".
3. **GOLD total (persistente)** — `PlayerSaveData+0x28`→CurrencySaveData.Quantity@0x18 (long). **[trivial; gotcha: achar gold-key 1x empiricamente]**
4. **GoldEarn + GOLD/s** — `ut.beid@0x20`[GoldEarn=2] (long PLAIN) p/ total ganho; gold/s = delta de Quantity ou de GoldEarn por tick. **[trivial apos resolver singleton ut — mesma tecnica do StageManager]**
5. **XP total + XP/s** — `heroSaveDatas@0x30`→{HeroLevel@0x14, HeroExp@0x1C}; XP/s por delta. **[trivial; gotcha: somar curva ao cruzar nivel — VALIDAR reset em runtime]**
6. **STAGE/WAVE counters** — CommonSaveData currentStageKey/Wave + StageInfoData WaveAmount/WaveMonsterAmount. **[trivial; gotcha: formula "x/y" e wave-base validar runtime]**

### FASE 2 — Facil-medio (PLAIN, mais hops/iteracao de dict)
7. **STATS por heroi (64)** — `Hero+0x3A0→+0x10(xd)→+0x18(bets)` iterar Dict<StatType,float>. **[medio; precisa-de-RE leve: confirmar bets=total e stride em runtime; sem cripto]**
8. **EQUIP — ficha PLAIN (raridade/slot/tipo/nivel-base/enchants-persistidos)** — equippedItemIds@0x28 → casar com itemSaveDatas@0x80 (UniqueId) → ItemInfoData via catalogo. **[medio; PLAIN; gotcha: mapear UniqueId→ItemKey]**
9. **SKILLS equipadas + info estatica** — equippedSKillKey@0x30 (ou bcgj@0x328 runtime) → yp.bfim@0x90 → SkillInfoData (PLAIN). **[medio; gotcha: andar no Dict do yp]**
10. **DECORATIONS/ENGRAVINGS aplicadas (por item)** — ItemSaveData.{Decoration/Engraving/Inscription}AppliedTotalCount@0x38/3C/40 (PLAIN). **[medio; preferivel aos logs de UI]**

### FASE 3 — Dificil (exige XOR ACTk ou RE adicional)
11. **EQUIP — nivel-vivo + mods/stats rolados + UniqueId no `te`** — `ud.th.te` GearModData@0x58.. e ObscuredInt/ULong → XOR por instancia. **[precisa-de-RE/risco: qual ObscuredInt e o "nivel" nao isolado — confirmar runtime decriptando candidatos @0x198/0x1B0/0x1C0/0x1D0]**
12. **NIVEL de skill** — lacuna; vive no `un` (Obscured) ou deriva de HeroLevel. **[precisa-de-RE: investigar fonte; XOR se vier do `un`]**
13. **RUNES/PETS (ficha de stats)** — SaveData PLAIN (chave+nivel facil), mas stats numericos exigem cruzar tabelas CSV estaticas. **[medio-baixa prioridade p/ run: account-wide, nao muda por run]**

### INVIAVEL read-only (ou so via heuristica fraca)
- **DPS "oficial" por skill** — `SkillStatusDescriptionPanel.m_DPS` e string de UI renderizada (so existe com painel aberto); NAO e numero. DPS real so via meter proprio (HP-delta dos Monsters).
- **Atribuir decorations/engravings logados a uma RUN especifica** — `LogManager` logs sao **historico de UI sem run-id**; so da pra correlacionar por timestamp/janela (heuristico, nao confiavel). A contagem por-item (item #10) e a saida read-only correta.
- **Nome legivel (heroi/skill/item)** — só chaves de i18n (HeroNameKey/NameKey); precisa resolver string-table (fora do escopo de offsets; outra subsistema).
- **Stats "core" individuais de `Unit` (12 ObscuredFloat @0x104)** — mapeamento indice→StatType nao recuperavel so do dump; use `xd.bets` (#7) que ja da os 64 por StatType.

Arquivo de referencia (tudo verificado): `re/dump/dump.cs` (Il2CppDumper output da GameAssembly.dll v1.00.07; artefato externo de RE, não-commitado neste repo).