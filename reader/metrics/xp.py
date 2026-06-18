"""xp.py — XP VIVA por herói: ACUMULADOR tick-a-tick (PartyXpAccumulator) + ponte de
level-up pela curva.

A xp viva (HeroRuntime.EXP_FAKE) é dentro-do-nível e zera no level-up; a curva
(config/level_curve.json = ExpForLevelUp por nível) preenche a volta. Validado ao vivo:
em 3 level-ups a conta bateu diff 0. O within-level é MONOTÔNICO fora do level-up
(detector de dip rodou muitas runs com morte e nunca disparou) — morto só PAUSA o ganho.

CAP: nível sem entrada na curva não tem progressão definida (level_capped) — o jogo segue
incrementando EXP_FAKE no cap sem level-up pra consumir, então o delta same-level é XP
FANTASMA: herói no cap ganha 0; cruzar PRA DENTRO do cap banka só até o limiar."""

import json
import os

from shared.utils import resource_path

_CURVE = None


def curve():
    """{nível: ExpForLevelUp} carregado uma vez de config/level_curve.json.
    Via resource_path -> funciona em source E congelado (PyInstaller sys._MEIPASS)."""
    global _CURVE
    if _CURVE is None:
        path = resource_path(os.path.join("config", "level_curve.json"))
        with open(path, encoding="utf-8") as f:
            _CURVE = {int(k): int(v) for k, v in json.load(f).items()}
    return _CURVE


def level_capped(lv):
    """Nível sem entrada na curva = sem progressão definida = CAP (a curva real cobre
    1..100 → cap 101). Também neutraliza nível-lixo FORA do range da curva (0/negativo
    ou acima do cap — melhor 0 que xp fantasma). level_capped(None) é False — sem info
    de nível, mantém o delta cru. Curva indisponível (bundle quebrado) → False: trata
    como não-capado (delta cru, comportamento pré-fix) — o reader continua vivo (este é
    o 1º toque na curva no caminho do close_run); o CI --selftest gateia o bundle quebrado."""
    if lv is None:
        return False
    try:
        return lv not in curve()
    except Exception:
        return False


def xp_through_levelup(lv0, exp0, lv1, exp1):
    """XP total ganho atravessando um (ou mais) level-up: (curva[lv0]-exp0) + níveis
    intermediários cheios + exp1. Cruzar PRA DENTRO do cap (lv1 sem entrada na curva)
    banka só até o limiar — o exp1 pós-cap é fantasma, não conta. None se a curva não
    cobre lv0/intermediários ou der negativo."""
    c = curve()
    try:
        total = (c[lv0] - exp0) + (exp1 if lv1 in c else 0.0)
        for L in range(lv0 + 1, lv1):
            total += c[L]
        return total if total >= 0 else None
    except (KeyError, TypeError):
        return None


def per_hero_gain(lv0, exp0, lv1, exp1):
    """Ganho de xp de UM herói entre dois snapshots vivos. Trata level-up via curva.
    Herói NO cap (level_capped) ganha 0.0 no same-level — EXP_FAKE segue subindo no cap
    sem level-up pra consumir, então o delta é fantasma. 0.0 é ganho zero VÁLIDO
    (≠ None = não-li). Retorna (gain|None, leveled: bool)."""
    leveled = (lv1 is not None and lv0 is not None and lv1 > lv0)
    if leveled:
        return xp_through_levelup(lv0, exp0, lv1, exp1), True
    if exp0 is None or exp1 is None:
        return None, False
    if level_capped(lv1):
        return 0.0, False
    return (exp1 - exp0), False


