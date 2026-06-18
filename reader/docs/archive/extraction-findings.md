---
type: archive
status: superseded
description: "SNAPSHOT histórico (RE cru ou plano entregue) — nomes/offsets/linhas podem estar obsoletos; a verdade atual está nas notas vivas (ver _index). Isento do drift-test de código."
---

> **HISTORICAL — RAW 9-domain RE findings (2026-06-02).** This is the raw multi-agent output that fed `extraction-spec.md` (the verified consolidation) and ultimately `config/offsets.py` (the live source of truth). LLM generation chatter is interleaved between domain sections. Where this disagrees with `extraction-spec.md` / `offsets.py`, THEY win — notably the "`SaveContainer`" save-root claimed in the Equipment domain below does NOT exist; the root is `PlayerSaveData` (offsets confirmed: `itemSaveDatas@0x80`, `heroSaveDatas@0x30`). `dump.cs` line numbers are from the external Il2CppDumper output for GameAssembly.dll v1.00.07 (not committed).

The `nn<a>` singleton base has a `private static a bbwf @0x0` (the singleton instance, per-generic-instantiation static storage) and property `brca` (Instance getter). Since the meter already resolves StageManager (which extends `nn<StageManager>`) by scanning for instances via the class pointer, the **same instance-scan technique works for `yp`** — no need to read the static field. This is fully consistent with the established method.

I have everything verified. Let me compose the final answer.

## DOMINIO: Composição (party / herois ativos e suas classes)

**Viável read-only:** sim — `StageManager.HeroList` dá os `Hero` ativos; cada `Hero` aponta pra um data-model (`uf cache`) que segura o `HeroInfoData`, de onde saem `HeroKey` (identidade) e `ClassType`=`EEquipClassType` (a classe/job). Tudo são ponteiros/ints/enums não-criptografados.

**Classes:**
- `Hero : Unit` (318755) — instância de heroi em batalha (vem de `StageManager.HeroList`)
- `Unit` (319277) — base abstrata de Hero/Monster; `b_isHero@0x100` distingue
- `uf : uo` (335005) — **data-model/contexto do heroi**; `Hero.cache@0x3A0` aponta pra cá; liga a instância ao save+info
- `HeroInfoData : ze` (354702) — dado estático por heroi (identidade + classe + stats base); construído via CSV (`ClassMap<HeroInfoData> zb`)
- `HeroSaveData` (342729) — save por heroi (heroKey, nível, itens); persistente em disco
- `yp : nn<yp>` (352341) — singleton "Data manager"; tabela `heroKey -> HeroInfoData` (rota alternativa de lookup)
- `nn<a>` (315606) — base singleton (mesmo padrão do StageManager): instância em `static a@0x0`, getter `brca`
- `EEquipClassType` (354930) — **o enum de classe/job do heroi** (verificado)
- `EHeroType` (354688) — enum legado Knight/Archer/Wizard/Priest/Hunter/Barbarian; **NÃO é usado como campo em lugar nenhum** (grep vazio) — ignore, não é a classe real

**Campos-chave:**
- `StageManager.HeroList` @0x30 (`Hero[]`) — array dos herois da run (party 1–3) [já resolvido]
- `Hero.cache` @0x3A0 (`uf`) — ponteiro pro data-model do heroi
- `uf.beew` @0x30 (`HeroInfoData`) — ponteiro direto pro info estático do heroi (privado, mas legível por offset)
- `uf.befh` @0x88 (`Hero`) — back-reference pro `Hero` (útil pra casar instância↔model)
- `HeroInfoData.HeroKey` @0x30 (int) — **identidade do heroi**
- `HeroInfoData.ClassType` @0x48 (`EEquipClassType`) — **a CLASSE/JOB** do heroi
- `HeroInfoData.HeroNameKey` @0x38 (string) — chave de localização do nome (não o nome literal)
- `HeroInfoData.MainWeaponGearType` @0x4C / `SubWeaponGearType` @0x50 (`EGearType`) — armas
- `HeroInfoData.SkillKey` @0x54 (int) — skill do heroi
- `HeroSaveData.heroKey` @0x10 (int) — identidade no save [já resolvido]
- `yp.bfin` @0xA8 (`Dictionary<int,HeroInfoData>`) — mapa heroKey->info; getter `yp.jfg(int)` (352576)
- Nenhum campo deste domínio é OBSCURED. heroKey/ClassType são int/enum em texto claro. (Os `Obscured*` do `uf` @0xC0+ e do `Unit` @0x104+ são stats/flags, fora deste domínio.)

**Enums:**
- `EEquipClassType` (354930) — verificado por grep: `All=0, Knight=1, Ranger=2, Sorcerer=3, Priest=4, Hunter=5, Slayer=6`
- `EHeroType` (354688) — verificado: `Knight=0, Archer=1, Wizard=2, Priest=3, Hunter=4, Barbarian=5` — **enum órfão, não mapeado a nenhum campo; NÃO usar**

**Resolução read-only:**
1. Resolver `StageManager` (singleton) como já fazemos → ler `HeroList @0x30` (`Hero[]`): cabeçalho do array em `data@0x20`, `_size`/length no header do Il2CppArray; iterar os ponteiros de `Hero`.
2. Para cada `Hero`: ler `cache @0x3A0` → ponteiro `uf`. (Opcional sanity-check: `Unit.b_isHero @0x100 == true`.)
3. Do `uf`: ler `beew @0x30` → ponteiro `HeroInfoData`.
4. Do `HeroInfoData`: ler `HeroKey @0x30` (int = identidade) e `ClassType @0x48` (int = `EEquipClassType` → mapear pra nome via tabela do enum acima).
5. (Rota alternativa de validação) achar o singleton `yp` por instance-scan (mesma técnica do StageManager, classe `yp`), ler `bfin @0xA8` e indexar pelo heroKey — deve devolver o mesmo `HeroInfoData`.

**Gotchas / confiança:**
- **Confiança alta** na cadeia `Hero.cache(uf)@0x3A0 -> HeroInfoData@0x30 -> {HeroKey@0x30, ClassType@0x48}`. `cache@0x3A0` está explícito no dump (318758); `uf.beew@0x30` é `HeroInfoData` (335008); offsets de HeroInfoData lidos direto (354705/354708).
- A classe/job correta é **`EEquipClassType`** (tem Ranger/Sorcerer/Slayer), não `EHeroType`. Confirmei por grep que `EHeroType` não é campo de nenhuma classe — não caia nessa armadilha.
- `HeroInfoData` é **dado ESTÁTICO** (tabela do jogo), não estado de UI nem histórico — confiável como fonte de verdade de identidade+classe.
- `HeroNameKey@0x38` é **chave de localização**, não o nome exibido; pra nome legível precisa resolver a string table (fora deste domínio). Para o meter, `HeroKey`+`ClassType` já bastam pra identidade+job.
- `uf.beew` é `private` — irrelevante para leitura por offset (lemos a memória direto), mas confirma que não há getter público simples; use o offset 0x30.
- Risco residual baixo: se algum `Hero` aparecer com `cache==null` (heroi em spawn/morte transitória), caia pra Rota B (heroKey via outra fonte) ou pule. Recomendo cross-check pontual em runtime: para 1 heroi conhecido, confirmar que `ClassType` lido bate com a classe vista no jogo antes de confiar 100%.

=====================

Fully confirmed. `STAGEDIFFICULTY` is a plain `int32_t` at offset 0x44, no Obscured wrapper. The whole chain is readable. Note `ze_Fields` is the base (CsvHelper-mapped data base, likely empty/header) so the @0x30 start for `StageKey` lines up with the dump offsets. I have everything needed.

## DOMINIO: Modo-Dificuldade (Normal / Nightmare / Hell / Torment)

**Viavel read-only:** sim — a dificuldade do stage em jogo vive como `int32_t` puro (NAO Obscured) em `StageInfoData.STAGEDIFFICULTY@0x44`, alcançavel a partir do hub estatico `ud.tv` que ja é do mesmo tipo de coisa que ja resolvemos.

**Classes:**
`ESTAGEDIFFICULTY` (dump.cs:355843) — o enum do modo (TypeDefIndex 3265)
`ud.tv` (dump.cs:333405, classe estatica) — hub de dados de stage; campo estatico `bebq` aponta pro StageCache atual
`ud.StageCache` (dump.cs:333851) — wrapper de um stage (envolve um `StageInfoData`); expõe a dificuldade via `izu()`/`brmv`
`StageInfoData` (dump.cs:355865) — dados crus do stage (CSV-mapped); contem `STAGEDIFFICULTY` legivel
`UI_Portal` (dump.cs:350337) — TELA de seleção do portal; guarda a dificuldade ESCOLHIDA no dropdown (UI-state, ver gotchas)
`ud.tv.tt`/`ud.tv.tu` (dump.cs:333387/333405) — closures LINQ que filtram StageCache por dificuldade; NAO sao estado, ignorar

**Campos-chave:**
`ud.tv.bebq` @0x88 (ud.StageCache*, **campo ESTATICO** — em `static_fields`, il2cpp.h:88462) — o StageCache do stage atual; pode ser null fora de batalha
`ud.StageCache.bebu` @0x10 (StageInfoData*) — o StageInfoData do stage; readonly, setado no .ctor
`StageInfoData.STAGEDIFFICULTY` @0x44 (int32 = ESTAGEDIFFICULTY) — **a dificuldade. NAO É OBSCURED** (confirmado em il2cpp.h:108288, `int32_t STAGEDIFFICULTY`)
`StageInfoData.StageKey` @0x30 (int32) — chave do stage; bate com `CommonSaveData.currentStageKey@0x58` (rota alternativa)
`UI_Portal.m_currentStageDifficulty` @0xB8 (int32 = ESTAGEDIFFICULTY) — dificuldade selecionada no dropdown do portal (UI-state, NAO autoritativo durante batalha)

**Enums:**
`ESTAGEDIFFICULTY` (dump.cs:355843, TypeDefIndex 3265): NORMAL=0, NIGHTMARE=1, HELL=2, TORMENT=3, COUNT=4 [VERIFICADO por grep — note a ordem: Nightmare(1) vem antes de Hell(2); e COUNT=4 é sentinela, não um modo]

