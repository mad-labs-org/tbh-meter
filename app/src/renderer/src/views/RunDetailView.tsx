import { useState, useEffect } from "react";
import {
  ArrowLeft,
  ArrowUp,
  Clock,
  Coins,
  Skull,
  HeartCrack,
  Sparkles,
  Swords,
  Crosshair,
  Star,
} from "lucide-react";
import type { RunRecord, RunStatus, RunQuality, RunHero } from "../../../shared/run-types.js";
import type { Translate } from "../../../shared/i18n/index.js";
import {
  humanize,
  formatDuration,
  statusLabel,
  formatDateTime,
  modeBadgeClass,
  modeLabel,
  runOutcomeBadge,
} from "~/lib/format";
import { heroName } from "~/lib/game-data";
import { useI18n } from "~/lib/i18n";
import { cn } from "~/lib/utils";
import { ChestDrops } from "~/components/ChestDrops";
import { HeroPortrait } from "~/components/HeroPortrait";

interface RunDetailViewProps {
  runId: string;
  onBack: () => void;
}

// Status pill (bg + text + ring) per run status.
const STATUS_CHIP: Record<RunStatus, string> = {
  success: "bg-emerald-500/10 text-emerald-400 ring-emerald-500/30",
  fail: "bg-red-500/10 text-red-400 ring-red-500/30",
  abandoned: "bg-zinc-500/10 text-zinc-400 ring-zinc-500/30",
};

export function RunDetailView({ runId, onBack }: RunDetailViewProps) {
  const { t, lang } = useI18n();
  const [run, setRun] = useState<RunRecord | null | "loading" | "error">("loading");
  const favorite = useFavorite(runId);

  useEffect(() => {
    setRun("loading");
    window.meter
      .getRun(runId)
      .then((r) => setRun(r ?? "error"))
      .catch(() => setRun("error"));
  }, [runId]);

  if (run === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
        {t("detail.loading")}
      </div>
    );
  }

  if (run === "error" || run === null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4">
        <p className="text-sm text-red-400">{t("detail.notFound")}</p>
        <button
          onClick={onBack}
          className="cursor-pointer text-xs text-brand-400 hover:text-brand-300"
        >
          {t("detail.backToList")}
        </button>
      </div>
    );
  }

  const measured = run.duration;
  const official = run.clearTime;
  const hasBothTimes = measured > 0 && official > 0;
  const timesDiverge =
    hasBothTimes && Math.abs(measured - official) / Math.max(measured, official) > 0.2;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="border-b border-surface-600 bg-surface-800/80 px-4 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={onBack}
            className="flex cursor-pointer items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <ArrowLeft className="size-3" />
            {t("detail.back")}
          </button>
          <button
            type="button"
            onClick={favorite.toggle}
            title={favorite.on ? t("runs.favoriteRemove") : t("runs.favoriteAdd")}
            aria-label={favorite.on ? t("runs.favoriteRemove") : t("runs.favoriteAdd")}
            className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-zinc-400 transition-colors hover:bg-surface-700 hover:text-amber-300"
          >
            <Star className={cn("size-3.5", favorite.on && "fill-amber-400 text-amber-400")} />
            {t("runs.favorite")}
          </button>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <div className="flex min-w-0 items-center gap-2.5">
            <h1 className="truncate text-base font-bold text-white">{run.stage}</h1>
            <span
              className={cn(
                "shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium",
                modeBadgeClass(run.mode),
              )}
            >
              {modeLabel(run.mode, t)}
            </span>
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1",
                STATUS_CHIP[run.status] ?? STATUS_CHIP.abandoned,
              )}
            >
              {statusLabel(run.status, t)}
            </span>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-zinc-500">
            <span className="flex items-center gap-1 font-mono text-zinc-300">
              <Clock className="size-3 text-zinc-500" />
              {official > 0 ? formatDuration(official) : formatDuration(measured)}
            </span>
            {hasBothTimes && official !== measured && (
              <span className="font-mono text-zinc-600" title={t("detail.measuredTitle")}>
                {t("detail.measuredParen", { duration: formatDuration(measured) })}
              </span>
            )}
            <span>{formatDateTime(run.ts, lang)}</span>
            {run.gameVersion && <span className="text-zinc-600">v{run.gameVersion}</span>}
          </div>
        </div>

        {timesDiverge && (
          <p className="mt-0.5 text-xs text-amber-500/70">{t("detail.measuredNe")}</p>
        )}
      </div>

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {/* Outcome notice — explains why a run did not count (wipe / abandon / too short / partial /
            bugged), with the per-field read failures (issues) when present. */}
        <QualityNotice status={run.status} quality={run.quality} issues={run.issues} />

        {/* Run metrics */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard
            icon={<Swords className="size-4 text-brand-400" />}
            iconBg="bg-brand-600/15"
            label={t("runs.colDps")}
            value={humanize(run.dps)}
          />
          <StatCard
            icon={<Crosshair className="size-4 text-zinc-400" />}
            iconBg="bg-surface-700"
            label={t("detail.damage")}
            value={humanize(run.totalDamage)}
          />
          <StatCard
            icon={<Coins className="size-4 text-amber-400" />}
            iconBg="bg-amber-500/10"
            label={t("runs.colGold")}
            value={humanize(run.goldGained)}
            sub={`${humanize(run.goldPerSec)}/s`}
          />
          <StatCard
            icon={<Sparkles className="size-4 text-emerald-400" />}
            iconBg="bg-emerald-500/10"
            label={t("detail.xp")}
            value={humanize(run.xpGained)}
            sub={`${humanize(run.xpPerSec)}/s`}
          />
          <StatCard
            icon={<Skull className="size-4 text-red-400" />}
            iconBg="bg-red-500/10"
            label={t("detail.mobs")}
            value={run.totalMobs != null ? `${run.mobs}/${run.totalMobs}` : String(run.mobs)}
          />
          {/* Deaths/revives from HeroDie/Resurrection logs (v11+). Absent on older runs → card hidden. */}
          {run.deaths != null && (
            <StatCard
              icon={<HeartCrack className="size-4 text-rose-400" />}
              iconBg="bg-rose-500/10"
              label={t("detail.deaths")}
              value={String(run.deaths)}
              sub={run.revives ? t("detail.revived", { count: run.revives }) : undefined}
            />
          )}
        </div>

        {/* Per-hero XP breakdown (v11+: live exp deltas per hero). A dead/revived hero keeps its
            partial share rather than reading zero (PR #369) — this panel makes that visible.
            Hidden on older runs that carry no per-hero xpGained. */}
        <XpByHero heroes={run.heroes} />

        {/* Drops — chests that dropped this run, by type (v10+). Hidden on older runs. */}
        {run.drops && run.drops.length > 0 && (
          <div className="mt-3 rounded-lg border border-surface-600 bg-surface-800/60 px-3 py-2.5">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                {t("detail.drops")}
              </p>
              <span className="text-[11px] tabular-nums text-zinc-500">
                {t(run.drops.length === 1 ? "detail.chestsOne" : "detail.chestsMany", {
                  count: run.drops.length,
                })}
              </span>
            </div>
            <ChestDrops drops={run.drops} size="md" />
          </div>
        )}
      </div>
    </div>
  );
}

