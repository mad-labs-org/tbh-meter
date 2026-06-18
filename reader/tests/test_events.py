"""Testes para metrics/events.py — EventFeed."""

import pytest

from metrics.events import EventFeed


class TestEventFeed:
    def test_initial_state(self):
        f = EventFeed()
        assert f.new_since_last == 0
        assert f.total_seen == 0

    def test_first_update_is_baseline_no_events(self):
        """Primeira chamada estabelece baseline; sem eventos contados."""
        f = EventFeed()
        f.update(10)
        assert f.new_since_last == 0
        assert f.total_seen == 0

    def test_count_increase_detected(self):
        f = EventFeed()
        f.update(10)   # baseline
        f.update(13)   # +3 novos
        assert f.new_since_last == 3
        assert f.total_seen == 3

    def test_multiple_increases_accumulate(self):
        f = EventFeed()
        f.update(0)
        f.update(5)
        f.update(7)
        assert f.total_seen == 7

    def test_same_count_no_events(self):
        f = EventFeed()
        f.update(10)
        f.update(10)
        assert f.new_since_last == 0
        assert f.total_seen == 0

    def test_list_truncation_reancors(self):
        """Quando a lista CAI (truncada pelo runtime, limite de 2000),
        não deve reportar eventos negativos — apenas re-ancora."""
        f = EventFeed()
        f.update(1500)
        f.update(1800)   # +300 ok
        f.update(100)    # caiu — truncado
        assert f.new_since_last == 0
        assert f.total_seen == 300  # só conta o legítimo

    def test_none_count_skipped(self):
        """None (leitura falhou) não altera estado."""
        f = EventFeed()
        f.update(5)
        f.update(None)
        assert f.new_since_last == 0
        assert f.total_seen == 0

    def test_none_count_after_baseline_skipped(self):
        f = EventFeed()
        f.update(5)   # baseline
        f.update(8)   # +3
        f.update(None)
        assert f.new_since_last == 0
        assert f.total_seen == 3  # mantém o que tinha

    @pytest.mark.parametrize("counts,expected_total", [
        ([0, 1, 2, 3, 4, 5], 5),
        ([10, 10, 15, 20], 10),
        ([0, 100], 100),
    ])
    def test_parametrized_totals(self, counts, expected_total):
        f = EventFeed()
        for c in counts:
            f.update(c)
        assert f.total_seen == expected_total
