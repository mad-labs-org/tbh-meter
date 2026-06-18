"""gold.py — GOLD POR RUN, isolado. Lê só o gold de COMBATE vivo (e nada além).

TODA a lógica de gold mora AQUI. O meter_windows só chama estas funções — zero leitura de
gold inline lá. Public API (o que o orquestrador usa):
    resolve_combat_gold_klass(reader, psd_list) -> klass | None   # acha a fonte viva (1x no startup)
    combat_gold_klass_ok(reader, klass)          -> bool          # valida klass do cache (barato)
    combat_gold_live(reader, klass)              -> int  | None   # cumulativo de combate AGORA
    combat_gold_save(reader, psd)                -> int  | None   # mesmo número, fonte SAVE (fallback)
    run_gain(start, end)                         -> int  | None   # delta = gold ganho na run

═══════════════════════════════════════════════════════════════════════════════════════════
MECANISMO (cravado ao vivo com o Mario, 2026-06-05). O jogo mantém GoldEarn como um
Dict<SubKey, long> CUMULATIVO. Os SubKeys NÃO são fontes paralelas independentes:

    SubKey 1 = COMBATE   ← o que a run ganhou matando mob. É ISTO que o gold-por-run quer.
    SubKey 0 = TOTAL     ← rollup (combate + venda + idle + quest). NÃO usar (conta venda).
    SubKey 2 / 3 = ruído ← venda/idle/quest avulsos.

VENDER um item entra no TOTAL (SubKey 0) e na carteira, mas NÃO no COMBATE (SubKey 1) —
validado ao vivo: numa run com venda de 186.480, live_total − live_combat = 186.480 EXATO,
e o live_combat ficou limpo. Por isso o gold-por-run = delta do SubKey 1.

DUAS fontes do MESMO número:
  • VIVO (AggregateManager.AGGREGATES[GoldEarn][SubKey1]): tempo real, exato, lag-zero. PRIMÁRIO.
  • SAVE (PlayerSaveData.AGGREGATES, GoldEarn/SubKey1): atualiza em SALTOS (só no save-write,
    ~a cada 100s) → o delta por run é não-confiável (0 se a run cai entre dois writes; ~2x se
    um write pega duas runs). Cravado ao vivo: o save errou +25k numa run e +1.18M em outra,
    enquanto o vivo bateu na unidade. SÓ fallback.

POR QUE O VIVO É DIFÍCIL — e como resolvemos (sem offset novo!):
  O AggregateManager é um singleton `X : nn<X>` de nome OFUSCADO de 2 letras. Esse nome
  DRIFTA entre builds (cravado: era "ut", virou "uu") → achar por nome (find_class_by_name)
  pega a classe ERRADA → o singleton não resolve → versões antigas caíam no scan-por-valor,
  que CHUTAVA a célula (maior valor → cópia congelada → gold 0; maior crescimento → lixo de
  heap → 1.97T). O OFFSET (AGGREGATES @0x20) sempre esteve certo; o problema era ACHAR o
  objeto vivo sem depender do nome.

  Resolução NAME-FREE, por ESTRUTURA (resolve_combat_gold_klass):
    1. Acha o inner-dict GoldEarn vivo pela assinatura de DOIS valores: uma entry Dict8B
       KEY==1 (SubKey1) com value ≈ combat_save E uma entry irmã KEY==0 (SubKey0) com
       value >= ela. Faixa ESTREITA em torno do save (o vivo lidera o save por poucos M).
       Dois números na casa do bilhão, juntos, não acontecem por acaso → assinatura cravada.
    2. SOBE os ponteiros (backrefs): inner-dict → o outer-dict que o referencia na chave
       GoldEarn(2) → o objeto que possui o outer-dict.
    3. CONFIRMA que esse objeto é o SINGLETON enraizado: o campo estático `nn<X>.bbwf`
       aponta de volta pra ele (round-trip). Cópia congelada (sobra de autosave/GC) NÃO é
       enraizada → não passa. É POSSE, não chute.
  Cacheia o KLASS (estável na sessão; classes não movem). A cada leitura, re-deref do
  singleton pelo bbwf (robusto a GC mover a instância) e anda AGGREGATES → GoldEarn →
  SubKey1 — exatamente como o XP lê o exp vivo do objeto do herói.
═══════════════════════════════════════════════════════════════════════════════════════════
"""

import struct

from config.offsets import (Dict, Dict8B, Array, EAggregateType, PlayerSaveData,
                             AggregateSaveData, AggregateManager)
from game import save
from il2cpp import typeinfo
from il2cpp.finder import bbwf_from_klass
from shared.memory import scan, scan_i64_range, writable_regions

