---
type: archive
status: superseded
description: "SNAPSHOT histórico (RE cru ou plano entregue) — nomes/offsets/linhas podem estar obsoletos; a verdade atual está nas notas vivas (ver _index). Isento do drift-test de código."
---

# Plano de mapeamento de valores do TBH

Como a gente mapeia, valida e guarda **todo** valor que o meter lê da memória do jogo — de
um jeito que sobreviva a rebuilds e não vire achismo. Escrito depois do caso do gold de
combate (2026-06-05), que serve de modelo.

---

## 1. Princípio: cada valor mora em UM lugar (single source of truth)

Reusa a variável, nunca repete o literal. Mas o "onde mora" depende da **estabilidade** do
valor entre builds do jogo:

| Tipo de valor | Muda entre builds? | Onde mora | Exemplos |
|---|---|---|---|
| **Offset / ID / enum** | ❌ estável | `config/offsets.py` (a bíblia) | `AggregateManager.AGGREGATES=0x20`, `GOLD_KEY=100001`, `EAggregateType.GoldEarn=2` |
| **Regra de negócio** | ❌ (semântica do jogo) | no módulo de lógica, comentada | `COMBAT_SUBKEY=1` em `metrics/gold.py` |
| **Nome de classe ofuscado** | ✅ **todo build** | **NÃO se guarda** — resolve por estrutura | `ut`→`uu`→`ux`… do AggregateManager |

**Regra de ouro:** se um valor é um *offset* ou *id* (não muda), ele vai pro `offsets.py` e
todo mundo importa de lá. Se é um *nome ofuscado* (muda), **não existe variável que salve** —
você teria que recaçar o nome a cada build. A solução é não depender do nome: achar o objeto
**por estrutura** (pelo que ele contém), como o `gold.py` faz com o `AggregateManager`.

---

## 2. Metodologia pra mapear/validar QUALQUER valor (a que cravou o gold)

Quatro passos, na ordem. Nenhum "chute por valor isolado".

**A) Oráculo de resposta conhecida.** Tenha o número REAL antes de procurar (gold do jogo,
xp de uma run, dano de um hit). Sem isso você não consegue provar nada — foi o que faltou e
deixou subir gold≈0 e depois 1.97T.

**B) Achar por ESTRUTURA, não por nome nem por valor único:**
- **Assinatura de N valores conhecidos juntos.** Ex.: o inner-dict GoldEarn vivo é o único
  Dict8B com `SubKey1≈combat_save` E `SubKey0≈total_save` lado a lado. Dois números na casa
  do bilhão juntos não acontecem por acaso.
- **Liveness (crescimento).** A célula viva CRESCE enquanto a ação acontece; cópias
  congeladas (sobra de autosave/GC) não. Distingue a viva sem depender do valor exato.
- **Subir ponteiros até a RAIZ.** De uma célula, ache quem aponta pra ela (backrefs) até
  chegar num objeto enraizado — um singleton `nn<T>` confirma pelo round-trip do campo
  estático `bbwf`. Isso é **posse**, não palpite: cópia congelada não é enraizada.

**C) Validar com o oráculo, em VÁRIAS runs, incluindo bordas.** Ex. gold: 3 runs, delta ==
carteira na unidade; +1 run vendendo um item, pra provar que o combate (`SubKey1`) **exclui**
a venda (`live_total − live_combat` = valor exato da venda).

**D) Ferramentas prontas** (em `tbh-meter-dev/`, fora do app, read-only):
- `tbh_mem.py` — cópias fiéis dos primitivos do reader (Reader, scan, resolver, singleton).
- `gold_diag.py` / `gold_diag2.py` — achar célula por crescimento / por assinatura de 2 valores + dump da estrutura + subida ao singleton.
- `gold_monitor.py` — fica escutando run a run e loga as variáveis por run num txt (cruzar com o oráculo).
- `test_gold_real.py` (em /tmp no dev) — teste unitário com memória SINTÉTICA (viva vs cópia congelada) contra o módulo real. **Todo valor novo deve ganhar um teste desses.**

