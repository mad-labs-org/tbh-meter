---
type: archive
status: superseded
description: "SNAPSHOT histórico (RE cru ou plano entregue) — nomes/offsets/linhas podem estar obsoletos; a verdade atual está nas notas vivas (ver _index). Isento do drift-test de código."
---

# TBH — Mapa de dados por run (read-only)

> Gerado por workflow (9 agentes sobre o dump IL2CPP), 2026-06-02. Confianca: CONFIRMADO=lido por nos / DUMP=offset no dump, nao probado / PROBE=incerto. Acessivel: sim / cuidado (via offset fixo a partir de classe legivel) / nao (ofuscado/criptografado).

Both critic claims verified: `struct ut_Fields : nn_ut__Fields` (PLAIN base) and `class ut : nn<ut>` (singleton via generic base, same as MonsterSpawnManager/LogManager). Both corrections are sound. Building the final consolidated table now.

## Resumo

**DURANTE A RUN: 36 itens** | **APOS A RUN: 78 itens** | **INACESSIVEL: 14 itens.** Correcoes aplicadas: `ut.beid` reclassificado de "so-disco" para fonte AO VIVO (singleton PLAIN); enum `EAggregateType` completado (HeroDeath=1, Synthesis=5, Alchemy=6, Crafting=7, Offering=8, Extraction=9, Decoration=10, Engraving=11, Inscription=12). Dedup feito (HeroExp/HeroLevel apareciam em ambas tabelas-base; mantidos em APOS como fonte persistida e em DURANTE so como delta de XP).

---

## DURANTE A RUN