**Resolucao read-only (a partir do que ja resolvemos):**
Diferente de StageManager/CommonSaveData, a dificuldade NAO está num singleton de instancia comum — vive num campo estatico de classe. Duas rotas:

Rota A (autoritativa, stage atual em batalha):
1. Achar a Il2CppClass de `ud.tv` pela varredura (mas o nome é so "ud/tv" ofuscado e a string da classe é `tv` — difícil de localizar por string de nome). Mais robusto: pegar `ud.tv` via referencia ja conhecida — qualquer StageCache instanciado aponta pra sua classe; mas o ponto de entrada limpo é o campo estatico.
2. Da Il2CppClass de `ud.tv`, ler o ponteiro `static_fields` (no header da classe; layout `Il2CppClass_1 _1; void* static_fields;` — o `static_fields` fica logo após o bloco `_1`). Dentro de `static_fields`, offset @0x88 = `bebq` (ponteiro pro StageCache atual).
3. Se `bebq != null`: ler `bebu@0x10` (StageInfoData*).
4. Ler `STAGEDIFFICULTY@0x44` desse StageInfoData → int → mapear pelo enum acima.

Rota B (mais facil de implementar, ja temos a peça): partir de `CommonSaveData.currentStageKey@0x58` (JA resolvido). A dificuldade NAO está no save, mas o `StageKey` codifica/indexa o stage; `ud.tv.bebk` (Dictionary<int,StageCache>@0x40 em static_fields) e os metodos `cmb(int)`/`hvd(int)` (dump.cs:333460/333466) mapeiam StageKey→StageCache. Para read-only puro sem chamar métodos, varra o Dictionary `bebk` procurando a entry cujo StageInfoData.StageKey == currentStageKey e leia o `STAGEDIFFICULTY@0x44` dela. (Mais trabalhoso; a Rota A com `bebq` é direta quando há stage ativo.)

**Gotchas / confianca:**
- `ud.tv` é classe ESTATICA — a dificuldade NAO está num objeto de instancia escaneavel pelo ponteiro-de-classe@0x0 como Hero/Unit. Precisa ler `static_fields` da Il2CppClass (mesmo mecanismo que qualquer leitura de campo estatico). Localizar a classe `ud.tv` por nome-string pode ser chato (nome ofuscado curto "tv"); alternativa é alcançá-la via `klass` de um `ud.StageCache` instanciado (o castClass@0x48 do StageCache, depois subir pro field estatico — ou simplesmente resolver `ud.StageCache` por nome e ler sua classe, mas `bebq` é estatico de `ud.tv`, não de StageCache).
- `bebq@0x88` pode ser **null** fora de batalha (no menu/portal). Quando null, use a Rota B (currentStageKey → lookup) ou leia `UI_Portal.m_currentStageDifficulty@0xB8`.
- `UI_Portal.m_currentStageDifficulty@0xB8` é **ESTADO/HISTORICO DE UI** — é o que o dropdown mostra na tela de seleção, não necessariamente o que está rodando. Só é confiável quando o portal está aberto. Não é contador persistente. NAO é Obscured.
- NENHUM campo do dominio de dificuldade é Obscured — `STAGEDIFFICULTY@0x44` e `m_currentStageDifficulty@0xB8` são int32 puros. (Os muitos `ObscuredInt/Float` em `StageCache`/`StageInfoData`-vizinhos são stats de balanceamento — HP/gold/exp multipliers etc. — NAO a dificuldade.)
- A dificuldade NAO está em `StageManager` nem em `CommonSaveData` (ambos lidos e confirmados sem campo de dificuldade — dump.cs:327247 e 328578). Quem errar e procurar lá não acha.
- Confianca: **alta** no enum (verificado), nos offsets (cruzados dump.cs + il2cpp.h: bebq@0x88, bebu@0x10, STAGEDIFFICULTY@0x44, não-Obscured) e em que UI_Portal é UI-state. **Media** na ergonomia de localizar a classe estatica `ud.tv` em runtime (não testado por nós ainda; é o único passo novo vs. o método já funcionando de instancias).

=====================

Confirmed. Gold lives only in the currency list, not in CommonSaveData. I have everything needed for a complete, evidence-backed answer.

## DOMINIO: gold-moedas (currency / Gold)

**Viavel read-only:** parcial — o GOLD persistente e legivel em claro (`CurrencySaveData.Quantity`), mas o GOLD "ao vivo" do runtime e `ObscuredLong` (exige XOR); o agregado GoldEarn esta em claro num Dictionary do singleton.

**Classes:**
- `CurrencySaveData` (342713) — par persistente {Key,Quantity} por moeda; serializado em JSON
- `CurrencyInfoData : ze` (354239) — metadado data-driven da moeda (CurrencyKey, nome, amount inicial, icone); carregado de tabela via `yv : ClassMap<CurrencyInfoData>` (354275)
- `PlayerSaveData` (328698) — raiz do save; contem a lista de moedas e a lista de agregados
- `ud.su` (330322) — wrapper RUNTIME de uma moeda (valor/key em campos Obscured); base da moeda
- `xg : ud.su` (342629) — subclasse CONCRETA do GOLD (unica que sobrescreve `iko(long, EGoldCurrencySource)`, 342637) — discriminador de Gold em runtime
- `ud.st` (330276) — registro estatico de moedas runtime: `List<ud.su> bdwi` @0x0 e `Dictionary<int,ud.su> bdwj` @0x8 (chave = CurrencyKey)
- `ut : nn<ut>` (336558) — **AggregateManager** (singleton `nn<>`, mesmo padrao do StageManager); guarda GoldEarn ao vivo
- `AggregateSaveData` (342642) — entrada persistente de agregado {Type,SubKey,Value}
- `ry` (328384) — registro de strings de analytics (`total_gold_earned`, etc.) — NAO e contador

**Campos-chave:**
- `CurrencySaveData.Key` @0x10 (int) — CurrencyKey da moeda (data-driven; ver Gotchas)
- `CurrencySaveData.Quantity` @0x18 (long) — quantidade persistida da moeda — **fonte limpa do GOLD atual**
- `PlayerSaveData.currenySaveDatas` @0x28 (List<CurrencySaveData>) — lista persistente de moedas (sic: "curreny")
- `PlayerSaveData.aggregateSaveDatas` @0x88 (List<AggregateSaveData>) — agregados persistidos
- `CurrencyInfoData.CurrencyKey` @0x30 (int) — id da moeda; `CurrencyNameStringKey` @0x38 (string)
- `ud.su.bdwk` @0x10 (CurrencyInfoData) — metadado da moeda runtime
- `ud.su.bdwn` @0x28 (ObscuredLong) **(OBSCURED)** — valor ao vivo da moeda (getter `briy`/`ikl()`)
- `ud.su.bdwo` @0x48 (ObscuredInt) **(OBSCURED)** — key ao vivo da moeda (getter `briz`/`ikm()`)
- `ut.beid` @0x20 (Dictionary<EAggregateType, Dictionary<int,long>>) — store ao vivo dos agregados; **GoldEarn = beid[2]** (long em claro, NAO obscured)
- `ut.OnAggregateChanged` @0x28 (Action) — callback
- `AggregateSaveData.Type` @0x10 (int=EAggregateType), `.SubKey` @0x14 (int), `.Value` @0x18 (long) — GoldEarn persistido = entradas com Type==2

**Enums:**
- `EAggregateType` (336661): MonsterKill=0, HeroDeath=1, **GoldEarn=2**, BoxObtain=3, ItemObtain=4, Synthesis=5, Alchemy=6, Crafting=7, Offering=8, Extraction=9, Decoration=10, Engraving=11, Inscription=12, StageClear=13, StageFail=14, PlayTime=15, BoxOpen=16 [VERIFICADO]
- `EGoldCurrencySource` (334995): MonsterKill=1, CubeAlchemy=2, OfflineReward=3 [VERIFICADO] (usado so pela moeda Gold `xg`)
- NAO existe `ECurrencyType`: CurrencyKey e int data-driven (tabela `CurrencyInfoData`), sem enum de constantes [VERIFICADO por grep — nenhum enum ECurrency/literal de gold-key]

**Resolucao read-only:**
1. GOLD persistente (recomendado, em claro): escaneie a classe `CurrencySaveData` (string "CurrencySaveData" -> Il2CppClass), ache a instancia/lista. O caminho estavel e via `PlayerSaveData.currenySaveDatas` (List@0x28 -> items@0x10/_size@0x18). Para cada `CurrencySaveData`: leia `Key`@0x10 e `Quantity`@0x18. Gold = a entrada cuja Key bate com o CurrencyKey do Gold (descubra empiricamente: e a moeda grande que cresce ao matar monstro; tipicamente a primeira/menor Key).
2. GoldEarn (total ganho, em claro): resolva o singleton `ut` igual ao StageManager (scan da classe "ut" -> instancia via klass@0x0). Leia `beid`@0x20 (Dictionary). Pegue o bucket da chave enum 2 (GoldEarn) -> `Dictionary<int,long>` interno; o(s) `long` sao em claro. Use `mbr`/`mgn(EAggregateType,int)` como referencia de agregacao (somam por SubKey).
3. GOLD ao vivo (alternativa, OBSCURED): scan da classe `xg` (subclasse de Gold) -> instancia -> `bdwn`@0x28 (ObscuredLong). Para o valor real aplique o XOR ACTk (hiddenValue XOR currentCryptoKey da propria instancia). Idem `bdwo`@0x48 (ObscuredInt) = key.

**Gotchas / confianca:**
- **CRIPTO:** o valor runtime da moeda (`ud.su.bdwn`/`bdwo`) e Obscured (ACTk) — leitura direta da `ObscuredLong` da lixo sem o XOR. Prefira `CurrencySaveData.Quantity` (long puro) que da o mesmo numero sem cripto. O agregado GoldEarn (`ut.beid[2]`) e long PURO (nao obscured). **Confianca alta.**
- **GOLD KEY e data-driven, nao enum:** nao ha constante hardcoded do key do Gold (confirmei: zero literais de gold-currency-key; tabela `CurrencyInfoData` via `ClassMap`). O discriminador robusto de Gold em runtime e o TIPO `xg` (unica moeda com `iko(...,EGoldCurrencySource)`). No save voce identifica o key empiricamente (1 leitura observando qual Quantity sobe ao matar monstro). **Confianca media** no mapeamento Key->Gold ate confirmar ao vivo.
- **UI vs persistente:** `ry.total_gold_earned` e nome de evento de analytics (string), NAO um contador — ignore. O contador real persistente de "gold ganho" e `EAggregateType.GoldEarn=2` (em `ut.beid` ao vivo / `aggregateSaveDatas` Type==2 no disco). **Confianca alta.**
- CommonSaveData NAO tem campo de gold (verificado) — gold so existe na lista de moedas. Nome do campo no save tem typo: `currenySaveDatas` (um "r"). **Confianca alta.**
- `ut` e singleton `nn<>` (instance estatica @0x0 da classe); resolva por scan de instancia (klass@0x0) como ja foi feito com StageManager, nao tente ler o campo static diretamente.

