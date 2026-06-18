"""models.py — leituras do MUNDO VIVO (monstros) pro DPS + o stageKey runtime.

Funções livres recebendo (reader, ...), espelhando o monólito (mesma lógica validada).
DPS = Σ quedas de HP dos monstros (o jogo não guarda dano); HP é float PURO @0x40/0x4C."""

from config.offsets import MonsterSpawnManager, Unit, UnitHealthController, Monster


def live_monsters(reader, msm):
    """Itera (unit_addr, hp_atual, hp_max) dos monstros vivos + invocados.

    HOT LOOP (10Hz, todos os mobs da stage): a lista de ponteiros sai em LOTE
    (reader.list_ptrs -> read_array_ptrs, 1 syscall p/ todos os Units, não 1 por Unit);
    e hp_atual+hp_max saem de UMA leitura (read_struct, 16B: 0x40..0x50) em vez de duas.
    Resta 1 syscall p/ derreferenciar o HealthController de cada Unit (endereços
    espalhados, não dá pra batch). HP é float PURO @0x40 (cur) / @0x4C (max)."""
    for field in (MonsterSpawnManager.MONSTER_LIST, MonsterSpawnManager.SUMMONED_LIST):
        for u in reader.list_ptrs(reader.rptr(msm + field), cap=600):
            hc = reader.rptr(u + Unit.HEALTH_CONTROLLER)
            if not hc:
                continue
            # HP_CURRENT@0x40, HP_MAX@0x4C -> "<4f" cobre 0x40,0x44,0x48,0x4C numa syscall.
            vals = reader.read_struct(hc + UnitHealthController.HP_CURRENT, "<4f")
            if vals is not None:
                yield u, vals[0], vals[3]


def live_stage_key(reader, msm):
    """stageKey VIVO = Monster.STAGE_KEY (todos os mobs têm o mesmo; muda na hora na troca de
    stage — o currentStageKey do save é stale). Moda das primeiras leituras."""
    keys = []
    for u in reader.list_iter(reader.rptr(msm + MonsterSpawnManager.MONSTER_LIST), cap=600):
        k = reader.ri32(u + Monster.STAGE_KEY)
        if k is not None and 0 < k < 10_000_000:
            keys.append(k)
        if len(keys) >= 10:
            break
    return max(set(keys), key=keys.count) if keys else None
