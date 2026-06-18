"""build.py — leitura da BUILD do herói: equips/mods/skills (do save) + os 64 stats
FINAIS vivos (id-only) + nível/xp vivos (ACTk fakeValue). Espelha o monólito.

Os 64 stats saem com chave = statId int (id-only; o front resolve o nome). Os labels
de item/mod/classe ainda vêm preenchidos (via os enums do offsets) pra a saída bater
byte-a-byte com o monólito no cutover; dropá-los é um schema-bump futuro."""

import json
import os
import struct

from config.offsets import (HeroRuntime, StatsHolder, Dict, DictFloat, Array, List, Unit,
                            StageManager, HeroInfoData, HeroSaveData, PlayerSaveData,
                            AttributeSaveData, ItemSaveData, ItemEnchant, name_map,
                            EItemParts, EGradeType, EEquipClassType, ERecipeType, StatType,
                            RuneSaveData, InventorySaveData, StashSaveData)
from shared.utils import resource_path

_PARTS = name_map(EItemParts)
_GRADE = name_map(EGradeType)
_CLAZZ = name_map(EEquipClassType)
_RECIPE = name_map(ERecipeType)
_STAT = name_map(StatType)

_SKILL_ATTR = None
_PASSIVE_KEYS = None


def skill_attr_map():
    """{skillKey: attributeKey} carregado uma vez de config/skill_attr_map.json (gerado por
    scripts/gen_skill_attr_map.py a partir da skill-tree). Faz a ponte da skill EQUIPADA
    (skillKey) p/ o nó da árvore (attributeKey) onde o nível investido mora. Via resource_path
    -> funciona em source E congelado (PyInstaller). {} se o recurso faltar."""
    global _SKILL_ATTR
    if _SKILL_ATTR is None:
        try:
            with open(resource_path(os.path.join("config", "skill_attr_map.json")),
                      encoding="utf-8") as f:
                _SKILL_ATTR = {int(k): int(v) for k, v in json.load(f).items()}
        except Exception:
            _SKILL_ATTR = {}
    return _SKILL_ATTR


def passive_skill_keys():
    """set{attributeKey} de TODAS as skills PASSIVAS (config/passive_skill_keys.json, gerado por
    scripts/gen_skill_attr_map.py). Passiva NÃO é equipada (não aparece em equippedSKillKey) —
    mora só na árvore, e sua attributeKey É a identidade da skill. O reader inclui as que o herói
    investiu (interseção com read_attribute_levels). set() se o recurso faltar."""
    global _PASSIVE_KEYS
    if _PASSIVE_KEYS is None:
        try:
            with open(resource_path(os.path.join("config", "passive_skill_keys.json")),
                      encoding="utf-8") as f:
                _PASSIVE_KEYS = {int(k) for k in json.load(f)}
        except Exception:
            _PASSIVE_KEYS = set()
    return _PASSIVE_KEYS


def read_attribute_levels(reader, psd):
    """{attributeKey: nível} da árvore de skills/passivas investida (PlayerSaveData.attributeSaveDatas
    @0x40; AttributeSaveData{Key@0x10, Level@0x14}). Fonte do nível de cada skill equipada. {} em falha."""
    res = {}
    if not psd:
        return res
    try:
        for a in reader.list_iter(reader.rptr(psd + PlayerSaveData.ATTRIBUTES)):
            k = reader.ri32(a + AttributeSaveData.KEY)
            if k is None:
                continue
            lv = reader.ri32(a + AttributeSaveData.LEVEL)
            if lv is not None:
                res[k] = lv
    except Exception:
        return {}
    return res


