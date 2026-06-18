---
type: invariant
description: "Classes (>= 3 letras, estáveis) são resolvidas PRIMARIAMENTE por TypeDefIndex + calibração (fast path, ~ms), com gate round-trip (class_name == nome) + size de instância; QUALQUER sanity-fail cai no scan. O scan é o fallback, não o primário."
symptoms:
  - "resolver classe nova"
  - "adicionar classe-alvo"
  - "fast path"
  - "fast path não ativa"
  - "calib"
  - "calibração"
  - "índice errado"
  - "wrong index"
  - "TypeDefIndex"
  - "anchor RVA"
  - "nunca acelera"
code_anchors:
  - il2cpp/resolver.py::resolve_via_rva
  - il2cpp/typeinfo.py::class_by_index
  - il2cpp/resolver.py::_manager_inst_ok
  - meter_windows.py::TARGETS
guarded_by:
  - tests/test_resolver_rva.py::test_name_mismatch_returns_none
  - tests/test_resolver_rva.py::test_happy_path_shape
  - tests/test_resolver_rva.py::test_msm_size_out_of_range_returns_none
  - tests/test_typeinfo.py::test_class_by_index
---

# Resolução de classes por índice RVA (fast path) vs. scan (fallback)

O PRIMÁRIO hoje é resolver classes por **`TypeDefIndex` + calibração**, não pelo scan. A
cadeia (em `typeinfo.py`): `[ga_base + anchor_rva]` → base viva da `s_TypeInfoTable`
(reescrita pelo runtime a cada launch — relê pelo anchor porque o `ga_base` muda por ASLR),
e `class_by_index` faz a deref crua `[tbase + idx*8]` → `Il2CppClass*`. Os índices são
constantes do build, aprendidos numa calibração e persistidos no cache por build-fingerprint.
Isso **mata o cold-start scan** (varrer ~GBs procurando as strings de nome). O `resolve`
(scan de 3 passadas, `il2cpp/resolver.py`) **continua existindo como FALLBACK permanente** —
sempre funciona, em qualquer build, e é o que alimenta a calibração na primeira vez.

**Esta nota NÃO é "name-free-resolution genérico".** Atenção ao drift histórico: a regra antiga
dizia "classes vêm por scan". O scan é o fallback; o caminho que roda num build calibrado é o
índice. (O gold/`AggregateManager` tem nome ofuscado `uu` e é tratado por ESTRUTURA num módulo
próprio — NÃO entra no `resolve_via_rva`; ver a nota de gold.)

## A regra (o gate anti-envenenamento)

`resolve_via_rva` devolve `(classes, instances)` no MESMO shape do scan, ou **`None` em
QUALQUER sanity-fail** — nunca dados parciais. Para cada nome em `targets`:

1. **CLASSE — gate round-trip.** `class_by_index(idx[nome])` dá um `Il2CppClass*` cru
   (`class_by_index` **não valida nada** — é só a deref da tabela). A validação é exigir
   `typeinfo.class_name(K) == nome`. `class_name` confere bounds + 8-alinhamento + o
   round-trip de `element_class`/`cast_class` apontando pra si. **Mismatch → `None` → scan.**
   É por isso que o índice nunca é confiado sozinho: um anchor/índice envenenado (ou drift de
   build sem recalibrar) lê outra classe naquele slot, o nome não bate, e a resolução degrada
   pro scan em vez de servir lixo.
2. **INSTÂNCIA de singleton — gate de size.** Para os nomes em `SINGLETONS`
   (`MonsterSpawnManager`, `LogManager`, `StageManager`) a instância vem por `bbwf_from_klass(K)`
   e passa por `_manager_inst_ok` — a MESMA sanidade do slow path: `MonsterSpawnManager` exige
   `MONSTER_LIST` size em `[0, 2000)`; `LogManager` exige `LOG_LIST` size em `[0, 100000)` (a
   `LOG_LIST` cresce a sessão inteira); `StageManager` é aceito como está (a verificação
   portadora-de-party é deferida pro pick ao vivo, não falha aqui). Size absurdo = lixo de
   menu → `None` → scan. Classes só-de-classe (logs, `*SaveData`, catálogos) saem com
   `instances[nome] = []` — o caller resolve essas instâncias por outro caminho.

`class_name` **só valida, nunca escolhe** a classe — a escolha é por índice. Por isso ele
devolve até um nome ofuscado se mandarem um (visto em `test_typeinfo`): a estabilidade do
fast path vem do índice, o nome só identifica/confirma o slot.

## Adicionar uma classe-alvo nova

Ponha o nome (>= 3 letras, estável/não-ofuscado) em **`TARGETS`** (em `meter_windows.py`) e
**deixe o scan achá-la** — a calibração aprende o `TypeDefIndex` dela a partir do K que o scan
resolveu e o persiste no cache; do próximo launch calibrado em diante ela sai pelo fast path.
Não há lugar pra hard-codar um índice: ele é descoberto e VERIFICADO contra o build, e mesmo já
no cache passa pelo gate round-trip toda vez. **NUNCA confie no índice sem o gate** — um índice
sem `class_name == nome` é exatamente a classe de bug "índice errado / classe trocada".

Se a calibração falhar (não achar o anchor/índices), o reader **nunca acelera** mas continua
correto via scan; um build que não acelera tem que ser observável no log — então prefira ver
um sintoma de "nunca acelera" a silenciar a falha.

## Related
- [[invariants/instance-selection]] — o size-gate de `_manager_inst_ok` é o MESMO `_pick_list_singleton`/`_valid_list_size` do scan; o fast path reusa a instância validada.
- [[invariants/gold-singleton-resolution]] — o `uu` ofuscado fica FORA daqui (resolvido por ESTRUTURA, não por índice).
- [[invariants/cache-management]] — os índices da calib são persistidos por build-fingerprint; bump de `CACHE_FMT` os invalida.
