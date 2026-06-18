"""Event feed (LogManager): detects new entries each tick.

Current state (v1): counts how many new events appeared. Reading the TYPE/content of
each event (StageClear, HeroDie, LevelUp...) needs the offset of the ELogType field
inside LogData — not dumped yet. TODO phase 2: dump 'class LogData' and fill in
LogManager.* in config/offsets.py to label each event.
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
            self._last_count = event_count   # baseline on the 1st read
            self.new_since_last = 0
            return
        delta = event_count - self._last_count
        # if it dropped, the list was truncated (2000-entry cap); re-anchor
        self.new_since_last = max(0, delta)
        self.total_seen += self.new_since_last
        self._last_count = event_count