=====================

I now have a complete, verified picture. `AccountSaveData` has NO account XP (only playerId, version, playTime, session). The other `Exp` JsonProperty belongs to `CubeLevelSaveData` (the Cube system — separate from hero XP, but worth noting). All data confirmed. Writing the final answer.

## DOMINIO: xp

**Viavel read-only:** sim — `HeroSaveData.HeroExp(float)@0x1C` e `HeroLevel(int)@0x14` sao campos PLAIN (nao Obscured), no mesmo save-root (`PlayerSaveData`) que ja resolvemos para Common/Currency. Curva global e legivel via master-data. Delta de XP por run = leitura periodica do par (level, exp).

**Classes:**
- `PlayerSaveData` (328698) — save-root persistente; `heroSaveDatas: List<HeroSaveData>@0x30`, `commonSaveData@0x10`, `currenySaveDatas@0x28` (mesmo objeto de onde ja lemos Common/Currency)
- `HeroSaveData` (342729) — XP/level persistente por heroi (PLAIN, JsonProperty)
- `yp : nn<yp>` (352341) — singleton MonoBehaviour de master-data (InfoData tables); guarda a curva de XP
- `LevelInfoData` (355194) — linha da curva de XP global do heroi: `Level@0x10`, `ExpForLevelUp@0x14` (int)
- `HeroInfoData : ze` (354702) — config base do heroi (stats); NAO contem XP/curva/maxlevel
- `uf : uo` (335005) — wrapper RUNTIME do heroi `.ctor(HeroSaveData, HeroInfoData)`; espelha level/exp em campos Obscured (NAO usar)
- `AccountSaveData` (328529) — conta; confirmado SEM XP/level de conta
- `CubeLevelSaveData` (342679) — sistema Cube (separado): `Level@0x10`, `Exp(float)@0x14` — NAO e XP de heroi
- `HeroLevelUpLog : LogData` (339447) — apenas log de UI (heroNameKey, heroLevel); NAO e contador

**Campos-chave:**
- `HeroSaveData.heroKey` @0x10 (int) — qual heroi
- `HeroSaveData.HeroLevel` @0x14 (int) — nivel atual **[PLAIN]**
- `HeroSaveData.HeroExp` @0x1C (float) — XP acumulado **dentro do nivel atual** (zera ao subir; vide curva) **[PLAIN]**
- `HeroSaveData.IsUnLock` @0x18 (bool), `AbilityPoint` @0x20 (int) — contexto
- `PlayerSaveData.heroSaveDatas` @0x30 (List<HeroSaveData>) — lista persistente (items@0x10/_size@0x18)
- `LevelInfoData.Level` @0x10 (int) / `LevelInfoData.ExpForLevelUp` @0x14 (int) — XP necessario para passar **daquele** nivel
- `yp.bfil` @0x88 (Dictionary<int,LevelInfoData>) — mapa nivel→curva; accessor `blm(int)`@352438
- `uf.befp/befq/befr/befs` @0xCC/0xDC/0xEC/0xFC (ObscuredInt) **(OBSCURED)** e `uf.beft` @0x10C (ObscuredFloat) **(OBSCURED)** — espelho runtime de level/exp; EVITAR, usar HeroSaveData

**Enums:** `EAccountStatus` (341805) [VERIFICADO] — modificadores que afetam ganho de XP (nao sao XP em si): IncreaseExpAmount=2, AdditionalExp=3, CubeExpPercent=11, AdditionalExpStageBoss=22, AdditionalExpActBoss=23, AdditionalExpNormalMonster=24, OfflineRewardExpPercent=41. Nenhum enum de "nivel". `LevelInfoData`/`HeroSaveData` nao tem enums.

**Resolucao read-only:**
1. Reutilize o ponteiro do `PlayerSaveData` ja resolvido (mesmo objeto de Common/Currency). Se ainda nao tiver: ache a classe `PlayerSaveData` pela string -> ache a instancia -> ela aponta `commonSaveData@0x10` (sanity-check com currentStageKey ja conhecido).
2. `PlayerSaveData+0x30` -> `List<HeroSaveData>`. Leia items@0x10 (Il2CppArray, data@0x20) e _size@0x18.
3. Para cada elemento HeroSaveData: `+0x10`=heroKey (int), `+0x14`=HeroLevel (int), `+0x1C`=HeroExp (float). Leitura direta, sem XOR.
4. Curva (opcional, p/ % e XP-to-next): ache singleton `yp` por scan de instancia (MonoBehaviour, klass@0x0 -> compara name "yp"; ou use o ponteiro de manager ja resolvido se houver). Leia `yp+0x88` (Dictionary) ou itere a `List<LevelInfoData>` equivalente; mapeie Level->ExpForLevelUp (offsets 0x10/0x14).
5. XP ganho numa run = amostre (HeroLevel, HeroExp) em t0 e t1. Mesmo nivel: `ganho = exp1 - exp0`. Cruzou nivel(is): `ganho = (ExpForLevelUp[lvl0] - exp0) + soma(ExpForLevelUp[lvl0+1..lvl1-1]) + exp1`.

**Gotchas / confianca:**
- HeroExp e XP **relativo ao nivel** (zera no level-up), nao acumulado total — o delta precisa somar a curva ao cruzar niveis (passo 5). Confianca media nessa semantica de "reset": inferida da estrutura (curva `ExpForLevelUp` por nivel + Hero wrapper que consome) — VALIDAR em runtime observando HeroExp cair quando HeroLevel sobe.
- NAO ha XP de conta/player persistente (AccountSaveData 328529 verificado: so playerId/version/playTime/session). XP e estritamente per-heroi.
- O espelho runtime em `uf` (befp..befs ObscuredInt, beft ObscuredFloat) e CRIPTOGRAFADO (ACTk: real = hiddenValue XOR cryptoKey por instancia). Ignore-o; HeroSaveData e plain e mais simples.
- `ExpForLevelUp` e **int** em LevelInfoData (355198) mas HeroExp e **float** (342739) — provavel acumulo fracionario por bonus (EAccountStatus IncreaseExpAmount etc.); compare como float.
- `CubeLevelSaveData.Exp` (342684) e XP do sistema Cube, NAO heroi — nao confundir.
- Master-data `yp` e MonoBehaviour singleton (`nn<a>`, instancia estatica @0x0 mas resolva por scan de instancia como StageManager). Confianca alta nos offsets de HeroSaveData/LevelInfoData (lidos direto do dump com JsonProperty); confianca media na resolucao do singleton `yp` (ainda nao resolvido por voces).

=====================

