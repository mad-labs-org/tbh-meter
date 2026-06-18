"""utils.py — utilitários compartilhados: formatação humana + janela de tempo + log.

Reúne formatting (números gigantes K/M/B, tempo, %), timing (relógio monotônico +
janela deslizante pro DPS/kills-min) e um tee de stdio (monitorar de fora). Nada de memória.
"""

import os
import sys
import time
from collections import deque


# ----------------------------- recursos (PyInstaller-safe) ------------------- #
def resource_path(rel: str) -> str:
    """Caminho de um recurso EMPACOTÁVEL (ex.: config/level_curve.json), tanto em
    source quanto congelado pelo PyInstaller. `rel` é relativo à RAIZ do projeto
    (a pasta reader/), ex.: 'config/level_curve.json'.

    Frozen: PyInstaller seta sys.frozen e expõe a raiz dos dados em sys._MEIPASS
    (onefile = dir temp; onedir = _internal/). O --add-data DEST tem que casar com
    `rel` (ex.: --add-data "config/level_curve.json;config" -> rel="config/...").
    Source: este arquivo vive em shared/, então a raiz é um nível acima."""
    if getattr(sys, "frozen", False):
        base = sys._MEIPASS  # type: ignore[attr-defined]
    else:
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, rel)


# ----------------------------- formatação ----------------------------------- #
# Sufixos para abreviar números grandes (idle games chegam a trilhões+).
_SUFFIXES = ["", "K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No", "Dc"]


def format_number(value: float, decimals: int = 2) -> str:
    """1234567 -> '1.23M'. Mantém pequenos sem sufixo. Aceita negativo."""
    if value is None:
        return "-"
    sign = "-" if value < 0 else ""
    n = abs(float(value))
    if n < 1000:
        # inteiro fica sem casas decimais; resto com 1 casa
        return f"{sign}{n:.0f}" if n == int(n) else f"{sign}{n:.1f}"
    magnitude = 0
    while n >= 1000 and magnitude < len(_SUFFIXES) - 1:
        n /= 1000.0
        magnitude += 1
    return f"{sign}{n:.{decimals}f}{_SUFFIXES[magnitude]}"


def format_dps(value: float) -> str:
    """DPS formatado com '/s'."""
    return f"{format_number(value)}/s"