def read_live_party(reader, sm):
    """{heroKey: (nível, exp)} VIVOS da party deployada (fakeValue, sem o vazamento do save).
    Nunca levanta exceção -> {} em qualquer falha."""
    res = {}
    try:
        if not sm:
            return res
        hl = reader.rptr(sm + StageManager.HERO_LIST)
        if not hl:
            return res
        n = reader.ri32(hl + Array.MAX_LENGTH)
        if n is None or not (0 < n <= 12):
            return res
        for i in range(n):
            h = reader.rptr(hl + Array.DATA + i * 8)
            if not h:
                continue
            uf = reader.rptr(h + Unit.CACHE)
            if not uf:
                continue
            hi = reader.rptr(uf + HeroRuntime.INFO)
            hk = reader.ri32(hi + HeroInfoData.HERO_KEY) if hi else None
            if hk is None or not (0 < hk < 10_000_000):
                continue
            lvl = reader.ri32(uf + HeroRuntime.LEVEL_FAKE)
            exp = reader.rf32(uf + HeroRuntime.EXP_FAKE)
            if lvl is None or exp is None or not (0 < lvl <= 999) or exp < 0:
                continue
            res[hk] = (lvl, exp)
    except Exception:
        return {}
    return res


def _raw_hero_list(reader, sm):
    """HeroList CRU (hk, lvl, exp) por slot, SEM o filtro de validade do read_live_party — só pro
    diagnóstico (describe_sm_candidates), p/ enxergar POR QUE uma instância é ghost (ex.: lvl=0).
    Never-raises -> [] em qualquer falha."""
    out = []
    try:
        if not sm:
            return out
        hl = reader.rptr(sm + StageManager.HERO_LIST)
        if not hl:
            return out
        n = reader.ri32(hl + Array.MAX_LENGTH)
        if n is None or not (0 < n <= 12):
            return out
        for i in range(n):
            h = reader.rptr(hl + Array.DATA + i * 8)
            uf = reader.rptr(h + Unit.CACHE) if h else None
            hi = reader.rptr(uf + HeroRuntime.INFO) if uf else None
            hk = reader.ri32(hi + HeroInfoData.HERO_KEY) if hi else None
            lvl = reader.ri32(uf + HeroRuntime.LEVEL_FAKE) if uf else None
            exp = reader.rf32(uf + HeroRuntime.EXP_FAKE) if uf else None
            out.append((hk, lvl, exp))
    except Exception:
        return out
    return out


def describe_sm_candidates(reader, sm_list, picked):
    """Diagnóstico do pick de StageManager (pro log de infra reader-diag.log). Devolve um dict:
      total      nº de candidatas (instâncias StageManager do scan/backref)
      hk_accept  quantas o check FRACO aceitaria (>=1 heroKey válido) = universo do pick ANTIGO
      carriers   quantas são carrier REAL (read_live_party não-vazio) = o que o pick NOVO aceita
      picked     endereço escolhido (ou None)
      ghosts     até 5 amostras (addr, heróis crus) de hk_accept-mas-NÃO-carrier (ex.: lvl=0)
    `hk_accept > carriers` é a assinatura do bug 1.00.13 (havia ghosts no universo do pick antigo);
    `carriers == 0` com a run em combate = a carrier nem foi capturada pelo scan (caso raro, H4).
    Pura leitura, never-raises."""
    hk_accept, carriers, ghosts = 0, 0, []
    try:
        for a in (sm_list or []):
            heroes = _raw_hero_list(reader, a)
            if not any(hk is not None and 0 < hk < 10_000_000 for hk, _, _ in heroes):
                continue
            hk_accept += 1
            if read_live_party(reader, a):
                carriers += 1
            elif len(ghosts) < 5:
                ghosts.append((a, heroes[:6]))
    except Exception:
        pass
    return {"total": len(sm_list or []), "hk_accept": hk_accept,
            "carriers": carriers, "picked": picked, "ghosts": ghosts}


def hero_in_run(hero_key, live_keys):
    """O herói entra no artefato da run? SÓ se está na party VIVA (`live_keys` = StageManager.HeroList
    ∪ party_seen) — a fonte AUTORITATIVA. SEM party viva (`live_keys` vazio = sm nulo a run INTEIRA),
    a run NÃO emite herói nenhum: o caller marca `heroes` como `err` no envelope ("party live off") e
    o conversor sela a run `degraded` (não sobe pro leaderboard; aparece no app, marcada). NUNCA o
    roster cru do save nem um proxy-chute (ex.: xp>0 incluiria um herói que só pegou xp idle, re-
    introduzindo o bug). Pura/testável."""
    return bool(live_keys) and hero_key in live_keys


