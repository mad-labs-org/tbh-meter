"""Offsets OBSCURED off-limits: existem como constantes NOMEADAS (p/ a nota
docs/invariants/obscured-data-offlimits ancorar) e NENHUM módulo de leitura pode
referenciá-los — ler nesses offsets dá lixo (ObscuredFloat/XOR), uma classe de bug real."""
from pathlib import Path

from config.offsets import Monster, Unit

ROOT = Path(__file__).resolve().parent.parent


def test_obscured_markers_exist():
    assert Unit.CORE_STATS_OBSCURED == 0x104
    assert Monster.CACHE_OBSCURED == 0x3B8  # 1.00.14: Unit cresceu +0x8 (0x3B0->0x3B8)


def test_no_reader_module_reads_obscured_offsets():
    """Os marcadores são "NÃO LER" — se um módulo de leitura os referenciar, alguém vai ler ali."""
    offenders = []
    for sub in ("metrics", "game"):
        for f in (ROOT / sub).glob("*.py"):
            txt = f.read_text(encoding="utf-8")
            if "CORE_STATS_OBSCURED" in txt or "CACHE_OBSCURED" in txt:
                offenders.append(f"{sub}/{f.name}")
    assert not offenders, f"módulos de leitura referenciam offset OBSCURED (ler dá lixo): {offenders}"