def format_duration(seconds: float) -> str:
    """93 -> '1m 33s'; 3725 -> '1h 02m 05s'."""
    seconds = int(max(0, seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h {m:02d}m {s:02d}s"
    if m:
        return f"{m}m {s:02d}s"
    return f"{s}s"


def format_percent(current: float, maximum: float) -> str:
    """HP atual/máx -> '73%'. Protege contra divisão por zero."""
    if not maximum:
        return "0%"
    return f"{max(0.0, min(1.0, current / maximum)) * 100:.0f}%"


# ----------------------------- tempo / janela -------------------------------- #
def now() -> float:
    """Relógio monotônico (não anda pra trás se o sistema ajustar a hora)."""
    return time.monotonic()


class RollingWindow:
    """Acumula (timestamp, valor) e responde soma e taxa na janela.

    Ex.: window de 5s recebendo dano por tick -> total()/5 = DPS suavizado.
    """

    def __init__(self, window_seconds: float):
        self.window = float(window_seconds)
        self._samples: deque[tuple[float, float]] = deque()
        self._total = 0.0

    def add(self, value: float, timestamp: float | None = None) -> None:
        ts = now() if timestamp is None else timestamp
        self._samples.append((ts, value))
        self._total += value
        self._trim(ts)

    def _trim(self, current_ts: float) -> None:
        limite = current_ts - self.window
        while self._samples and self._samples[0][0] < limite:
            _, v = self._samples.popleft()
            self._total -= v

    def total(self, timestamp: float | None = None) -> float:
        """Soma dos valores ainda dentro da janela."""
        self._trim(now() if timestamp is None else timestamp)
        return self._total

    def rate_per_second(self, timestamp: float | None = None) -> float:
        """Soma / tamanho da janela (ex.: DPS)."""
        return self.total(timestamp) / self.window if self.window else 0.0

    def rate_per_minute(self, timestamp: float | None = None) -> float:
        """Conveniência pra kills/min etc."""
        return self.rate_per_second(timestamp) * 60.0

    def reset(self) -> None:
        self._samples.clear()
        self._total = 0.0


# ----------------------------- log (monitorar de fora) ----------------------- #
def _stamp_lines(text, at_line_start):
    """Prefixa [HH:MM:SS] no inicio de cada linha; devolve (texto, novo_at_line_start).
    O estado e necessario porque print() escreve em pedacos (o conteudo e o newline em
    writes separados), entao o carimbo so entra quando uma linha REALMENTE comeca. Linhas
    vazias nao sao carimbadas. So pro arquivo (meter.log) — o console fica cru."""
    if not text:
        return text, at_line_start
    stamp = time.strftime("[%H:%M:%S] ")
    out = []
    for i, part in enumerate(text.split("\n")):
        if i > 0:
            out.append("\n")
            at_line_start = True
        if part:
            if at_line_start:
                out.append(stamp)
                at_line_start = False
            out.append(part)
    return "".join(out), at_line_start


class _Tee:
    """Escreve em vários streams (console + arquivo). Tolerante a erro de I/O. Pro
    arquivo, troca '\\r' por '\\n' (a linha-viva do meter usa \\r in-place -> no arquivo
    vira 1 linha/atualização, legível, em vez de um \\r-amontoado ilegível)."""

    def __init__(self, console, fileobj):
        self._console = console
        self._file = fileobj
        self._file_at_line_start = True

    def write(self, s):
        # console: CRU (sem timestamp) — nao quebra a linha-viva (\r) nem duplica horario
        # quando o app captura este stdout.
        try:
            self._console.write(s)
            self._console.flush()
        except Exception:
            pass
        # arquivo (meter.log): \r -> \n e [HH:MM:SS] no comeco de cada linha (log de debug).
        try:
            stamped, self._file_at_line_start = _stamp_lines(
                s.replace("\r", "\n"), self._file_at_line_start)
            self._file.write(stamped)
            self._file.flush()
        except Exception:
            pass

    def flush(self):
        for st in (self._console, self._file):
            try:
                st.flush()
            except Exception:
                pass


def tee_stdio(log_path, max_bytes=5_000_000):
    """Espelha stdout+stderr num arquivo (além do console) — deixa o run OBSERVÁVEL de
    fora (ex.: o share SMB, onde o Claude lê). Cria o dir. Chamar 1x no main().
    Bound de tamanho: o app respawna o reader com frequência (~5s com o jogo fechado) e o
    tee dá append, então um meter.log de vida-longa cresceria sem limite. Se já passou de
    max_bytes recomeça do zero; senão dá append (um respawn não perde o contexto recente).
    Best-effort: se não der pra abrir o arquivo, segue só no console."""
    try:
        os.makedirs(os.path.dirname(log_path) or ".", exist_ok=True)
        mode = "a"
        try:
            if os.path.exists(log_path) and os.path.getsize(log_path) > max_bytes:
                mode = "w"
        except OSError:
            pass
        f = open(log_path, mode, encoding="utf-8", buffering=1)
    except Exception:
        return None
    sys.stdout = _Tee(sys.__stdout__, f)
    sys.stderr = _Tee(sys.__stderr__, f)
    return f


# ----------------------------- log de infra (diag) --------------------------- #
# SEPARADO do meter.log (que é evento/usuário: attach / resolve / run-close / erro). Aqui mora o
# INTERNO da resolução e da SELEÇÃO DE INSTÂNCIA — os dados que faltaram em vários debugs. Ex.: o
# party-off do 1.00.13: o meter.log só dizia "0 heroes deployed", sem dizer QUAL StageManager foi
# escolhido, que existiam 453 candidatas, nem que a escolhida era um GHOST (heroKey ok, lvl=0). Uma
# linha de diag teria mostrado tudo. Sempre ligado (não gateado por --debug); mesmo bound do tee.
_DIAG = None


def init_diag_log(log_path, max_bytes=5_000_000):
    """Abre o log de infra (reader-diag.log), separado do meter.log. Mesma política de bound do
    tee_stdio (recomeça se passou de max_bytes; senão append, pra um respawn não perder contexto).
    Best-effort: NUNCA levanta — um diagnóstico não pode derrubar o reader. Chamar 1x no main()."""
    global _DIAG
    try:
        os.makedirs(os.path.dirname(log_path) or ".", exist_ok=True)
        mode = "w" if (os.path.exists(log_path) and os.path.getsize(log_path) > max_bytes) else "a"
        _DIAG = open(log_path, mode, encoding="utf-8", buffering=1)
        _DIAG.write(time.strftime("\n===== reader start %Y-%m-%d %H:%M:%S =====\n"))
        _DIAG.flush()
    except Exception:
        _DIAG = None


def diag(msg):
    """Anexa uma linha [HH:MM:SS] no log de infra. No-op se não inicializado (testes, selftest).
    NUNCA levanta — best-effort igual ao _Tee."""
    f = _DIAG
    if f is None:
        return
    try:
        f.write(time.strftime("[%H:%M:%S] ") + str(msg) + "\n")
        f.flush()
    except Exception:
        pass
