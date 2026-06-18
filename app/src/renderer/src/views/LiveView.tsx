import { useState, useEffect, useMemo, useRef } from "react";
import { Swords, ScrollText, ChartColumn, Minus, Plus, X, ShieldAlert, Pin, PinOff } from "lucide-react";
import type { LiveSnapshot } from "../../../shared/run-types.js";
import type { ReaderState } from "../../../shared/ipc-types.js";
import { humanize, formatDuration, modeBadgeClass, modeTextClass, modeLabel } from "~/lib/format";
import { heroSprite } from "~/lib/game-data";
import { stageThreat, hasThreat } from "~/lib/stage-threat";
import { StageThreatBadges } from "~/components/StageThreat";
import { HeroFrame } from "~/components/HeroFrame";
import { useT } from "~/lib/i18n";
import { cn } from "~/lib/utils";

// The realtime meter content. Two layouts off ONE data source (SSOT = the live
// snapshot): a full HUD "card" and a lean 2-line "strip". The chosen layout persists
// in settings (liveExpanded) so it survives restarts. Window chrome (drag/resize/height)
// lives in LiveApp; this component only renders content + wires the passed handlers.
// Base font sizes sit one notch above the rest of the app (#232): the overlay floats
// over the game, so its tiny labels earn an extra pixel by default; the font-size
// setting (zoom) scales on top of this.

interface LiveViewProps {
  /** Start a window drag from a title-bar / header pointerdown (JS-driven, pointer-captured; see LiveApp). */
  onStartDrag: (e: React.PointerEvent) => void;
  /** Open the runs/logs window. */
  onOpenLogs: () => void;
}