---

## 3. Inventário de valores

Status: ✅ validado ao vivo · 🟡 mapeado, revalidar · ⚪ TODO/futuro.

### Vivos (tempo real — fonte preferida)
| Valor | Caminho | Status | Obs |
|---|---|---|---|
| Gold de COMBATE / run | `AggregateManager`(singleton, estrutura) → `AGGREGATES[GoldEarn][SubKey1]` | ✅ | exato, exclui venda; `metrics/gold.py` |
| Gold TOTAL / run | mesmo dict → `[GoldEarn][SubKey0]` | 🟡 | combate+venda+idle; `live_total−live_combat` = venda |
| XP viva / herói | `StageManager→HeroList→Hero→HeroRuntime.EXP_FAKE` | ✅ | `metrics/xp.py`; curva p/ level-up |
| Nível vivo / herói | `HeroRuntime.LEVEL_FAKE` | ✅ | |
| Dano / DPS | `MonsterSpawnManager` → `UnitHealthController.HP_CURRENT` (Σ quedas) | ✅ | `metrics/dps.py` |
| Stats finais (64) / herói | `HeroRuntime→StatsHolder.FINAL_STATS` (DictFloat) | ✅ | `game/build.py` |
| Mobs vivos / mortos | `MonsterSpawnManager.MONSTER_LIST / DEAD_MONSTER_LIST` | ✅ | kills + reload de stage |
| StageKey vivo | `Monster.STAGE_KEY` | ✅ | o do save congela na troca |
| Boundary de run | `LogManager.LOG_LIST` + `StageClearLog`/`StageFailedLog` | ✅ | clear time / wave |

### Save (defasado — snapshot, só fallback)
| Valor | Caminho | Status | Obs |
|---|---|---|---|
| Gold combate/total (fallback) | `PlayerSaveData.AGGREGATES` (`AggregateSaveData` Type=GoldEarn) | ✅ | atualiza em SALTOS → delta/run não-confiável |
| Carteira | `PlayerSaveData.CURRENCIES` (`CurrencySaveData` Key=GOLD_KEY) | ✅ | também é do save (defasado) |
| Itens equipados + enchants | `PlayerSaveData.ITEMS` / `ItemSaveData.ENCHANT_DATA` | ✅ | `game/build.py` |
| Identidade da party | `PlayerSaveData.HEROES` | ✅ | |
| playTime / stage atual | `CommonSaveData` | ✅ | |

### ⚪ TODO / futuro (achar com a metodologia da seção 2)
- **Outros `EAggregateType` vivos**: `MonsterKill(0)`, `BoxObtain(3)`, `ItemObtain(4)`,
  `PlayTime(15)`, `StageClear(13)`, `StageFail(14)` — mesma estrutura do gold (mesmo
  `AggregateManager`, outra chave externa); já resolvido o singleton, é só ler outra chave.
- **Gold por FONTE** (venda/idle/quest): `GoldEarn[SubKey2/3]` — pra separar de combate.
- **Drops por run** (itens/caixas obtidos) — via `LogManager.LOG_BY_TYPE`.
- **Recursos não-gold** (gemas, etc.): outras `CurrencySaveData.Key` (mapear os Keys).

---

## 4. Workflow pra mapear um valor NOVO (passo a passo)

1. **Oráculo**: anote o número real (do jogo) — início/fim, ou um valor exato.
2. **Achar**: rode os probes do `tbh-meter-dev` (assinatura de valor / crescimento / dump).
3. **Subir à raiz** se quiser fonte VIVA estável (singleton/owner) — senão o save serve de fallback.
4. **Validar**: delta == oráculo em N runs + 1 caso de borda. Sem bater, **não** sobe.
5. **Persistir** (single source):
   - offset novo → `config/offsets.py` (com comentário + ref do `dump.cs` se houver);
   - regra de negócio → no módulo de lógica (`metrics/…`), comentada;
   - nome ofuscado → **resolver estrutural**, nunca hardcode.
