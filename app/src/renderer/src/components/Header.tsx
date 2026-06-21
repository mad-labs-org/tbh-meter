import { useState, useEffect } from "react";
import { X, RefreshCw } from "lucide-react";
import type { AuthStatus, UpdateStatus } from "../../../shared/ipc-types.js";
import { DiscordIcon } from "~/components/DiscordIcon";
import { useT } from "~/lib/i18n";
import { cn } from "~/lib/utils";

const drag = { WebkitAppRegion: "drag" } as React.CSSProperties;
const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

export type ListTab = "runs" | "cooldowns" | "planner" | "settings";

interface ListHeaderProps {
  activeTab: ListTab;
  onTabChange: (tab: ListTab) => void;
  onClose: () => void;
}

/** Runs-window header: [Runs | Settings] tabs + close. */
export function ListHeader({ activeTab, onTabChange, onClose }: ListHeaderProps) {
  const t = useT();
  return (
    <div
      className="flex h-9 shrink-0 items-center gap-1 border-b border-surface-600 bg-surface-800/80 px-2"
      style={drag}
    >
      <span className="mr-1 text-xs font-bold tracking-tight text-brand-400">TBH</span>

      <div className="flex items-center gap-0.5" style={noDrag}>
        <TabButton active={activeTab === "runs"} onClick={() => onTabChange("runs")}>
          {t("header.tabRuns")}
        </TabButton>
        <TabButton active={activeTab === "cooldowns"} onClick={() => onTabChange("cooldowns")}>
          {t("header.tabTracker")}
        </TabButton>
        <TabButton active={activeTab === "planner"} onClick={() => onTabChange("planner")}>
          {t("header.tabPlanner")}
        </TabButton>
        <TabButton active={activeTab === "settings"} onClick={() => onTabChange("settings")}>
          {t("header.tabSettings")}
        </TabButton>
      </div>

      <div className="ml-auto flex items-center gap-1.5" style={noDrag}>
        <VersionControl />
        <AuthControl />
        <IconButton
          onClick={onClose}
          title={t("common.close")}
          hoverClassName="hover:bg-red-900 hover:text-white"
        >
          <X className="size-3.5" />
        </IconButton>
      </div>
    </div>
  );
}

/**
 * Auto-update status, shared by both headers. Fetches on mount (catches events
 * fired before this window opened) then subscribes to live changes.
 */
function useUpdateStatus(): UpdateStatus {
  const [update, setUpdate] = useState<UpdateStatus>({ state: "idle" });

  useEffect(() => {
    window.meter.getUpdateStatus().then(setUpdate);
    return window.meter.onUpdateStatus(setUpdate);
  }, []);

  return update;
}

/**
 * App version in the runs-window header. When an update has been downloaded it
 * turns into a one-click "Restart to update" action (full window, misclick-safe);
 * available/downloading show a subtle progress badge in place of the version.
 */
function VersionControl() {
  const t = useT();
  const [version, setVersion] = useState<string | null>(null);
  const update = useUpdateStatus();

  useEffect(() => {
    window.meter.getAppVersion().then(setVersion);
  }, []);

  if (update.state === "downloaded") {
    return (
      <button
        onClick={() => window.meter.quitAndInstall()}
        title={t("header.updateReady", { version: update.version })}
        className="flex cursor-pointer items-center gap-1.5 rounded bg-brand-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-brand-500"
      >
        <RefreshCw className="size-3" />
        {t("header.restartToUpdate")}
      </button>
    );
  }

  if (update.state === "available" || update.state === "downloading") {
    return (
      <span
        className="text-[10px] text-brand-400"
        title={t("header.updateBadge", { version: update.version })}
      >
        {t("header.updateBadge", { version: update.version })}
        {update.state === "downloading" && (
          <span className="tabular-nums"> {update.percent}%</span>
        )}
      </span>
    );
  }

  if (!version) return null;
  return (
    <span
      className="font-mono text-[10px] tabular-nums text-zinc-600"
      title={t("header.appVersion")}
    >
      v{version}
    </span>
  );
}

/**
 * Discord auth in the runs-window header (mirrors the web header's AccountMenu):
 *   signed out -> "Sign in" button (opens the browser OAuth flow)
 *   signed in  -> avatar + username pill
 */
function AuthControl() {
  const t = useT();
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    window.meter.authGetStatus().then(setAuth);
    return window.meter.onAuthChanged((status) => {
      setAuth(status);
      setSigningIn(false);
    });
  }, []);

  if (!auth) return null;

  if (auth.signedIn) {
    return (
      <span className="flex min-w-0 items-center gap-1.5 rounded-full bg-surface-700 py-0.5 pl-0.5 pr-2">
        {auth.avatarUrl ? (
          <img src={auth.avatarUrl} alt="" className="size-5 rounded-full" />
        ) : (
          <span className="flex size-5 items-center justify-center rounded-full bg-brand-600 text-[10px] font-bold text-white">
            {(auth.displayName ?? "?").charAt(0).toUpperCase()}
          </span>
        )}
        <span className="max-w-24 truncate text-xs text-zinc-200">
          {auth.displayName ?? t("header.signedIn")}
        </span>
      </span>
    );
  }

  return (
    <button
      onClick={() => {
        setSigningIn(true);
        window.meter.authSignIn().catch(() => setSigningIn(false));
      }}
      disabled={signingIn}
      className="flex cursor-pointer items-center gap-1.5 rounded bg-discord px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-discord-dark disabled:cursor-default disabled:opacity-60"
    >
      <DiscordIcon className="size-3" />
      {signingIn ? t("common.waitingBrowser") : t("header.signIn")}
    </button>
  );
}

interface IconButtonProps {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  className?: string;
  hoverClassName?: string;
}

function IconButton({
  onClick,
  title,
  children,
  className,
  hoverClassName = "hover:bg-surface-600 hover:text-white",
}: IconButtonProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "cursor-pointer rounded p-1 text-zinc-400 transition-colors",
        hoverClassName,
        className,
      )}
    >
      {children}
    </button>
  );
}

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function TabButton({ active, onClick, children }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "cursor-pointer rounded px-2 py-0.5 text-xs font-medium transition-colors",
        active
          ? "bg-surface-700 text-white"
          : "text-zinc-500 hover:bg-surface-700 hover:text-zinc-300",
      )}
    >
      {children}
    </button>
  );
}
