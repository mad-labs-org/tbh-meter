---
type: invariant
description: "Eventos do LogManager são detectados por KLASS-POINTER (kl == sc_class/sf_class/gb_class/...), NUNCA por um campo ELogType — esse campo foi stripado do IL2CPP. Evento novo: classe em TARGETS + klass no cache + campos por constante de offsets.py + exception-safety por entry."
symptoms:
  - "novo evento de log"
  - "detectar evento"
  - "new log event"
  - "ELogType"
  - "klass pointer"
  - "ponteiro de classe"
  - "GetBoxLog"
  - "StageClearLog"
  - "HeroDieLog"
  - "evento não detectado"
  - "log event not detected"
code_anchors:
  - meter_windows.py::TARGETS
  - meter_windows.py::run
  - meter_windows.py::BOX_KEY_BY_TIER
  - config/offsets.py::GetBoxLog
  - config/offsets.py::ELogType
  - metrics/events.py::EventFeed
asserts:
  - config.offsets.GetBoxLog.MONSTER_TYPE == 0x50
guarded_by:
  - tests/test_meter_windows.py::TestBoxKeyByTier::test_three_tiers_map_to_canonical_box_keys
  - tests/test_meter_windows.py::TestSuffixInt::test_no_numeric_suffix
  - tests/test_events.py::TestEventFeed::test_first_update_is_baseline_no_events
---

# Detecção de eventos de log (por klass-pointer, não por ELogType)

O `LogManager` mantém um `List<LogData>` (`LogManager.LOG_LIST`) onde o jogo empurra **uma
entry por evento** — fim de stage (sucesso/falha), drop de baú, morte/revive de herói. O loop
em `run` lê do **`size` anterior até o atual** as entries novas a cada tick e decide o que cada
uma é. Cada `LogData` é um objeto gerenciado, então seu **primeiro campo (offset 0) é o ponteiro
para a Il2CppClass** — a "classe-K" do tipo concreto do log.

**A regra dura: o tipo do evento é decidido por IGUALDADE DE KLASS-POINTER, nunca por um campo
de tipo.** O loop faz `kl = reader.rptr(e)` (o klass da entry) e compara `kl == sc_class`,
`elif kl == sf_class`, `elif kl == gb_class`, `elif kl == die_class`, `elif kl == res_class`.
Cada `*_class` é a Il2CppClass que o resolver achou para `StageClearLog`/`StageFailedLog`/
`GetBoxLog`/`HeroDieLog`/`ResurrectionLog`. **NÃO existe leitura de um campo `ELogType` na entry**
para rotular o evento — o enum `ELogType` continua em `config/offsets.py` (catálogo dos valores),
mas o *campo* dentro de `LogData` foi stripado do dump IL2CPP desta build, então não há offset
pra ler. O `Dictionary<ELogType, List<LogData>>` (`LogManager.LOG_BY_TYPE`) também **não é usado**
no loop — só o `LOG_LIST` plano. Detectar por tipo-de-classe é o que torna a leitura imune ao
campo de tipo ausente.

(Detecção ≠ **roteamento**: decidir EM QUAL run um evento cai é do ciclo de vida. O caso real:
o `GetBoxLog` de boss é logado ~0.6s DEPOIS do `StageClearLog` e pertence ao success PENDENTE,
não à run que o close acabou de abrir — ver [[invariants/run-lifecycle]], pending-close.)

## Como adicionar um evento novo

1. **Resolver a classe.** Ponha o nome do log em `TARGETS` (lista de classes que o resolver
   varre/indexa). Sem isso, o resolver nunca aprende o K daquele tipo e o `kl ==` nunca casa.
2. **Guardar/validar o klass.** Pegue o `*_class` do dict de classes resolvidas (igual a
   `gb_class`/`die_class`/`res_class`); o fast-path por índice valida cada classe por
   round-trip de nome antes de servir o K (qualquer mismatch → cai no scan), então o klass que
   chega ao loop é confiável.
3. **Ler os campos por CONSTANTE de `offsets.py`, nunca magic number.** Defina uma classe de
   offsets (estilo `GetBoxLog`/`HeroDieLog`/`ResurrectionLog`) e leia via ela — ex.: o tier do
   baú vem de `GetBoxLog.MONSTER_TYPE` (e mapeia por `BOX_KEY_BY_TIER`), a vítima/assassino de
   `HeroDieLog.VICTIM_HERO`/`KILLER_MONSTER`, o revivido de `ResurrectionLog.HERO`. Strings são
   name-keys `"Nome_<key>"` → use o parser de sufixo, nunca `int()` no string inteiro.
4. **Exception-safety por entry.** Uma entry ruim deve **pular, não derrubar** o loop. O loop
   já tem `if not e: continue`, e os primitivos do `Reader` (`rptr`/`ri32`/`read_string`)
   retornam `None` em memória ilegível (nunca levantam); o parser de sufixo também devolve `None`
   em entrada inválida. Mantenha esse contrato no campo novo — leia defensivo, trate `None`,
   e deixe o tick inteiro coberto pelo `try/except` que existe no loop. Lixo numa entry vira
   um no-op silencioso, não um crash que mata a sessão.

**Mudou o campo? É schema.** Adicionar a entry nova ao `rec` da run é uma mudança de forma do
`runs.jsonl` → exige bumpar `SCHEMA_VERSION` e normalizar no app (ver a nota de versionamento).

## metrics/events.py é só CONTAGEM (v1)

`metrics.events.EventFeed` é independente do loop de rótulo acima: ele só conta **quantas entries
novas** surgiram (delta de `size`, re-ancorando quando a lista trunca), sem olhar tipo nenhum.
Não é o caminho de detecção de evento — é um contador. **Rotular** (saber QUE evento é) exige o
klass-pointer, como descrito acima; o TODO de "ler o tipo de cada evento" no header de `events.py`
foi resolvido no loop de `run` justamente por klass-pointer, não por dumpar o campo `ELogType`.

## Related
- [[invariants/offsets-single-source]]
Veja também: [[invariants/run-lifecycle]] (StageClear/Failed fecham a run a partir desta detecção) · [[invariants/rva-index-resolution]] (o índice que serve os *_class com gate de round-trip) · [[reference/run-data-map]] (os campos de cada *Log) · [[invariants/schema-versioning]] (campo novo = bump) · [[guides/add-log-event]] (passo-a-passo)