# Regras de NEGÓCIO (qual SubKey significa o quê) — não são offsets, por isso moram aqui com
# a lógica, e NÃO em config/offsets.py (que é só offsets/enums). Cravado por oráculo vivo.
COMBAT_SUBKEY = 1            # GoldEarn de COMBATE (o gold-por-run)
TOTAL_SUBKEY = 0            # GoldEarn TOTAL (rollup; inclui venda → não usar)

# Faixa de busca da célula viva = em torno de combat_save. O vivo LIDERA o save pelo gold
# ganho desde o último save-write (alguns M, depende da taxa de farm); nunca fica atrás. A
# precisão vem da ASSINATURA + do round-trip do singleton, não da janela — a faixa só precisa
# conter o valor sem varrer meio heap (faixa larga estourava o teto de scan e nem chegava nele).
_LEAD_DOWN = 2_000_000      # folga p/ baixo (skew de leitura; o vivo >= save)
_LEAD_UP = 60_000_000       # folga p/ cima (lead grande com farm rápido entre save-writes)


# --------------------------------------------------------------------------- #
# SAVE (fallback) + delta
# --------------------------------------------------------------------------- #
def combat_gold_save(reader, psd):
    """Gold de COMBATE cumulativo do SAVE (defasado, fallback): o AggregateSaveData com
    Type==GoldEarn E SubKey==1. NÃO soma todos os Type==GoldEarn (isso pegava o rollup +
    as partes = 2× e ainda o ruído). None se não achar."""
    if not psd:
        return None
    try:
        for e in reader.list_iter(reader.rptr(psd + PlayerSaveData.AGGREGATES), cap=2000):
            if (reader.ri32(e + AggregateSaveData.TYPE) == EAggregateType.GoldEarn and
                    reader.ri32(e + AggregateSaveData.SUB_KEY) == COMBAT_SUBKEY):
                return reader.ri64(e + AggregateSaveData.VALUE)
        return None
    except Exception:
        return None


def run_gain(start_value, end_value):
    """Gold de combate GANHO na run = delta do cumulativo (end − start). É O número
    'gold por run': combate puro, sem venda/idle/quest e sem o dobro do autosave.

    None se faltar leitura ou o cumulativo não for monotônico — e aí o caller NÃO deve
    cair pro delta do saldo da carteira (que incluiria venda/idle), senão volta o bug."""
    if start_value is None or end_value is None or end_value < start_value:
        return None
    return end_value - start_value


# --------------------------------------------------------------------------- #
# VIVO (primário): resolve o AggregateManager por ESTRUTURA, lê GoldEarn[SubKey1]
# --------------------------------------------------------------------------- #
def combat_gold_live(reader, klass):
    """Cumulativo de gold de COMBATE VIVO (GoldEarn[SubKey1]) lido do AggregateManager AGORA.

    Re-deref do singleton pelo campo estático (bbwf) a cada chamada — robusto a o GC mover a
    instância (a classe `klass` é estável; a instância pode mudar de endereço). Depois anda
    AGGREGATES (Dict externo) → entry GoldEarn → Dict interno → SubKey1. None se o klass não
    resolve mais ou a estrutura sumiu → o caller cai pro save."""
    if not klass:
        return None
    inst = bbwf_from_klass(reader, klass)
    if not inst:
        return None
    outer = reader.rptr(inst + AggregateManager.AGGREGATES)
    if not outer:
        return None
    for k, v in reader.dict8b_items(outer):
        if k == EAggregateType.GoldEarn:
            for sk, sv in reader.dict8b_items(v):       # v = ponteiro do inner Dict<SubKey,long>
                if sk == COMBAT_SUBKEY:
                    return sv if (sv is not None and 0 < sv < 1_000_000_000_000_000) else None
            return None
    return None


def combat_gold_klass_ok(reader, klass):
    """True se o `klass` (vindo do cache) ainda resolve um AggregateManager vivo com GoldEarn.
    Barato (sem scan) → dá pra reusar do cache em vez de re-resolver quando o jogo não reiniciou."""
    return combat_gold_live(reader, klass) is not None


def resolve_combat_gold_klass(reader, psd_list):
    """Acha o KLASS do AggregateManager VIVO por ESTRUTURA (name-free). Roda 1× no startup
    (e no re-attach / self-heal); o resultado é cacheável. None se não convergir → caller usa
    o save. Veja o cabeçalho do módulo pro método (assinatura de 2 valores + round-trip do
    singleton)."""
    sv = combat_gold_save(reader, save.pick_live_psd(reader, psd_list))
    if not sv:
        return None
    owners = _resolve_aggregate_singleton(reader, writable_regions(reader), sv)
    return owners[0][1] if owners else None      # owners = [(inst, klass)]; queremos o klass


