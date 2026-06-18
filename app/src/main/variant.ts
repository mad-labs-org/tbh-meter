// Build variant resolver. `__TBH_VARIANT__` is inlined by electron.vite.config.ts's
// `define` at build time (see env.d.ts). Under vitest there is no define, so the bare
// identifier would be undefined — the `typeof` guard makes that safe and falls back to
// "stable". Kept as functions (not a load-time const) so tests can flip it with
// vi.stubGlobal("__TBH_VARIANT__", "rc").

export function variant(): "stable" | "rc" {
  return typeof __TBH_VARIANT__ === "undefined" ? "stable" : __TBH_VARIANT__;
}

/** True only in the side-by-side release-candidate build (tbh-meter-rc). */
export function isRcBuild(): boolean {
  return variant() === "rc";
}