I have enough verified evidence to compile the domain report. The `xd` class has many `float xx(StatType)` getters reading from the two `Dictionary<StatType,float>` caches (`bets`@0x18 = final computed total per stat; `bett`@0x20 = a secondary cache, likely base-only or pre-mod). The values are PLAIN float — not obscured (the obscuring lives only in the raw `up` modifier sources via Unit's ObscuredFloats, but the aggregated cache is plaintext). 

Let me do a final sanity check on whether the two dicts are total-vs-base by examining the `up` value field type (plain float, confirmed) and confirm the entries data offset convention. I have everything. Writing the report.

## DOMINIO: Stats-por-Heroi (ficha de 64 stats via StatType)

**Viavel read-only:** sim — a ficha completa fica em `Dictionary<StatType,float>` PLANO (nao-obscured) dentro do `xd` (stat calculator), alcancavel de `Hero.cache`/`Monster.cache` por offsets fixos; nao precisa do XOR para ler o total agregado.

**Classes:**
- `Hero : Unit` (dump.cs:318755) — heroi; segura o stat-controller em `cache`.
- `Monster : Unit` (dump.cs:319084) — monstro; mesmo padrao, controller diferente.
- `uo` (dump.cs:336113, abstract) — base do stat-controller; segura o calculator `xd` em `behg`.
- `uf : uo` (dump.cs:335005) — stat-controller do HEROI (HeroInfoData, Hero ref, itens equipados).
- `ud.tl : uo` (dump.cs:332557) — stat-controller do MONSTRO (MonsterInfoData).
- `xd` (dump.cs:342026) — o calculator: 2x `Dictionary<StatType,float>` (cache de stats computados) + ref ao registro de mods `uq`.
- `uq` (dump.cs:336345) — registro de modificadores: `Dictionary<StatType,List<up>>` por fonte.
- `up` (dump.cs:336257) — UM modificador: StatType + MODTYPE + valor + MODSOURCE.
- `Unit` (dump.cs:319277) — segura 12 `ObscuredFloat` (stats "core" em runtime, mapeamento ofuscado).

**Campos-chave:**
- `Hero.cache` @0x3A0 (uf) — stat-controller do heroi (dump.cs:318758).
- `Monster.cache` @0x3B0 (ud.tl) — stat-controller do monstro (dump.cs:319089).
- `uo.behg` @0x10 (xd*) — ponteiro pro calculator; herdado por uf e ud.tl (dump.cs:336117; il2cpp.h:88094 `_behg_k__BackingField` 1o campo de `uo_Fields`).
- `xd.bets` @0x18 (Dictionary<StatType,float>) — **stat TOTAL computado por StatType (a ficha final)** (dump.cs:342030; il2cpp.h:94904).
- `xd.bett` @0x20 (Dictionary<StatType,float>) — segundo cache de stats (provavel base/pre-mod ou cache auxiliar) (dump.cs:342031; il2cpp.h:94905).
- `Dictionary<StatType,float>._entries` @0x18, `._count` @0x20 (array de Entry) (il2cpp.h:837231-837232).
- Entry de `<StatType,float>` (canonico .NET): `hashCode` @0x0 (int), `next` @0x4 (int), `key` @0x8 (StatType=int32), `value` @0xC (float); stride 16 bytes. Array `_entries`: dados comecam @0x20.
- `up.behk` @0x10 (StatType), `up.behl` @0x14 (MODTYPE), `up.behm` @0x18 (float valor), `up.behn` @0x1C (MODSOURCE) — **todos PLANOS** (dump.cs:336261-336267; il2cpp.h:89776-89779).
- `ObscuredFloat`: `hiddenValue` @0x4 (int), `currentCryptoKey` @0x8 (int), `fakeValue` @0xC (float); `hash`@0x0 (il2cpp.h:79753-79758).
- `Unit.bcex..bcfi` @0x104,0x118,0x12C,0x140,0x154,0x168,0x17C,0x190,0x1A4,0x1B8,0x1CC,0x1E0 (12x **ObscuredFloat (OBSCURED)**) — stats core em runtime (dump.cs:319321-319332); `bcfl`@0x214 (ObscuredFloat, OBSCURED).
- `ud.tl.bdzz..beae` @0x48,0x5C,0x70,0x84,0x98,0xAC (6x ObscuredFloat, OBSCURED) — stats core do monstro (dump.cs:332562-332567).

**Enums:**
- `StatType` (dump.cs:336161) [VERIFICADO]: NONE=0, AttackDamage=1, AttackSpeed=2, CriticalChance=3, CriticalDamage=4, MaxHp=5, Armor=6, MovementSpeed=7, AreaOfEffect=8, BaseAttackCountReduction=9, CooldownReduction=10, SkillRangeExpansion=11, FireResistance=12, ColdResistance=13, LightningResistance=14, ChaosResistance=15, DodgeChance=16, BlockChance=17, MaxDodgeChance=18, MaxBlockChance=19, Multistrike=20, HpLeech=21, ProjectileCount=22, HpRegenPerSec=23, PhysicalDamagePercent=24, FireDamagePercent=25, ColdDamagePercent=26, LightningDamagePercent=27, ChaosDamagePercent=28, MaxFireResistance=29, MaxColdResistance=30, MaxLightningResistance=31, MaxChaosResistance=32, AddHpPerHit=33, DamageReduction=34, PhysicalDamageReduction=35, FireDamageReduction=36, ColdDamageReduction=37, LightningDamageReduction=38, ChaosDamageReduction=39, DamageAbsorption=40, DamageAddition=41, PhysicalDamageAddition=42, FireDamageAddition=43, ColdDamageAddition=44, LightningDamageAddition=45, ChaosDamageAddition=46, IncreaseExpAmount=47, AdditionalExp=48, CastSpeed=49, SkillHealIncrease=50, SkillDurationIncrease=51, AllElementalResistance=52, IncreaseProjectileDamage=53, IncreaseMeleeDamage=54, IncreaseAreaOfEffectDamage=55, IncreaseSummonDamage=56, IncreaseProjectileSpeed=57, AddHpPerKill=58, AddAllSkillLevel=59, ElementalBlockChance=60, ElementalDodgeChance=61, MaxElementalBlockChance=62, MaxElementalDodgeChance=63. (64 valores, 0-63)
- `MODTYPE` (dump.cs:336232) [VERIFICADO]: FLAT=0, ADDITIVE=1, MULTIPLICATIVE=2.
- `MODSOURCE` (dump.cs:336242) [VERIFICADO]: BASE=0, ITEM=1, ATTRIBUTE=2, PASSIVE=3, AccountStatus=4, StatusEffect=5, BuffSkill=6, ENVIROUNMENT=7.

**Resolucao read-only** (a partir de `StageManager.HeroList: Hero[]@0x30` ja resolvido):
1. Para cada `Hero*` em `HeroList`: ler ponteiro `uf* cache` em `Hero+0x3A0`. (Monstros: `MonsterSpawnManager.MonsterList`→`Monster*`→`ud.tl* cache` em `Monster+0x3B0`.)
2. No objeto `uf`/`ud.tl` (que e um `uo`): ler `xd* = *(cache + 0x10)` (`uo.behg`).
3. No `xd`: ler `Dictionary<StatType,float>* total = *(xd + 0x18)` (`bets`) — esta e a ficha final agregada. (Opcional: `*(xd+0x20)` = `bett`.)
4. No Dictionary: ler `entriesArray = *(dict + 0x18)`; `count = *(int*)(dict + 0x20)`.
5. Iterar `i` de 0 a count-1 sobre `entriesArray` (dados @ array_base+0x20, stride 16): `key = *(int*)(entry+0x8)` (=StatType), `value = *(float*)(entry+0xC)`. Pular entries com `hashCode<0` (slots livres). Mapear `key`→nome via enum StatType acima.
6. Resultado: ficha {StatType: float} completa do heroi, em plaintext.

**Gotchas / confianca:**
- **Onde a pergunta presumiu errado:** os 12 `ObscuredFloat` em `Unit@0x104` NAO sao os 64 stats — sao um punhado de stats "core" cacheados em runtime, com nomes 100% ofuscados (bcex..bcfi), impossiveis de mapear indice→StatType com confianca so pelo dump (exigiria ler os corpos RVA dos getters brdy/brdz/...). A ficha real e indexada por StatType e mora no `xd.bets`. (CONFIANCA ALTA na localizacao do `xd.bets`; confianca BAIXA em mapear os ObscuredFloats individuais — evite-os.)
- **Cripto:** o `Dictionary<StatType,float>` (bets/bett) e PLANO (`float` puro), assim como os modificadores `up.behm` (`float` puro) e suas chaves StatType/MODTYPE/MODSOURCE. So precisa do XOR (`hiddenValue ^ currentCryptoKey` reinterpretado como float via union, e o `hash` valida anti-tamper) se voce optar por ler os `ObscuredFloat` de `Unit`/`ud.tl` em vez do dict — recomendo NAO fazer isso.
- **bets vs bett:** confirmei que sao dois caches distintos (il2cpp.h:94904-94905); pelo padrao do sistema (registro `uq` com mods por MODSOURCE BASE/ITEM/etc.) e fortemente provavel que `bets` = total final e `bett` = cache secundario (base ou dirty-flag), mas NAO verifiquei os corpos RVA de `kg/kak/bnx` para provar qual getter le qual. Se precisar de certeza absoluta sobre qual dict e "o total", leia ambos em runtime e compare com a UI. (CONFIANCA MEDIA em bets=total.)
- **Estado vs persistente:** isto e ESTADO DE RUNTIME (stats computados da instancia viva do Unit em cena), recalculado por mods (itens/atributos/buffs). NAO e save persistente. A fonte persistente de progressao fica em `HeroSaveData` (heroKey/HeroLevel/exp/itens) ja resolvido, e atributos investidos provavelmente em `AttributeSaveData` (nao coberto aqui) — o `xd` deriva o numero final a partir dessas fontes + nivel + equipamento.
- **Dictionary pode reordenar/rehash:** as entries nao tem ordem estavel e ha slots livres (hashCode<0 / freeList); sempre filtre por hashCode e itere ate `_count`+freeCount. Releia o ponteiro do dict a cada poll (pode ser recriado em level-up/reequip).
- **Entry layout:** o struct `Dictionary.Entry<StatType,float>` nao aparece nomeado no dump; usei o layout canonico .NET (key@0x8/value@0xC, stride 16) — CONFIANCA ALTA (StatType e float sao ambos 4 bytes, sem padding extra), mas confirme o stride em runtime lendo 2-3 entries conhecidas.

=====================

I now have everything needed. Let me confirm the `te` UniqueId backing field stride: `bdyr ObscuredULong@0x148` (16-byte fields: hash@0x148, hiddenValue@0x150, currentCryptoKey@0x158). And map the `ObscuredInt` level field. The getter `ipp()`→ulong is UniqueId reading `bdyr`. The 5 GearModData are the rolled stat mods (StatType/ModType/Value each ObscuredInt). 

One last verification: the `te` ObscuredInt fields (level/enchant counts) — confirm `ipu()` (level, ObscuredInt) maps to a backing field. The most likely candidate is `bdyw@0x198`. I have enough to write the report with appropriate confidence on the offsets I've directly read (field offsets are certain; getter→field mapping I'll mark medium). Let me do one final check to confirm there isn't a simpler plain ItemKey field on `te` and check what `irx` builds (to confirm te = ItemInfoData + ItemSaveData merge).

The field layout is fully read. I have all I need to produce the report.

## DOMINIO: Equipamentos (Itens / Gear)

**Viavel read-only:** parcial — a topologia resolve 100% (catalogo estatico + registro UniqueId->gear sao ponteiros plain), mas TODO atributo de instancia (nivel, mods/stats rolados, enchants, ate o proprio UniqueId no objeto gear) e ObscuredInt/ULong e exige o XOR ACTk por instancia.

**Classes:**
- `HeroSaveData` (342729) — save do heroi; `equippedItemIds` (ulong[]) lista os **UniqueId** dos itens equipados (NAO ItemKeys)
- `ItemSaveData` (342805) — save persistente de cada item (ItemKey, UniqueId, enchant counts/data); base do estado serializado
- `ItemEnchantSaveData` (342779, struct) — enchant serializado (plain ints): StatModKey/Tier/Value/RecipeType/ModType/MaterialKey/StatType
- `ItemInfoData` (354859, `: ze`) — CATALOGO estatico keyed por ItemKey: GRADE/PARTS/GEARTYPE/Level/NameKey. Carregado de ScriptableObject/ClassMap, plain
- `GearTypeInfoData` (354545) — base-stats por EGearType (catalogo)
- `GradeInfoData` (354635) — slots/pesos por EGradeType (catalogo)
- `ud.th.te` (331532) — **modelo de gear em runtime** (merge de ItemInfoData + ItemSaveData); campos de instancia Obscured
- `ud.th.GearModData` (331416, struct) — 1 stat rolado do gear: StatType/ModType/Value (3x ObscuredInt)
- `ud.th.ItemEnchantData` (331439, struct) — enchant em runtime: 6x ObscuredInt + MaterialKey(int)
- `ud.th` (332084, static) — **REGISTRO de gear**: `Dictionary<ulong, ud.th.te> bdzo` @0x0 (UniqueId -> gear). Ponto de resolucao
- `ud.tc` (330997, static) — registro de INVENTORY-SLOT (`ul`), nao confundir com gear
- `ul` (335698, `: zw, zv`) — wrapper de InventorySaveData (slot da bag), NAO e o item/gear
- `PlayerSaveData` (328698) — raiz do save: `List<ItemSaveData> itemSaveDatas` @0x80, `List<HeroSaveData> heroSaveDatas` @0x30 — ⚠ this domain wrongly called it `SaveContainer @328700`; corrected per extraction-spec.md E1 (@328700 is the `// Fields` comment INSIDE PlayerSaveData, not a class)