| Info | Fonte (Classe.campo @0xNN, tipo) | Confianca | Acessivel | Obs |
|---|---|---|---|---|
| HP atual de cada mob | `pe(UnitHealthController).bcgy @0x40, float` (via `Unit.UnitHealthController@0xB0`) | CONFIRMADO | sim | NUCLEO DO METER. PLAIN. `pe` confirmado il2cpp.h:80063. Monstro usa subclasse `pc:pe`. Dano = soma das quedas de HP |
| HP max de cada mob | `pe.bchb @0x4C, float` | CONFIRMADO | sim | PLAIN |
| HP atual/max de cada heroi | `pe` via `Hero(Unit).UnitHealthController@0xB0` -> @0x40/@0x4C | CONFIRMADO | sim | PLAIN. Mesma classe `pe` p/ Hero e Monster |
| Nº de mobs vivos | `MonsterSpawnManager.MonsterList @0x28, List<Unit>` -> `_size@0x18` | CONFIRMADO | sim | PLAIN. Contagem = `_size` |
| Nº de mobs mortos (na run) | `MonsterSpawnManager.DeadMonsterUnit @0x30, List<Unit>` -> `_size@0x18` | CONFIRMADO | sim | PLAIN. Segrega mortos sem o `b_isLive` (Obscured) |
| Nº de mobs summonados | `MonsterSpawnManager.SummonedMonsterList @0x38, List<Unit>` -> `_size@0x18` | CONFIRMADO | sim | PLAIN |
| Lista de herois ativos | `StageManager.HeroList @0x30, Hero[]` | CONFIRMADO | sim | PLAIN. Ancora resolvida |
| Estado da unidade (idle/move/attack/die) | `Unit.state @0x354, EUNITSTATE(int)` | CONFIRMADO | sim | PLAIN (il2cpp.h:79902). NONE=0,IDLE=1,MOVE=2,RETURN=3,ATTACK=4,REVIVE=5,DIE=6 |
| Sub-estado de ataque | `Unit.attackState @0x358, EATTACKSTATE(int)` | CONFIRMADO | sim | PLAIN. PREDELAY=0, ACTIONTIME=1, POSTDELAY=2 |
| Esta atacando | `Unit.b_attacking @0x35D, bool` | CONFIRMADO | sim | PLAIN. `b_updateUnit@0x35C` tambem PLAIN |
| StatusEffectManager (debuffs elementais) | `Unit.StatusEffectManager @0xC0, wg` | CONFIRMADO | sim | ponteiro PLAIN |
| BuffManager (buffs ativos) | `Unit.BuffManager @0xC8, wm` | CONFIRMADO | sim | ponteiro PLAIN |
| Heroi: FICHA COMPLETA (64 stats, total agregado) | `Hero.cache(uf)@0x3A0 -> uo.behg@0x10 (xd) -> xd.bets@0x18, Dict<StatType,float>` | CONFIRMADO | cuidado | bets=final. Cadeia uf/uo/xd (2 letras) por offset fixo. Dict PLAIN: _entries@0x18,_count@0x20; Entry stride16 {hash@0x0,next@0x4,key@0x8(StatType),value@0xC(float)} |
| Heroi: identidade (HeroKey) | `Hero.cache(uf)@0x3A0 -> uf.beew@0x30 (HeroInfoData) -> HeroKey@0x30 (int)` | CONFIRMADO | cuidado | Passa por uf/beew por offset fixo. HeroInfoData legivel por nome |
| Heroi: CLASSE/JOB | `HeroInfoData.ClassType @0x48 (EEquipClassType=int)` via `Hero.cache@0x3A0 -> beew@0x30` | CONFIRMADO | cuidado | All=0,Knight=1,Ranger=2,Sorcerer=3,Priest=4,Hunter=5,Slayer=6. NAO usar EHeroType (orfao) |
| Skills ativas em runtime | `Unit.bcgj @0x328, List<ActiveSkill>`; `Unit.bcgl @0x338, Dictionary<int,ActiveSkill>` | CONFIRMADO | cuidado | ponteiros PLAIN. Entrada via `ActiveSkill.skillCache(un).begn@0x10` (SkillInfoData PLAIN) |
| Item: 5 stats rolados (mods) | `ud.th.te.bdym@0x58, bdyn@0x88, bdyo@0xB8, bdyp@0xE8, bdyq@0x118 (GearModData, stride 0x30)` | CONFIRMADO | cuidado | Cada GearModData = StatType@0x0 + ModType@0x10 + Value@0x20, TODOS ObscuredInt (XOR). MODTYPE: FLAT=0,ADDITIVE=1,MULTIPLICATIVE=2 |
| Item: UniqueId (objeto runtime) | `ud.th.te.bdyr @0x148 (ObscuredULong)` | CONFIRMADO | cuidado | XOR (real = read64(X+0x8) ^ read64(X+0x10)). P/ casar prefira ItemSaveData.UniqueId (PLAIN) |
| Item runtime: gateway catalogo (sem cripto) | `ud.th.te.bdyd @0x10 (ItemInfoData*, PLAIN)` | CONFIRMADO | cuidado | te obfuscada; bdyd da raridade/slot/tipo/nivel/nome sem XOR |
| Item: mods runtime (alternativa obscured) | `ud.th.te.bdyv @0x190 (ud.th.ItemEnchantData[])` | CONFIRMADO | cuidado | 6x ObscuredInt {StatModKey@0x0,Tier@0x10,Value@0x20,RecipeType@0x30,ModType@0x40,StatType@0x50}+MaterialKey@0x60(int PLAIN). Prefira ItemSaveData.EnchantData (PLAIN) |
| XP da run (delta) | `HeroSaveData.HeroExp@0x1C (float)` + `HeroLevel@0x14 (int)` | CONFIRMADO | sim | XP da run = somar deltas de HeroExp dos herois usados entre snapshots. Fonte persistida na secao APOS |
| Kills/gold/box da run AO VIVO (contador live) | `ut.beid @0x20, Dict<EAggregateType,Dict<int,long>>` -> chave externa (ex. `MonsterKill=0`) -> Dict<int,long> (SubKey->count) | DUMP | cuidado | **CORRIGIDO**: PLAIN (long sem XOR, confirmado `struct ut_Fields : nn_ut__Fields` il2cpp.h:89931). `ut : nn<ut>` SINGLETON (mesma base `nn<a>` de MonsterSpawnManager/LogManager; instancia em `nn<ut>.bbwf@0x0` via getter `brca`/`gbx()`). NAO resolver por string (nome "ut") -> via static do generic `nn<ut>`. Getter: `jly(type,subkey)`. Espelho live exato do `aggregateSaveDatas`. Tick a tick, nao so no clear |
| Pet vivo na run (instancia runtime) | `StageManager.bcsw @0xD8, Pet` | DUMP | cuidado | ponteiro PLAIN. `Pet` MonoBehaviour LEGIVEL: `belm(Unit owner)@0x40, beln(petKey int)@0x48, belo(StageManager)@0x50`. So 1 pet/run (= ArrangedPetKey). Pet NAO contribui dano/stat por-run (cosmetico; stat account-wide) |
| Outros floats de HP (regen/buffer/shield-hp) | `pe.bcgw@0x38, bcgx@0x3C, bcgz@0x44, bcha@0x48 (float)` | DUMP | sim | PLAIN, semantica nao isolada (provavel regen/last-damage/delayed-hp-bar) |
| Flag de boss-wave forcado | `MonsterSpawnManager.IsForceEnterBossWave @0x40, bool` | DUMP | sim | PLAIN |
| Stage iniciado | `StageManager.b_StageStart @0x98, bool` | DUMP | sim | PLAIN |
| Unidades por lado (Hero/Monster/Structure) | `StageManager.bcsl @0x58, Dictionary<DamageableType, HashSet<bci>>` | DUMP | cuidado | PLAIN porem dict+HashSet trabalhoso. Prefira MonsterSpawnManager/HeroList |
| Tipo de monstro / boss vivo | `Monster.MonsterType @0x3B8, EMonsterType(int)` | DUMP | cuidado | PLAIN. MONSTER=0, BOSS=1. Itere MonsterList; offset fixo a partir de Monster. `Monster.cache@0x3B0` (ud.tl) Obscured -> nao usar |
| Monster: params de spawn (scaling) | `Monster.bcek@0x3BC(int), bcel@0x3C0(int), bcem@0x3C4(float), bcei@0x3A0(long), bcej@0x3A8(float), bcen@0x3C8(EStageType), bceo@0x3CC(int)` | DUMP | cuidado | TODOS PLAIN (`Monster_Fields`, NAO Obscured). Setados em `gpc(...)`. Semantica exata de cada int nao isolada (provavel key/level/stageLevel); IDENTIDADE limpa so via cache Obscured -> evitar. Use p/ detectar boss-scaling sem cripto |
| Contagem de cada debuff ativo | `wg.besa @0x30, Dictionary<StatusEffectType,int>` | DUMP | cuidado | PLAIN (int em claro). Chill=101,Freeze=102,Ignite=103,Shock=104,Bleed=105,Stun=106 |
| Instancias de debuff ativas | `wg.berz @0x28, Dictionary<StatusEffectType,Dictionary<int,wf>>` | DUMP | cuidado | PLAIN; aninhado. Cada `wf` carrega timers/mods |
| Debuff: timers/duracao/stacks | `wf.bern@0x18..berq@0x24, bers@0x30, bert@0x34(float); beru@0x38(bool); berv@0x3C(int stacks); berm@0x10(target); berr@0x28(List<up> mods); berw@0x40(float)` | DUMP | cuidado | PLAIN. Props `brst`(float dur)/`brsu`(bool active) confirmam legibilidade. Qual float=remaining nao isolado |
| Buffs ativos (por buffKey) | `wm.besv @0x30 / besw @0x38, Dictionary<int,wk>` | DUMP | cuidado | PLAIN. `wm.besu@0x28`(int)=contador |
| Buff: chave/stacks/mods/source | `wk.besj@0x20(int key), besk@0x28(List<up> mods), besp@0x4C(int), besq@0x50(MODSOURCE)` | DUMP | sim | PLAIN. `List<up>` = modificadores de stat aplicados |
| Escudo/absorcao de dano | `Unit.bcew @0xF8, DamageAbsorbComponent -> bgca@0x38/bgcb@0x3C/bgcc@0x40 (float)` | DUMP | cuidado | ponteiro PLAIN; floats PLAIN. `originLifeTime@0x54`,`existLifeTime@0x50` PLAIN. Null se sem escudo. Qual float=absorb-atual nao isolado |
| Caches multiplicador/resistência por-elemento (build state, NÃO dano) | `Unit.bcgc@0x2A8/bcgd@0x2B0/bcge@0x2B8/bcgf@0x2C0, Dictionary<EDamageAttribute,float>` | CONFIRMADO | cuidado | ⚠ LIVE-CRACKED 2026-06-05: NÃO é "dano acumulado" (rótulo antigo errado). São caches de MULTIPLICADOR/RESISTÊNCIA (build state) — `@0x2C0` lê o cap de resist elemental ({Phys=0,Fire=75,…}) e `@0x2B0` pode ser NEGATIVO (debuff). Dano por-elemento/atributo NÃO é extraível read-only (só o transiente DamageInfo). Ver damage-model.md. Physical=0,Fire=1,Cold=2,Lightning=3,Chaos=4 |
| Resistencias/reducao por elemento | `Unit.bcfr@0x260, Dictionary<EDamageAttribute,float>` | DUMP | cuidado | PLAIN. P/ ficha completa use `xd.bets` |
| Contador de ataque normal | `Unit.bcgo@0x360 / bcgp@0x364, int` (privados) | DUMP | cuidado | PLAIN; provavel count atual/max do multi-hit. Validar |
| Heroi: 2o cache de stats | `xd.bett @0x20 (Dictionary<StatType,float>)` | DUMP | cuidado | Cache secundario (provavel base/pre-mod). Validar vs UI |
| Item: classe-restricao (runtime) | `ud.th.te.bdyh @0x30 (EEquipClassType=int, PLAIN)` | DUMP | cuidado | Qual classe pode usar; PLAIN dentro do te |
| Item: nivel-vivo + contadores de enchant | `ud.th.te.bdyw@0x198, bdyy@0x1B0, bdyz@0x1C0, bdza@0x1D0 (ObscuredInt)` | DUMP | cuidado | XOR. Qual e o "nivel" nao isolado. Prefira contadores persistidos |
| XP por monstro (template) | `MonsterInfoData.RewardExp@0x48 (int)` | DUMP | cuidado | Base por MonsterKey; boss x `StageInfoData.BossExpMultiplier@0x88`. Creditado ao vivo nos herois |
| Ouro por monstro (template) | `MonsterInfoData.RewardGold@0x44 (int)` | DUMP | cuidado | Base por MonsterKey (antes de multiplicadores). Boss x `BossGoldMultiplier@0x84`. Prever, nao ler real |
| Drop REAL daquela run (item que caiu) | `StageBox.OnGetItemWithOpenBox(Action<ulong>)`; item entra em `LocalInventoryManager` | PROBE | nao | id ulong entregue ao abrir box; vira ItemInfoData no Dict obfuscado. So por delta de inventario / hook |