def read_stats_dict(reader, uf):
    """64 stats FINAIS vivos: uf->xd->bets = Dict<StatType,float> (DictFloat). id-only:
    {statId int: valor}. {} se falhar."""
    try:
        xd = reader.rptr(uf + HeroRuntime.STATS_HOLDER)
        d = reader.rptr(xd + StatsHolder.FINAL_STATS) if xd else None
        if not d:
            return {}
        ent = reader.rptr(d + Dict.ENTRIES)
        n = reader.ri32(ent + Array.MAX_LENGTH) if ent else None
        if n is None or not (0 < n <= 512):
            return {}
        raw = reader.read(ent + Array.DATA, n * DictFloat.STRIDE)
        if not raw or len(raw) < n * DictFloat.STRIDE:
            return {}
        out = {}
        for i in range(n):
            o = i * DictFloat.STRIDE
            if struct.unpack_from("<i", raw, o + DictFloat.HASH)[0] < 0:   # slot livre
                continue
            key = struct.unpack_from("<i", raw, o + DictFloat.KEY)[0]
            val = struct.unpack_from("<f", raw, o + DictFloat.VALUE)[0]
            out[key] = round(val, 4)
        return out
    except Exception:
        return {}


def read_live_stats_by_hero(reader, sm):
    """{heroKey: {statId: valor}} dos 64 stats FINAIS vivos da party deployada."""
    res = {}
    try:
        if not sm:
            return res
        hl = reader.rptr(sm + StageManager.HERO_LIST)
        n = reader.ri32(hl + Array.MAX_LENGTH) if hl else None
        if n is None or not (0 < n <= 12):
            return res
        for i in range(n):
            h = reader.rptr(hl + Array.DATA + i * 8)
            uf = reader.rptr(h + Unit.CACHE) if h else None
            hi = reader.rptr(uf + HeroRuntime.INFO) if uf else None
            hk = reader.ri32(hi + HeroInfoData.HERO_KEY) if hi else None
            if hk is None or not (0 < hk < 10_000_000):
                continue
            st = read_stats_dict(reader, uf)
            if st:
                res[hk] = st
    except Exception:
        return {}
    return res


def read_mods(reader, item_addr):
    """EnchantData[] (struct stride 0x1C) -> mods reais (pula slots vazios)."""
    arr = reader.rptr(item_addr + ItemSaveData.ENCHANT_DATA)
    if not arr:
        return []
    ln = reader.ri32(arr + Array.MAX_LENGTH)
    if ln is None or ln < 0 or ln > 64:
        return []
    res = []
    for i in range(ln):
        b = arr + Array.DATA + i * ItemEnchant.STRIDE
        st = reader.ri32(b + ItemEnchant.STAT_TYPE)
        val = reader.ri32(b + ItemEnchant.VALUE)
        if (not st) and (not val):
            continue  # slot vazio
        rc = reader.ri32(b + ItemEnchant.RECIPE)
        res.append({"recipeId": rc, "recipe": _RECIPE.get(rc, f"r{rc}"),
                    "statId": st, "stat": _STAT.get(st, f"stat{st}"),
                    "value": val, "tier": reader.ri32(b + ItemEnchant.TIER)})
    return res


