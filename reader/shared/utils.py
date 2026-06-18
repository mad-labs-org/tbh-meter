"""utils.py — shared utilities: human formatting + time window + log.

Bundles formatting (huge numbers K/M/B, time, %), timing (monotonic clock +
sliding window for DPS/kills-min) and a stdio tee (watch from outside). No memory.
"""

import os
import sys
import time
from collections import deque


# ----------------------------- resources (PyInstaller-safe) ------------------ #
def resource_path(rel: str) -> str:
    """Path to a BUNDLEABLE resource (e.g. config/level_curve.json), both in
    source and frozen by PyInstaller. `rel` is relative to the project ROOT
    (the reader/ folder), e.g. 'config/level_curve.json'.

    Frozen: PyInstaller sets sys.frozen and exposes the data root at sys._MEIPASS
    (onefile = temp dir; onedir = _internal/). The --add-data DEST must match
    `rel` (e.g. --add-data "config/level_curve.json;config" -> rel="config/...").
    Source: this file lives in shared/, so the root is one level up."""
    if getattr(sys, "frozen", False):
        base = sys._MEIPASS  # type: ignore[attr-defined]
    else:
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, rel)


# ----------------------------- formatting ------------------------------------ #
# Suffixes to abbreviate large numbers (idle games reach trillions+).
_SUFFIXES = ["", "K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No", "Dc"]


def format_number(value: float, decimals: int = 2) -> str:
    """1234567 -> '1.23M'. Keeps small ones unsuffixed. Accepts negatives."""
    if value is None:
        return "-"
    sign = "-" if value < 0 else ""
    n = abs(float(value))
    if n < 1000:
        # integers get no decimals; the rest get 1 decimal place
        return f"{sign}{n:.0f}" if n == int(n) else f"{sign}{n:.1f}"
    magnitude = 0
    while n >= 1000 and magnitude < len(_SUFFIXES) - 1:
        n /= 1000.0
        magnitude += 1
    return f"{sign}{n:.{decimals}f}{_SUFFIXES[magnitude]}"


def format_dps(value: float) -> str:
    """DPS formatted with '/s'."""
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
    """current/max HP -> '73%'. Guards against division by zero."""
    if not maximum:
        return "0%"
    return f"{max(0.0, min(1.0, current / maximum)) * 100:.0f}%"


# ----------------------------- time / window --------------------------------- #
def now() -> float:
    """Monotonic clock (doesn't go backwards if the system adjusts the time)."""
    return time.monotonic()


class RollingWindow:
    """Accumulates (timestamp, value) and reports sum and rate over the window.

    E.g. a 5s window receiving damage per tick -> total()/5 = smoothed DPS.
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
        """Sum of the values still inside the window."""
        self._trim(now() if timestamp is None else timestamp)
        return self._total

    def rate_per_second(self, timestamp: float | None = None) -> float:
        """Sum / window size (e.g. DPS)."""
        return self.total(timestamp) / self.window if self.window else 0.0

    def rate_per_minute(self, timestamp: float | None = None) -> float:
        """Convenience for kills/min etc."""
        return self.rate_per_second(timestamp) * 60.0

    def reset(self) -> None:
        self._samples.clear()
        self._total = 0.0


# ----------------------------- log (watch from outside) ---------------------- #
def _stamp_lines(text, at_line_start):
    """Prefixes [HH:MM:SS] at the start of each line; returns (text, new_at_line_start).
    State is needed because print() writes in chunks (the content and the newline in
    separate writes), so the stamp only goes in when a line REALLY starts. Empty lines
    aren't stamped. File only (meter.log) — the console stays raw."""
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
    """Writes to multiple streams (console + file). Tolerant of I/O errors. For the
    file, swaps '\\r' for '\\n' (the meter's live line uses \\r in-place -> in the file
    it becomes 1 line/update, readable, instead of an illegible \\r-pileup)."""

    def __init__(self, console, fileobj):
        self._console = console
        self._file = fileobj
        self._file_at_line_start = True

    def write(self, s):
        # console: RAW (no timestamp) — doesn't break the live line (\r) or duplicate the time
        # when the app captures this stdout.
        try:
            self._console.write(s)
            self._console.flush()
        except Exception:
            pass
        # file (meter.log): \r -> \n and [HH:MM:SS] at the start of each line (debug log).
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
    """Mirrors stdout+stderr to a file (besides the console) — makes the run OBSERVABLE from
    outside (e.g. the SMB share, where Claude reads). Creates the dir. Call once in main().
    Size bound: the app respawns the reader frequently (~5s with the game closed) and the
    tee appends, so a long-lived meter.log would grow without limit. If it already passed
    max_bytes it restarts from scratch; otherwise it appends (a respawn doesn't lose recent
    context). Best-effort: if the file can't be opened, it continues on the console only."""
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


# ----------------------------- infra log (diag) ------------------------------ #
# SEPARATE from meter.log (which is event/user: attach / resolve / run-close / error). Here lives the
# INTERNALS of resolution and INSTANCE SELECTION — the data missing in several debugs. E.g. the
# 1.00.13 party-off: meter.log only said "0 heroes deployed", without saying WHICH StageManager was
# chosen, that there were 453 candidates, nor that the chosen one was a GHOST (heroKey ok, lvl=0). A
# diag line would have shown it all. Always on (not gated by --debug); same bound as the tee.
_DIAG = None


def init_diag_log(log_path, max_bytes=5_000_000):
    """Opens the infra log (reader-diag.log), separate from meter.log. Same bound policy as
    tee_stdio (restarts if it passed max_bytes; otherwise append, so a respawn doesn't lose context).
    Best-effort: NEVER raises — a diagnostic can't take down the reader. Call once in main()."""
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
    """Appends a [HH:MM:SS] line to the infra log. No-op if not initialized (tests, selftest).
    NEVER raises — best-effort like _Tee."""
    f = _DIAG
    if f is None:
        return
    try:
        f.write(time.strftime("[%H:%M:%S] ") + str(msg) + "\n")
        f.flush()
    except Exception:
        pass
