import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/globals.css";
import LiveApp from "./LiveApp";
import ListApp from "./ListApp";
import SplashApp from "./SplashApp";
import { I18nProvider } from "~/lib/i18n";
import { initAnalytics } from "~/lib/analytics";

// Surface renderer errors in the Discord error channel (no Sentry/Datadog).
// Dedup + rate limiting live main-side (error-report.ts), so firing freely is fine.
window.addEventListener("error", (event) => {
  window.meter?.reportError(
    "window-error",
    event.message,
    event.error instanceof Error ? event.error.stack : undefined,
  );
});
window.addEventListener("unhandledrejection", (event) => {
  const reason: unknown = event.reason;
  window.meter?.reportError(
    "unhandled-rejection",
    reason instanceof Error ? reason.message : String(reason),
    reason instanceof Error ? reason.stack : undefined,
  );
});

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

// Both windows load the same bundle; the URL hash selects the root.
const route = window.location.hash.replace(/^#\/?/, "");
const App = route === "list" ? ListApp : route === "splash" ? SplashApp : LiveApp;

// Usage analytics: count how many people use the meter. Loaded ONLY from the Live
// overlay (the always-present window) so the three windows don't triple-count, and
// gated on the user's opt-in. initAnalytics no-ops in dev / when disabled. The client
// id comes from the main process (file:// has no cookie storage for gtag to use one).
if (route === "") {
  const meter = window.meter;
  if (meter) {
    void (async () => {
      const clientId = await meter.getAnalyticsClientId().catch(() => undefined);
      const settings = await meter.getSettings().catch(() => undefined);
      if (settings) initAnalytics(settings.analyticsEnabled, clientId);
      meter.onSettingsChanged((s) => initAnalytics(s.analyticsEnabled, clientId));
    })();
  }
}

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