def read_build(reader, psd, item_cat, hero_cat):
    """Snapshot da build por herói jogado: classe/nível/exp + itens equipados
    (slot/raridade/nível/uniqueId) com mods + skills [{key, lv}].

    O array `skills` traz ATIVAS equipadas E PASSIVAS investidas, cada uma com nível (lv):
    - ATIVA: a skill EQUIPADA (equippedSKillKey). skillKey -> attributeKey (skill_attr_map)
      -> AttributeSaveData.Level. key = skillKey. lv=None quando não é nó ACTIVESKILL conhecido
      (ex.: a skill inata, fora da árvore) ou não há nível investido.
    - PASSIVA: nó PASSIVESKILL investido. key == attributeKey (== refKey nas passivas); lv
      direto do attr_levels. Só as que o herói tem na árvore.
    `skillLevels` (árvore COMPLETA por attributeKey) segue em paralelo enquanto o web migra
    pra consumir o array `skills`."""
    out = []
    if not psd:
        return out
    attr_levels = read_attribute_levels(reader, psd)
    skill_attr = skill_attr_map()
    passive_keys = passive_skill_keys()
    uid2item = {}
    for a in reader.list_iter(reader.rptr(psd + PlayerSaveData.ITEMS)):
        uid = reader.ru64(a + ItemSaveData.UNIQUE_ID)
        if uid:
            uid2item[uid] = a
    for h in reader.list_iter(reader.rptr(psd + PlayerSaveData.HEROES), cap=200):
        hk = reader.ri32(h + HeroSaveData.HERO_KEY)
        lvl = reader.ri32(h + HeroSaveData.LEVEL)
        exp = reader.rf32(h + HeroSaveData.EXP)
        if hk is None or lvl is None:
            continue
        if not (lvl > 1 or (exp or 0) > 0):
            continue
        cls = hero_cat.get(hk)
        items = []
        for uid in reader.arr_u64(reader.rptr(h + HeroSaveData.EQUIPPED_ITEMS)):
            if not uid:
                continue
            it = uid2item.get(uid)
            if not it:
                continue
            ik = reader.ri32(it + ItemSaveData.ITEM_KEY)
            grade, parts, ilvl = item_cat.get(ik, (None, None, None))
            items.append({"slot": _PARTS.get(parts, "?"), "slotId": parts,
                          "grade": _GRADE.get(grade, "?"), "gradeId": grade,
                          "itemKey": ik, "uniqueId": str(uid), "level": ilvl,
                          "mods": read_mods(reader, it)})
        # `skills` = ATIVAS equipadas (key = skillKey) + PASSIVAS investidas (key = attributeKey
        # == refKey), cada uma com lv. attr_levels é account-wide e os attributeKeys são
        # hero-prefixed (a // 1000 == heroKey) -> filtra pra este herói.
        skills = [{"key": k, "lv": attr_levels.get(skill_attr.get(k))}
                  for k in reader.arr_i32(reader.rptr(h + HeroSaveData.EQUIPPED_SKILLS)) if k]
        skills += [{"key": a, "lv": lv}
                   for a, lv in sorted(attr_levels.items())
                   if lv and lv > 0 and a // 1000 == hk and a in passive_keys]
        # skillLevels: árvore investida COMPLETA por attributeKey. Redundante com `skills` de
        # propósito (temporário): o web ainda consome este shape e migra p/ o array depois.
        skill_levels = {str(a): lv for a, lv in attr_levels.items()
                        if lv and lv > 0 and a // 1000 == hk}
        out.append({"heroKey": hk, "class": _CLAZZ.get(cls, "?"), "classId": cls,
                    "level": lvl, "exp": round(exp or 0.0, 2), "items": items,
                    "skills": skills, "skillLevels": skill_levels})
    return out


def _item_view(reader, it, item_cat):
    """1 item do save -> dict CRU (itemKey/raridade/slot/nível/uniqueId + mods). None se itemKey ilegível.
    Mesma forma do item equipado em read_build (o app resolve nome/sprite pelo itemKey)."""
    ik = reader.ri32(it + ItemSaveData.ITEM_KEY)
    if ik is None:
        return None
    grade, parts, ilvl = item_cat.get(ik, (None, None, None))
    return {"itemKey": ik, "uniqueId": str(reader.ru64(it + ItemSaveData.UNIQUE_ID) or 0),
            "slotId": parts, "gradeId": grade, "level": ilvl, "mods": read_mods(reader, it)}


def _list_or_none(reader, list_obj, cap):
    """Ponteiros (não-nulos) de um List<T>, DISTINGUINDO não-li (None) de vazio ([]) — pro caller
    emitir `err` em vez de `ok([])` SILENCIOSO (invariante do envelope: NÃO-LI != LI-ZERO, a mesma
    regra que matou o bug do gold:0). None se o List não é estruturalmente legível (size/items
    ilegível ou fora da faixa); [] SÓ quando size==0 de verdade. O `list_ptrs` do Reader NÃO serve
    aqui: ele devolve [] nos DOIS casos (vazio e ilegível), apagando a distinção."""
    if not list_obj:
        return None
    size = reader.ri32(list_obj + List.SIZE)
    if size is None or size < 0 or size > cap:
        return None
    if size == 0:
        return []
    items = reader.rptr(list_obj + List.ITEMS)
    if not items:
        return None
    b = reader.read(items + Array.DATA, size * 8)
    if not b or len(b) < size * 8:
        return None
    return [p for p in struct.unpack(f"<{size}Q", b) if p]


def _read_runes(reader, psd):
    """[{key, level}] das runas (PlayerSaveData.RUNES). None se a lista NÃO LEU (nunca [] silencioso)."""
    try:
        raw = _list_or_none(reader, reader.rptr(psd + PlayerSaveData.RUNES), 5000)
        if raw is None:
            return None
        out = []
        for a in raw:
            k = reader.ri32(a + RuneSaveData.KEY)
            lv = reader.ri32(a + RuneSaveData.LEVEL)
            if k is not None and lv is not None:
                out.append({"key": k, "level": lv})
        return out
    except Exception:
        return None


def _read_slot_items(reader, psd, list_off, uid_off, uid2item, item_cat):
    """Itens nos slots (uniqueId -> uid2item -> item). None se a lista de slots OU o uid2item não leu
    (-> err, não [] silencioso). Slot com uniqueId 0 é VAZIO (pulado; não conta como falha)."""
    if uid2item is None:
        return None
    try:
        raw = _list_or_none(reader, reader.rptr(psd + list_off), 100000)
        if raw is None:
            return None
        out = []
        for s in raw:
            uid = reader.ru64(s + uid_off)
            if not uid:
                continue                                   # slot vazio (não é falha)
            it = uid2item.get(uid)
            if it:
                v = _item_view(reader, it, item_cat)
                if v:
                    out.append(v)
        return out
    except Exception:
        return None


def read_account_snapshot(reader, psd, item_cat):
    """Retrato CRU da conta no fim da run (fonte SAVE): (runes, inventory, stash). Cada um é uma LISTA
    quando LEU OK (pode ser [] = genuinamente vazio), ou **None quando NÃO LEU** — e aí o caller emite
    `err`, NUNCA `ok([])` (invariante do envelope: não-li != li-zero, a mesma regra que matou o gold:0).
    NÃO confunda os dois: conta nova sem runa = `ok([])`; o offset quebrar num patch = `err`.
      - runes:     PlayerSaveData.RUNES (account-wide; casa com data/runes.json pro drop-rate/wave).
      - inventory: itens nos slots do inventário (INVENTORY_SLOTS -> uniqueId -> ITEMS).
      - stash:     itens nos slots do stash (STASH), separado do inventário.
    Snapshot GRANDE por design (gravado em TODA run). Tudo PLAIN do save já aberto (sem singleton novo,
    sem Obscured). NEVER-RAISES (cada bloco guardado -> None na falha) p/ não derrubar o close_run."""
    if not psd:
        return None, None, None                            # sem save vivo -> tudo NÃO-LI (err)
    runes = _read_runes(reader, psd)
    # uid2item de ITEMS: None se ITEMS não leu -> inv/stash viram err (não [] silencioso). cap ALTO:
    # materiais empilham como instâncias; _list_or_none devolve None acima do cap (não trunca).
    # Guardado como os blocos irmãos (_read_runes/_read_slot_items): o contrato NEVER-RAISES não
    # pode depender do Reader nunca levantar — um throw aqui mataria o close_run.
    try:
        items_raw = _list_or_none(reader, reader.rptr(psd + PlayerSaveData.ITEMS), 100000)
        uid2item = None
        if items_raw is not None:
            uid2item = {}
            for it in items_raw:
                uid = reader.ru64(it + ItemSaveData.UNIQUE_ID)
                if uid:
                    uid2item[uid] = it
    except Exception:
        uid2item = None
    inventory = _read_slot_items(reader, psd, PlayerSaveData.INVENTORY_SLOTS,
                                 InventorySaveData.UNIQUE_ID, uid2item, item_cat)
    stash = _read_slot_items(reader, psd, PlayerSaveData.STASH,
                             StashSaveData.UNIQUE_ID, uid2item, item_cat)
    return runes, inventory, stash
