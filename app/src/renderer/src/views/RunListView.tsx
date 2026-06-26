import { Fragment, useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react";
import {
  Inbox,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  ChartColumn,
  SlidersHorizontal,
  Filter,
  GripVertical,
  RotateCcw,
  Eye,
  EyeOff,
  Star,
  X,
} from "lucide-react";
import type { RunIndexEntry, RunColumnConfig } from "../../../shared/ipc-types.js";
import type { RunStatus } from "../../../shared/run-types.js";
import type { DictKey, Translate } from "../../../shared/i18n/index.js";
import {
  humanize,
  formatDuration,
  formatDateTime,
  ago,
  modeTextClass,
  modeLabel,
  statusLabel,
  runOutcomeBadge,
} from "~/lib/format";
import { ChestDrops } from "~/components/ChestDrops";
import { HeroPortrait } from "~/components/HeroPortrait";
import { resolveColumnConfig, reorderColumnConfig, toggleColumnConfig } from "~/lib/run-columns";
import { applyRunFilter, countQualityHidden } from "~/lib/run-filter";
import {
  EMPTY_FILTER,
  DEFAULT_SORT,
  isFilterActive,
  filterAndSortRuns,
  distinctStages,
  distinctModes,
  type RunListFilter,
  type RunSort,
  type SortKey,
} from "~/lib/run-list-filter";
import { useI18n } from "~/lib/i18n";
import { useDismissOnOutsideClick } from "~/lib/use-dismiss-on-outside-click";
import { cn } from "~/lib/utils";

interface RunListViewProps {
  onSelectRun: (id: string) => void;
  /** Persisted column config ([] = use defaults); resolved against the registry below. */
  runColumns: RunColumnConfig[];
  onRunColumnsChange: (columns: RunColumnConfig[]) => void;
  /** Display-filter prefs (PR6): hide non-counted runs + an optional minimum duration. */
  hideNonCounted: boolean;
  minDurationSec: number | null;
  /** Toggle the hide-non-counted preference (the "show ignored" affordance). */
  onToggleHideNonCounted: () => void;
  /** Clear the duration filter (minDurationSec -> null). The duration filter's own control lives in
   *  Settings; this is the empty-state escape when the duration gate alone is hiding every run. */
  onClearDurationFilter: () => void;
}

// Rows shown per page. Capped at 50 (largest option).
const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
const DEFAULT_PAGE_SIZE = 20;

// Column REGISTRY — the single source of truth for every runs-list column: its grid track,
// header label (a dict key — resolved per the app language at render), alignment, and cell
// renderer. The visible+ordered subset (from the user's saved config) drives the grid
// template, the header, and the rows alike, so the three can never drift. The metric block
// is right-aligned and rides equal flexible tracks so slack spreads evenly instead of
// pooling in the last column. Cells receive the i18n context (t + BCP47 lang) as an arg —
// they are plain functions, not components, so they can't call hooks themselves.
interface CellI18n {
  t: Translate;
  lang: string;
}
interface RunColumn {
  key: string;
  labelKey: DictKey;
  track: string; // a grid-template-columns track
  alignEnd?: boolean; // right-align (the metric block)
  /** When set, clicking this column's header sorts the list by this metric (Feature 4). */
  sortKey?: SortKey;
  cell: (run: RunIndexEntry, i18n: CellI18n, onToggleFavorite: (id: string) => void) => ReactNode;
}

const FLEX = "minmax(4.5rem,1fr)";
const COLUMNS: RunColumn[] = [
  {
    key: "favorite",
    labelKey: "runs.colFavorite",
    track: "1.75rem",
    cell: (r, { t }, onToggleFavorite) => (
      <button
        type="button"
        title={r.favorite ? t("runs.favoriteRemove") : t("runs.favoriteAdd")}
        aria-label={r.favorite ? t("runs.favoriteRemove") : t("runs.favoriteAdd")}
        onClick={(e) => {
          e.stopPropagation(); // don't open the detail view when toggling the star
          onToggleFavorite(r.id);
        }}
        className="flex cursor-pointer items-center justify-center text-zinc-600 transition-colors hover:text-amber-300"
      >
        <Star
          className={cn("size-3.5", r.favorite && "fill-amber-400 text-amber-400")}
        />
      </button>
    ),
  },
  {
    key: "stage",
    labelKey: "runs.colStage",
    track: "8.5rem",
    cell: (r, { t }) => {
      // A run revealed by "show ignored" looks identical to a clean run in the table, so flag it
      // with an outcome-specific icon next to the stage chip (the whole row is also tinted — see
      // RunRow). The icon + colour say WHY it didn't count (wipe / abandon / too short / partial /
      // bugged); the tooltip + detail-view banner carry the full reason. The compact icon keeps the
      // narrow column readable.
      const badge = runOutcomeBadge(r.status, r.quality, t);
      return (
        <span className="inline-flex min-w-0 items-center gap-1">
          {/* Stage + mode as one chip, like the web leaderboard's stage cell. */}
          <span className="inline-flex items-center gap-1.5 rounded border border-surface-600 bg-surface-700/60 px-1.5 py-0.5">
            <span className="font-semibold tabular-nums text-white">{r.stage}</span>
            <span
              className={cn("text-[10px] font-semibold uppercase tracking-wide", modeTextClass(r.mode))}
            >
              {modeLabel(r.mode, t)}
            </span>
          </span>
          {badge && (
            <span title={badge.title} className="inline-flex shrink-0">
              <badge.Icon
                aria-label={t("runs.flaggedRun", { label: badge.label })}
                className={cn("size-3", badge.iconClass)}
              />
            </span>
          )}
        </span>
      );
    },
  },
  {
    key: "clearTime",
    labelKey: "runs.colClearTime",
    track: "5.5rem",
    sortKey: "clearTime",
    cell: (r) => (
      <span className="font-mono tabular-nums text-zinc-300">{formatDuration(r.clearTime)}</span>
    ),
  },
  {
    key: "team",
    labelKey: "runs.colTeam",
    track: "6rem",
    cell: (r, { t }) => <Team party={r.party} t={t} />,
  },
  {
    key: "dps",
    labelKey: "runs.colDps",
    track: FLEX,
    alignEnd: true,
    sortKey: "dps",
    cell: (r) => <span className="font-semibold tabular-nums text-brand-300">{humanize(r.dps)}</span>,
  },
  {
    key: "totalDamage",
    labelKey: "runs.colTotalDamage",
    track: FLEX,
    alignEnd: true,
    sortKey: "totalDamage",
    cell: (r) => <span className="tabular-nums text-brand-300/60">{humanize(r.totalDamage)}</span>,
  },
  {
    key: "xpGained",
    labelKey: "runs.colExp",
    track: FLEX,
    alignEnd: true,
    sortKey: "xpGained",
    cell: (r) => <span className="tabular-nums text-emerald-400">{humanize(r.xpGained)}</span>,
  },
  {
    key: "xpPerSec",
    labelKey: "runs.colExpPerSec",
    track: FLEX,
    alignEnd: true,
    sortKey: "xpPerSec",
    cell: (r) => <span className="tabular-nums text-emerald-400/60">{humanize(r.xpPerSec)}</span>,
  },
  {
    key: "goldGained",
    labelKey: "runs.colGold",
    track: FLEX,
    alignEnd: true,
    sortKey: "goldGained",
    cell: (r) => <span className="tabular-nums text-amber-400">{humanize(r.goldGained)}</span>,
  },
  {
    key: "goldPerSec",
    labelKey: "runs.colGoldPerSec",
    track: FLEX,
    alignEnd: true,
    sortKey: "goldPerSec",
    cell: (r) => <span className="tabular-nums text-amber-400/60">{humanize(r.goldPerSec)}</span>,
  },
  {
    key: "drops",
    labelKey: "runs.colDrops",
    track: "minmax(5.5rem,1fr)",
    alignEnd: true,
    cell: (r) => <ChestDrops drops={r.drops ?? []} />,
  },
  {
    key: "date",
    labelKey: "runs.colDate",
    track: FLEX,
    alignEnd: true,
    sortKey: "date",
    cell: (r, { t, lang }) => (
      <span
        className="whitespace-nowrap tabular-nums text-zinc-400"
        title={formatDateTime(r.ts, lang)}
      >
        {ago(r.ts, t)}
      </span>
    ),
  },
];
const DEFAULT_KEYS = COLUMNS.map((c) => c.key);
const COLUMN_BY_KEY = new Map(COLUMNS.map((c) => [c.key, c]));

export function RunListView({
  onSelectRun,
  runColumns,
  onRunColumnsChange,
  hideNonCounted,
  minDurationSec,
  onToggleHideNonCounted,
  onClearDurationFilter,
}: RunListViewProps) {
  const { t, lang } = useI18n();
  // ALL runs (every quality + status): the table shows the user's filtered subset (PR6 display
  // filter), but the "new session" gate counts EVERY run in the reader's current session (a fail —
  // or a skipped/degraded run — still belongs to the session).
  const [allRuns, setAllRuns] = useState<RunIndexEntry[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  // Interactive filter + sort (Feature 4) — LOCAL UI state, not persisted (a transient lens).
  const [filter, setFilter] = useState<RunListFilter>(EMPTY_FILTER);
  const [sort, setSort] = useState<RunSort>(DEFAULT_SORT);

  const loadRuns = useCallback(async () => {
    // The current session id is authoritative from the reader's session.json (persists
    // across app restarts), so the markers work between runs and when the reader is idle —
    // not only while a live snapshot happens to be arriving. Refreshed after each new run.
    const [list, session] = await Promise.all([
      window.meter.listRuns(),
      window.meter.getCurrentSession(),
    ]);
    setAllRuns(list);
    setCurrentSessionId(session);
  }, []);

  useEffect(() => {
    loadRuns();
    const unsub = window.meter.onRunsChanged(() => loadRuns());
    return unsub;
  }, [loadRuns]);

  // Favorite toggle (Feature 3): fire-and-forget; the main process flips the sidecar and broadcasts
  // runs-changed, so loadRuns re-fetches with the new `favorite` flag (no optimistic local edit
  // needed — the round-trip is sub-frame and keeps the list the single source of truth).
  const toggleFavorite = useCallback((id: string) => {
    void window.meter.toggleFavorite(id);
  }, []);

  // The current session id comes from getCurrentSession() in loadRuns above — the DERIVED current
  // session (newest run's app-derived sessionId; Redesign 2), refreshed on every runs-changed reload.
  // (The old live-snapshot refresh is gone: the reader no longer emits a session in live.json.)

  // The DISPLAYED runs = the user's display filter (PR6, layer 3): hide non-counted (default) +
  // an optional minimum duration (x-10 exempt). The toggle below reveals the hidden runs — they
  // are marked + filterable, never deleted. Sorted newest-first.
  // First the layer-3 DISPLAY filter (settings prefs), then the layer-4 INTERACTIVE filter + sort
  // (the filter bar / sortable columns). Two layers compose: a user can hide non-counted runs in
  // settings AND filter to one stage sorted by gold in the bar.
  const displayed = useMemo(
    () => applyRunFilter(allRuns, { hideNonCounted, minDurationSec }),
    [allRuns, hideNonCounted, minDurationSec],
  );
  const runs = useMemo(
    () => filterAndSortRuns(displayed, filter, sort),
    [displayed, filter, sort],
  );
  // Stage / mode facets offered by the bar = only those present in the display-filtered set.
  const stageOptions = useMemo(() => distinctStages(displayed), [displayed]);
  const modeOptions = useMemo(() => distinctModes(displayed), [displayed]);
  const filterActive = isFilterActive(filter);
  // Session dividers only make sense in the default newest-first date view — once the user sorts by
  // a metric (or filters), the contiguous "current session at the top" assumption breaks, so hide them.
  const groupBySession = !filterActive && sort.key === "date" && sort.dir === "desc";

  // Header click → sort by that metric. First click on a new column = desc (biggest first, the
  // "where did I earn the most" view); clicking the active column flips the direction.
  const onSortColumn = useCallback((key: SortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "desc" ? "asc" : "desc" }
        : { key, dir: "desc" },
    );
    setPage(1);
  }, []);
  // How many runs the QUALITY gate is hiding — the count the "show ignored" toggle governs. It does
  // NOT include duration-hidden runs (those have their own control in Settings), so flipping the
  // toggle always reveals exactly this many (the affordance must match
  // the gate it controls, never promise N then reveal fewer).
  const qualityHidden = useMemo(
    () => countQualityHidden(allRuns, { hideNonCounted, minDurationSec }),
    [allRuns, hideNonCounted, minDurationSec],
  );
  // The empty state distinguishes the two gates: if the duration filter alone is emptying the list
  // (nothing is quality-hidden but runs exist), the escape is to CLEAR the duration filter — not the
  // hide-non-counted toggle, which would only add the quality gate on top and leave the list empty.
  const durationHidesAll =
    runs.length === 0 && qualityHidden === 0 && allRuns.length > 0 && minDurationSec != null;
  // "New session" button gate: any run (incl. fails) in the current session.
  const sessionHasRuns =
    currentSessionId != null && allRuns.some((r) => r.sessionId === currentSessionId);
  // Divider + "Session stats" target: the current session has a completed (shown) run.
  const currentHasRuns =
    currentSessionId != null && runs.some((r) => r.sessionId === currentSessionId);

  // Resolved config (forward-compatible) feeds the menu; the visible subset drives the table.
  const config = resolveColumnConfig(DEFAULT_KEYS, runColumns);
  const visibleCols = config
    .filter((c) => c.visible)
    .map((c) => COLUMN_BY_KEY.get(c.key))
    .filter((c): c is RunColumn => c != null);
  const gridTemplateColumns = visibleCols.map((c) => c.track).join(" ");

  const total = runs.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  // Clamp on read so a shrinking list (or a larger page size) never renders an
  // out-of-range page; the stale `page` state self-heals on the next click.
  const currentPage = Math.min(page, pageCount);
  const start = (currentPage - 1) * pageSize;
  const pageRuns = runs.slice(start, start + pageSize);

  const goToPage = (p: number) => setPage(Math.min(Math.max(1, p), pageCount));
  const changePageSize = (size: number) => {
    setPageSize(size);
    setPage(1);
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Top toolbar: filter bar + show-ignored toggle + column menu + new session + session stats. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-surface-600 bg-surface-800/95 px-3 py-1.5">
        <FilterBar
          filter={filter}
          onChange={(f) => {
            setFilter(f);
            setPage(1);
          }}
          stageOptions={stageOptions}
          modeOptions={modeOptions}
        />
        <div className="flex flex-1 items-center justify-end gap-2">
        <ShowIgnoredToggle
          hideNonCounted={hideNonCounted}
          hiddenCount={qualityHidden}
          onToggle={onToggleHideNonCounted}
        />
        <ColumnsMenu config={config} onChange={onRunColumnsChange} />
        {sessionHasRuns && <NewSessionButton />}
        <SessionStatsButton
          currentSessionId={currentSessionId}
          currentHasRuns={currentHasRuns}
          anyRuns={runs.length > 0}
        />
        </div>
      </div>

      {runs.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-zinc-500">
          <Inbox className="size-6 text-zinc-600" />
          {qualityHidden > 0 ? (
            // Runs exist but the QUALITY filter hides them — say so + offer to reveal, so the meter
            // never looks broken (skipped runs are filtered, not gone).
            // The toggle reveals exactly `qualityHidden` runs (the gate it controls).
            <>
              <p className="text-sm">{t("runs.emptyFiltered")}</p>
              <button
                type="button"
                onClick={onToggleHideNonCounted}
                className="cursor-pointer rounded bg-surface-700 px-2 py-1 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-600 hover:text-white"
              >
                {t(qualityHidden === 1 ? "runs.showIgnoredOne" : "runs.showIgnoredMany", {
                  count: qualityHidden,
                })}
              </button>
            </>
          ) : durationHidesAll ? (
            // The DURATION filter alone is emptying the list — the escape is to clear it (the toggle
            // would only add the quality gate and leave the list empty). The control itself is in
            // Settings; this is the direct way back to the runs.
            <>
              <p className="text-sm">{t("runs.emptyDuration")}</p>
              <button
                type="button"
                onClick={onClearDurationFilter}
                className="cursor-pointer rounded bg-surface-700 px-2 py-1 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-600 hover:text-white"
              >
                {t("runs.clearDurationFilter")}
              </button>
            </>
          ) : filterActive && displayed.length > 0 ? (
            // The INTERACTIVE filter bar emptied the list (runs exist, just not matching) — offer
            // to clear it (Feature 4). Distinct from the settings display gates above.
            <>
              <p className="text-sm">{t("runs.emptyFilterBar")}</p>
              <button
                type="button"
                onClick={() => {
                  setFilter(EMPTY_FILTER);
                  setPage(1);
                }}
                className="cursor-pointer rounded bg-surface-700 px-2 py-1 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-600 hover:text-white"
              >
                {t("runs.clearFilters")}
              </button>
            </>
          ) : (
            <p className="text-sm">{t("runs.emptyNone")}</p>
          )}
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto">
            {/* Column labels — SAME grid template as the rows, so they stay aligned. */}
            <div
              className="sticky top-0 z-10 grid items-center gap-x-2 border-b border-surface-600 bg-surface-800/95 px-3 py-2 text-[11px] font-medium text-zinc-500 backdrop-blur"
              style={{ gridTemplateColumns }}
            >
              {visibleCols.map((col) => {
                const sortable = col.sortKey !== undefined;
                const active = sortable && sort.key === col.sortKey;
                return (
                  <span key={col.key} className={cn(col.alignEnd && "justify-self-end")}>
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => onSortColumn(col.sortKey as SortKey)}
                        title={t("runs.sortBy")}
                        className={cn(
                          "flex cursor-pointer items-center gap-0.5 transition-colors hover:text-zinc-300",
                          active && "text-brand-300",
                          col.alignEnd && "flex-row-reverse",
                        )}
                      >
                        {t(col.labelKey)}
                        {active &&
                          (sort.dir === "desc" ? (
                            <ChevronDown className="size-3" />
                          ) : (
                            <ChevronUp className="size-3" />
                          ))}
                      </button>
                    ) : (
                      t(col.labelKey)
                    )}
                  </span>
                );
              })}
            </div>

            {pageRuns.map((run, i) => {
              // Mark where the live ("current") session starts vs older runs. Dividers
              // only appear once the current session has a shown run (else the list is
              // a flat history, as before). Runs are newest-first, so the current
              // session is a contiguous block at the top.
              const isCurrent = currentSessionId != null && run.sessionId === currentSessionId;
              const prevCurrent =
                i > 0
                  ? currentSessionId != null && pageRuns[i - 1].sessionId === currentSessionId
                  : null;
              // Session dividers only in the default date-desc view (groupBySession): a metric
              // sort or an active filter breaks the contiguous-session assumption.
              const showDivider =
                groupBySession && currentHasRuns && (i === 0 || isCurrent !== prevCurrent);
              return (
                <Fragment key={run.id}>
                  {showDivider && <SessionDivider current={isCurrent} />}
                  <RunRow
                    run={run}
                    cols={visibleCols}
                    i18n={{ t, lang }}
                    gridTemplateColumns={gridTemplateColumns}
                    zebra={i % 2 === 1}
                    onSelect={() => onSelectRun(run.id)}
                    onToggleFavorite={toggleFavorite}
                  />
                </Fragment>
              );
            })}
          </div>

          <PaginationBar
            page={currentPage}
            pageCount={pageCount}
            pageSize={pageSize}
            rangeStart={start + 1}
            rangeEnd={start + pageRuns.length}
            total={total}
            onPageChange={goToPage}
            onPageSizeChange={changePageSize}
          />
        </>
      )}
    </div>
  );
}