---

## APOS A RUN

| Info | Fonte (Classe.campo @0xNN, tipo) | Confianca | Acessivel | Obs |
|---|---|---|---|---|
| stageState (fase do stage) | `StageManager.stageState @0x78, EStageState(int)` | CONFIRMADO | sim | PLAIN. NONE=0, MONSTERSPAWN=1, BATTLE=2, REORGANIZATION=3 |
| Lista de eventos da run (todos os logs) | `LogManager.bepm (List<LogData>) @0x20` | CONFIRMADO | sim | Singleton via string "LogManager". _items@0x10/_size@0x18. Cap 2000 (bepl). Tem Dict<ELogType,List<LogData>>@0x28 e List<LogData>@0x30 (pendentes) |
| Tipo de cada log (qual evento) | `LogData.klass @0x0 (ponteiro Il2CppClass)` | CONFIRMADO | sim | ELogType NAO e campo (virtual jsy() strippado). Classifique por klass@0x0. None=0,StageClear=1,GetItemWithBoxOpen=2,GetBox=3,HeroDie=4,HeroResurrection=5,HeroLevelUp=6,StageFailed=7,Synthesis=8,Alchemy=9,Decoration=10,Engraving=11,Inscription=12,Offering=13,Crafting=14,Extraction=15 |
| StageClear: act limpo | `StageClearLog.beqc (int) @0x40` | CONFIRMADO | sim | .ctor(clearTime, act, stage, isActBoss). NAO carrega ouro/drop |
| StageClear: stage limpo | `StageClearLog.beqd (int) @0x44` | CONFIRMADO | sim | |
| StageClear: tempo de clear (s) | `StageClearLog.beqe (int) @0x48` | CONFIRMADO | sim | .ctor recebe float, grava int. Unico "best clear time" do jogo (so runtime, nao persiste em disco) |
| StageClear: foi boss de act | `StageClearLog.beqf (bool) @0x4C` | CONFIRMADO | sim | |
| Common save (sub-raiz) | `PlayerSaveData.commonSaveData @0x10 (CommonSaveData)` | CONFIRMADO | sim | Sanity-check do PlayerSaveData certo: leia currentStageKey e cruze com stage atual |
| Lista de moedas | `PlayerSaveData.currenySaveDatas @0x28 (List<CurrencySaveData>)` | CONFIRMADO | sim | OURO aqui (Key 100001). Typo "curreny". Instancia viva = a de MAIOR ouro |
| Lista de herois (save) | `PlayerSaveData.heroSaveDatas @0x30 (List<HeroSaveData>)` | CONFIRMADO | sim | Level/exp/itens/skills por heroi |
| Itens (todas instancias) | `PlayerSaveData.itemSaveDatas @0x80 (List<ItemSaveData>)` | CONFIRMADO | sim | Registro persistente de todo item por UniqueId |
| PlayTime total | `CommonSaveData.playTime @0x20 (float)` | CONFIRMADO | sim | Segundos acumulados; delta entre polls ~ tempo da run |
| Party persistida (herois slotados) | `CommonSaveData.arrangedHeroKey @0x48 (int[])` | CONFIRMADO | sim | Herois na party (1-3); alternativa limpa a StageManager.HeroList |
| Maior stage concluido (highscore de progresso) | `CommonSaveData.maxCompletedStage @0x54 (int)` | CONFIRMADO | sim | Melhor progresso persistido (nao e tempo) |
| Stage atual (key) | `CommonSaveData.currentStageKey @0x58 (int)` | CONFIRMADO | sim | Cruza com StageInfoData.StageKey; DEFASADO entre saves |
| Wave atual | `CommonSaveData.currentStageWave @0x5C (int)` | CONFIRMADO | sim | DEFASADO entre saves; base 0-vs-1 incerta. (Sem contador limpo de wave em runtime — so slider UI float) |
| Currency: chave da moeda | `CurrencySaveData.Key @0x10 (int)` | CONFIRMADO | sim | OURO = 100001 (data-driven). UNICA currency real do jogo |
| Currency: quantidade (ouro) | `CurrencySaveData.Quantity @0x18 (long)` | CONFIRMADO | sim | OURO atual (plain long); gold/s = delta entre polls. Ganho da run = Quantity(agora) - Quantity(inicio) |
| Heroi (key) | `HeroSaveData.heroKey @0x10 (int)` | CONFIRMADO | sim | Identidade |
| Heroi: nivel | `HeroSaveData.HeroLevel @0x14 (int)` | CONFIRMADO | sim | Plain. Runtime mirror uf.befp@0xCC e ObscuredInt -> evitar |
| Heroi: exp | `HeroSaveData.HeroExp @0x1C (float)` | CONFIRMADO | sim | XP relativo ao nivel (zera no level-up); delta = XP da run |
| Heroi: itens equipados (UniqueIds) | `HeroSaveData.equippedItemIds @0x28 (ulong[])` | CONFIRMADO | sim | UniqueId por slot (NAO ItemKey). Casar com ItemSaveData/te por UniqueId |
| Item: catalogo-key | `ItemSaveData.ItemKey @0x10 (int)` | CONFIRMADO | sim | Plain (no save NAO e Obscured) |
| Item: UniqueId | `ItemSaveData.UniqueId @0x18 (ulong)` | CONFIRMADO | sim | Casa com equippedItemIds |
| Item: raridade/slot/tipo/nivel-base/nome (catalogo) | `ItemInfoData @0x30+: ItemKey@0x30, ITEMTYPE@0x34, GRADE@0x38, PARTS@0x3C, GEARTYPE@0x40, GearGroup@0x44, NameKey@0x50, GearKey@0x60, Level@0x6C` | CONFIRMADO | sim | Catalogo keyed por ItemKey. EItemParts(slot): NONE=0,MAIN_WEAPON=1,SUB_WEAPON=2,HELMET=3,ARMOR=4,GLOVES=5,BOOTS=6,AMULET=7,EARING=8,RING=9,BRACER=10. Via te.bdyd@0x10 ou catalogo por ItemKey |
| Item: ENCHANTS/DECORATIONS/ENGRAVINGS/INSCRIPTIONS (persist) | `ItemSaveData.EnchantData @0x30 (ItemEnchantSaveData[], PLAIN)` | CONFIRMADO | sim | CHAVE: cada entry {StatModKey@0x0,Tier@0x4,Value@0x8,RecipeType@0xC,ModType@0x10,MaterialKey@0x14,StatType@0x18}, TODOS int PLAIN. RecipeType discrimina (Decoration=3,Engraving=4,Inscription=5). NAO sao classes separadas |
| Item: contadores totais aplicados | `ItemSaveData.DecorationAppliedTotalCount @0x38, EngravingAppliedTotalCount @0x3C, InscriptionAppliedTotalCount @0x40 (int)` | CONFIRMADO | sim | Count agregado por tipo; mods reais em EnchantData[]. EnchantCount@0x28 (int[]) = contagem por slot |
| Heroi: pontos de atributo | `HeroSaveData.AbilityPoint @0x20 (int), AllocatedHeroAbilityPoint @0x24 (int), unlockedAttributeGroupKeys @0x38 (int[])` | CONFIRMADO | sim | Arvore de atributos investidos (PLAIN, no save) |
| Heroi: stats-base do catalogo | `HeroInfoData @0x58..0x78: AttackDamage@0x58, AttackSpeed@0x5C, CastSpeed@0x60, CriticalChance@0x64, CriticalDamage@0x68, CooldownReduction@0x6C, MaxHp@0x70, Armor@0x74, MovementSpeed@0x78 (int)` | CONFIRMADO | cuidado | Valores BASE da classe (catalogo), nao total. Via cache(uf)@0x3A0->beew@0x30 |
| Versao do save | `CommonSaveData.version @0x10 (string)` | DUMP | sim | Metadado |
| Ultimo save (epoch) | `CommonSaveData.lastSavedTime @0x18 (long)` | DUMP | sim | Timestamp |
| Pet ativo (arranjado) | `CommonSaveData.ArrangedPetKey @0x40 (int)` | DUMP | sim | O unico pet ativo na run |
| Estatisticas acumuladas (persist) | `PlayerSaveData.aggregateSaveDatas @0x88 (List<AggregateSaveData>)` | DUMP | sim | Espelho EM DISCO do runtime `ut.beid`. Delta entre polls = contribuicao da run. P/ AO VIVO use `ut.beid` (secao DURANTE) |
| Agregado: tipo | `AggregateSaveData.Type @0x10 (int = EAggregateType)` | DUMP | sim | **CORRIGIDO (completo)**: MonsterKill=0, HeroDeath=1, GoldEarn=2, BoxObtain=3, ItemObtain=4, Synthesis=5, Alchemy=6, Crafting=7, Offering=8, Extraction=9, Decoration=10, Engraving=11, Inscription=12, StageClear=13, StageFail=14, PlayTime=15, BoxOpen=16. HeroDeath=1 da deaths-da-run por delta sem parsear HeroDieLog |
| Agregado: SubKey | `AggregateSaveData.SubKey @0x14 (int)` | DUMP | sim | Discriminador secundario (ex.: stageKey/monsterKey por bucket) |
| Agregado: valor acumulado | `AggregateSaveData.Value @0x18 (long)` | DUMP | sim | Contador total persistido (plain long); espelho em disco do runtime `ut.beid` |
| Heroi: desbloqueado | `HeroSaveData.IsUnLock @0x18 (bool)` | DUMP | sim | Flag |
| Heroi: skills equipadas | `HeroSaveData.equippedSKillKey @0x30 (int[])` | DUMP | sim | SkillKeys (sic "SKill"). Info estatica via yp.bfim@0x90 (Dict<int,SkillInfoData>) |
| Heroi: grupos de atributo desbloqueados | `HeroSaveData.unlockedAttributeGroupKeys @0x38 (int[])` | DUMP | sim | Passives desbloqueadas do heroi |
| Item: flags | `ItemSaveData.IsChaotic@0x20 / IsBlocked@0x21 / IsServerPendingItem@0x22 (bool)` | DUMP | sim | Estado do item |
| Item: contagem de enchant | `ItemSaveData.EnchantCount @0x28 (int[])` | DUMP | sim | Plain |
| Enchant entry (struct PLAIN) | `ItemEnchantSaveData @0x0/0x4/0x8/0xC/0x10/0x14/0x18 (StatModKey/Tier/Value/RecipeType/ModType/MaterialKey/StatType, int)` | DUMP | sim | stride 0x1C; contraste com runtime `te` Obscured. ERecipeType: ALCHEMY=0,SYNTHESIS=1,CRAFTING=2,DECORATION=3,ENGRAVING=4,INSCRIPTION=5,OFFERING=6,EXTRACTION=7,NONE=8 |
| Atributos investidos (passive tree) | `PlayerSaveData.attributeSaveDatas @0x40 (List<AttributeSaveData>)` | DUMP | sim | AttributeSaveData{Key@0x10, Level@0x14}; account-wide; afeta stats da run |
| Pet: stats que o pet concede (catalogo) | `PetStatInfoData.StatType @0x34 (EAccountStatus), MODTYPE @0x38, Value @0x3C (int)`; ligado por `PetInfoData.StatDataKey @0x48` | DUMP | sim | Bonus do pet e ACCOUNT-wide (EAccountStatus, nao StatType de combate). Entra na ficha (`xd.bets`), nao e per-run. `PetInfoData{PetKey@0x30,NameKey@0x38,StatDataKey@0x48,UnlockCondition@0x4C}` keyed por nome |
| Pets (save) | `PlayerSaveData.PetSaveData @0x48 (List<PetSaveData>)` | DUMP | sim | PetSaveData{PetKey@0x10, IsUnlock@0x14, IsViewed@0x15}; account-wide. Sem nivel no save |
| Runas (save) | `PlayerSaveData.RuneSaveData @0x50 (List<RuneSaveData>)` | DUMP | sim | RuneSaveData{RuneKey@0x10, Level@0x14}; account-wide |
| Inventario (bag slots) | `PlayerSaveData.inventorySaveDatas @0x58 (List<InventorySaveData>)` | DUMP | sim | InventorySaveData{Index@0x10, ItemUniqueId@0x18, IsUnlock@0x20, IsUnlockedByRune@0x21} |
| Caixas pendentes (boxes) | `PlayerSaveData.BoxData @0x20 (SerializedBoxData)` | DUMP | sim | SerializedBoxData{BoxTypes:List<EBoxType>@0x10, BoxUniqueId:List<ulong>@0x18}; loot ainda nao aberto |
| Monster: nome + stats-base do catalogo | `MonsterInfoData.MonsterName @0x38 (string), AttackDamage @0x58, AttackSpeed @0x5C, MaxLife @0x60, MovementSpeed @0x64 (int), RewardGold @0x44, RewardExp @0x48 (int)` | DUMP | sim | Catalogo keyed por MonsterKey (classe LEGIVEL por nome). Da nome+stats-base de cada mob do `StageInfoData.Monsters` (CSV). MONSTERTYPE@0x40, SkillKey@0x50, DeadSoundKey@0x68 |
| StageInfoData da run (resolver por nome) | `StageInfoData.StageKey @0x30, int` | DUMP | sim | Varra string "StageInfoData" -> Il2CppClass -> instancia com StageKey@0x30 == currentStageKey. base `ze` so static consts (offsets 0x30+ autoritativos) |
| Stage: nome (loc key) | `StageInfoData.StageNameKey @0x38, string` | DUMP | sim | Chave de localizacao |
| Stage: tipo | `StageInfoData.STAGETYPE @0x40, EStageType` | DUMP | sim | NORMAL=0, ACTBOSS=1 |
| Stage: dificuldade | `StageInfoData.STAGEDIFFICULTY @0x44, ESTAGEDIFFICULTY` | DUMP | sim | NORMAL=0, NIGHTMARE=1, HELL=2, TORMENT=3. Bate com UI_Portal.m_currentStageDifficulty@0xB8 |
| Stage: act | `StageInfoData.Act @0x48, int` | DUMP | sim | |
| Stage: StageNo | `StageInfoData.StageNo @0x4C, int` | DUMP | sim | Numero do stage dentro do ato |
| Stage: StageLevel | `StageInfoData.StageLevel @0x50, int` | DUMP | sim | Nivel/escala (scaling de mob) |
| Stage: WaveAmount | `StageInfoData.WaveAmount @0x54, int` | DUMP | sim | Numero de waves |
| Stage: WaveMonsterAmount | `StageInfoData.WaveMonsterAmount @0x58, int` | DUMP | sim | Total mobs = WaveAmount x WaveMonsterAmount (normal; boss a parte) |
| Stage: pool de mobs | `StageInfoData.Monsters @0x60, string` | DUMP | sim | CSV de keys de monstro do spawn |
| Stage: MonsterDropItemKey | `StageInfoData.MonsterDropItemKey @0x68, int` | DUMP | sim | Item dropado por mob comum |
| Stage: FirstClearDropKey | `StageInfoData.FirstClearDropKey @0x6C, int` | DUMP | sim | Recompensa de 1o clear (uma vez); gatilho StageManager.OnFirstClearStage(Action)@0xF8 |
| Stage: MonsterDropItemRate | `StageInfoData.MonsterDropItemRate @0x70, int` | DUMP | sim | Taxa de drop do mob |
| Stage: BossDropItemRate | `StageInfoData.BossDropItemRate @0x74, int` | DUMP | sim | Taxa de drop do boss |
| Stage: BossDropItemKey | `StageInfoData.BossDropItemKey @0x78, int` | DUMP | sim | Item dropado pelo boss |
| Stage: BossMonsterKey | `StageInfoData.BossMonsterKey @0x7C, int` | DUMP | sim | Key do boss (0/ausente quando sem boss) |
| Stage: multiplicadores de boss | `StageInfoData.BossDamageMultiplier@0x80, BossGoldMultiplier@0x84, BossExpMultiplier@0x88, BossHpMultiplier@0x8C, BossScale@0x90 (int)` | DUMP | sim | |
| Stage: SoulStoneItemKey | `StageInfoData.SoulStoneItemKey @0x94, int` | DUMP | sim | Key da soul stone desta run. SOULSTONE=1 em EMaterialType |
| Stage: SoulStoneAmount | `StageInfoData.SoulStoneAmount @0x98, int` | DUMP | sim | Quantidade de soul stone |
| Stage: IsDemo | `StageInfoData.IsDemo @0x9C, bool` | DUMP | sim | Flag de stage demo |
| Stage: NextStageKey | `StageInfoData.NextStageKey @0xA0, int` | DUMP | sim | Proximo stage (progressao apos clear) |
| Stage: BGMSoundKey | `StageInfoData.BGMSoundKey @0xA4, int` | DUMP | sim | Trilha; completude |
| Drop table (linha de drop) | `DropInfoData: DropKey@0x30, REWARDTYPE@0x34, RewardKey@0x38 (uint), Weight@0x3C, HeroKeyCondition@0x40, DropType@0x44` | DUMP | sim | EREWARDTYPE: ITEM=0/ITEMGROUP=1/MONSTER=2. EDropType: EachDropOneWeight=0/SelectOneByClass=1. Loot por peso |
| StageFailed: act | `StageFailedLog.beqg (int) @0x40` | DUMP | sim | .ctor(act, stage, nowWave, totalWave, isActBoss). Revela ate onde a run chegou |
| StageFailed: stage | `StageFailedLog.beqh (int) @0x44` | DUMP | sim | |
| StageFailed: wave atual (onde morreu) | `StageFailedLog.beqi (int) @0x48` | DUMP | sim | Progresso da run no momento da falha |
| StageFailed: total de waves | `StageFailedLog.beqj (int) @0x4C` | DUMP | sim | |
| StageFailed: era boss de act | `StageFailedLog.beqk (bool) @0x50` | DUMP | sim | |
| HeroDie: monstro que MATOU (key) | `HeroDieLog @0x40 (string)` | **CONFIRMADO** | sim | ⚠ LIVE-CRACKED 2026-06-06 (32 eventos): os campos estavam TROCADOS na doc. @0x40 = MONSTRO matador, formato `"MonsterName_<monsterKey>"`. (A ordem do .ctor != ordem dos campos.) |
| HeroDie: heroi que MORREU (key) | `HeroDieLog @0x48 (string)` | **CONFIRMADO** | sim | LIVE-CRACKED: @0x48 = HERÓI vítima, formato `"HeroName_<heroKey>"` (heroKey=201 <-> 'HeroName_201'). Parseia o int do sufixo. Evento de morte -> conta deaths/killed_by da run (schema v11) |
| HeroResurrection: heroi revivido (key) | `ResurrectionLog @0x40 (string)` | **CONFIRMADO** | sim | LIVE-CRACKED (5 eventos): @0x40 = `"HeroName_<heroKey>"`; @0x48/@0x50 vazios. Auto-revive ~115s se houver outro herói vivo (ou skill da Priest). -> conta revives da run (schema v11) |
| HeroLevelUp: novo nivel | `HeroLevelUpLog.bepa (int) @0x40` | DUMP | sim | .ctor(heroNameKey, heroLevel). Progresso de heroi na run |
| HeroLevelUp: heroi (key) | `HeroLevelUpLog.bepb (string) @0x48` | DUMP | sim | |
| GetItemWithBoxOpen: item (key) | `BoxOpenLog.benp (string) @0x40` | DUMP | sim | ELogType=2. .ctor(itemStringKey, itemGradeType). Drop aberto na run |
| GetItemWithBoxOpen: grade do item | `BoxOpenLog.benq (EGradeType) @0x48` | DUMP | sim | enum EGradeType (raridade) |
| GetBox: TIPO do baú (não item key) | `GetBoxLog.beov (string) @0x40` | CONFIRMADO | sim | ELogType=3. LIVE 2026-06-06: "TreasureChest_Monster/StageBoss/ActBoss". O reader classifica o tier por monster_type e grava a box key canônica daquele tier (`BOX_KEY_BY_TIER`) |
| GetBox: monstro que dropou (key) | `GetBoxLog.beow (string) @0x48` | CONFIRMADO | sim | LIVE: "MonsterName_<key>" (ex: "MonsterName_20111" = boss do stage) |
| GetBox: tipo do monstro (tier do baú) | `GetBoxLog.beox (EMonsterLogType) @0x50` | CONFIRMADO | sim | LIVE: Monster=0, Boss=1, ActBoss=2. Sinal canônico do tier |
| Timestamp do evento (log) | `LogData.bepj (DateTime) @0x30` | DUMP | cuidado | DateTime struct 8 bytes (ticks @0x30). Offset fixo a partir de classe legivel. Ordena eventos no tempo |
| Idioma p/ format da msg (log) | `LogData.bepk (SystemLanguage enum) @0x38` | DUMP | sim | Pouco util p/ run |
| Unidades mortas da run (dados) | `StageManager.bcsz @0x108, Dictionary<int, DeadUnitData>` | DUMP | cuidado | PLAIN; andar no Dictionary. DeadUnitData = registro de morte |
| Settings | `PlayerSaveData.settingSaveData @0x18 (SettingSaveData)` | DUMP | sim | Config UI/janela; irrelevante p/ run |
| Mails | `PlayerSaveData.mailSaveDatas @0x38 (SerializedMailData)` | DUMP | sim | MailSaveData{index@0x10, receivedDate@0x18, itemInstanceId@0x20, isRead@0x28, isClaimedItem@0x29, ItemKey@0x2C, wasMarketItem@0x30} |
| Stash (bau) | `PlayerSaveData.stashSaveDatas @0x60 (List<StashSaveData>)` | DUMP | sim | StashSaveData{Index@0x10, ItemUniqueId@0x18, IsUnLock@0x20}. Storage; nao da run |
| Trading stash | `PlayerSaveData.tradingStashSaveDatas @0x68 (List<TradingStashSaveData>)` | DUMP | sim | mesmos offsets do Stash. Storage de troca |
| Cube: receitas desbloqueadas | `PlayerSaveData.cubeRecipeSaveDatas @0x70 (List<CubeRecipeSaveData>)` | DUMP | sim | CubeRecipeSaveData{CubeRecipeTypeInt@0x10, CubeKey@0x14, MaxUnlockRecipeKey@0x18}. Crafting; nao por run |
| Cube: nivel/exp | `PlayerSaveData.cubeSaveLevelData @0x78 (CubeLevelSaveData{Level@0x10, Exp@0x14})` | DUMP | sim | Progressao do Cube, NAO de heroi |
| CommonSaveData: flags diversas | `isFirstPlay@0x24 (bool), LastRollingBackUpTime@0x28 (long), SendSteamId@0x30 (bool), TutorialCleared@0x38 (bool[]), firstUnlockHeroKey@0x50 (int), useStorage@0x60 (bool), isOpeningDirectionPlayed@0x61 (bool)` | DUMP | sim | Metadados/flags; contexto, nao metrica de run |
| AccountSaveData (NAO confundir com Common) | `playTime@0x30 (float); playerId@0x10, version@0x18, isFirstRun@0x20, lastSavedTime@0x28, lastExitSteamUnixSecEncrypted@0x38, lastExitSteamUnixSecKey@0x40, sessionCounter@0x48, ownerSteamId@0x50` | DUMP | sim | playTime duplica CommonSaveData. SEM XP de conta/player (nao existe) |
| Recompensa idle/offline (gold) | `OfflineRewardResult.Gold@0x20 (long), RewardSec@0x8, HeroResults@0x28` | DUMP | nao | Struct retornado por metodo (gaz/iuc/joc), nao residente. UI em UI_OfflineReward.m_goldText@0x38. Fora de "uma run" de combate |

