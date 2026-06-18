import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { Modal } from "~/components/Modal";
import { DiscordIcon } from "~/components/DiscordIcon";
import { useT } from "~/lib/i18n";

/**
 * Shown when the runs window opens while signed OUT (unless the user opted out):
 * runs are saved locally either way, but they only reach the leaderboard when
 * signed in. Closes itself the moment auth flips to signed in.
 */
export function SignInPromptModal() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);

  useEffect(() => {
    Promise.all([window.meter.authGetStatus(), window.meter.getSettings()])
      .then(([auth, settings]) => {
        if (!auth.signedIn && !settings.hideSignInPrompt) setOpen(true);
      })
      .catch(() => setOpen(false));
    return window.meter.onAuthChanged((auth) => {
      if (auth.signedIn) setOpen(false);
      setSigningIn(false);
    });
  }, []);

  if (!open) return null;

  const dismiss = (): void => {
    if (dontShowAgain) void window.meter.setSettings({ hideSignInPrompt: true });
    setOpen(false);
  };

  const handleSignIn = (): void => {
    setSigningIn(true);
    window.meter.authSignIn().catch(() => setSigningIn(false));
  };

  return (
    <Modal title={t("signin.title")} onClose={dismiss}>
      <p className="mt-2 text-xs text-zinc-400">{t("signin.body")}</p>
      <div className="mt-4 flex items-center justify-between gap-2">
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-zinc-500">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
            className="size-3 cursor-pointer accent-brand-500"
          />
          {t("signin.dontShow")}
        </label>
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