**Campos-chave:**
- `HeroSaveData.equippedItemIds` @0x28 (ulong[]) — UniqueIds equipados (slot por indice do array)
- `HeroSaveData.equippedSKillKey` @0x30 (int[]) — skills, fora do escopo de itens
- `ItemSaveData.ItemKey` @0x10 (int, **PLAIN** — nao Obscured aqui) — chave do catalogo
- `ItemSaveData.UniqueId` @0x18 (ulong, **PLAIN**) — id da instancia
- `ItemSaveData.IsChaotic` @0x20 (bool) / `IsBlocked` @0x21 / `IsServerPendingItem` @0x22
- `ItemSaveData.EnchantCount` @0x28 (int[]) / `EnchantData` @0x30 (ItemEnchantSaveData[]) — enchants persistidos (plain)
- `ItemSaveData.DecorationAppliedTotalCount` @0x38 / `EngravingAppliedTotalCount` @0x3C / `InscriptionAppliedTotalCount` @0x40 (int)
- `ItemInfoData.ItemKey` @0x30 (int) / `ITEMTYPE` @0x34 / `GRADE` @0x38 (EGradeType) / `PARTS` @0x3C (EItemParts) / `GEARTYPE` @0x40 (EGearType) / `GearGroup` @0x44 / `NameKey` @0x50 (string) / `Level` @0x6C (int) — TODOS plain (catalogo)
- `ud.th.te.bdyd` @0x10 (ItemInfoData, ref plain) — ponteiro pro catalogo (le GRADE/PARTS/GEARTYPE/Level daqui sem cripto)
- `ud.th.te.bdym..bdyq` @0x58/0x88/0xB8/0xE8/0x118 (GearModData x5) — os 5 stats rolados (cada um 3x ObscuredInt) **(OBSCURED)**
- `ud.th.te.bdyr` @0x148 (ObscuredULong = UniqueId) **(OBSCURED)** — getter `ipp()`
- `ud.th.te.bdyv` @0x190 (ItemEnchantData[]) — enchants runtime **(OBSCURED nos elementos)**
- `ud.th.te.bdyw` @0x198 / `bdyx[]` @0x1A8 / `bdyy` @0x1B0 / `bdyz` @0x1C0 / `bdza` @0x1D0 (ObscuredInt) — nivel/contadores de enchant **(OBSCURED)**; getter de nivel `ipu()` retorna ObscuredInt
- `ud.th.te.bdzd` @0x200 (ObscuredLong) **(OBSCURED)** — provavel preco/alchemy gold
- `GearModData.StatType` @0x0 / `ModType` @0x10 / `Value` @0x20 (ObscuredInt) **(OBSCURED)** — stride 16 bytes
- `ItemEnchantData.StatModKey`@0x0/`Tier`@0x10/`Value`@0x20/`RecipeType`@0x30/`ModType`@0x40/`StatType`@0x50 (ObscuredInt) **(OBSCURED)**; `MaterialKey`@0x60 (int, plain)
- `ud.th.bdzo` @0x0 (Dictionary<ulong, te>, **PLAIN**) — registro UniqueId->gear

**Enums (VERIFICADO por grep):**
- `EGradeType` (354944): COMMON=0, UNCOMMON=1, RARE=2, LEGENDARY=3, IMMORTAL=4, ARCANA=5, BEYOND=6, CELESTIAL=7, DIVINE=8, COSMIC=9, NONE=10
- `EItemParts` (354962) [= o "slot"]: NONE=0, MAIN_WEAPON=1, SUB_WEAPON=2, HELMET=3, ARMOR=4, GLOVES=5, BOOTS=6, AMULET=7, EARING=8, RING=9, BRACER=10
- `EItemType` (354919): STAGEBOX=0, MATERIAL=1, GEAR=2, NONE=3
- `EGearType` (354992): NONE=0, SWORD=1, BOW=2, STAFF=3, SCEPTER=4, CROSSBOW=5, AXE=6, SHIELD=7, ARROW=8, ORB=9, TOME=10, BOLT=11, HATCHET=12, HELMET=13, ARMOR=14, GLOVES=15, BOOTS=16, AMULET=17, EARING=18, RING=19, BRACER=20
- `EGearGroup` (354980): NONE=0, WEAPON=1, ARMOR=2, ACCESSORY=3, COMMON=4
- `EEquipClassType` (354930): All=0, Knight=1, Ranger=2, Sorcerer=3, Priest=4, Hunter=5, Slayer=6
- NAO existe `EEquipSlot` — o slot e `EItemParts`.

**Resolucao read-only (a partir do que ja resolvemos):**
1. Heroi -> `equippedItemIds` (ulong[] @0x28): resolva HeroSaveData (ja faz CommonSaveData/HeroSaveData por offset). Cada elemento e um **UniqueId**, posicao no array = slot.
2. Ache a Il2CppClass do registro estatico `ud.th` (escaneia string `"ud.th"` -> classe). Em IL2CPP, `Dictionary<ulong,te> bdzo` e campo **static** -> fica no `static_fields` da Il2CppClass (Il2CppClass->static_fields @ offset da struct; ja conseguem achar a classe via name@0x10). O dict esta em static_fields+0x0.
3. Leia o Dictionary<ulong, te>: layout padrao .NET — `entries[]`@0x18 (array de Entry{int hashCode@0x0, int next@0x4, ulong key@0x8, te value@0x10}), `count`@0x38. Itere entries, case key == UniqueId, pegue o ponteiro `te value`.
   - Alternativa mais simples (recomendada p/ read-only): NAO ler o dict. Em vez disso escaneie instancias de `te` na heap (objeto com klass@0x0 == classe `te`) e leia `bdyr` (UniqueId, apos XOR) para casar com `equippedItemIds`. Mais caro, mas evita andar na estrutura interna do Dictionary.
4. Do `te`: leia `bdyd`@0x10 (ptr ItemInfoData) e siga p/ catalogo: `GRADE`@0x38, `PARTS`@0x3C, `GEARTYPE`@0x40, `Level`@0x6C, `NameKey`@0x50 — tudo **plain**, sem cripto. Isso ja da raridade/slot/tipo/nivel-base do item.
5. Stats rolados: leia os 5 `GearModData` (@0x58..0x118). Cada `StatType/ModType/Value` e ObscuredInt -> aplique XOR (passo 6). StatType decodificado indexa o enum StatType(64) ja conhecido; ModType -> MODTYPE.
6. **Decrypt ObscuredInt** (ACTk): valor real = `hiddenValue XOR currentCryptoKey`. Layout ObscuredInt: `hash`@0x0(int), `hiddenValue`@0x4(int), `currentCryptoKey`@0x8(int), `fakeValue`@0xC. Logo p/ um ObscuredInt em offset X: real = read_i32(X+0x4) ^ read_i32(X+0x8).
   **Decrypt ObscuredULong** (UniqueId `bdyr`): layout `hash`@0x0(int), `hiddenValue`@0x8(ulong), `currentCryptoKey`@0x10(ulong), `fakeValue`@0x18 -> real = read_u64(X+0x8) ^ read_u64(X+0x10). (ObscuredLong = mesmo layout do ULong.)
7. Enchants em runtime: `bdyv`@0x190 (ItemEnchantData[]) — cada elemento tem 6 ObscuredInt (XOR) + MaterialKey plain@0x60. Ou use a versao persistida `ItemSaveData.EnchantData`@0x30 (ItemEnchantSaveData, plain) varrendo `itemSaveDatas` por UniqueId — sem cripto, mais facil.

**Gotchas / confianca:**
- **CRIPTO (alta confianca):** dentro de `te`, UniqueId/nivel/mods/enchants/preco sao Obscured (ObscuredInt/ULong/Long). Sem o XOR voce le lixo (fakeValue/hiddenValue). Os offsets dos campos sao certos; a formula XOR esta verificada nas structs (linhas 1117993, 1119060).
- **Atalho sem cripto (alta confianca):** raridade(GRADE), slot(PARTS), tipo(GEARTYPE), nivel-base(Level), nome(NameKey) vem do `ItemInfoData` (catalogo, plain) via `te.bdyd`@0x10. E `ItemSaveData` (em `itemSaveDatas`@0x80) tem ItemKey/UniqueId/EnchantData **plain**. Entao "quais itens estao equipados e suas raridades/slots/enchants persistidos" e 100% legivel SEM XOR — so o nivel/stats-rolados-vivos do `te` exigem XOR.
- **equippedItemIds = UniqueId, nao ItemKey (alta confianca):** confirmado tipo ulong[] (342745) e a existencia do registro Dictionary<ulong,te> (332087). Mapear UniqueId->ItemKey passa por `te.bdyd.ItemKey` ou por `itemSaveDatas`.
- **Nao e UI-history:** `itemSaveDatas`/`equippedItemIds` sao estado PERSISTENTE real (JsonProperty, save). O registro `ud.th.bdzo` e estado runtime espelhado do save (nao historico de UI). `ud.tc`/`ul` sao slots de bag (InventorySaveData), dominio distinto — nao usar p/ resolver equipado.
- **Getter vs campo (confianca media):** getters como `ipp()`(UniqueId), `ipu()`(nivel), `ipg()`(PARTS), `ipf()`(GRADE) nao podem ser chamados em read-only; mapeei p/ campos backing por tipo/offset. UniqueId=`bdyr`@0x148 e os 5 GearModData@0x58.. sao certos pelos tipos declarados. A identificacao exata de QUAL ObscuredInt (`bdyw`@0x198 vs `bdyy`@0x1B0...) e o nivel vs contador de enchant nao foi 100% isolada — confirme em runtime decriptando os candidatos @0x198/0x1B0/0x1C0/0x1D0 e comparando com a UI.
- **Dictionary interno (confianca media):** ler `bdzo` exige andar no layout interno do Dictionary<TKey,TValue> do IL2CPP; o atalho de escanear instancias `te` por klass e mais robusto e ja e o metodo que voces usam p/ achar instancias.

