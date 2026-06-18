---
type: guide
description: "Receita pra capturar um evento NOVO do LogManager: pôr a classe em TARGETS → pegar o klass resolvido (round-trip-validado) → detectar por igualdade de klass-pointer no loop → ler os campos por constante de offsets.py com leitura defensiva. Detecção é por klass, NUNCA por um campo ELogType (foi stripado do dump)."
code_anchors:
  - meter_windows.py::TARGETS
  - meter_windows.py::run
  - meter_windows.py::_suffix_int
  - config/offsets.py::GetBoxLog
  - il2cpp/resolver.py::resolve_via_rva
  - metrics/events.py::EventFeed
asserts:
  - config.offsets.GetBoxLog.MONSTER_TYPE == 0x50
guarded_by:
  - tests/test_meter_windows.py::TestBoxKeyByTier::test_three_tiers_map_to_canonical_box_keys
  - tests/test_meter_windows.py::TestSuffixInt::test_no_numeric_suffix
---

# Guia: capturar um evento de log novo

O `LogManager` mantém **um** `List<LogData>` plano (offset `LogManager.LOG_LIST`) onde o jogo
empurra uma entry por evento — fim de stage, drop de baú, morte/revive de herói. O loop em `run`
lê as entries que surgiram **do `size` anterior até o atual** a cada tick. Cada `LogData` é um
objeto gerenciado, então seu **primeiro campo (offset 0) é o ponteiro pra Il2CppClass** — é por
ESSE ponteiro que se descobre QUE evento é (ver [[invariants/log-event-detection]]). Capturar um
evento novo toca **4 lugares em ordem**; pule um e ou o klass nunca casa, ou o reader lê lixo, ou
um campo malformado derruba a sessão. Faça nesta sequência.

## 0. Confirme que existe um log dedicado (e descubra os campos)

A detecção precisa de uma **classe-K própria** pro evento (`StageClearLog`, `GetBoxLog`,
`HeroDieLog`…). Se o jogo não emite um `*Log` distinto pro que você quer, não há klass pra casar —
isso é trabalho de RE (achar a classe e os offsets dos campos ao vivo), não desta receita. Os
campos de um log são name-keys ou ints crus; mapeie-os ao vivo antes (o método de gating de um
valor mapeado está em [[process/value-mapping-method]]).

## 1. Ponha a classe em `TARGETS`

`TARGETS` (em `meter_windows.py`) é a lista de nomes de classe que o resolver **aprende** o K —
por índice RVA no fast-path e por scan no fallback. **Sem o nome aqui, o resolver nunca resolve
aquele K**, e o `kl ==` do passo 3 nunca casa: o evento passa despercebido pra sempre. O nome da
classe do log tem que ser **estável** (>= 3 letras, não-ofuscado) — `StageClearLog` e cia são; um
singleton ofuscado de 2 letras NÃO entra em `TARGETS` (esse resolve por estrutura, outro caminho —
ver [[invariants/gold-singleton-resolution]]).

## 2. Pegue o klass resolvido (já validado por round-trip)

O resolver devolve `classes = {nome: {K}}`. Extraia o seu K igual aos vizinhos
(`sc_class`/`gb_class`/`die_class`/`res_class` saem de `next(iter(classes["<Nome>"]))` no
fast-path, ou `next(iter(classes.get("<Nome>", [])), None)` no scan — tolerante a ausência). **Não
precisa de validação extra de instância**: logs são só-classe (o resolver não procura instância
deles), e o fast-path por índice já **valida cada K por round-trip de nome** em `resolve_via_rva`
(`class_name(K) != nome` → devolve `None` → cai no scan; NUNCA serve um K errado). Então o klass
que chega ao loop é confiável. (A sanidade de **instância** por `_manager_inst_ok` é dos
*singletons* — `LogManager`/`MonsterSpawnManager` — não dos logs; ver [[invariants/instance-selection]].)

> Se o evento novo entra no record da run, esse K também passa a fazer parte da forma calibrada
> → leia [[invariants/cache-management]] antes de mexer no shape do cache (bump de `CACHE_FMT`
> exige recapturar o `calib_seed`).

## 3. Detecte por igualdade de KLASS-POINTER no loop

Dentro do bloco que varre as entries novas em `run`, adicione um ramo `elif`:

- lê o klass da entry com `reader.rptr(e)` (o primeiro campo);
- compara por **igualdade** com o seu `*_class` (`elif <novo>_class and kl == <novo>_class:`),
  guardando o `and <novo>_class` pra não casar contra `None` quando o resolver não achou aquela
  classe (degrada limpo num build sem ela).

**Nunca leia um campo de tipo na entry pra rotular o evento.** O campo `ELogType` foi **stripado**
do dump IL2CPP desta build (o enum `ELogType` segue em `offsets.py` como catálogo de valores, mas
não há offset pro *campo* dentro de `LogData`), e o `Dictionary<ELogType, List<LogData>>` também
não é usado — só o `LOG_LIST` plano. Igualdade de klass-pointer é o que torna a detecção imune ao
campo de tipo ausente.

## 4. Leia os campos por CONSTANTE de `offsets.py`, com leitura defensiva

Defina uma classe de offsets no estilo `GetBoxLog`/`HeroDieLog`/`ResurrectionLog` em
`config/offsets.py` (a fonte única — ver [[invariants/offsets-single-source]]) e leia os campos
**pelo símbolo**, nunca por um literal `@0x` cravado na lógica:

- **int cru** → `reader.ri32(e + <Classe>.<CAMPO>)` (ex.: o tier do baú vem de
  `GetBoxLog.MONSTER_TYPE`, depois mapeado por `BOX_KEY_BY_TIER` — o número solto `int(bk_str)`
  antigo engolia todo drop; o `assert` deste guia ancora `MONSTER_TYPE == 0x50`);
- **name-key string** (`"HeroName_<heroKey>"`, `"MonsterName_<monsterKey>"`) →
  `_suffix_int(reader.read_string(reader.rptr(e + <Classe>.<CAMPO>)))`. **Use o parser de sufixo,
  nunca `int()` no string inteiro** — ele faz `rsplit("_", 1)` e só converte se o tail for dígito,
  devolvendo `None` em qualquer formato inesperado (vide os campos de `HeroDieLog`/`ResurrectionLog`).

**Por que isto não derruba a sessão:** os primitivos do `Reader` (`rptr`/`ri32`/`read_string`)
**nunca levantam** — devolvem `None` em memória ilegível (um endereço pode liberar no meio da
luta). O loop já tem `if not e: continue` por entry, e `_suffix_int` devolve `None` em entrada
inválida. **Mantenha esse contrato no campo novo**: leia defensivo e trate `None` como "sem dado",
nunca como `0`/default mentiroso. (O `try/except` externo do loop só pega `KeyboardInterrupt`/morte
do jogo — **não** é uma rede que engole exceções por-tick. A segurança vem das leituras
never-raise + os guards por entry, não de um catch genérico; ver [[invariants/memory-safety]].)
Lixo numa entry vira no-op silencioso, não um crash que mata a sessão inteira.

## Mudou o record da run? É schema.

Se o evento novo acrescenta dado ao `runs.jsonl` (um campo no `rec`/`heroes_out` de `close_run`,
ou um acumulador iniciado em `new_run`), isso é **mudança de forma** → bumpe `SCHEMA_VERSION` e
normalize defensivo no app. A receita ponta-a-ponta de campo está em [[guides/add-runs-field]]; o
porquê do bump em [[invariants/schema-versioning]].

## `metrics/events.py` é só CONTAGEM — não confunda

`metrics.events.EventFeed` é um **contador** independente: ele só mede **quantas** entries novas
surgiram (delta de `size`, re-ancorando quando a lista trunca), sem olhar tipo nenhum. **Não é o
caminho de detecção** — rotular QUE evento é exige o klass-pointer (passo 3). O TODO de "ler o tipo
de cada evento" no header de `events.py` já foi resolvido no loop de `run` justamente por
klass-pointer, não por dumpar o campo `ELogType`. Não tente reabrir essa porta.

## Related
- [[invariants/log-event-detection]] — o invariante: por que klass-pointer e não `ELogType`.
- [[invariants/offsets-single-source]] — onde a classe de offsets do log novo mora (fonte única).
- [[invariants/memory-safety]] — o contrato never-raise das leituras e os guards por entry.
- [[invariants/schema-versioning]] — se o evento entra no record: por que bumpar o `SCHEMA_VERSION`.
Veja também: [[reference/run-data-map]] (os campos de cada *Log mapeados por símbolo) · [[invariants/run-lifecycle]] (StageClear/Failed fecham a run a partir desta detecção)
