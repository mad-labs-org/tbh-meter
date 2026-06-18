import type { ReaderStatus, UpdateStatus } from "../../../shared/ipc-types.js";

// The boot now feeds the splash TWO independent signals: the reader bring-up phase AND the
// auto-updater (the boot checks for an update before starting the reader). This pure picker
// collapses them into the one phase the splash renders — extracted so the precedence rule is
// unit-tested, not buried in the component.

/** The visual phase the splash renders. Reader phases mirror ReaderStatus 1:1; the two update
 *  phases are derived from UpdateStatus and win when an update is in flight. */
export type SplashPhase = "updating" | "restarting" | ReaderStatus;

/**
 * Pick the splash phase from the update + reader signals.
 *
 * An update being applied WINS over the reader (the app is about to relaunch, so the reader's
 * progress is moot): `available`/`downloading` → "updating", `downloaded` → "restarting".
 * Every OTHER update state — `checking`, `up-to-date`, `idle`, `error` — falls through to the
 * reader phase, so a normal boot never flashes a "checking for updates" screen (the product
 * decision: skip the check UI when there's nothing to install). During the brief pre-reader
 * check the reader status is still its initial "searching" — exactly what we want to show.
 */
export function splashPhase(update: UpdateStatus, reader: ReaderStatus): SplashPhase {
  if (update.state === "available" || update.state === "downloading") return "updating";
  if (update.state === "downloaded") return "restarting";
  return reader;
}
