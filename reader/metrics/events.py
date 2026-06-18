"""Feed de eventos (LogManager): detecta entradas novas a cada tick.

Estado atual (v1): conta quantos eventos novos surgiram. Ler o TIPO/conteúdo de
cada evento (StageClear, HeroDie, LevelUp...) precisa do offset do campo ELogType
dentro de LogData — ainda não dumpado. TODO fase 2: dumpar 'class LogData' e
preencher LogManager.* em config/offsets.py pra rotular cada evento.
"""


class EventFeed:
    def __init__(self):
        self._last_count: int | None = None
        self.new_since_last: int = 0
        self.total_seen: int = 0

    def update(self, event_count: int) -> None:
        if event_count is None:
            self.new_since_last = 0
            return
        if self._last_count is None:
            self._last_count = event_count   # baseline na 1ª leitura
            self.new_since_last = 0
            return
        delta = event_count - self._last_count
        # se diminuiu, a lista foi truncada (limite de 2000); reancora
        self.new_since_last = max(0, delta)
        self.total_seen += self.new_since_last
        self._last_count = event_count
