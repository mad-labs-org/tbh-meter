import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/globals.css";
import LiveApp from "./LiveApp";
import ListApp from "./ListApp";
import SplashApp from "./SplashApp";
import { I18nProvider } from "~/lib/i18n";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

// Both windows load the same bundle; the URL hash selects the root.
const route = window.location.hash.replace(/^#\/?/, "");
const App = route === "list" ? ListApp : route === "splash" ? SplashApp : LiveApp;

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