Arquivos/linhas-chave: `re/dump/dump.cs` (Il2CppDumper output, GameAssembly.dll v1.00.07; não-commitado) — HeroSaveData 342729, ItemSaveData 342805, ItemInfoData 354859, gear `ud.th.te` 331532, GearModData 331416, ItemEnchantData 331439, registro `ud.th` 332084, PlayerSaveData raiz 328698 (NÃO "SaveContainer"), ObscuredInt 1117993, ObscuredULong 1119060, enums 354919-354989.

=====================

Confirmed definitively. `HeroSaveData` has no rune/pet field — runes and pets are global account-level, not per-hero. The `InventorySaveData.IsUnlockedByRune@0x21` confirms runes unlock account-wide features (inventory slots), consistent with the passive-tree model. I have everything needed.

## DOMINIO: runes-pets

**Viavel read-only:** sim — `PetSaveData` e `RuneSaveData` sao classes plaintext (int/bool simples, sem wrappers Obscured), alcançaveis via `PlayerSaveData` (listas globais) ou `PetManager` (dicionario). Stats numericos exigem cruzar com tabelas CSV estaticas.

**Classes:**
- `PetSaveData` (linha 342845) — estado salvo de 1 pet: chave, desbloqueio, visto. Plaintext.
- `RuneSaveData` (linha 342862) — estado salvo de 1 runa: chave + nivel. Plaintext.
- `PlayerSaveData` (linha ~328645, TypeDefIndex 2614) — container raiz; segura `List<PetSaveData>@0x48` e `List<RuneSaveData>@0x50` (listas GLOBAIS da conta).
- `PetManager` (linha 343118, nn<PetManager> singleton) — runtime: `Dictionary<int,PetSaveData>@0x30`, `m_arrangedPetKeyRuntimeData(int)@0x38`.
- `PetInfoData` (linha 355446, : ze) — tabela estatica CSV: PetKey→StatDataKey (liga pet a stats).
- `PetStatInfoData` (linha 355500, : ze) — tabela estatica CSV: linha de stat de pet (StatType=EAccountStatus, MODTYPE, Value).
- `RuneInfoData` (linha 355544, : ze) — tabela estatica CSV: definicao da runa (campos ofuscados, ver gotchas).
- `RuneLevelInfoData` (linha 355592, : ze) — tabela estatica CSV: stat por nivel de runa (EAccountStatus@0x40).
- `AccountStatus` (linha 341850) — agrega bonus de pets+runas em `Dictionary<EAccountStatus,ObscuredInt>@0x10` (valor agregado e OBSCURED).
- `RuneNode` (linha 351402) / `RunePage` (linha 351569) — UI de arvore de runas (nao e save state).

**Campos-chave:**
- `PetSaveData.PetKey` @0x10 (int) — chave do pet [JsonProperty "PetKey"]
- `PetSaveData.IsUnlock` @0x14 (bool) — pet desbloqueado
- `PetSaveData.IsViewed` @0x15 (bool) — flag de UI (visto na coleção)
- `RuneSaveData.RuneKey` @0x10 (int) — chave da runa [JsonProperty "RuneKey"]
- `RuneSaveData.Level` @0x14 (int) — nivel investido na runa [JsonProperty "Level"]
- `PlayerSaveData.PetSaveData` @0x48 (List<PetSaveData>) — lista global de pets
- `PlayerSaveData.RuneSaveData` @0x50 (List<RuneSaveData>) — lista global de runas
- `CommonSaveData.ArrangedPetKey` @0x40 (int) — UNICO pet ativo no momento (so 1 pet equipado) [JsonProperty "ArrangedPetKey"]
- `PetManager.beur (Dictionary<int,PetSaveData>)` @0x30 — espelho runtime dos pets por chave
- `PetManager.m_arrangedPetKeyRuntimeData` @0x38 (int) — pet ativo em runtime (espelha ArrangedPetKey)
- `PetInfoData.PetKey` @0x30 / `.StatDataKey` @0x48 (int) — liga PetKey ao bloco de stats
- `PetStatInfoData.StatType` @0x34 (EAccountStatus) / `.MODTYPE` @0x38 / `.Value` @0x3C (int) — stat concedido pelo pet
- `RuneLevelInfoData.bfob` @0x40 (EAccountStatus) / `.bfoc` @0x44 (int) — stat por nivel de runa
- `AccountStatus.betp (Dictionary<EAccountStatus,ObscuredInt>)` @0x10 — **(OBSCURED)** soma agregada dos bonus

Nenhum campo dentro de Pet/RuneSaveData e Obscured. O unico Obscured do dominio e o agregado runtime em `AccountStatus`.

**Enums (VERIFICADO por grep):**
- `EPetUnlockConditionType` (linha 355435): NONE=0, KillMonster=1, DLC=2
- `MODTYPE` (linha 336232): FLAT=0, ADDITIVE=1, MULTIPLICATIVE=2
- `EAccountStatus` (linha 341801): 0..41 — IncreaseGoldAmount=0, AdditionalGold=1, IncreaseExpAmount=2, AdditionalExp=3, DropChanceNormalChest=4, DropChanceStageBossChest=5, WaveCountReduction=6, WaveMonsterAmount=7, MaxAmountNormalChest=8, MaxAmountStageBossChest=9, MaxAmountActBossChest=10, CubeExpPercent=11, CubeAlchemyGoldPercent=12, AllHeroMoveSpeed=13, AllHeroAttackSpeed=14, AllHeroAttackDamage=15, AllHeroAttackDamagePercent=16, AllHeroArmor=17, AllHeroArmorPercent=18, AdditionalGoldStageBoss=19, AdditionalGoldActBoss=20, AdditionalGoldNormalMonster=21, AdditionalExpStageBoss=22, AdditionalExpActBoss=23, AdditionalExpNormalMonster=24, MaxInventorySlot=25, UnlockStashPageCount=26, UnlockArrangeSlotCount=27, UnlockSkillSlotCount=28, DropChanceNormalChestPercent=29, DropChanceStageBossChestPercent=30, UnlockAutoOpenNormalChest=31, ReduceAutoOpenNormalChestTime=32, UnlockAutoOpenStageBossChest=33, ReduceAutoOpenStageBossChestTime=34, UnlockAutoOpenActBossChest=35, ReduceAutoOpenActBossChestTime=36, OpenOneTypeChestAllAtOnce=37, OpenAllTypeChestAllAtOnce=38, UnlockOfflineReward=39, OfflineRewardGoldPercent=40, OfflineRewardExpPercent=41

Nota: pets/runas usam `EAccountStatus` (buffs economicos/globais da conta + AllHero*), NAO o enum `StatType(64)` de combate por unidade.

**Resolucao read-only:** Partindo do que ja resolvemos (achar classe pela string do nome → instancias por klass@0x0 → ler campos):
1. Pets: localize `PetManager` (singleton via nn<>) pela string "PetManager"; leia `m_arrangedPetKeyRuntimeData@0x38` (int) = pet ativo. Para a colecao, leia `beur@0x30` (Dictionary). Alternativa robusta: leia `CommonSaveData.ArrangedPetKey@0x40` (ja resolvido) para o pet ativo. So existe 1 pet equipado.
2. Lista completa salva: resolva `PlayerSaveData` pela string e leia `List<PetSaveData>@0x48` e `List<RuneSaveData>@0x50` (padrao List: items@0x10/_size@0x18; cada elemento e objeto com klass@0x0, ler PetKey@0x10/IsUnlock@0x14 e RuneKey@0x10/Level@0x14).
3. Runas: sao arvore de progressao GLOBAL (RunePage/RuneNode com `m_nextRuneKey` encadeados), keyed por RuneKey com Level investido — nao se equipam a heroi. Leia chave+nivel direto de cada RuneSaveData.
4. Stats numericos (opcional): RuneSaveData/PetSaveData NAO guardam stats, so chave+nivel. O valor real vem das tabelas estaticas: PetKey→PetInfoData.StatDataKey→PetStatInfoData(StatType/MODTYPE/Value); RuneKey+Level→RuneLevelInfoData(bfob=EAccountStatus, bfoc=Value). Essas tabelas sao CSV carregadas (`ze`/`ClassMap`), achaveis em runtime mas trabalhosas; mais facil extrair do CSV do jogo.

**Gotchas / confianca:**
- **Ligacao heroi/party:** VERIFIQUEI que `HeroSaveData` (linha 342729) NAO tem campo de runa/pet. Runas e pets sao 100% account-wide, nao por-heroi/por-slot. Pets afetam todos via `EAccountStatus` (incl. AllHeroAttackDamage etc.); runas desbloqueiam features da conta (ex.: `InventorySaveData.IsUnlockedByRune@0x21`, linha 342768). So 1 pet fica ativo (`ArrangedPetKey`).
- **Sem campo de slot:** `RuneSaveData` so tem RuneKey+Level — NAO ha campo "slot". O "slot"/posicao e definido pela tabela estatica da arvore (RuneNode.m_nextRuneKey), nao no save. Confianca alta.
- **OBSCURED:** Os SaveData crus sao plaintext (sem XOR). MAS o valor agregado runtime de stats vive em `AccountStatus.betp` como `Dictionary<EAccountStatus,ObscuredInt>@0x10` — se for ler dali, precisa do XOR (hiddenValue XOR currentCryptoKey por ObscuredInt). Prefira ler RuneSaveData.Level + tabela estatica e calcular voce mesmo, evitando cripto. Confianca alta.
- **IsViewed:** e flag de UI (colecao vista), nao contador/estado de gameplay. Confianca alta.
- **`PetManager` runtime vs save:** `m_arrangedPetKeyRuntimeData@0x38` e `beur@0x30` sao espelho runtime; a fonte persistente canônica e `PlayerSaveData`/`CommonSaveData`. Ambos confiaveis para leitura ao vivo.
- **Lacuna (media confianca):** Nomes de campos de `RuneInfoData` (bfnp..bfnw, @0x30-0x58) ficaram ofuscados — nao estao no stringliteral.json nem mapeados em texto legivel; inferencia pelo tipo: 2x int + chave + 3 strings (NameKey/DescKey/IconKey) + 2 int, por analogia a PetInfoData. Nao sao necessarios para ler estado do jogador (so chave+nivel bastam). `RuneLevelInfoData.bfob@0x40 (EAccountStatus)` e `.bfoc@0x44 (Value)` foram identificados pelo tipo concreto do campo.

