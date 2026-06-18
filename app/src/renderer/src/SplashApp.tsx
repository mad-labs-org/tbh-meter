import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { ReaderStatus, UpdateStatus } from "../../shared/ipc-types.js";
import type { DictKey, Translate } from "../../shared/i18n/index.js";
import { useT } from "~/lib/i18n";
import { splashPhase } from "~/lib/splash-phase";

// Discord-style startup splash: a frameless rounded card with the wordmark logo, a progress
// bar, and a phase-driven status line. It combines TWO signals — the reader bring-up phase AND
// the auto-updater — because the boot now checks for an update BEFORE the reader: a real update
// shows "updating" (live download %) → "restarting" (about to relaunch); everything else falls
// through to the reader phases (searching → resolving → scanning → ready). Dismissed main-side
// once real data flows — there is NO skip button (the splash guards loading).
// The window is frameless + transparent — this card paints the only visible surface.

const STATUS_KEY: Record<ReaderStatus, DictKey> = {
  searching: "splash.searching",
  resolving: "splash.resolving",
  scanning: "splash.scanning",
  ready: "splash.ready",
};

const TIP_KEYS: DictKey[] = ["splash.tip1", "splash.tip2", "splash.tip3", "splash.tip4"];

export default function SplashApp() {
  const t = useT();
  const [reader, setReader] = useState<ReaderStatus>("searching");
  const [update, setUpdate] = useState<UpdateStatus>({ state: "idle" });
  const [tip, setTip] = useState(0);

  // Both signals are fetched once on mount (to catch a status set before this window opened)
  // and then streamed — see the matching getX()/onX() pairs in the MeterApi contract.
  useEffect(() => {
    void window.meter.getReaderStatus().then(setReader);
    return window.meter.onReaderStatus(setReader);
  }, []);

  useEffect(() => {
    void window.meter.getUpdateStatus().then(setUpdate);
    return window.meter.onUpdateStatus(setUpdate);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTip((n) => (n + 1) % TIP_KEYS.length), 4000);
    return () => clearInterval(id);
  }, []);

  const phase = splashPhase(update, reader);

  if (phase === "updating") {
    const percent = update.state === "downloading" ? update.percent : 0;
    const version = "version" in update ? update.version : "";
    return <UpdatingCard t={t} percent={percent} version={version} />;
  }
  if (phase === "restarting") return <RestartingCard t={t} />;
  return <ReaderCard t={t} status={phase} tip={tip} />;
}

/** The shared frameless card surface — the whole card is the window's drag region. `tone`
 *  tints the decorative brand glow (emerald on the "done" phases). */
function Shell({
  children,
  tone = "brand",
  gap = "gap-6",
}: {
  children: ReactNode;
  tone?: "brand" | "emerald";
  gap?: string;
}) {
  return (
    <div
      style={{ WebkitAppRegion: "drag" } as CSSProperties}
      className={`relative flex h-screen w-screen flex-col items-center justify-center ${gap} overflow-hidden rounded-2xl border border-surface-600 bg-surface-900 px-8 text-center`}
    >
      <div
        aria-hidden
        className={`pointer-events-none absolute -top-16 h-48 w-48 rounded-full blur-3xl ${
          tone === "emerald" ? "bg-emerald-500/20" : "bg-brand-600/20"
        }`}
      />
      {children}
    </div>
  );
}

/** The logo IS the title (the app has no separate mark) — show it as the hero. */
function Wordmark({ className = "text-5xl" }: { className?: string }) {
  return (
    <h1 className={`relative ${className} font-black tracking-tight text-white`}>
      TBH <span className="text-brand-400">METER</span>
    </h1>
  );
}

function DownloadIcon() {
  return (
    <svg
      className="h-3 w-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3v12" />
      <path d="m7 12 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

/** Reader bring-up phases (searching → resolving → scanning → ready) — the no-update path. */
function ReaderCard({ t, status, tip }: { t: Translate; status: ReaderStatus; tip: number }) {
  const ready = status === "ready";
  return (
    <Shell tone={ready ? "emerald" : "brand"}>
      <Wordmark />
      <div className="relative h-1.5 w-full max-w-[220px] overflow-hidden rounded-full bg-surface-600">
        {ready ? (
          <div className="h-full w-full rounded-full bg-emerald-400" />
        ) : (
          <div className="splash-indeterminate absolute inset-y-0 w-1/3 rounded-full bg-brand-400" />
        )}
      </div>
      <p
        className={`relative min-h-[2.5rem] max-w-[260px] text-sm leading-snug ${
          ready ? "font-semibold text-emerald-300" : "text-zinc-400"
        }`}
      >
        {t(STATUS_KEY[status])}
      </p>
      <p className="relative h-8 max-w-[260px] text-xs leading-snug text-zinc-600">
        <span className="font-mono uppercase tracking-wider text-zinc-500">{t("splash.tipLabel")} </span>
        {t(TIP_KEYS[tip])}
      </p>
    </Shell>
  );
}

/** Update download in progress — the "expressive" treatment: an unmistakable "this is an
 *  update, not a hang" badge, the live download %, and a one-liner that it restarts itself. */
function UpdatingCard({ t, percent, version }: { t: Translate; percent: number; version: string }) {
  return (
    <Shell gap="gap-5">
      <span className="relative inline-flex items-center gap-1.5 rounded-full border border-brand-400/30 bg-brand-400/10 px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-brand-300">
        <DownloadIcon />
        {t("splash.update.badge")}
      </span>
      <Wordmark className="text-4xl" />
      <div className="relative h-1.5 w-full max-w-[220px] overflow-hidden rounded-full bg-surface-600">
        <div
          className="h-full rounded-full bg-brand-400 transition-[width] duration-300 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="relative text-sm text-zinc-300">
        <span className="font-mono font-bold text-white">{percent}%</span>
        {version ? <span className="text-zinc-500"> · v{version}</span> : null}
      </p>
      <p className="relative max-w-[260px] text-xs leading-relaxed text-zinc-500">
        {t("splash.update.note")}
      </p>
    </Shell>
  );
}

/** Update downloaded — the app is about to quitAndInstall and relaunch into the new build. */
function RestartingCard({ t }: { t: Translate }) {
  return (
    <Shell tone="emerald">
      <Wordmark />
      <div className="relative h-1.5 w-full max-w-[220px] overflow-hidden rounded-full bg-surface-600">
        <div className="h-full w-full rounded-full bg-emerald-400" />
      </div>
      <p className="relative min-h-[2.5rem] max-w-[260px] text-sm font-semibold leading-snug text-emerald-300">
        {t("splash.update.restarting")}
      </p>
    </Shell>
  );
}