export function LiveView({ onStartDrag, onOpenLogs }: LiveViewProps) {
  const t = useT();
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [status, setStatus] = useState<ReaderState>("idle");
  const [expanded, setExpanded] = useState(true);
  const [pinned, setPinned] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  // Smooth elapsed clock: anchored to each snapshot's elapsedSec + wall time, advanced by a
  // local interval. Decouples the displayed seconds from the file-poll/reader-write cadence,
  // which otherwise alias (poll 700ms vs write ~1s) and make the second tick unevenly.
  const [displaySec, setDisplaySec] = useState(0);
  const elapsedAnchor = useRef<{ sec: number; atMs: number } | null>(null);
  // Stage threat (badges + floating tooltip) — derived once per stage change.
  const threat = useMemo(() => stageThreat(snap?.stageKey), [snap?.stageKey]);
  const showThreat = hasThreat(threat);

  // Real live data from the reader (live.json, cooked by the main process) — the only source.
  useEffect(() => window.meter.onLive(setSnap), []);

  // Layout mode + always-on-top are persisted in settings (SSOT): read once,
  // then stay in sync.
  useEffect(() => {
    void window.meter.getSettings().then((s) => {
      setExpanded(s.liveExpanded);
      setPinned(s.alwaysOnTop);
    });
    return window.meter.onSettingsChanged((s) => {
      setExpanded(s.liveExpanded);
      setPinned(s.alwaysOnTop);
    });
  }, []);

  // Auth = whether runs sync to the leaderboard. Drives the Live/Offline status pill.
  useEffect(() => {
    void window.meter.authGetStatus().then((s) => setSignedIn(s.signedIn));
    return window.meter.onAuthChanged((s) => setSignedIn(s.signedIn));
  }, []);

  // While there's no live data, poll the reader status. First launch resolves the
  // game's memory (1-2 min, up to 5 on a cold scan) before any data — show "starting
  // up". "blocked" means the reader keeps being killed (almost always antivirus).
  useEffect(() => {
    if (snap) return;
    let active = true;
    const check = (): void => {
      window.meter.readerStatus().then((s) => {
        if (active) setStatus(s);
      });
    };
    check();
    const id = setInterval(check, 2500);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [snap]);

  // Re-anchor ONLY when needed: no anchor yet, or the reader's clock genuinely diverged —
  // a new run (elapsedSec resets to ~0) or real drift (>=2s, tolerating the normal ±1 floor
  // jitter). Re-anchoring on EVERY snapshot was the bug: it reset the anchor to the jittery
  // poll-arrival time (700ms poll vs ~1s reader write), so the increment boundary kept
  // shifting and the second ticked unevenly.
  useEffect(() => {
    if (!snap) {
      elapsedAnchor.current = null;
      setDisplaySec(0);
      return;
    }
    const a = elapsedAnchor.current;
    const localSec = a ? a.sec + Math.floor((Date.now() - a.atMs) / 1000) : null;
    if (localSec === null || Math.abs(snap.elapsedSec - localSec) >= 2) {
      elapsedAnchor.current = { sec: snap.elapsedSec, atMs: Date.now() };
      setDisplaySec(snap.elapsedSec);
    }
  }, [snap]);

  // The free-running ticker: advances displaySec from the stable anchor at a steady ~4Hz,
  // mounted ONCE so a snapshot never restarts it. Null anchor (offline) = idle.
  useEffect(() => {
    const id = setInterval(() => {
      const a = elapsedAnchor.current;
      if (a) setDisplaySec(a.sec + Math.floor((Date.now() - a.atMs) / 1000));
    }, 250);
    return () => clearInterval(id);
  }, []);

  const toggle = (): void => {
    const next = !expanded;
    setExpanded(next);
    void window.meter.setSettings({ liveExpanded: next });
  };

  const togglePin = (): void => {
    const next = !pinned;
    setPinned(next);
    void window.meter.setSettings({ alwaysOnTop: next });
  };

  if (!snap) {
    // The reader keeps getting killed — tell the truth (it's almost always AV) and
    // offer a one-click retry instead of an endless, lying "Starting up".
    if (status === "blocked") {
      return (
        <div className="flex h-full w-full items-center justify-center gap-2 px-3 text-center text-xs text-zinc-400">
          <ShieldAlert className="size-3 shrink-0 text-amber-400" />
          <span className="truncate">{t("live.blockedMsg")}</span>
          <button
            type="button"
            onClick={() => window.meter.retryReader()}
            className="shrink-0 rounded bg-surface-600/60 px-1.5 py-0.5 font-medium text-zinc-200 hover:bg-surface-600"
          >
            {t("live.retry")}
          </button>
        </div>
      );
    }
    return (
      <div>
        <TitleBar
          onStartDrag={onStartDrag}
          onOpenLogs={onOpenLogs}
          expanded={expanded}
          onToggle={toggle}
          pinned={pinned}
          onTogglePin={togglePin}
        >
          <span className="flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">
            <span className="size-1.5 rounded-full bg-zinc-600" />
            {status === "starting" ? t("live.pillStarting") : t("live.pillOffline")}
          </span>
        </TitleBar>
        <div className="flex items-center justify-center gap-2 px-3 py-2 text-center text-xs text-zinc-500">
          <Swords className="size-3.5 shrink-0 text-zinc-600" />
          <span className="truncate">
            {status === "starting" ? t("live.startingMsg") : t("live.offlineMsg")}
          </span>
        </div>
      </div>
    );
  }

  const mobsLabel = snap.totalMobs != null ? `${snap.mobs}/${snap.totalMobs}` : String(snap.mobs);

  // ── Lean 2-line strip ──────────────────────────────────────────────────────
  if (!expanded) {
    return (
      <div className="flex flex-col gap-1 px-2 py-1.5">
        <div className="flex items-center gap-2">
          <WinControls expanded={expanded} onToggle={toggle} />
          <span
            onPointerDown={onStartDrag}
            className="flex min-w-0 flex-1 cursor-move select-none items-center gap-1.5"
          >
            <span
              title={syncTitle(signedIn, t)}
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                signedIn ? "live-pulse bg-brand-400" : "bg-amber-400",
              )}
            />
            <span className="truncate font-mono text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
              {snap.stage}
            </span>
            <span
              className={cn(
                "shrink-0 font-mono text-[10px] font-bold uppercase tracking-wider",
                modeTextClass(snap.mode),
              )}
            >
              {modeLabel(snap.mode, t)}
            </span>
            {showThreat && <StageThreatBadges info={threat} />}
          </span>
          <span className="shrink-0 font-mono text-base font-bold tabular-nums text-brand-300">
            {humanize(snap.dps)}
            {snap.approx && <span className="ml-0.5 align-top text-[10px] text-zinc-500">~</span>}
          </span>
          <PinButton pinned={pinned} onTogglePin={togglePin} />
          <IconButton
            title={t("live.sessionStats")}
            onClick={() => void window.meter.openSessionStats()}
          >
            <ChartColumn className="size-3.5" />
          </IconButton>
          <IconButton title={t("live.openLogs")} onClick={onOpenLogs}>
            <ScrollText className="size-3.5" />
          </IconButton>
        </div>
        <div className="flex items-center gap-2">
          <Bar value={snap.mobs} total={snap.totalMobs} className="flex-1" />
          <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums">
            <span className="text-zinc-400">{mobsLabel}</span>
            <Sep />
            <span className="text-zinc-300">{humanize(snap.damage)}</span>
            {snap.goldGain != null && (
              <>
                <Sep />
                <span className="text-amber-400">+{ratePerSec(snap.goldGain, snap.elapsedSec)}/s</span>
              </>
            )}
            {snap.xpGain != null && (
              <>
                <Sep />
                <span className="text-emerald-400">+{ratePerSec(snap.xpGain, snap.elapsedSec)}/s</span>
              </>
            )}
            <Sep />
            <span className="text-zinc-400">{formatDuration(displaySec)}</span>
          </span>
        </div>
      </div>
    );
  }

  // ── Full HUD card ──────────────────────────────────────────────────────────
  return (
    <div>
      <TitleBar
        onStartDrag={onStartDrag}
        onOpenLogs={onOpenLogs}
        expanded={expanded}
        onToggle={toggle}
        pinned={pinned}
        onTogglePin={togglePin}
        run={snap.runNumber}
        stage={snap.stage}
        mode={snap.mode}
        stageExtra={showThreat ? <StageThreatBadges info={threat} /> : undefined}
      >
        <span
          title={syncTitle(signedIn, t)}
          className={cn(
            "flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-[0.14em]",
            signedIn ? "text-brand-300" : "text-amber-300",
          )}
        >
          <span
            className={cn(
              "inline-block size-1.5 rounded-full",
              signedIn ? "live-pulse bg-brand-400" : "bg-amber-400",
            )}
          />
          {signedIn ? t("live.statusLive") : t("live.statusOffline")}
        </span>
      </TitleBar>

      <div className="px-3 pb-2 pt-2.5">
        <div className="flex items-end justify-between">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
            {t("live.dps")}
          </span>
          <span className="text-2xl font-bold leading-none tabular-nums text-brand-300">
            {humanize(snap.dps)}
            {snap.approx && <span className="ml-0.5 align-top text-[11px] text-zinc-500">~</span>}
          </span>
        </div>

        <Bar value={snap.mobs} total={snap.totalMobs} className="mt-2" />
        <div className="mt-1 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-zinc-500">
          <span className="text-white">
            {t("live.mobs")} {mobsLabel}
          </span>
          <span className="tabular-nums text-white">{humanize(snap.damage)}</span>
        </div>

        <div className="mt-2 flex gap-1.5 font-mono text-[11px] font-semibold">
          <StatBox
            label={t("live.gold")}
            value={fmtRateTotal(snap.goldGain, snap.elapsedSec)}
            tone="text-amber-400"
            className="flex-1"
          />
          <StatBox
            label={t("live.exp")}
            value={fmtRateTotal(snap.xpGain, snap.elapsedSec)}
            tone="text-emerald-400"
            className="flex-1"
          />
          <LootBox drops={snap.drops} />
        </div>
      </div>

      {/* Footer (last line): the live party frame + elapsed time — mirrors the mock. */}
      <div className="flex items-center justify-between border-t border-surface-600 bg-surface-800/90 px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
        <span className="flex items-center gap-1.5">
          {t("live.team")}
          <PartyFrame party={snap.party} partyStats={snap.partyStats} mode={snap.mode} />
        </span>
        <span className="flex items-center gap-1.5">
          {t("live.time")}{" "}
          <span className="tabular-nums normal-case text-zinc-300">{formatDuration(displaySec)}</span>
        </span>
      </div>
    </div>
  );
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

