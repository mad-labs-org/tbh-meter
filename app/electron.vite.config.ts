import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  main: {
    // Bundle electron-updater (and its deps: debug, ms, semver, js-yaml, …) INTO the
    // main chunk instead of externalizing it. Externalized, it is require()d from
    // node_modules inside app.asar at runtime, and electron-builder + pnpm's isolated
    // node_modules dropped the transitive `ms` -> "Cannot find module 'ms'" crash on
    // launch (regression from wiring the updater in #57). Bundling removes the runtime
    // node_modules dependency entirely, so no transitive dep can go missing.
    plugins: [externalizeDepsPlugin({ exclude: ["electron-updater"] })],
    // Build-time variant flag (see src/main/env.d.ts). The RC build sets
    // TBH_BUILD_VARIANT=rc so the main process isolates its data folder (~/tbh-meter-rc)
    // and disables auto-update; everything else builds "stable".
    define: {
      __TBH_VARIANT__: JSON.stringify(process.env.TBH_BUILD_VARIANT ?? "stable"),
    },
    resolve: {
      alias: {
        "~": resolve(__dirname, "src/main"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "~": resolve(__dirname, "src/preload"),
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "~": resolve(__dirname, "src/renderer/src"),
      },
    },
  },
});
