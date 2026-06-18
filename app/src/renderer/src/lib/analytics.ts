// Lightweight, privacy-respecting usage analytics for the overlay: it loads the
// Google tag (gtag.js) so we can see how many people actually use the meter — active
// users / DAU on the SAME GA4 property as the website (its own "TBH Meter" data
// stream, id below). No api_secret and no Measurement Protocol: an Electron renderer
// IS a Chromium context, so the browser SDK works with just the public measurement id,
// exactly like the website. We collect nothing beyond what gtag does by default — no
// run details, no account data.
//
// Guards (so callers never have to): it only fires on a packaged production build
// (import.meta.env.PROD — `pnpm dev` never pollutes the property) and only while the
// user has not opted out. It is loaded ONCE, from the Live overlay window only (see
// main.tsx), so the three windows that share this bundle don't triple-count.

const MEASUREMENT_ID = "G-DNE3BHEF4N";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

let started = false;

/**
 * Load gtag and register a single `meter_app_open` event (mirrors the website's
 * `meter_download_click`). Idempotent, and a no-op in dev or when disabled.
 * `enabled` is the user's opt-in (settings.analyticsEnabled); `clientId` is the
 * stable per-install GA4 client id from the main process (analytics-id.ts).
 */
export function initAnalytics(enabled: boolean, clientId?: string): void {
  // Honour the opt-out at runtime too: gtag reads this flag on every hit, so flipping
  // the Settings toggle stops collection even if the tag was already loaded this session.
  (window as unknown as Record<string, boolean>)[`ga-disable-${MEASUREMENT_ID}`] = !enabled;

  if (!import.meta.env.PROD || !enabled || started) return;
  started = true;

  const tag = document.createElement("script");
  tag.async = true;
  tag.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  document.head.appendChild(tag);

  window.dataLayer = window.dataLayer || [];
  const gtag = (...args: unknown[]): void => {
    window.dataLayer!.push(args);
  };
  window.gtag = gtag;

  gtag("js", new Date());
  // The renderer's origin is file:// in production, where Chromium blocks cookies and
  // localStorage — so gtag cannot persist its own client_id and silently sends NOTHING
  // (the symptom: GA shows "data collection not active" even with users online). Disable
  // client-side storage and feed a stable id from the main process: that makes hits
  // actually fire AND keeps active-user counts honest (one id per install, not a fresh
  // "user" every overlay open). page_location/title also keep reports off "file://…".
  const config: Record<string, unknown> = {
    page_location: "app://meter/overlay",
    page_title: "TBH Meter",
    client_storage: "none",
  };
  if (clientId) config.client_id = clientId;
  gtag("config", MEASUREMENT_ID, config);
  gtag("event", "meter_app_open");
}