/** Tooltip for the sync status dot: attributed (signed in) / local-only (signed out). */
function syncTitle(signedIn: boolean, t: ReturnType<typeof useT>): string {
  return signedIn ? t("live.syncLive") : t("live.syncOff");
}

/** Title bar: drag region (mac-traffic-light dots + "TBH Meter" + run #) plus a
 *  right-aligned slot for the live/offline indicator and controls. */
function TitleBar({
  onStartDrag,
  onOpenLogs,
  expanded,
  onToggle,
  pinned,
  onTogglePin,
  run,
  stage,
  mode,
  stageExtra,
  children,
}: {
  onStartDrag: (e: React.PointerEvent) => void;
  onOpenLogs: () => void;
  expanded: boolean;
  onToggle: () => void;
  pinned: boolean;
  onTogglePin: () => void;
  run?: number | null;
  stage?: string;
  mode?: string;
  /** Slot after the mode badge — the stage-threat element badges. */
  stageExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <div
      onPointerDown={onStartDrag}
      className="flex cursor-move select-none items-center gap-2 border-b border-surface-600 bg-surface-800/90 px-2.5 py-1.5"
    >
      <WinControls expanded={expanded} onToggle={onToggle} />
      {stage != null ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
            {stage}
          </span>
          {mode != null && (
            <span
              className={cn(
                "shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider",
                modeBadgeClass(mode),
              )}
            >
              {modeLabel(mode, t)}
            </span>
          )}
          {stageExtra}
        </span>
      ) : (
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-400">
          TBH Meter
        </span>
      )}
      {run != null && (
        <span className="shrink-0 font-mono text-[10px] font-semibold tracking-wider text-zinc-600">
          #{run}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {children}
        <PinButton pinned={pinned} onTogglePin={onTogglePin} />
        <IconButton
          title={t("live.sessionStats")}
          onClick={() => void window.meter.openSessionStats()}
        >
          <ChartColumn className="size-3.5" />
        </IconButton>
        <IconButton title={t("live.openLogs")} onClick={onOpenLogs}>
          <ScrollText className="size-3.5" />
        </IconButton>
      </span>
    </div>
  );
}

/** Mob-progress bar (mobs / totalMobs). Empty track when the total is unknown. */
function Bar({
  value,
  total,
  className,
}: {
  value: number;
  total: number | null;
  className?: string;
}) {
  const pct = total != null && total > 0 ? Math.min(100, (value / total) * 100) : null;
  return (
    <div className={cn("h-1 overflow-hidden rounded-full bg-surface-600", className)}>
      {pct != null && (
        <span
          className="block h-full rounded-full bg-gradient-to-r from-brand-600 to-brand-400 transition-[width] duration-700 ease-out"
          style={{ width: `${pct}%` }}
        />
      )}
    </div>
  );
}

/** Card stat: "39/s (14.5K)" — per-second rate (running total ÷ elapsed) with the total in
 *  parens. "—" when the reader isn't emitting the value yet. */
function fmtRateTotal(total: number | null, elapsedSec: number): string {
  if (total == null) return "—";
  return `${humanize(total / Math.max(1, elapsedSec))}/s (${humanize(total)})`;
}

/** Strip stat: just the per-second rate, e.g. "39" (caller appends "/s"). */
function ratePerSec(total: number, elapsedSec: number): string {
  return humanize(total / Math.max(1, elapsedSec));
}

/** Muted dot separator for the strip's inline stats. */
function Sep() {
  return <span className="text-surface-500">·</span>;
}

// Chest types by EMonsterLogType index — color is the signal: common = white,
// stage boss = blue, act boss = red. Labels resolve through the dict (tooltips).
const CHEST_TYPES = [
  { idx: 0, tone: "text-zinc-100", labelKey: "live.chestCommon" },
  { idx: 1, tone: "text-sky-400", labelKey: "live.chestStageBoss" },
  { idx: 2, tone: "text-rose-400", labelKey: "live.chestActBoss" },
] as const;

/** Loot row (expanded card, after EXP): chest-drop counts by type — "N×" + a
 *  color-coded chest. ALWAYS rendered (stable layout, no toggle jump): shows a muted
 *  "no loot" until something drops. `drops` is null until the reader emits counts. */
function LootBox({ drops }: { drops: number[] | null }) {
  const t = useT();
  const counts = drops ?? [];
  const hasLoot = counts.some((c) => c > 0);
  return (
    <div className="flex shrink-0 items-center gap-2 rounded bg-surface-800/80 px-2 py-1 ring-1 ring-surface-600/60">
      <span className="tracking-[0.12em] text-zinc-500 uppercase">{t("live.loot")}</span>
      {hasLoot ? (
        <span className="flex items-center gap-1">
          {CHEST_TYPES.map(({ idx, tone, labelKey }) =>
            counts[idx] > 0 ? (
              <span key={idx} className="flex items-center gap-1 tabular-nums text-zinc-300">
                {counts[idx]}×<ChestIcon className={tone} title={t(labelKey)} />
              </span>
            ) : null,
          )}
        </span>
      ) : (
        <span className="text-zinc-600 normal-case">{t("live.noLoot")}</span>
      )}
    </div>
  );
}

/** Tiny treasure-chest glyph; `className` (text color) tints the body via currentColor,
 *  while the seam + latch stay dark so they read on white/blue/red alike. */
function ChestIcon({ className, title }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cn("size-3.5", className)} role="img" aria-label={title}>
      <title>{title}</title>
      <path
        d="M3 6.4a5 5 0 0 1 10 0V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6.4Z"
        fill="currentColor"
      />
      <rect x="3" y="7.5" width="10" height="1.3" fill="#0b0b14" opacity="0.4" />
      <rect x="7.1" y="7.2" width="1.8" height="2.2" rx="0.4" fill="#0b0b14" opacity="0.55" />
    </svg>
  );
}

