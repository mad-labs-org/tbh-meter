"""catalog.py — monta os catálogos (id -> atributos) a partir das instâncias resolvidas.

stage_info[stageKey] = (act, stageNo, total_mobs, difficulty)
item_cat[itemKey]   = (grade, parts, level)
hero_cat[heroKey]   = classId
Mesma lógica do resolve_all do monólito. (No futuro vira o --dump-catalogs pro front.)"""

from config.offsets import StageInfoData, ItemInfoData, HeroInfoData


def build_stage_info(reader, instances):
    out = {}
    for a in instances.get("StageInfoData", []):
        sk = reader.ri32(a + StageInfoData.STAGE_KEY)
        wa = reader.ri32(a + StageInfoData.WAVE_AMOUNT)
        wm = reader.ri32(a + StageInfoData.WAVE_MOB_AMOUNT)
        act = reader.ri32(a + StageInfoData.ACT)
        sno = reader.ri32(a + StageInfoData.STAGE_NO)
        diff = reader.ri32(a + StageInfoData.DIFFICULTY)
        if sk is not None and wa and wm and 1 <= wa <= 200 and 1 <= wm <= 200:
            out[sk] = (act or 0, sno or 0, wa * wm, diff if diff is not None else -1)
    return out


def build_item_cat(reader, instances):
    out = {}
    for a in instances.get("ItemInfoData", []):
        ik = reader.ri32(a + ItemInfoData.ITEM_KEY)
        if ik is not None and 0 < ik < 10_000_000 and ik not in out:
            out[ik] = (reader.ri32(a + ItemInfoData.GRADE),
                       reader.ri32(a + ItemInfoData.PARTS),
                       reader.ri32(a + ItemInfoData.LEVEL))
    return out


def build_hero_cat(reader, instances):
    out = {}
    for a in instances.get("HeroInfoData", []):
        hk = reader.ri32(a + HeroInfoData.HERO_KEY)
        if hk is not None and 0 < hk < 10_000_000 and hk not in out:
            out[hk] = reader.ri32(a + HeroInfoData.CLASS_TYPE)
    return out
