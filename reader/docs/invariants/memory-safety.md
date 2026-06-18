---
type: invariant
description: "O reader é READ-ONLY (handle PROCESS_QUERY_INFORMATION|PROCESS_VM_READ, ZERO WriteProcessMemory/inject) e DEFENSIVO: read/ri32/ri64/rptr devolvem None em leitura ruim e o caller trata None antes de aritmética; toda deref checa null; dict8b_items/list_ptrs têm cap p/ não iterar infinito em struct corrompida."
symptoms:
  - "crash no read"
  - "crash reading memory"
  - "null pointer"
  - "ponteiro nulo"
  - "WriteProcessMemory"
  - "escrever na memória"
  - "write to game memory"
  - "inject"
  - "injeção"
  - "anti-cheat"
  - "ACTk"
  - "cap de iteração"
  - "iteration cap"
  - "loop infinito na leitura"
  - "TypeError NoneType arithmetic"
  - "None não tratado"
code_anchors:
  - shared/memory.py::open_process
  - shared/memory.py::Reader.read
  - shared/memory.py::Reader.ri32
  - shared/memory.py::Reader.ri64
  - shared/memory.py::Reader.rptr
  - shared/memory.py::Reader.read_string
  - shared/memory.py::Reader.dict8b_items
  - shared/memory.py::Reader.list_ptrs
asserts:
  - config.offsets.Dict8B.STRIDE == 0x18
---

# Segurança de memória (read-only + leitura defensiva)

Toda a interação com o jogo passa por `shared.memory` — o único módulo que toca o processo.
Ele carrega DOIS invariantes que, se quebrados, ou crashám o reader ou tropeçam no anti-cheat.

## 1. READ-ONLY, sem exceção

O ÚNICO ponto de anexação é `open_process`, e ele abre o handle com
`PROCESS_QUERY_INFORMATION | PROCESS_VM_READ` — **sem nenhum flag de escrita** (sem
`PROCESS_VM_WRITE`/`PROCESS_VM_OPERATION`). Não existe `WriteProcessMemory`, `VirtualProtectEx`
nem injeção em parte alguma do reader (é grep-verificável: zero hits). O `_kernel32()` só registra
`ReadProcessMemory` + as APIs de enumeração (Toolhelp/`VirtualQueryEx`/`QueryFullProcessImageNameW`).

**Por que isto é inviolável:** o jogo roda **ACTk** (anti-cheat). O reader é um sidecar não
assinado que já flerta com falso-positivo de AV (ver [[invariants/cache-management]] sobre o
estado `blocked`). Qualquer escrita ou injeção transforma "leitor passivo" em "trapaça detectável"
— ban do jogador e morte do projeto. Resolver classe/instância é **scan de leitura**
(`scan`/`scan_i64_range` desempacotam qwords; nunca escrevem), e singleton vivo se acha por
ESTRUTURA, não por patch (ver [[invariants/rva-index-resolution]]). **Nunca** adicione um write
"só pra testar".

## 2. Leitura defensiva: None na fonte, tratado no caller

O endereço que você tem agora pode ter sido liberado no próximo tick (objeto morre na luta,
GC move, jogo fecha). Então o núcleo `Reader.read` é defensivo por construção: devolve `None` se
o endereço é falsy, se `size <= 0`, ou se `ReadProcessMemory` falha — **nunca levanta**. Em cima
disso, os primitivos tipados (`ri32`/`ri64`/`ru32`/`ru64`/`rptr`/`rf32`) só desempacotam quando os
bytes vieram com o tamanho exato, senão devolvem `None`. `read_string`/`read_cstr` checam endereço
nulo e tamanho sentinela (`String.LENGTH` fora de `[0, 4096]` → `None`) antes de decodificar.

**A regra para o caller:** `None` significa "leitura ruim", não "valor zero". Quem chama **tem
que tratar `None` ANTES de qualquer aritmética/comparação** — senão é `TypeError: unsupported
operand … NoneType` no meio do loop de captura. O padrão é o early-return:

```python
p = reader.rptr(addr)
if not p:        # None OU 0 — ambos "sem objeto", deref aborta aqui
    return None
```

Isto é o contrato que o orquestrador e as métricas ASSUMEM: o andaime do ciclo de vida
([[invariants/run-lifecycle]]) usa "read falhando = jogo fechou" como sinal legítimo, e as cadeias
de fallback ([[invariants/metric-fallback-chains]]) tratam `None` como "esta fonte não deu, tenta a
próxima". A validação estrutural de manager ([[invariants/instance-selection]]) só consegue
distinguir lista viva de lixo porque um read em slot inválido volta `None`/garbage em vez de
explodir. Não troque o early-return por um valor default mascarado — um `0` no lugar de `None`
vira dado errado silencioso.

## 3. Cap em todo iterador de container

Uma struct corrompida (ou um falso-positivo do scan) pode declarar um `count`/`size` gigante e
fazer o reader iterar "para sempre" sobre lixo. Por isso **todo iterador de container tem teto**:
`list_ptrs`/`list_iter` abortam (lista vazia) se `size` for negativo ou exceder o `cap`;
`dict8b_items` desiste se o `count` exceder o `cap` E ainda limita o número de slots varridos
(`limit = count + 64`) para não rodar além das entries reais ao pular tombstones (`hash < 0`).
O `cap` é um KWARG com default por chamador — não crave o número no corpo; o `dict8b_items` usa o
stride `Dict8B.STRIDE` (jamais o de `DictFloat`, ver [[invariants/dict-strides]]).

## Related
- [[invariants/run-lifecycle]] — o andaime trata "read falhando" como "jogo fechou"; assume o reader nunca-raises.
- [[invariants/metric-fallback-chains]] — `None`-em-leitura-ruim é o sinal "esta fonte falhou, vai pra próxima".
- [[invariants/instance-selection]] — só dá pra validar List<T> viva vs. lixo porque o read volta None/garbage, não crash.
- [[invariants/dict-strides]] — o cap de `dict8b_items` anda junto do stride correto.
- [[invariants/rva-index-resolution]] — resolver é só leitura/scan; nunca patch.
- [[invariants/cache-management]] — AV/ACTk pode bloquear o reader não-assinado (estado `blocked`).
Veja também: [[invariants/obscured-data-offlimits]] (ler o fakeValue PLANO via Reader, nunca o hidden^key)