/** Live party frame: deployed heroes' idle sprites. Reuses heroSprite + public/heroes/
 *  (same source as the runs list). Each hero hover-shows its effective elemental resistances on the
 *  current stage (HeroFrame), when the reader emits per-hero stats. Renders nothing until the reader
 *  emits the party. */
function PartyFrame({
  party,
  partyStats,
  mode,
}: {
  party: number[] | null;
  partyStats: Record<number, Record<number, number>> | null;
  mode: string;
}) {
  const heroes = (party ?? [])
    .map((key) => ({ key, src: heroSprite(key) }))
    .filter((h): h is { key: number; src: string } => h.src != null);
  if (!heroes.length) return null;
  return (
    <span className="flex items-center gap-1">
      {heroes.map((h) => (
        <HeroFrame
          key={h.key}
          heroKey={h.key}
          src={h.src}
          stats={partyStats?.[h.key]}
          mode={mode}
        />
      ))}
    </span>
  );
}

/** A labelled stat chip (the card's stats row cells). */
function StatBox({
  label,
  value,
  tone,
  className,
}: {
  label: string;
  value: string;
  tone?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center justify-between gap-2 rounded bg-surface-800/80 px-2 py-1 ring-1 ring-surface-600/60",
        className,
      )}
    >
      <span className="tracking-[0.12em] text-zinc-500 uppercase">{label}</span>
      <span className={cn("truncate tabular-nums", tone ?? "text-zinc-200")}>{value}</span>
    </div>
  );
}

