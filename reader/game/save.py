"""save.py — leitores do PlayerSaveData (plaintext, snapshot) + escolha da instância VIVA.

Funções livres recebendo (reader, ...). Portado fiel do monólito. O save é DEFASADO
(snapshot) — bom pra ficha/identidade e como fallback; gold/xp ao vivo ficam em metrics/."""

from config.offsets import (PlayerSaveData, CurrencySaveData, HeroSaveData,
                            CommonSaveData, GOLD_KEY)
from game.build import read_live_party


def read_gold(reader, psd):
    """Saldo de ouro (CurrencySaveData Key==GOLD_KEY)."""
    if not psd:
        return 0
    for e in reader.list_iter(reader.rptr(psd + PlayerSaveData.CURRENCIES), cap=200):
        if reader.ri32(e + CurrencySaveData.KEY) == GOLD_KEY:
            return reader.ri64(e + CurrencySaveData.QUANTITY) or 0
    return 0


def read_heroes(reader, psd):
    """{heroKey: (level, exp)} dos heróis jogados (do save; exp defasado)."""
    res = {}
    if not psd:
        return res
    for e in reader.list_iter(reader.rptr(psd + PlayerSaveData.HEROES), cap=200):
        k = reader.ri32(e + HeroSaveData.HERO_KEY)
        lvl = reader.ri32(e + HeroSaveData.LEVEL)
        exp = reader.rf32(e + HeroSaveData.EXP)
        if k is None or lvl is None or exp is None:
            continue
        if lvl > 1 or exp > 0:
            res[k] = (lvl, exp)
    return res


def pick_live_psd(reader, cands):
    """PlayerSaveData VIVO = o com MAIS ouro (snapshots antigos têm menos)."""
    best, bg = None, -1
    for a in (cands or [])[:200]:
        g = read_gold(reader, a)
        if g and g > bg:
            bg, best = g, a
    return best


def pick_live_sm(reader, cands):
    """StageManager VIVO = a 1ª candidata de onde `read_live_party` extrai uma party (>=1 herói
    DEPLOYADO válido). Varre TODAS, sem cap (igual `pick_live_csd`): a portadora pode estar em
    QUALQUER índice; cap fixo (era `[:600]`) a perdia quando o backref devolvia mais que isso —
    CRAVADO no 1.00.11 (1162 instâncias, portadora além de 600 → `StageManager NOT found` em
    combate → party caía no roster). `read_live_party` varre TODOS os slots (party solo fora do
    slot 0 ainda resolve) e nunca levanta.

    A VALIDAÇÃO É A MESMA de `read_live_party` (por construção: chama-o). Antes, este pick usava um
    check MAIS FRACO (só `heroKey`) que o `read_live_party` (que exige TAMBÉM nível/exp): uma
    instância 'ghost' (StageManager torn-down/template — heroKey válido mas lvl=0) passava aqui,
    era escolhida e CONGELADA (`if not sm` no loop do meter), e o `read_live_party` lia {} a sessão
    inteira → 1.00.13: `StageManager ok — 0 heroes deployed`, toda run `heroes:err`. É a MESMA
    família de [[invariants/instance-selection]] (managers): escolher a instância VIVA por
    validação estrutural, nunca a 1ª-na-faixa. Nenhuma candidata legível → None (degrada honesto;
    NUNCA um ghost que o `read_live_party` não consegue ler)."""
    for a in (cands or []):
        if read_live_party(reader, a):
            return a
    return None


def pick_live_csd(reader, cands):
    """CommonSaveData VIVO = o de MAIOR playTime (com stageKey plausível). Lê o
    currentStageKey ao vivo. Espelha o monólito (varre TODOS os candidatos, sem cap)."""
    best, best_pt = None, -1.0
    for a in (cands or []):
        key = reader.ri32(a + CommonSaveData.CURRENT_STAGE_KEY)
        pt = reader.rf32(a + CommonSaveData.PLAYTIME)
        if key is not None and 0 < key < 10_000_000 and pt is not None and pt > best_pt:
            best_pt, best = pt, a
    return best
