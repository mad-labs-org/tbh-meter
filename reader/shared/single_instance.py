"""single_instance.py — garante que SÓ UM reader rode por vez.

Por quê: se dois readers anexam ao mesmo jogo, os dois escrevem em runs.jsonl —
a mesma run sai duplicada, e a disputa pela memória derruba a leitura de gold VIVA,
caindo no fallback SAVE, que sob contenção rende gold 2×. Cravado nos dados reais:
uma instância (live) = gold correto, sem duplicata; duas = duplicata + 2×.

Como (Windows): um MUTEX NOMEADO (kernel32.CreateMutexW). O SO libera o mutex
AUTOMATICAMENTE quando o processo dono morre — inclusive em crash ou kill — então
NÃO existe stale-lock pra limpar (ao contrário de um PID-file). Uma segunda instância
recebe ERROR_ALREADY_EXISTS e desiste. Namespace `Local\\` (escopo de sessão): sempre
permitido pra usuário não-elevado, e é onde o app + um run manual colidem. (`Global\\`
exigiria SeCreateGlobalPrivilege, que o app não-elevado não tem.)

Fora do Windows é no-op: o reader só anexa ao jogo no Windows, então não há o que
proteger em dev/CI (o --selftest sequer chega aqui).
"""
import sys

# Mantém o handle do mutex vivo pela duração do processo. Se ele for coletado pelo GC,
# o handle fecha e o mutex é liberado — perderíamos o lock. Por isso guardamos aqui.
_held = []

MUTEX_NAME = "Local\\TBH_Meter_Reader"
_ERROR_ALREADY_EXISTS = 183


def acquire():
    """Tenta virar o único reader rodando. True se conseguiu (ou se não há o que
    proteger fora do Windows); False se outra instância já está rodando."""
    if sys.platform != "win32":
        return True
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    kernel32.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]

    handle = kernel32.CreateMutexW(None, False, MUTEX_NAME)
    err = ctypes.get_last_error()
    if not handle:
        # Nem criar o mutex deu certo — falha ABERTO: nunca bloqueia o único reader.
        return True
    if err == _ERROR_ALREADY_EXISTS:
        kernel32.CloseHandle(handle)
        return False
    _held.append(handle)  # dono: segura o handle; o SO libera no fim do processo
    return True