/** Traffic-light title-bar dot holding a tiny icon (minimize / toggle view). Stops
 *  pointerdown from starting a window drag (the title bar drags on pointerdown). */
function WinDot({
  title,
  className,
  onClick,
  children,
}: {
  title: string;
  className: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      className={cn(
        "flex size-4 items-center justify-center rounded-full text-surface-900 transition-colors",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** The two window-control dots, shared by the card title bar and the lean strip:
 *  red X (minimize → background) first, then the green view toggle (−/+). */
function WinControls({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  const t = useT();
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <WinDot
        title={t("live.minimizeTitle")}
        className="bg-red-500/80 hover:bg-red-500"
        onClick={() => window.meter.windowControls.minimize()}
      >
        <X className="size-2.5" strokeWidth={3} />
      </WinDot>
      <WinDot
        title={expanded ? t("live.collapseTitle") : t("live.expandTitle")}
        className="bg-emerald-500/80 hover:bg-emerald-500"
        onClick={onToggle}
      >
        {expanded ? (
          <Minus className="size-2.5" strokeWidth={3} />
        ) : (
          <Plus className="size-2.5" strokeWidth={3} />
        )}
      </WinDot>
    </span>
  );
}

/** Small chrome icon button. Stops pointerdown from starting a window drag (the title
 *  bar drags on pointerdown). `className` overrides the default muted-zinc/brand-hover
 *  tone (e.g. the amber unpinned pin). */
function IconButton({
  title,
  onClick,
  className,
  children,
}: {
  title: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      className={cn(
        "flex size-4 shrink-0 cursor-pointer items-center justify-center rounded text-zinc-500 transition-colors hover:text-brand-300",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** The pin toggle: keeps the overlay above other windows. Pinned = default chrome look;
 *  unpinned reads as "non-default" via an amber tint. Used in both icon clusters. */
function PinButton({ pinned, onTogglePin }: { pinned: boolean; onTogglePin: () => void }) {
  const t = useT();
  return (
    <IconButton
      title={pinned ? t("live.pinTitle") : t("live.unpinTitle")}
      onClick={onTogglePin}
      className={pinned ? undefined : "text-amber-400 hover:text-amber-300"}
    >
      {pinned ? <Pin className="size-3.5" /> : <PinOff className="size-3.5" />}
    </IconButton>
  );
}