# --------------------------------------------------------------------------- #
# FAST PATH (primário): klass do AggregateManager por TypeDefIndex (RVA) — sem scan
# --------------------------------------------------------------------------- #
def resolve_combat_gold_klass_by_index(reader, tbase, idx_ut):
    """KLASS do AggregateManager VIVO resolvido por TypeDefIndex (`table[idx_ut]`) — o fast
    path que MATA o value-scan de ~90s (prova rva_probe5/6: idx_ut=2744 no v1.00.07 → klass
    idêntico ao do value-scan, em ~0.1ms). NAME-FREE por construção (§3): o singleton de gold
    é ofuscado e o nome DRIFTA (`ut`→`uu`), então resolve-se por ÍNDICE, NUNCA por nome.

    `combat_gold_klass_ok` é o GATE anti-veneno: confirma que o klass resolve um AggregateManager
    vivo com GoldEarn (= round-trip do singleton). RVA/idx ruim (build trocou, calib velha) →
    klass errado → gate falha → None → o caller cai no value-scan (`resolve_combat_gold_klass`).
    Não cacheia nem escreve nada — só resolve e valida."""
    K = typeinfo.class_by_index(reader, tbase, idx_ut)
    return K if (K and combat_gold_klass_ok(reader, K)) else None


def gold_index_of_klass(reader, tbase, klass):
    """Localiza o TypeDefIndex de um gold-klass JÁ resolvido, varrendo a TypeInfoTable por
    valor==klass (leitura direta, barata; cap duro `_MAX_TABLE_ENTRIES`, §10). É a parte SEM
    value-scan da calibração: quando o scan legado JÁ achou o `gold_klass`, a calibração reusa
    ESTE walk em vez de re-rodar o value-scan de ~90s (e sem precisar de `psd_list`). Name-free
    por construção. None se tbase/klass inválido ou não achar."""
    if not tbase or not klass:
        return None
    for idx in range(typeinfo._MAX_TABLE_ENTRIES):
        if typeinfo.class_by_index(reader, tbase, idx) == klass:
            return idx
    return None


def find_gold_index(reader, tbase, psd_list):
    """CALIBRAÇÃO SEM klass pré-resolvido: roda o value-scan UMA vez (precisa do `psd_list` p/
    ancorar a faixa via combat_gold_save) pra obter o gold-klass vivo, depois acha seu índice via
    `gold_index_of_klass`. PREFIRA `gold_index_of_klass(reader, tbase, gold_klass)` quando o scan
    legado já resolveu o klass (caso do `_calibrate`) — evita o value-scan redundante de ~90s.
    None se não convergir → o caller mantém o value-scan a cada run."""
    if not tbase:
        return None
    return gold_index_of_klass(reader, tbase, resolve_combat_gold_klass(reader, psd_list))


def gold_index_by_structure(reader, tbase):
    """idx_ut (TypeDefIndex do AggregateManager) por ESTRUTURA, SEM value-scan: o MENOR idx cujo
    `table[idx]` passa `combat_gold_klass_ok` — i.e. resolve um AggregateManager VIVO com GoldEarn
    (singleton enraizado por bbwf + GoldEarn[SubKey1]). Name-free (§3): testa o MESMO gate do fast
    path varrendo os índices da tabela JÁ descoberta — nunca toca no nome ofuscado (ut/uu/…).

    POR QUÊ (1.00.11): o value-scan (`resolve_combat_gold_klass`) bootstrapa o gold_klass por VALOR
    numa faixa estreita em torno do `combat_gold_save` — frágil: se o save está defasado do vivo
    (farm entre save-writes), não converge → gold_klass None → a calibração morria em
    'FAILED to locate gold idx'. Este walk NÃO depende do save: prova ao vivo (gold11_diag, build
    1.00.11) um único hit idx=2744 em <1s. PREFERÍVEL ao `gold_index_of_klass(gold_klass)` na
    calibração porque dispensa o value-scan inteiro. None se nada passar (rodou fora de combate →
    caller mantém o scan)."""
    if not tbase:
        return None
    for idx in range(typeinfo._MAX_TABLE_ENTRIES):
        K = typeinfo.class_by_index(reader, tbase, idx)
        if K and combat_gold_klass_ok(reader, K):
            return idx
    return None


# --------------------------------------------------------------------------- #
# internos (a "subida" estrutural) — todos privados; só resolve_combat_gold_klass os usa
# --------------------------------------------------------------------------- #
def _backrefs(reader, wregs, targets):
    """{target: [endereços 8-alinhados que CONTÊM um ponteiro == target]}. Acha quem aponta
    pra cada alvo. Após os filtros estruturais os alvos são POUCOS (≈1), então o scan por
    ponteiro (C, rápido) é barato. 1 scan resolve todos os alvos de uma vez."""
    needles = {struct.pack("<Q", t): t for t in targets if t}
    res = scan(reader, wregs, list(needles.keys()), aligned=True) if needles else {}
    return {t: res.get(nd, []) for nd, t in needles.items()}


