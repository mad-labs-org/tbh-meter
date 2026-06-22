import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { Modal } from "~/components/Modal";
import { DiscordIcon } from "~/components/DiscordIcon";
import { useT } from "~/lib/i18n";

/**
 * Three modes, one modal:
 *   - the gentle first-run `nudge`: shown when the runs window opens while signed OUT
 *     with NO local backlog (unless the user opted out via hideSignInPrompt); runs are
 *     saved locally either way but only reach the leaderboard when signed in.
 *   - the involuntary-expiry notice (`expired`): a 401 cleared the session out from
 *     under a signed-in user (token expired / JWT_SECRET rotated — no refresh). Forced
 *     open by `meter:session-expired` with explicit "your session expired" copy.
 *   - the `pending`-backlog notice: shown on launch when signed OUT and runs are
 *     already queued locally (countPendingRuns > 0). The new build has no anonymous
 *     upload path, so a signed-out meter silently piles runs up — and a user who was
 *     logged out BEFORE updating never saw the live `expired` event (issue #60). Like
 *     `expired`, it is actionable and ignores the opt-out, and it shows the count.
 * The expiry/pending notices ignore hideSignInPrompt on purpose — that opt-out silences
 * the first-run nudge, never a "your runs aren't syncing" state the user didn't choose.
 * Closes itself the moment auth flips to signed in.
 */
type PromptMode = "nudge" | "expired" | "pending";

export function SignInPromptModal() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [mode, setMode] = useState<PromptMode>("nudge");
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    Promise.all([
      window.meter.authGetStatus(),
      window.meter.getSettings(),
      window.meter.getPendingSyncCount(),
    ])
      .then(([auth, settings, pending]) => {
        if (auth.signedIn) return;
        // A signed-out user with a local backlog is sitting OFFLINE with runs that
        // will never sync until they act, so surface it REGARDLESS of the opt-out
        // (same reasoning as the expiry notice). Otherwise fall back to the gentle
        // first-run nudge, which the opt-out may silence.
        if (pending > 0) {
          setPendingCount(pending);
          setMode("pending");
          setOpen(true);
        } else if (!settings.hideSignInPrompt) {
          setMode("nudge");
          setOpen(true);
        }
      })
      .catch(() => setOpen(false));

    const offAuth = window.meter.onAuthChanged((auth) => {
      // A successful (re-)sign-in resolves every mode.
      if (auth.signedIn) {
        setOpen(false);
        setMode("nudge");
      }
      setSigningIn(false);
    });
    // Involuntary 401 logout: force the prompt open with the expiry copy.
    const offExpired = window.meter.onSessionExpired(() => {
      setMode("expired");
      setOpen(true);
    });
    return () => {
      offAuth();
      offExpired();
    };
  }, []);

  if (!open) return null;

  // Only the gentle nudge is opt-out-able; an expiry/pending notice is an actionable
  // "your runs aren't syncing" state that must never persist hideSignInPrompt (which
  // would suppress future involuntary-logout notices too).
  const actionable = mode !== "nudge";
  const title =
    mode === "expired"
      ? t("signin.expiredTitle")
      : mode === "pending"
        ? t("signin.pendingTitle")
        : t("signin.title");
  const body =
    mode === "expired"
      ? t("signin.expiredBody")
      : mode === "pending"
        ? t("signin.pendingBody", { count: pendingCount })
        : t("signin.body");

  const dismiss = (): void => {
    if (!actionable && dontShowAgain) void window.meter.setSettings({ hideSignInPrompt: true });
    setOpen(false);
  };

  const handleSignIn = (): void => {
    setSigningIn(true);
    window.meter.authSignIn().catch(() => setSigningIn(false));
  };

  return (
    <Modal title={title} onClose={dismiss}>
      <p className="mt-2 text-xs text-zinc-400">{body}</p>
      <div className="mt-4 flex items-center justify-between gap-2">
        {actionable ? (
          <span />
        ) : (
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-zinc-500">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
              className="size-3 cursor-pointer accent-brand-500"
            />
            {t("signin.dontShow")}
          </label>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={dismiss}
            className="cursor-pointer rounded px-2.5 py-1.5 text-xs text-zinc-400 transition-colors hover:text-zinc-200"
          >
            {t("signin.notNow")}
          </button>
          <button
            onClick={handleSignIn}
            disabled={signingIn}
            className="flex cursor-pointer items-center gap-1.5 rounded bg-discord px-2.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-discord-dark disabled:cursor-default disabled:opacity-60"
          >
            {signingIn ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <DiscordIcon className="size-3.5" />
            )}
            {signingIn ? t("common.waitingBrowser") : t("common.signInDiscord")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
