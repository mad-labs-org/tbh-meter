import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { Modal } from "~/components/Modal";
import { DiscordIcon } from "~/components/DiscordIcon";
import { useT } from "~/lib/i18n";

/**
 * Two modes, one modal:
 *   - the gentle first-run nudge: shown when the runs window opens while signed OUT
 *     (unless the user opted out via hideSignInPrompt); runs are saved locally either
 *     way but only reach the leaderboard when signed in.
 *   - the involuntary-expiry notice (`expired`): a 401 cleared the session out from
 *     under a signed-in user (token expired / JWT_SECRET rotated — no refresh). It is
 *     forced open by `meter:session-expired` REGARDLESS of the opt-out, with explicit
 *     "your session expired, sign in again" copy, so the user knows their runs stopped
 *     syncing instead of silently going OFFLINE.
 * Closes itself the moment auth flips to signed in.
 */
export function SignInPromptModal() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    Promise.all([window.meter.authGetStatus(), window.meter.getSettings()])
      .then(([auth, settings]) => {
        if (!auth.signedIn && !settings.hideSignInPrompt) setOpen(true);
      })
      .catch(() => setOpen(false));

    const offAuth = window.meter.onAuthChanged((auth) => {
      // A successful (re-)sign-in resolves both the nudge and the expiry notice.
      if (auth.signedIn) {
        setOpen(false);
        setExpired(false);
      }
      setSigningIn(false);
    });
    // Involuntary 401 logout: force the prompt open with the expiry copy. This ignores
    // hideSignInPrompt on purpose — that opt-out silences the first-run nudge, never a
    // logout the user did not ask for.
    const offExpired = window.meter.onSessionExpired(() => {
      setExpired(true);
      setOpen(true);
    });
    return () => {
      offAuth();
      offExpired();
    };
  }, []);

  if (!open) return null;

  const dismiss = (): void => {
    // Only the gentle nudge is opt-out-able; an expiry notice must never persist
    // hideSignInPrompt (that would suppress future involuntary-logout notices too).
    if (!expired && dontShowAgain) void window.meter.setSettings({ hideSignInPrompt: true });
    setOpen(false);
  };

  const handleSignIn = (): void => {
    setSigningIn(true);
    window.meter.authSignIn().catch(() => setSigningIn(false));
  };

  return (
    <Modal title={expired ? t("signin.expiredTitle") : t("signin.title")} onClose={dismiss}>
      <p className="mt-2 text-xs text-zinc-400">{expired ? t("signin.expiredBody") : t("signin.body")}</p>
      <div className="mt-4 flex items-center justify-between gap-2">
        {expired ? (
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