/** Per-hero XP breakdown. Renders only when at least one hero carries a numeric `xpGained` (v11+);
 *  older runs without it show nothing. Each hero's share is its xp over the SUM of the panel's
 *  numeric xp values — NOT `run.xpGained`, which can be save-sourced and diverge from the live
 *  per-hero deltas. A hero in a mixed record with no `xpGained` renders "—" and no bar; a hero with
 *  `xpGained === 0` (e.g. it died early) renders "0" with an empty bar — a valid value, never hidden. */
function XpByHero({ heroes }: { heroes: RunHero[] }) {
  const { t } = useI18n();

  const withXp = heroes.filter((h) => typeof h.xpGained === "number");
  if (withXp.length === 0) return null;

  // Bar base = the sum of the panel's own numeric xp values (each hero's slice of THIS total).
  const total = withXp.reduce((acc, h) => acc + (h.xpGained ?? 0), 0);

  // Highest contributor first; heroes with no xpGained (mixed record) trail in their original order.
  const rows = [...heroes].sort((a, b) => {
    const ax = typeof a.xpGained === "number";
    const bx = typeof b.xpGained === "number";
    if (ax && bx) return (b.xpGained ?? 0) - (a.xpGained ?? 0);
    return ax === bx ? 0 : ax ? -1 : 1;
  });

  return (
    <div className="mt-3 rounded-lg border border-surface-600 bg-surface-800/60 px-3 py-2.5">
      <div className="mb-2 flex items-center gap-1.5">
        <Sparkles className="size-3.5 text-emerald-400" />
        <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          {t("detail.xpByHero")}
        </p>
      </div>
      <div className="space-y-1.5">
        {rows.map((h, i) => (
          <XpHeroRow key={`${h.heroKey}-${i}`} hero={h} total={total} t={t} />
        ))}
      </div>
    </div>
  );
}