/** Row separating the live ("current") session from older runs: a full-width rule with the
 *  label centered inside it (line — label — line). */
function SessionDivider({ current }: { current: boolean }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider">
      <span className="h-px flex-1 bg-surface-600/40" />
      <span className={cn("shrink-0", current ? "text-brand-300" : "text-zinc-500")}>
        {current ? t("runs.currentSession") : t("runs.earlierRuns")}
      </span>
      <span className="h-px flex-1 bg-surface-600/40" />
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Session stats — opens the website's dashboard for the CURRENT (live) session. When the
// reader is offline it falls back to the most recent session (top of the list). When there
// is nothing to open yet (current session has no completed run, or no runs at all) it
// surfaces a small popover instead of a silent no-op. Auto-dismisses on outside click.
// --------------------------------------------------------------------------- //
function SessionStatsButton({
  currentSessionId,
  currentHasRuns,
  anyRuns,
}: {
  currentSessionId: string | null;
  currentHasRuns: boolean;
  anyRuns: boolean;
}) {
  const { t } = useI18n();
  const [showHint, setShowHint] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismissOnOutsideClick(ref, showHint, () => setShowHint(false));

  const onClick = (): void => {
    if (currentSessionId != null && currentHasRuns) {
      setShowHint(false);
      void window.meter.openSessionStats(currentSessionId); // the live session
    } else if (currentSessionId == null && anyRuns) {
      setShowHint(false);
      void window.meter.openSessionStats(); // reader offline -> newest session (top)
    } else {
      setShowHint((v) => !v); // nothing to open yet -> explain
    }
  };

  // currentSessionId set = reader live but the current session has no shown run yet;
  // otherwise there are no runs at all.
  const hintText =
    currentSessionId != null ? t("runs.hintNoRunsCurrent") : t("runs.hintNoRuns");

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title={t("runs.sessionStatsTitle")}
        onClick={onClick}
        className="flex cursor-pointer items-center gap-1.5 rounded bg-surface-700 px-2 py-1 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-600 hover:text-white"
      >
        <ChartColumn className="size-3.5" />
        {t("runs.sessionStats")}
      </button>
      {showHint && (
        <div className="absolute right-0 top-full z-20 mt-1 w-60 rounded-lg border border-surface-600 bg-surface-800 p-2.5 text-xs leading-relaxed text-zinc-300 shadow-xl">
          {hintText}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Show-ignored toggle (PR6) — flips the hide-non-counted display preference. When hiding, it shows
// how many runs the QUALITY gate is filtering out (skipped/degraded — partial clears stay shown;
// all marked + filterable, never deleted), so the count always matches what flipping the toggle
// reveals (the duration gate
// is separate, controlled in Settings). Persists via settings. Hidden entirely when nothing is
// quality-hidden AND the filter is already on (no count to reveal), but stays visible while
// showing-all so the user can re-hide.
// --------------------------------------------------------------------------- //
function ShowIgnoredToggle({
  hideNonCounted,
  hiddenCount,
  onToggle,
}: {
  hideNonCounted: boolean;
  hiddenCount: number;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  // Nothing to reveal and already filtering -> no affordance needed.
  if (hideNonCounted && hiddenCount === 0) return null;

  const showing = !hideNonCounted;
  return (
    <button
      type="button"
      title={showing ? t("runs.hideIgnoredTitle") : t("runs.showIgnoredTitle")}
      onClick={onToggle}
      className={cn(
        "flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors",
        showing
          ? "bg-surface-700 text-zinc-200 hover:bg-surface-600"
          : "text-zinc-400 hover:bg-surface-700 hover:text-zinc-200",
      )}
    >
      {showing ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      {showing ? t("runs.hideIgnoredBtn") : t("runs.showIgnoredBtn", { count: hiddenCount })}
    </button>
  );
}

// --------------------------------------------------------------------------- //
// "New session" (#220; app-side since Redesign 2) — records a manual cut in session-cuts.json,
// so the session derivation (deriveSessions) starts a fresh grind at the NEXT run closed after
// the cut. The reader is not involved (it no longer knows sessions). Shown only while the
// reader is live AND the current session has >=1 run. Two-step confirm: first click arms the
// button for a few seconds, second click cuts.
// --------------------------------------------------------------------------- //
function NewSessionButton() {
  const { t } = useI18n();
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(id);
  }, [armed]);

  const onClick = (): void => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    void window.meter.resetSession();
  };

  return (
    <button
      type="button"
      title={t("runs.newSessionTitle")}
      onClick={onClick}
      className={cn(
        "flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors",
        armed
          ? "bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
          : "text-zinc-400 hover:bg-surface-700 hover:text-zinc-200",
      )}
    >
      <RotateCcw className="size-3.5" />
      {armed ? t("runs.newSessionConfirm") : t("runs.newSession")}
    </button>
  );
}

// --------------------------------------------------------------------------- //
// Filter bar (Feature 4) — a popover of faceted filters (stage / mode / status / favorites-only).
// LOCAL UI state, not persisted (a transient lens). The button shows a dot + count when a filter is
// active; the popover offers a "clear filters" escape. Stage/mode options come from the runs present
// (distinctStages/distinctModes), so it only offers what the user actually ran.
// --------------------------------------------------------------------------- //
const STATUS_OPTIONS: RunStatus[] = ["success", "fail", "abandoned"];

function FilterBar({
  filter,
  onChange,
  stageOptions,
  modeOptions,
}: {
  filter: RunListFilter;
  onChange: (filter: RunListFilter) => void;
  stageOptions: string[];
  modeOptions: string[];
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = isFilterActive(filter);
  const activeCount =
    (filter.stage !== null ? 1 : 0) +
    (filter.mode !== null ? 1 : 0) +
    (filter.status !== null ? 1 : 0) +
    (filter.favoritesOnly ? 1 : 0);
  useDismissOnOutsideClick(ref, open, () => setOpen(false));

  const anyLabel = t("runs.filterAny");

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title={t("runs.filtersTitle")}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors",
          active || open
            ? "bg-surface-700 text-zinc-200 hover:bg-surface-600"
            : "text-zinc-400 hover:bg-surface-700 hover:text-zinc-200",
        )}
      >
        <Filter className="size-3.5" />
        {t("runs.filters")}
        {active && (
          <span className="rounded-full bg-brand-600 px-1.5 text-[10px] font-bold tabular-nums text-white">
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-56 rounded-lg border border-surface-600 bg-surface-800 p-2.5 shadow-xl">
          <div className="flex items-center justify-between pb-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              {t("runs.filters")}
            </span>
            {active && (
              <button
                type="button"
                onClick={() => onChange(EMPTY_FILTER)}
                className="flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-[11px] text-zinc-500 transition-colors hover:bg-surface-700 hover:text-zinc-300"
              >
                <X className="size-3" />
                {t("runs.clearFilters")}
              </button>
            )}
          </div>

          <FilterSelect
            label={t("runs.filterStage")}
            value={filter.stage}
            anyLabel={anyLabel}
            options={stageOptions.map((s) => ({ value: s, label: s }))}
            onChange={(v) => onChange({ ...filter, stage: v })}
          />
          <FilterSelect
            label={t("runs.filterMode")}
            value={filter.mode}
            anyLabel={anyLabel}
            options={modeOptions.map((m) => ({ value: m, label: modeLabel(m, t) }))}
            onChange={(v) => onChange({ ...filter, mode: v })}
          />
          <FilterSelect
            label={t("runs.filterStatus")}
            value={filter.status}
            anyLabel={anyLabel}
            options={STATUS_OPTIONS.map((s) => ({ value: s, label: statusLabel(s, t) }))}
            onChange={(v) => onChange({ ...filter, status: (v as RunStatus | null) ?? null })}
          />

          <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={filter.favoritesOnly}
              onChange={(e) => onChange({ ...filter, favoritesOnly: e.target.checked })}
              className="size-3.5 shrink-0 cursor-pointer accent-brand-500"
            />
            <Star className={cn("size-3.5", filter.favoritesOnly && "fill-amber-400 text-amber-400")} />
            {t("runs.filterFavorites")}
          </label>
        </div>
      )}
    </div>
  );
}

/** One labelled <select> in the filter popover; "" maps to null (Any). */
function FilterSelect({
  label,
  value,
  anyLabel,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  anyLabel: string;
  options: { value: string; label: string }[];
  onChange: (value: string | null) => void;
}) {
  return (
    <label className="mt-1.5 flex items-center justify-between gap-2 text-xs text-zinc-400">
      <span className="shrink-0">{label}</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        className="min-w-0 flex-1 cursor-pointer rounded bg-surface-700 px-1.5 py-0.5 text-xs text-zinc-200 outline-none transition-colors hover:bg-surface-600 focus:ring-1 focus:ring-brand-600"
      >
        <option value="">{anyLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// --------------------------------------------------------------------------- //
// Columns menu — toggle visibility, drag to reorder, reset to default. The full resolved
// config is passed in; every change saves the full ordered list (Reset saves [] -> default).
// --------------------------------------------------------------------------- //
function ColumnsMenu({
  config,
  onChange,
}: {
  config: RunColumnConfig[];
  onChange: (columns: RunColumnConfig[]) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useDismissOnOutsideClick(ref, open, () => setOpen(false));

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title={t("runs.columnsTitle")}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-zinc-400 transition-colors hover:bg-surface-700 hover:text-zinc-200",
          open && "bg-surface-700 text-zinc-200",
        )}
      >
        <SlidersHorizontal className="size-3.5" />
        {t("runs.columns")}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-52 rounded-lg border border-surface-600 bg-surface-800 p-1.5 shadow-xl">
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              {t("runs.columns")}
            </span>
            <button
              type="button"
              onClick={() => onChange([])}
              className="flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-[11px] text-zinc-500 transition-colors hover:bg-surface-700 hover:text-zinc-300"
            >
              <RotateCcw className="size-3" />
              {t("common.reset")}
            </button>
          </div>
          {config.map((c) => {
            const col = COLUMN_BY_KEY.get(c.key);
            if (!col) return null;
            return (
              <div
                key={c.key}
                draggable
                onDragStart={() => setDragKey(c.key)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragKey) onChange(reorderColumnConfig(config, dragKey, c.key));
                  setDragKey(null);
                }}
                onDragEnd={() => setDragKey(null)}
                className={cn(
                  "flex items-center gap-1.5 rounded px-1 py-1 transition-colors hover:bg-surface-700",
                  dragKey === c.key && "opacity-40",
                )}
              >
                <GripVertical className="size-3.5 shrink-0 cursor-grab text-zinc-600" />
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={c.visible}
                    onChange={() => onChange(toggleColumnConfig(config, c.key))}
                    className="size-3.5 shrink-0 cursor-pointer accent-brand-500"
                  />
                  <span className="truncate text-xs text-zinc-300">{t(col.labelKey)}</span>
                </label>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface PaginationBarProps {
  page: number;
  pageCount: number;
  pageSize: number;
  rangeStart: number;
  rangeEnd: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

function PaginationBar({
  page,
  pageCount,
  pageSize,
  rangeStart,
  rangeEnd,
  total,
  onPageChange,
  onPageSizeChange,
}: PaginationBarProps) {
  const { t } = useI18n();
  return (
    <div className="flex shrink-0 items-center justify-between border-t border-surface-600 bg-surface-800/95 px-3 py-1.5 text-xs text-zinc-400">
      <label className="flex items-center gap-1.5">
        <span>{t("runs.rows")}</span>
        <select
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          className="cursor-pointer rounded bg-surface-700 px-1.5 py-0.5 text-zinc-300 outline-none transition-colors hover:bg-surface-600 focus:ring-1 focus:ring-brand-600"
        >
          {PAGE_SIZE_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>

      <div className="flex items-center gap-2">
        <span className="tabular-nums">
          {t("runs.rangeOf", { start: rangeStart, end: rangeEnd, total })}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            aria-label={t("runs.prevPage")}
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            className="rounded p-1 text-zinc-400 transition-colors hover:bg-surface-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-zinc-400"
          >
            <ChevronLeft className="size-4" />
          </button>
          <span className="px-1 tabular-nums text-zinc-500">
            {page} / {pageCount}
          </span>
          <button
            aria-label={t("runs.nextPage")}
            onClick={() => onPageChange(page + 1)}
            disabled={page >= pageCount}
            className="rounded p-1 text-zinc-400 transition-colors hover:bg-surface-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-zinc-400"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

interface RunRowProps {
  run: RunIndexEntry;
  cols: RunColumn[];
  i18n: CellI18n;
  gridTemplateColumns: string;
  zebra: boolean;
  onSelect: () => void;
  onToggleFavorite: (id: string) => void;
}

function RunRow({ run, cols, i18n, gridTemplateColumns, zebra, onSelect, onToggleFavorite }: RunRowProps) {
  // Tint the whole row when the run did not count, in the outcome's colour family (red = wipe, slate
  // = abandon, zinc = too short, amber = partial, rose = bugged). This is the at-a-glance "this is
  // not a real run" signal; rowClass wins the bg conflict over zebra via tailwind-merge (last class),
  // so an ignored run never reads as a normal striped row.
  const rowClass = runOutcomeBadge(run.status, run.quality)?.rowClass;
  return (
    <div
      onClick={onSelect}
      style={{ gridTemplateColumns }}
      className={cn(
        "grid cursor-pointer items-center gap-x-2 border-b border-surface-600/40 px-3 py-1.5 text-xs transition-colors hover:bg-surface-700/60",
        zebra && "bg-surface-800/25",
        rowClass,
      )}
    >
      {cols.map((col) => (
        <div key={col.key} className={cn("min-w-0", col.alignEnd && "justify-self-end")}>
          {col.cell(run, i18n, onToggleFavorite)}
        </div>
      ))}
    </div>
  );
}

function Team({ party, t }: { party: RunIndexEntry["party"]; t: Translate }) {
  if (party.length === 0) return <span className="text-zinc-600">—</span>;
  return (
    <div className="flex items-center gap-1">
      {party.map((h, i) => (
        <span
          key={i}
          title={t("runs.teamTooltip", { class: h.class, level: h.level })}
          className="contents"
        >
          <HeroPortrait heroKey={h.heroKey} heroClass={h.class} />
        </span>
      ))}
    </div>
  );
}
