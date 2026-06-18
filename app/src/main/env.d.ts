// Build-time constant inlined by electron.vite.config.ts (`define`). It is `"rc"` for the
// side-by-side release-candidate variant (productName/appId `tbh-meter-rc`, data folder
// ~/tbh-meter-rc, auto-update OFF) and `"stable"` for the normal shipped app. Baked at
// build time because a packaged app has no runtime env, and `app.getName()` is unreliable
// here (electron-builder may not propagate the productName override into the asar).
declare const __TBH_VARIANT__: "stable" | "rc";

// Build-time constant inlined by electron.vite.config.ts (`define`). The Ed25519 private
// key (PEM or base64 PKCS8 DER) the app signs POST /runs requests with — see
// src/main/request-signer.ts. Sourced from the TBH_SIGNING_PRIVATE_KEY build secret
// (the production key lands here in Phase 3); empty string in dev/test builds, where the
// signer emits NO signature headers (no key is committed). Under vitest there is no
// `define`, so the bare identifier is undefined — request-signer.ts guards with `typeof`.
declare const __TBH_SIGNING_PRIVATE_KEY__: string;
