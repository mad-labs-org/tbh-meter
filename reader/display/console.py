"""Live terminal panel using rich. Only displays the data it's given."""

from rich.console import Group
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from shared.utils import (
    format_number,
    format_dps,
    format_percent,
    format_duration,
)


class Dashboard:
    def render(self, *, total_dps, peak_dps, total_damage, elapsed,
               heroes, monsters_alive, kills_per_min, total_kills,
               stage_state, events_new):
        """`heroes` = list of (current_hp, hp_max)."""
        header = Panel(
            Text(
                f"DPS  {format_dps(total_dps)}        "
                f"peak  {format_dps(peak_dps)}        "
                f"total damage  {format_number(total_damage)}",
                style="bold green",
            ),
            title="tbh-meter",
            subtitle=f"session {format_duration(elapsed)}",
        )

        party = Table(title="Party", expand=True)
        party.add_column("#", justify="right")
        party.add_column("HP")
        party.add_column("%", justify="right")
        for i, (hp, hp_max) in enumerate(heroes, 1):
            hp = hp or 0.0
            hp_max = hp_max or 0.0
            party.add_row(
                str(i),
                f"{format_number(hp)} / {format_number(hp_max)}",
                format_percent(hp, hp_max),
            )
        if not heroes:
            party.add_row("-", "(no heroes read)", "-")

        rodape = Panel(
            Text(
                f"monsters alive: {monsters_alive}    "
                f"kills/min: {kills_per_min:.0f}    "
                f"kills (session): {total_kills}    "
                f"stage_state: {stage_state}    "
                f"new events: {events_new}"
            )
        )
        return Group(header, party, rodape)