=====================

The `List<ActiveSkill> bcgj @0x328` and `Dictionary<int, ActiveSkill> bcgl @0x338` live on the **`Unit` base class** (line 319277) — which Hero already extends and which we already resolve. This is the cleanest runtime path: each live Hero unit carries its instantiated ActiveSkill objects, each holding a `un skillCache @0x18` → `SkillInfoData begn @0x10`. I have a complete, verified picture. Writing the final report.

## DOMINIO: Skills (skills equipadas por heroi, niveis, info estatica, DPS teorico)

**Viavel read-only:** sim — toda a chain resolve a partir de Unit (ja resolvido) e de um singleton de dados; `SkillInfoData` e 100% plano (nenhum campo Obscured), valores por-nivel exigem ler um dict de level-table mas tambem plano.

**Classes:**
`HeroSaveData` (342729) — save de heroi; lista de skill keys equipadas (persistente)
`SkillInfoData : ze` (355677) — registro estatico de skill (key, nome-key, params, atributo de dano, slot). Campos planos
`PassiveSkillInfoData : ze` (355390) — registro de skill passiva (statType/modType/value)
`SkillLevelInfoData : ze` (355761) — entrada de tabela por-nivel (3 ints: bfod/bfoe/bfof @0x30/0x34/0x38)
`un` (335893) — CACHE runtime de skill (envolve SkillInfoData; stats em Obscured*)
`um` (335807) — cache runtime de skill passiva (envolve PassiveSkillInfoData)
`ActiveSkill` (abstract, 360548) — instancia de skill ativa no combate; guarda `skillCache (un) @0x18`
`Unit : MonoBehaviour` (319277) — base de Hero/Monster; carrega as ActiveSkill instanciadas em runtime
`yp : nn<yp>` (352341) — singleton tabela-mestre de dados; dict skillKey->SkillInfoData
`ScriptableObjectDataContainer` (353756) — singleton (static Instance@0x0); dict skillKey->SkillSO (prefabs/anim/sprite)
`SkillStatusDescriptionPanel : MonoBehaviour` (349069) — UI de tooltip; contem `m_DPS`
`SkillSO : ScriptableObject` (293630) — dados de apresentacao/efeitos da skill (nao numericos de balanco)

**Campos-chave:**
`HeroSaveData.equippedSKillKey` @0x30 (int[]) — keys das skills equipadas (note o "K" maiusculo); resolve por StageManager.HeroList ou pelo save
`SkillInfoData.SkillKey` @0x30 (int) — chave da skill (= chave do dict em yp)
`SkillInfoData.SkillNameKey` @0x38 (string) — chave de localizacao do nome
`SkillInfoData.SkillDescriptionKey` @0x40 (string) — chave de localizacao da descricao
`SkillInfoData.ActivationType` @0x48 (ACTIVATIONTYPE) — como dispara (BASEATTACK/COOLDOWN/CONTINUOUS)
`SkillInfoData.ActivationValue` @0x4C (int) — cooldown/contagem conforme ActivationType
`SkillInfoData.DamageAttribute` @0x50 (EDamageAttribute) — atributo de dano
`SkillInfoData.DamageDeliveryType` @0x54 (EDamageType) — Melee/Projectile/AOE/DOT/...
`SkillInfoData.SlotType` @0x58 (SLOTTYPE) — BASEATTACK(0)/SKILL(1)
`SkillInfoData.SkillBuffType` @0x5C (SkillBuffType) — Normal(0)/Buff(1)
`SkillInfoData.Param1..Param5` @0x64/0x68/0x6C/0x70/0x74 (int) — params de balanco
`SkillInfoData.Value` @0x80 (int) — valor base
`SkillInfoData.SkillLevelKey` @0x84 (int) — chave para a level-table (dict bfit em yp)
`PassiveSkillInfoData.bfnm` @0x40 (StatType), `.bfnn` @0x44 (MODTYPE), `.bfno` @0x48 (int valor)
`SkillLevelInfoData.bfod/bfoe/bfof` @0x30/0x34/0x38 (int) — provaveis {nivel, key, valor-por-nivel} (nomes ofuscados; semantica nao confirmada)
`Unit.bcgj` @0x328 (List<ActiveSkill>) — skills ativas instanciadas neste Hero em runtime
`Unit.bcgl` @0x338 (Dictionary<int,ActiveSkill>) — mapa skillKey->ActiveSkill ativo
`ActiveSkill.skillCache` @0x18 (un) — cache runtime da skill; `ActiveSkill.skillSo` @0x10 (SkillSO)
`un.begn` @0x10 (SkillInfoData) — ref ao registro estatico (porta de entrada NAO-obscured)
`un.bego/begp/begq/begr` @0x18/0x28/0x38/0x48 (ObscuredInt) (OBSCURED) — params runtime cacheados
`un.begs` @0x58 (ObscuredFloat) (OBSCURED), `un.begt` @0x6C (ObscuredFloat) (OBSCURED) — floats runtime (provavel dano/escala)
`un.begu..begy` @0x80/0x90/0xA0/0xB0/0xC0 (ObscuredInt) (OBSCURED)
`un.begz` @0xD0 (SkillSO) — ref ao SkillSO
`yp.bfim` @0x90 (Dictionary<int,SkillInfoData>) — skillKey -> SkillInfoData (lookup principal)
`yp.passiveSkillInfoDatas` @0x98 (List<PassiveSkillInfoData>)
`yp.bfit` @0x120 (Dictionary<int,Dictionary<int,SkillLevelInfoData>>) — [skillLevelKey][nivel] -> SkillLevelInfoData
`ScriptableObjectDataContainer.bflb` @0x50 (Dictionary<int,SkillSO>) — skillKey -> SkillSO; `.SkillData` @0x48 (List<SkillSO>)
`SkillStatusDescriptionPanel.m_DPS` @0xB0 (TextMeshProUGUI) — **UI text label, NAO numerico**; idem `m_coolTime`@0xA8

**Enums (VERIFICADO por grep):**
`ACTIVATIONTYPE` (355741): BASEATTACK=0, BASEATTACK_COUNT=1, COOLDOWN=2, CONTINUOUS=3
`SLOTTYPE` (355752): BASEATTACK=0, SKILL=1
`SkillBuffType` (355667): Normal=0, Buff=1
`SKILLTYPE` [Flags] (335878): None=0, Direct=1, Projectile=4, Aoe=8, SpawnTurret=16, SpawnTrap=32, SpawnSomething=64, SpawnRandomMonster=128
`EDamageType` [Flags] (~355650): None=0, Melee=1, Projectile=2, AOE=4, Summon=8, DOT=16, Trap=32

**Resolucao read-only:**
1. Skills equipadas (persistente): a partir de CommonSaveData/HeroSaveData ja resolvidos -> `HeroSaveData.equippedSKillKey` @0x30 (int[], layout Il2CppArray: data@0x20, _size). Cada elemento e um skillKey.
2. Skills ativas no combate (runtime, preferivel): a partir de StageManager.HeroList -> cada Hero (extends Unit) -> `Unit.bcgj` @0x328 (List<ActiveSkill>, items@0x10/_size@0x18). Cada ActiveSkill -> `skillCache (un)` @0x18 -> `un.begn (SkillInfoData)` @0x10.
3. skillKey -> info estatica: localize o singleton `yp` (escaneie a string de classe "yp" e/ou ache a instancia MonoBehaviour cujo klass aponta pra ela; nn<a> guarda o singleton em static `bbwf`, entao mais robusto e achar a instancia viva pelo metodo ja usado). Leia `yp.bfim` @0x90 (Dictionary<int,SkillInfoData>), procure a entry com `SkillInfoData.SkillKey` @0x30 == skillKey. (Layout Dictionary IL2CPP: entries array + count; iterar buckets/entries.)
4. Nome/descricao: `SkillInfoData.SkillNameKey`@0x38 / `SkillDescriptionKey`@0x40 sao chaves de localizacao (strings) — passe pela tabela de i18n do jogo para texto final; cru, voce ja tem a key.
5. Nivel da skill por-nivel: use `SkillInfoData.SkillLevelKey`@0x84 + nivel atual -> `yp.bfit` @0x120 (dict aninhado [levelKey][nivel]) -> `SkillLevelInfoData` (3 ints). O "nivel atual" da skill nao esta em HeroSaveData (so heroKey/HeroLevel) — vem do cache runtime `un` (ObscuredInt) ou e derivado de HeroLevel; precisa investigacao adicional para confirmar a origem do nivel.
6. SkillSO (sprite/anim/efeitos): `ScriptableObjectDataContainer.Instance` (static@0x0) -> `bflb` @0x50 (dict skillKey->SkillSO). So util para apresentacao, nao para dano.

**Gotchas / confianca:**
- **m_DPS e UI, nao contador.** `SkillStatusDescriptionPanel.m_DPS`@0xB0 e um `TextMeshProUGUI` — texto formatado de tooltip (DPS teorico exibido), nao um numero persistente nem o DPS real do combate. Ler isso da um string ja renderizado e so existe quando o painel esta aberto. Para DPS real/empirico, use seu meter (HP delta dos Monsters via UnitHealthController + LogManager), nao este campo. Confianca alta.
- **SkillInfoData/PassiveSkillInfoData/SkillLevelInfoData sao 100% planos (nenhum Obscured)** — leitura direta por offset. Confianca alta (verifiquei o bloco 355677-355704, zero ocorrencias de Obscured).
- **O cache runtime `un` e fortemente Obscured** (bego..begy = ObscuredInt/Float = CodeStage ACTk): valor real = hiddenValue XOR cryptoKey por instancia. Evite-o; prefira o caminho via `un.begn -> SkillInfoData` (plano) para tudo que precisar. Confianca alta.
- **Nivel da skill: lacuna.** HeroSaveData NAO tem nivel de skill (so equippedSKillKey + HeroLevel). O nivel efetivo provavelmente vive no `un` cache (Obscured) ou e funcao de HeroLevel; nao confirmei a fonte persistente. Confianca media-baixa nesse ponto especifico.
- **Semantica de SkillLevelInfoData.bfod/bfoe/bfof e dos Param1..5 e nomes ofuscados** — offsets certos, significado inferido. Cruze com dados in-game para mapear. Confianca media.
- **equippedSKillKey** tem o "K" maiusculo no meio (typo do dev) — atencao ao casar a string. Confianca alta (linha 342746-342747).
- **Singleton `yp`**: `nn<a>` guarda o singleton em static field (`bbwf`@0x0 no storage estatico da classe, nao no objeto). Resolver via static exige ler o ponteiro de estatico da Il2CppClass; mais simples e achar a instancia viva pelo metodo de scan que ja usam. Confianca media na mecanica de localizar o singleton, alta nos offsets dos dicts.