6. **Teste unitário** com memória sintética (modelo: `test_gold_real.py`).
7. **Isolar**: lógica no módulo de domínio (`metrics/…` ou `game/…`); o `meter_windows.py`
   só **chama**, nunca lê memória inline.

---

## 5. Nota sobre nomes ofuscados (a armadilha do `ut`/`uu`)

O dump (`re/dump/dump.cs`) traz nomes de 2 letras pra classes internas (`ut`, `uf`, `xd`,
`up`…). Esses nomes são **embaralhados a cada build** do `GameAssembly.dll`: o que era `ut`
(AggregateManager) virou `uu`, e `ut` agora nomeia OUTRA classe. Então:

- **Nunca** resolver classe interna por nome literal em produção.
- Onde for singleton com conteúdo identificável (ex.: AggregateManager tem o dict GoldEarn) →
  **resolver por estrutura** (`metrics/gold.py::resolve_combat_gold_klass`).
- Onde hoje ainda se usa nome (`HeroRuntime`/`uf`, `StatsHolder`/`xd` chegam via offset a
  partir de objetos já resolvidos, então não dependem do nome — OK). Auditar se algum
  resolve por nome curto direto e migrar pra estrutura se o build quebrar.
- Os comentários `# ut : nn<ut>` no `offsets.py` são **histórico do dump**, não verdade do
  runtime — servem só pra rastrear a origem.

---

## 6. Estratégia de RESOLUÇÃO por RVA (build-keyed) — SHIPPED (#190 + seed-calib)

> Isto NÃO adiciona valor de run-data novo — resolve as MESMAS classes (managers, save, logs,
> catálogos, gold singleton) por um caminho diferente. Fica aqui por ser a regra-mãe de "como
> achar a classe sem depender do nome ofuscado" (a armadilha do `ut`/`uu` da seção 5), agora
> sem o scan de ~2.6GB a cada launch.

**Cadeia:** `module_base(GameAssembly.dll) + anchor_rva → s_TypeInfoTable (heap) → table[TypeDefIndex] → Il2CppClass*`. O `anchor_rva` é um offset FIXO no módulo (o runtime reescreve o ponteiro da tabela a cada launch); o `TypeDefIndex` é constante do build. Os endereços de classe continuam dinâmicos (ASLR/GC) — só o anchor e os índices são build-estáveis.

**Auto-calibração keyed por fingerprint de build** (`resolve_cache.json`, `CACHE_FMT 9`, calib-only): no 1º cold start de um build novo o scan roda 1× e aprende `{anchor_rva, indices{nome:idx}, idx_ut, catálogos}` (`typeinfo.discover_anchor` + `gold.gold_index_of_klass`, reusando o klass do scan — sem value-scan redundante); todo launch seguinte resolve por índice (~ms), sem scan. Um build SHIPADO evita até esse 1º scan via o **seed-calib** embarcado (`config/calib_seed.json`, bundlado por `--add-data`; `load_calib` tenta o cache do usuário → cai no seed). Um game patch muda o fingerprint (PE TimeDateStamp/SizeOfImage + Version.txt) → recalibra sozinho 1×. Escrita atômica (`os.replace`) + persist-gate de catálogo completo → nunca envenena.

**Name-free permanece:** o gold ofuscado (`ut`→`uu`) é resolvido por `idx_ut`, NUNCA por nome; `class_name` só VALIDA (round-trip), não escolhe. Qualquer sanity-fail (round-trip de nome, size de instância, gold round-trip) → cai no scan garantido (§ `metrics/gold.py`, `il2cpp/typeinfo.py`, `il2cpp/resolver.py::resolve_via_rva`). Referência provada (v1.00.07): `ANCHOR_RVA=0x5b070e0`, `idx_ut=2744`. Detalhe completo + números em `docs/startup-optimization-plan.md` ("RVA resolution — IMPLEMENTED"). Verificação live de ponta-a-ponta: `tbh-meter-dev/rva_integration_probe.py`.