def _inner_array_of(reader, c, cval):
    """Base do entries-array do inner-dict GoldEarn que contém a célula `c` (=SubKey1=cval).
    Valida a ASSINATURA: SubKey1==cval E SubKey0 presente com total>=combate. Determinístico
    e específico → ~zero falso-positivo. None se não casar."""
    for j in range(16):                                            # índice da entry SubKey1
        a = c - Dict8B.VALUE - Dict.DATA - j * Dict8B.STRIDE       # candidato a entries-array
        subs = {}
        for i in range(16):
            e = a + Dict.DATA + i * Dict8B.STRIDE
            h = reader.ri32(e + Dict8B.HASH)
            if h is None:
                break
            if h < 0:                                              # tombstone
                continue
            k = reader.ri32(e + Dict8B.KEY)
            v = reader.ri64(e + Dict8B.VALUE)
            if k is not None and v is not None and 0 <= k <= 3:
                subs.setdefault(k, v)
        if subs.get(COMBAT_SUBKEY) == cval and TOTAL_SUBKEY in subs and subs[TOTAL_SUBKEY] >= cval:
            return a
    return None


def _array_base_of_slot(reader, loc, maxidx=128):
    """Dado um VALUE-slot `loc` (entry+0x10) dentro de um entries-array, acha a base do array
    por busca local (MAX_LENGTH plausível + ponteiro de klass válido). None se não achar."""
    for i in range(maxidx):
        a = loc - Dict8B.VALUE - Dict.DATA - i * Dict8B.STRIDE
        ml = reader.ri32(a + Array.MAX_LENGTH)
        kls = reader.rptr(a)
        if ml is not None and i < ml <= 8192 and kls and kls > 0x10000:
            return a
    return None


def _dict_owning_array(reader, wregs, arr):
    """Dict-objs D tais que D+ENTRIES == arr (achados por backref ao array)."""
    out = []
    for loc in _backrefs(reader, wregs, [arr]).get(arr, []):
        d = loc - Dict.ENTRIES
        if reader.rptr(d + Dict.ENTRIES) == arr:
            cnt = reader.ri32(d + Dict.COUNT)
            if cnt is not None and 0 <= cnt <= 100000:
                out.append(d)
    return out


def _resolve_aggregate_singleton(reader, wregs, sv):
    """Acha [(inst, klass)] do AggregateManager VIVO por ESTRUTURA, name-free, em ~4 scans em
    lote (independe do nº de candidatas). sv = combat_gold_save (centro da faixa estreita). A
    célula viva é a única GoldEarn[SubKey1] que sobe, por backrefs, até um SINGLETON enraizado
    (bbwf round-trip); cópias congeladas param antes. Lista (≈1 elemento) ou []."""
    lo, hi = max(0, sv - _LEAD_DOWN), sv + _LEAD_UP
    arrays = {}                                       # A_in (entries-array do inner dict) -> cval
    for c in scan_i64_range(reader, wregs, lo, hi):
        cv = reader.ri64(c)
        if cv is None:
            continue
        a = _inner_array_of(reader, c, cv)
        if a:
            arrays.setdefault(a, cv)
    if not arrays:
        return []
    dins = set()                                      # A_in -> D_in (objeto do inner dict)
    for a, locs in _backrefs(reader, wregs, list(arrays.keys())).items():
        for loc in locs:
            d = loc - Dict.ENTRIES
            if reader.rptr(d + Dict.ENTRIES) == a:
                cnt = reader.ri32(d + Dict.COUNT)
                if cnt is not None and 0 <= cnt <= 100000:
                    dins.add(d)
    slots = []                                        # D_in -> slot do outer-dict com KEY==GoldEarn(2)
    for _, locs in _backrefs(reader, wregs, list(dins)).items():
        for loc in locs:
            if reader.ri32(loc - (Dict8B.VALUE - Dict8B.KEY)) == EAggregateType.GoldEarn:
                slots.append(loc)
    aouts = set()                                     # slot -> A_out (entries-array do outer dict)
    for slot in slots:
        a_out = _array_base_of_slot(reader, slot)
        if a_out:
            aouts.add(a_out)
    douts = set()                                     # A_out -> D_out
    for a, locs in _backrefs(reader, wregs, list(aouts)).items():
        for loc in locs:
            d = loc - Dict.ENTRIES
            if reader.rptr(d + Dict.ENTRIES) == a:
                douts.add(d)
    owners, seen = [], set()                          # D_out -> INST (confirma singleton enraizado)
    for _, locs in _backrefs(reader, wregs, list(douts)).items():
        for loc in locs:
            inst = loc - AggregateManager.AGGREGATES
            kk = reader.rptr(inst)                     # Obj.KLASS @ +0x0
            if kk and inst not in seen and bbwf_from_klass(reader, kk) == inst:
                seen.add(inst)
                owners.append((inst, kk))
    return owners