Arquivo de referencia: `re/dump/dump.cs` (Il2CppDumper output, GameAssembly.dll v1.00.07; artefato externo não-commitado) — linhas citadas acima.

=====================

Confirmed: `ut` derives from `MonoBehaviour` (via `nn<ut>`), so the dump's `// 0x20`, `// 0x28` are absolute object offsets — directly readable. The aggregate holder `ut` is layout-identical in resolution to StageManager (both `nn<T>` MonoBehaviour singletons). 

I have everything needed. Here is the domain analysis.

## DOMINIO: agregados-stage-info

**Viavel read-only:** sim — todos os campos sao tipos primitivos (int/long), zero `Obscured*`; o holder `ut` e singleton `nn<ut>` identico em layout ao StageManager que ja resolvemos.

**Classes:**
- `ut : nn<ut>` (dump.cs:336558) — holder em runtime dos agregados vivos (kills/gold/playtime). Singleton MonoBehaviour. **NAO confundir** com namespace; e classe ofuscada de 2 letras.
- `nn<a> : MonoBehaviour` (dump.cs:315606) — base singleton generica; instancia em static field `bbwf@0x0`.
- `yp : nn<yp>` (dump.cs:352341) — DataManager mestre (TypeDefIndex 3132); guarda as tabelas de definicao de stage. Singleton.
- `StageInfoData : ze` (dump.cs:355865) — definicao estatica de um stage (waves, mobs por wave, boss, drops).
- `StageLevelInfoData : ze` (dump.cs:355932) — escala por nivel de stage (campos todos ofuscados `bfog`..`bfok`, nao mapeados aqui).
- `ze` (dump.cs:355114) — base abstrata das *InfoData; ocupa 0x10-0x2F, por isso campos de StageInfoData comecam em 0x30.
- `CommonSaveData` (dump.cs:328578) — fonte da wave/stage ATUAIS ao vivo (ja resolvido).
- `StageManager : nn<StageManager>` (dump.cs:327247) — NAO cacheia StageInfoData; so estado de batalha. Use como template de resolucao do singleton.

**Campos-chave:**
- `ut.beid` @0x20 (`Dictionary<EAggregateType, Dictionary<int,long>>`) — **o dict de agregados**. Outer key=EAggregateType; inner key=stageKey (int); value=contador (long). Ex.: kills, gold, playtime acumulados.
- `ut.OnAggregateChanged` @0x28 (`Action<EAggregateType,int,long>`) — evento; ignore para leitura.
- `nn<ut>.bbwf` @0x0 do `static_fields` (`ut_o*`) — **ponteiro da instancia singleton** (il2cpp.h:89926).
- `yp.stageInfoData` @0x80 (`List<StageInfoData>`) — **tabela de todos os stages** (dump.cs:352356).
- `yp.stageLevelinfoDatas` @0x110 (`List<StageLevelInfoData>`) — tabela de escala (dump.cs:352375).
- `yp` (nn<yp>) instancia @0x0 do static_fields (mesmo `bbwf`, il2cpp.h:102227).
- `StageInfoData.StageKey` @0x30 (int) — chave; casa com `CommonSaveData.currentStageKey`.
- `StageInfoData.WaveAmount` @0x54 (int) — **TOTAL de waves** do stage (o "29" em "1/29").
- `StageInfoData.WaveMonsterAmount` @0x58 (int) — **monstros por wave**. Total de mobs do stage = `WaveAmount * WaveMonsterAmount` (o "512" em "15/512"; ver gotcha).
- `StageInfoData.STAGETYPE` @0x40 (EStageType), `.STAGEDIFFICULTY` @0x44 (ESTAGEDIFFICULTY), `.Act` @0x48, `.StageNo` @0x4C, `.StageLevel` @0x50, `.BossMonsterKey` @0x7C, `.NextStageKey` @0xA0 (todos int) — metadados uteis.
- `CommonSaveData.currentStageKey` @0x58 (int) — stage atual. **Plain int, NAO Obscured.**
- `CommonSaveData.currentStageWave` @0x5C (int) — **wave atual ao vivo** (o "1" em "1/29"). **Plain int.**
- `CommonSaveData.maxCompletedStage` @0x54 (int) — progresso maximo.
- Layout interno do inner `Dictionary<int,long>`: `_buckets`@0x10, `_entries`@0x18, `_count`@0x20, `_freeList`@0x24, `_freeCount`@0x28, `_version`@0x2C, `_comparer`@0x30. Entry (stride **24 bytes**, 8-aligned): `hashCode`@0x0, `next`@0x4, `key`@0x8, `value(long)`@0x10 (il2cpp.h:787129 + alinhamento int64).

**Enums:**
- `EAggregateType` (dump.cs:336661) **[VERIFICADO]**: MonsterKill=0, HeroDeath=1, GoldEarn=2, BoxObtain=3, ItemObtain=4, Synthesis=5, Alchemy=6, Crafting=7, Offering=8, Extraction=9, Decoration=10, Engraving=11, Inscription=12, StageClear=13, StageFail=14, PlayTime=15, BoxOpen=16.
- `EStageType` (dump.cs:355855) **[VERIFICADO]**: NORMAL=0, ACTBOSS=1.
- `ESTAGEDIFFICULTY` (dump.cs:355843) **[VERIFICADO]**: NORMAL=0, NIGHTMARE=1, HELL=2, TORMENT=3, COUNT=4.

**Resolucao read-only:**

*Para totais do stage atual (WaveAmount / WaveMonsterAmount):*
1. Le `CommonSaveData.currentStageKey@0x58` (ja resolvido) e `currentStageWave@0x5C`.
2. Resolve singleton `yp`: escaneie a classe `yp` por nome (ofuscado — ver gotcha; melhor ancorar pela string de algum campo conhecido ou pela tabela) -> `Il2CppClass.static_fields` -> le ptr @0x0 (`bbwf`) = instancia `yp`.
3. Na instancia `yp`, le `List<StageInfoData> @0x80`: items@0x10, _size@0x18. Para cada elemento (ptr de objeto), le `StageKey@0x30`; quando `StageKey == currentStageKey`, achou o `StageInfoData`.
4. Nesse `StageInfoData` le `WaveAmount@0x54` e `WaveMonsterAmount@0x58`.
5. UI: wave = `currentStageWave / WaveAmount`. Mobs do stage = `WaveAmount * WaveMonsterAmount` (validar — ver gotcha).

*Para agregados vivos (kills/gold/playtime):*
1. Resolve singleton `ut` (mesma mecanica do StageManager): classe `ut` -> `static_fields` -> ptr @0x0 = instancia.
2. Na instancia le `beid@0x20` = outer `Dictionary<EAggregateType,Dictionary<int,long>>`.
3. Caminhe o outer dict por entries (`_entries@0x18`, `_count@0x20`): cada entry key=EAggregateType(int)@0x8, value=ptr do inner dict@0x10.
4. Selecione o agregado desejado (ex.: MonsterKill=0, GoldEarn=2, PlayTime=15), pegue o inner `Dictionary<int,long>`.
5. No inner dict, caminhe entries (stride 24B): key(stageKey)@0x8, value(long)@0x10. Filtre por `key==currentStageKey` para o valor do stage atual; ou some/itere todas para totais globais.

**Gotchas / confianca:**
- **Nomes ofuscados de 2 letras (`ut`, `yp`):** o scan-por-string-do-nome-da-classe e fragil para nomes tao curtos (alto risco de falso-positivo no heap). Mitigacao: ancore pela classe BASE generica instanciada (`nn<ut>`/`nn<yp>` tem nomes de tipo derivados distintos no metadata) ou valide o candidato checando o shape esperado dos campos (ex.: `ut` tem exatamente 2 campos: um Dictionary@0x20 + um Action@0x28; `yp` tem ~60 List/Dictionary). **Confianca media** so na etapa de localizar o singleton; **alta** depois que a instancia esta em mao.
- **"15/512" — formula nao 100% confirmada:** `WaveMonsterAmount` e claramente *mobs por wave*; o total `WaveAmount*WaveMonsterAmount` e a interpretacao natural mas NAO ha codigo de UI legivel provando (o `StageWaveIconSliderController@348331` so tem um `Slider` float, sem contador). O "15" (mob atual) provavelmente vem de contagem viva de mortes na stage — candidato: `ut.beid[MonsterKill][currentStageKey]` (long). **Confianca media** na formula; valide em runtime comparando com a UI.
- **`currentStageWave` base (0 vs 1):** nao determinei se e 0-based ou 1-based. Para exibir "1/29" pode precisar `+1`. **Confianca media** — checar empiricamente.
- **NADA e Obscured neste dominio** (verificado em il2cpp.h e dump): dict de agregados e `long` puro, campos de StageInfoData/CommonSaveData sao `int` puros. Sem XOR necessario. **Confianca alta.**
- **Estado vs historico:** `ut.beid` e CONTADOR PERSISTENTE real (agregados acumulados, salvos), nao UI-history. `CommonSaveData.currentStage*` e estado persistente real. StageInfoData e DEFINICAO estatica (tabela carregada de dados), imutavel em runtime. **Confianca alta.**
- **`StageLevelInfoData`** tem campos todos ofuscados (`bfog`@0x30..`bfok`@0x40, todos int) — nao mapeei significado; provavelmente nao necessario para wave/mob counts. Lacuna conhecida.
- Lookup de StageInfoData e por **iteracao na List** (nao ha `Dictionary<int,StageInfoData>` exposto em `yp`; existe metodo `iue(int)` em dump.cs:332726 que faz isso internamente). Iterar ~centenas de entries e barato. **Confianca alta.**