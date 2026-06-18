// Build-time constant inlined by electron.vite.config.ts (`define`). It is `"rc"` for the
// side-by-side release-candidate variant (productName/appId `tbh-meter-rc`, data folder
// ~/tbh-meter-rc, auto-update OFF) and `"stable"` for the normal shipped app. Baked at
// build time because a packaged app has no runtime env, and `app.getName()` is unreliable
// here (electron-builder may not propagate the productName override into the asar).
declare const __TBH_VARIANT__: "stable" | "rc";