---

## INACESSIVEL (read-only nao alcanca)

| Info | Fonte (Classe.campo @0xNN, tipo) | Confianca | Acessivel | Obs |
|---|---|---|---|---|
| Esta vivo (flag) | `Unit.b_isLive @0xD8, ObscuredBool` | CONFIRMADO | nao | OBSC (XOR). Prefira derivar vivo/morto das listas do MonsterSpawnManager (sem cripto) |
| Ouro creditado por kill (fonte de credito) | `ud.su.iko(long, EGoldCurrencySource)` RVA 0x876E20; MonsterKill=1 | CONFIRMADO | nao | Metodo, nao campo. Prova que ouro entra ao vivo por morte. ud.su obfuscada. P/ ler ao vivo use `ut.beid` |
| Alvo atual da unidade | `Unit.ebb()` (slot 12, retorna Unit) — metodo, sem campo | DUMP | nao | NAO ha campo de alvo armazenado; computado por busca a cada chamada. Inalcancavel sem chamar o metodo |
| Dano/crit/elemento de UM hit | `DamageInfo{Attacker@0x0, OriginDamage@0x8 float, IsCritical@0xC bool, DamageAttribute@0x10, DamageType@0x14, FloatingDamageText@0xD}` | DUMP | nao | struct transiente passada a `gnl(DamageInfo,bool)`; NAO armazenada na Unit. Derive dano/crit/elemento do delta de HP |
| 12 stats "core" ObscuredFloat | `Unit.bcex..bcfi @0x104..0x1E0 (12x ObscuredFloat)` | DUMP | nao | OBSC + nomes ofuscados; indice->StatType nao recuperavel. Use `xd.bets` (64 stats PLAIN) |
| Heroi: mirror runtime de level/exp | `uf.befp@0xCC, befq@0xDC, befr@0xEC, befs@0xFC (ObscuredInt), beft@0x10C (ObscuredFloat)` | DUMP | nao | Espelho CRIPTOGRAFADO; use HeroSaveData (PLAIN) |
| Ouro ao vivo (wallet em memoria) | `ud.su.bdwn@0x28 (ObscuredLong)`; store static `ud.st.bdwi(List<ud.su>)@0x0 / bdwj(Dict<int,ud.su>)@0x8` | DUMP | nao | Classe obfuscada + ObscuredLong (cripto ACTk). Use o save plain-long |
| Soul Stone (saldo/contagem ao vivo) | `LocalInventoryManager` (static beul@0x0, getter brur); estoque Dict<int,Dict<ulong,ItemInfoData>>@0x20 | DUMP | nao | Manager nao-singleton facil + Dict obfuscado. Use StageInfoData (template) / delta de save |
| StageInfoData da run viva (holder runtime) | `ud.StageCache.bebu @0x10, StageInfoData (+ ObscuredInt)` | DUMP | nao | Holder com nome OBFUSCADO + campos ObscuredInt. Pegue StageInfoData direto por nome |
| Lista global de stages (registro) | `yp.stageInfoData @0x80, List<StageInfoData>` | DUMP | nao | Classe dona OBFUSCADA (yp). Resolva StageInfoData diretamente por string |
| Boss spawnou (evento) | `MonsterSpawnManager.OnBossMonsterSpawned @0x50, Action<EStageType>` | DUMP | nao | Delegate; read-only nao assina callback. Use Monster.MonsterType por polling |
| Box obtida na run (gatilho) | `StageManager.OnGetBox(Action<int>)@0x100` | CONFIRMADO | nao | Action (gatilho), nao contador. Derive de GetBoxLog / delta inventario / `ut.beid` BoxObtain=3 |
| Recompensa de 1a vez (gatilho) | `StageManager.OnFirstClearStage(Action)@0xF8` | DUMP | nao | Action; o key do bonus esta em StageInfoData.FirstClearDropKey@0x6C (legivel) |
| Best-clear-time persistido (em disco) | `SteamItemRecordData{UniqueId, RecordTime@0x8}` | DUMP | nao | struct transiente de callback de inventario Steam, SEM holder residente. Unico clear-time vivo e `StageClearLog.beqe` (runtime, nao persiste) |

