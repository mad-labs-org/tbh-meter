"""envelope.py — Result/Either por campo do RAW (raw/<id>.json).

Cada campo de DADO do raw que vem de uma LEITURA de memória pode falhar (o jogo
fechou, o endereço mudou, a classe não resolveu). Em vez de gravar `0` ou `"?"` — que
vira lixo eterno e INDISTINGUÍVEL de um zero real (o bug do 1.00.10: gold lido como 0
ficou permanente no runs.jsonl) — embrulha o valor num envelope marcado:

    {"ok": true,  "value": <leitura>}      # leu
    {"ok": false, "error": "<motivo>"}     # não leu

O conversor (app, TS) desembrulha: `ok` → usa o value; erro → registra em `issues` e
degrada a run, sem nunca confundir "não-li" com "li zero". Espelha o `Field<T>` em
`app/src/shared/raw-types.ts` (mesma forma nos dois lados do contrato).

Regra de uso (ver progress.md "Contrato do RAW"):
- DADO observado (gold, xp, stage, heróis, dano…) → `field(lambda: <leitura>)` ou `ok()/err()`.
- META estrutural (raw_schema_version, id, ts, run, run_outcome, session) → vai CRU, sem envelope
  (se isso falta, não existe record).
"""

from typing import Any, Callable


def ok(value: Any) -> dict:
    """Campo lido com sucesso. `value` pode ser qualquer coisa, inclusive None
    (use `ok(None)` quando None é um valor LEGÍTIMO — ex.: act ausente num stage sem info)."""
    return {"ok": True, "value": value}


def err(error: Any) -> dict:
    """Campo que NÃO pôde ser lido. `error` é um motivo curto (string) que o conversor
    propaga pra `issues:{campo: motivo}` — serve de auditoria, não de valor."""
    return {"ok": False, "error": str(error)}


def field(read: Callable[[], Any]) -> dict:
    """Embrulha uma leitura de memória num envelope.

    Chama `read()`:
    - levantou exceção  → `err` (a leitura de memória pode dar `raise`);
    - retornou `None`   → `err("none")` (None aqui = "não consegui determinar");
    - retornou valor    → `ok(value)`.

    Uso: `field(lambda: reader.ri32(addr + OFF))`. Quando None é um valor VÁLIDO (não um
    erro), NÃO use `field()` — use `ok(value)` direto, pra não transformar um null legítimo
    em erro.
    """
    try:
        value = read()
    except Exception as e:  # leitura de memória pode levantar (processo morto, addr inválido)
        return err(f"{type(e).__name__}: {e}")
    if value is None:
        return err("none")
    return ok(value)
