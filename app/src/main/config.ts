import { app } from "electron";

// --------------------------------------------------------------------------- //
// Static config for auth + leaderboard sharing. Every value has an env-var
// override so a dev can point the meter at a local API without a rebuild.
// --------------------------------------------------------------------------- //

/**
 * API base URL. An explicit env override always wins; otherwise a packaged build
 * targets production and a dev build targets the local API. Auth (Discord OAuth
 * loopback + JWT) and run upload both go through this base.
 */
export const API_URL =
  process.env.TBH_API_URL ??
  (app.isPackaged ? "https://api.tbherohelper.com" : "http://localhost:8787");

export const SITE_URL = process.env.TBH_SITE_URL ?? "https://tbherohelper.com";

/** Community Discord invite (footer/settings "Bugs & feedback" button). */
export const DISCORD_INVITE_URL = "https://discord.gg/eYqUkxu3";

/** Loopback port for the Discord OAuth callback. 0 = an OS-assigned ephemeral
 *  port (the default). A dev can pin a fixed port via the env var (e.g. to
 *  pre-register a redirect URI), parsed to an int; anything invalid falls back
 *  to ephemeral. */
export const AUTH_CALLBACK_PORT = (() => {
  const raw = process.env.TBH_AUTH_CALLBACK_PORT;
  const n = raw != null ? Number.parseInt(raw, 10) : 0;
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 0;
})();