---

**Notas globais (sem linha de tabela):**
- DANO E DPS NAO SAO LOGADOS NEM ARMAZENADOS. Nenhum *Log carrega dano; `DamageInfo` e transiente; os 12 core stats e `b_isLive` sao Obscured. **Nucleo do meter de DPS = soma das quedas de HP dos Monsters** (`pe@0x40` via `MonsterSpawnManager.MonsterList`/`DeadMonsterUnit`). Crit/elemento por hit nao recuperaveis read-only.
- OURO/XP/SOUL STONE/KILLS da run: duas vias agora. (a) DELTA de snapshots no SAVE PLAIN: `CurrencySaveData.Quantity` (ouro), `HeroSaveData.HeroExp` (xp), `aggregateSaveDatas`/inventario. (b) AO VIVO via `ut.beid` (singleton PLAIN) p/ kills/gold/box tick a tick — espelho live do aggregate. As wallets/inventarios ao vivo crus (`ud.su`/`LocalInventoryManager`) sao obfuscados + Obscured (evitar).
- O SAVE inteiro e PLAINTEXT; Obscured/ACTk so nos espelhos RUNTIME (`ud.su`, `ud.th.te`, `uf`, 12 core stats, `b_isLive`). Excecao util: `ut.beid` e runtime PLAIN. Sempre que houver versao-save de um dado runtime obscured, use a do save.
- Resolucao: `PlayerSaveData` NAO e singleton estavel (jogo recria) -> instancia viva = a de MAIOR ouro. `StageInfoData`/`LogManager` resolvem por string. Singletons via base generica `nn<a>` (`MonsterSpawnManager`, `LogManager`, **`ut`**): instancia no static do generic, NAO por string. Classes 2-letras puras (uf/uo/xd/te/ud.su/yp) so por offset fixo a partir de classe legivel.
- Categorias verificadas e ausentes/ja-cobertas: combo (nao existe — "combo" no dump e UI de crafting); crit/elemento por hit (transiente em DamageInfo); stamina/energia (nao existe — idle sem gate); prestigio/ascensao/rebirth (nenhuma classe); afinidade elemental (= resistencias por elemento, ja em `Unit.bcfr`/`xd.bets`); achievements/missions (so cruft MoreMountains/Steam, nao quests de run); status effects (Chill/Freeze/Ignite/Shock/Bleed/Stun, 100% coberto).
