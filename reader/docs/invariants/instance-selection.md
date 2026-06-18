---
type: invariant
description: "Managers (LogManager/MonsterSpawnManager) são escolhidos do scan por VALIDAÇÃO ESTRUTURAL de List<T>, nunca pelo 1º-na-faixa — senão a lista morta vira a escolhida e nenhuma run fecha."
symptoms:
  - "runs não fecham"
  - "runs não aparecem"
  - "runs não resetam"
  - "runs not closing"
  - "lista morta"
  - "dead list"
  - "meter trava em #1"
  - "recent-runs vazio"
code_anchors:
  - meter_windows.py::_pick_list_singleton
  - meter_windows.py::_valid_list_size
  - il2cpp/resolver.py::_manager_inst_ok
guarded_by:
  - tests/test_meter_windows.py::TestPickListSingleton::test_picks_real_over_first_garbage
  - tests/test_meter_windows.py::TestPickListSingleton::test_prefers_largest_valid_list
  - tests/test_meter_windows.py::TestPickListSingleton::test_fallback_to_loose_pick_never_regresses_to_none
---

# Seleção de instância de singleton (managers)

O scan de ponteiros acha a classe-K de um manager (`LogManager`, `MonsterSpawnManager`) em
**dezenas de slots** que NÃO são o objeto vivo — vtables, cópias, metadata. Escolher o **1º
candidato na faixa** `[0, cap)` pega um slot de lixo cujo `List<T>` nunca cresce (`size=0`
de memória zerada passa numa checagem ingênua de faixa) → a lista fica morta → **NENHUMA run
fecha** (bug não-determinístico de launch: o `StageClearLog` entra numa lista que o reader
nem está olhando, então o ciclo de vida da run nunca vê o fim).

**A regra:** o singleton real é o único cujo offset de lista é um `List<T>` **estruturalmente
válido** — `items` legível, `capacity >= size`, e entries que são objetos com classe legível.
Entre os válidos, escolhe-se o de **maior `size`** (a lista viva tem entries; o lixo, não).
Validação estrutural em `_valid_list_size`; o pick em `_pick_list_singleton` (com fallback ao
pick-na-faixa só pra um resolve bom nunca regredir a `None` num estado degenerado). A
instância vinda do fast-path (RVA/bbwf) passa pela MESMA sanidade em `_manager_inst_ok`
(`LogManager`: `size` em `[0, 100000)` — cresce a sessão inteira; `MonsterSpawnManager`:
`[0, 2000)`).

**Por que isto NÃO é "name-free-resolution":** o nome da classe aqui é ESTÁVEL (`LogManager`
não é ofuscado). O problema não é achar a classe certa entre nomes que driftam — é escolher a
**instância** viva entre os falsos-positivos do scan da MESMA classe. São invariantes
distintos; não confunda os dois.

## Related
Veja também: [[invariants/run-lifecycle]] (o fim de run depende desta lista viva) · [[invariants/rva-index-resolution]] (o fast-path que reusa a instância validada)