/** One hero's row in the XP breakdown: portrait · name + level + badges · xp value + share · bar. */
function XpHeroRow({ hero, total, t }: { hero: RunHero; total: number; t: Translate }) {
  const hasXp = typeof hero.xpGained === "number";
  const xp = hero.xpGained ?? 0;
  const share = hasXp && total > 0 ? xp / total : 0;
  const pct = share * 100;
  const shareLabel = !hasXp ? "" : xp === 0 ? "0%" : pct < 1 ? "<1%" : `${Math.round(pct)}%`;
  const deaths = hero.deaths ?? 0;

  return (
    <div className="flex items-center gap-2.5">
      {/* Portrait — same sprite source as the runs list / live party, with a 2-char class fallback. */}
      <HeroPortrait heroKey={hero.heroKey} heroClass={hero.class} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-xs font-medium text-zinc-200">
              {heroName(hero.heroKey)}
            </span>
            <span className="shrink-0 text-[10px] tabular-nums text-zinc-500">
              {t("detail.heroLv", { level: hero.level })}
            </span>
            {hero.levelup && (
              <span
                title={t("detail.levelUp")}
                className="flex shrink-0 items-center text-emerald-400"
              >
                <ArrowUp className="size-3" />
              </span>
            )}
            {deaths > 0 && (
              <span
                title={t("detail.heroDeaths", { count: deaths })}
                className="flex shrink-0 items-center gap-0.5 text-[10px] tabular-nums text-rose-400"
              >
                <HeartCrack className="size-3" />
                {deaths}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-baseline gap-1.5">
            <span className="text-xs font-bold tabular-nums text-white">
              {hasXp ? humanize(xp) : "—"}
            </span>
            {shareLabel && (
              <span className="text-[10px] tabular-nums text-zinc-500">{shareLabel}</span>
            )}
          </div>
        </div>
        {/* Thin emerald share bar — only for a numeric value (a missing xpGained has no bar). An
            xpGained of 0 keeps the track but leaves it empty. */}
        {hasXp && (
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-700">
            <div
              className="h-full rounded-full bg-emerald-400/70"
              style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** Banner shown for any run that did not count, labelled by its specific outcome (wipe / abandon /
 *  too short / partial / bugged) so the reason is explicit — not just "invalid". For a degraded
 *  (bugged) run, `issues` carries the per-field read failures (field → reason), surfaced so the user
 *  can see exactly what was lost. Cosmetic only — it never gates the display. */
function QualityNotice({
  status,
  quality,
  issues,
}: {
  status: RunStatus;
  quality: RunQuality | undefined;
  issues?: Record<string, string>;
}) {
  const { t } = useI18n();
  const badge = runOutcomeBadge(status, quality, t);
  if (!badge) return null;
  const entries = issues ? Object.entries(issues) : [];
  return (
    <div className={cn("mb-3 rounded-lg border px-3 py-2.5", badge.noticeClass)}>
      <div className="flex items-center gap-2">
        <badge.Icon className={cn("size-4 shrink-0", badge.iconClass)} />
        <span className="text-xs font-semibold">{badge.label}</span>
      </div>
      <p className="mt-1 text-xs leading-relaxed opacity-90">{badge.title}</p>
      {entries.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[11px] opacity-80">
          {entries.map(([field, reason]) => (
            <li key={field}>
              <span className="font-mono">{field}</span>: {reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Favorite state for the detail view (Feature 3). The favorite flag is a main-owned sidecar, not a
 *  field on the RunRecord, so seed it from the runs index (listRuns carries `favorite`) on mount and
 *  keep it in sync with the runs-changed broadcast. Toggling round-trips through main, which returns
 *  the new state — applied optimistically. */
function useFavorite(runId: string): { on: boolean; toggle: () => void } {
  const [on, setOn] = useState(false);

  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void window.meter.listRuns().then((list) => {
        if (alive) setOn(list.find((r) => r.id === runId)?.favorite === true);
      });
    };
    refresh();
    const off = window.meter.onRunsChanged(refresh);
    return () => {
      alive = false;
      off();
    };
  }, [runId]);

  const toggle = (): void => {
    void window.meter.toggleFavorite(runId).then(setOn);
  };
  return { on, toggle };
}

interface StatCardProps {
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  value: string;
  sub?: string;
}

function StatCard({ icon, iconBg, label, value, sub }: StatCardProps) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-surface-600 bg-surface-800/60 px-3 py-2">
      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-md", iconBg)}>
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{label}</p>
        <p className="truncate text-sm font-bold tabular-nums text-white">
          {value}
          {sub && <span className="ml-1 text-[11px] font-normal text-zinc-500">{sub}</span>}
        </p>
      </div>
    </div>
  );
}