class PartyXpAccumulator:
    """Acumulador VIVO de xp por-herói — o LIVE primário da cadeia de xp, pra run INTEIRA.

    Integra os incrementos do within-level (HeroRuntime.EXP_FAKE, shape de
    build.read_live_party) tick-a-tick, keyed por heroKey, em vez de subtrair dois
    endpoints (baseline t=0 → leitura no close). O delta de endpoints dava +0 a herói
    FORA do baseline (deploy tardio, ou morto da run ANTERIOR ainda em revive ~115s:
    sem exp_start → gain None → +0 no app) — cravado ao vivo em 2 users: runs com morte
    zeravam um herói em 30–45% dos casos; sem morte, 0%.

    Regras do update (1 snapshot {heroKey: (lv, exp)} por chamada):
      - 1º avistamento → semeia o baseline (acc=0, exp_start=exp): crédito DESTE ponto
        em diante (o fix do +0); não inventa passado.
      - tick seguinte → soma per_hero_gain(prev, cur) SÓ quando > 0; level-up faz a
        ponte pela curva e marca `levelup` STICKY.
      - herói NO CAP (level_capped: nível sem entrada na curva) → ganho 0 (per_hero_gain
        devolve 0.0, não None); cruzar PRA DENTRO do cap banka só até o limiar. O
        baseline AVANÇA no g == 0 → exp_start/exp_end seguem a observação CRUA (honesta);
        só o ganho é suprimido (EXP_FAKE sobe no cap sem level-up = fantasma).
      - dip same-level (g < 0 = leitura suja; o within-level real é monotônico fora do
        level-up) → não soma E NÃO avança o baseline: a recuperação telescopa
        (cur − último_bom) sem double-count.
      - herói AUSENTE do snapshot (morto/dropout) → nada anda: o acumulado fica banked
        (morto acumula 0 enquanto morto — comportamento real do jogo, preservado).
      - entrada lixo (lv/exp None, shape errado) → ignorada; NUNCA levanta (espelha o
        contrato never-raise de read_live_party).

    Leitura: gain/record devolvem None se o herói NUNCA foi visto (≠ 0.0 = ganho zero
    VÁLIDO); total() devolve None se NINGUÉM foi visto (fonte viva OFF → o caller cai
    pro SAVE — nunca conflar None-de-leitura com 0-de-ganho)."""

    def __init__(self):
        self._heroes = {}   # heroKey -> {acc, lv, exp, exp_start, levelup}

    def update(self, party):
        """Integra um snapshot vivo {heroKey: (lv, exp)}. Never-raises; {}/None = no-op."""
        try:
            items = party.items() if party else ()
            for hk, cur in items:
                try:
                    lv, exp = cur
                except (TypeError, ValueError):
                    continue
                if lv is None or exp is None:
                    continue
                st = self._heroes.get(hk)
                if st is None:
                    self._heroes[hk] = {"acc": 0.0, "lv": lv, "exp": exp,
                                        "exp_start": exp, "levelup": False}
                    continue
                if lv < st["lv"]:
                    # Nível NUNCA cai mid-run: leitura suja (slot de HeroList pendente que ainda
                    # devolve um heroKey válido) → não soma E não avança o baseline (simétrico ao
                    # dip same-level). O tick-a-tick multiplica a exposição a leitura suja ~600x
                    # vs o delta de 2 endpoints, então o guard de regressão importa aqui.
                    continue
                g, leveled = per_hero_gain(st["lv"], st["exp"], lv, exp)
                if leveled:
                    st["levelup"] = True
                if g is not None and g > 0:
                    st["acc"] += g
                if g is None or g >= 0:
                    # Avança o baseline (g=None = level-up que a curva não cobriu: pula a
                    # ponte mas segue acumulando dali). No dip same-level (g<0) NÃO avança.
                    st["lv"], st["exp"] = lv, exp
        except Exception:
            return

    def gain(self, hk):
        """Acumulado CRU do herói, ou None se nunca visto (≠ 0.0, ganho zero válido)."""
        st = self._heroes.get(hk)
        return st["acc"] if st is not None else None

    def record(self, hk):
        """{gain, levelup, exp_start, exp_end} prontos pro record da run (arredondados),
        ou None se o herói nunca foi visto vivo."""
        st = self._heroes.get(hk)
        if st is None:
            return None
        return {"gain": round(st["acc"], 2), "levelup": st["levelup"],
                "exp_start": round(st["exp_start"], 2), "exp_end": round(st["exp"], 2)}

    def total(self):
        """Soma CRUA dos acumulados, ou None se NENHUM herói foi visto (fonte viva off)."""
        if not self._heroes:
            return None
        return sum(st["acc"] for st in self._heroes.values())
