import { app, BrowserWindow } from "electron";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getRunsSource } from "./sources/runs-source.js";
import { getAccessToken } from "./auth.js";
import { getSettings } from "./settings.js";
import { uploadRun, isUploaded, claimDeviceRuns } from "./share.js";
import type { RunRecord } from "../shared/run-types.js";

// --------------------------------------------------------------------------- //
// Auto-upload service — a background scheduler that uploads successful runs to
// the leaderboard, so the user doesn't have to share each run by hand. The
// manual ShareControls flow still works for any individual run.
//
// All network + auth lives in the MAIN process (reusing share.ts's uploadRun).
// State (permanently-failed runs) lives in its OWN small JSON file under
// userData; we never overload share.ts's uploads.json, which stays the dedup
// record of successful uploads.
//
// Semantics:
//   - EVERY successful local run is auto-uploaded — signed in (attributed,
//     ranks on the leaderboard) or signed out (anonymous via the device id,
//     session page only; claimed by the account on sign-in). Turning the
//     "anonymous upload" setting off restores the old behavior: signed-out
//     runs stay local until a sign-in. The backlog drains oldest-first,
//     MAX_PER_CYCLE per tick.
//   - Dedup: uploads.json (via isUploaded) is the source of truth for "already
//     shared".
//   - failed: runs the API permanently rejected (bad_request) so we stop retrying
//     them forever. Transient failures (network / rate_limited / unauthorized) are
//     NOT recorded and simply retry on a later tick.
// --------------------------------------------------------------------------- //

const FIRST_TICK_DELAY_MS = 30_000;
const TICK_INTERVAL_MS = 5 * 60 * 1000;
const MAX_PER_CYCLE = 8;
const PER_UPLOAD_SPACING_MS = 1_000;

interface AutoUploadState {
  /** runId -> error code for runs permanently rejected by the API (e.g. bad_request). */
  failed: Record<string, string>;
}

function statePath(): string {
  return join(app.getPath("userData"), "auto-upload.json");
}

/** Reads persisted state; a leftover `watermark` field from pre-0.15.1 files is ignored. */
function readState(): AutoUploadState {
  const path = statePath();
  if (!existsSync(path)) return { failed: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<AutoUploadState> | null;
    return {
      failed: parsed?.failed && typeof parsed.failed === "object" ? parsed.failed : {},
    };
  } catch {
    return { failed: {} };
  }
}

function writeState(state: AutoUploadState): void {
  try {
    writeFileSync(statePath(), JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // best effort — never crash on a state write failure
  }
}

/** Notify every open window that a run was just uploaded, so an open RunDetailView
 *  flips to "View on TBH Helper" live (same fan-out pattern as the auth broadcast). */
function broadcastShareUpdated(runId: string, url: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("meter:share-updated", { runId, url });
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

/** Start the background scheduler: a first tick ~30s after launch, then every 5 min.
 *  Ticks are no-ops while signed out. Safe to call once from index.ts after ready. */
export function startAutoUpload(): void {
  if (timer) return;
  timer = setTimeout(function tick() {
    void runCycle().finally(() => {
      timer = setTimeout(tick, TICK_INTERVAL_MS);
    });
  }, FIRST_TICK_DELAY_MS);
}

export function stopAutoUpload(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Auth hook: the moment a session becomes available (fresh sign-in or restored
 *  at startup), claim this install's anonymous uploads, then attempt an immediate
 *  upload cycle so pending runs appear on the leaderboard right away instead of
 *  waiting for the next 5-minute tick. */
export function notifySignedIn(): void {
  void claimDeviceRuns().finally(() => void runCycle());
}

/** Fire an immediate upload sweep on demand (e.g. just before opening the session
 *  stats page) so freshly-finished runs are on the leaderboard. Same cycle as the
 *  scheduler. */
export function requestUploadNow(): void {
  void runCycle();
}

function eligible(run: RunRecord, failed: Record<string, string>): boolean {
  return (
    run.status === "success" &&
    // Only a `counted` run uploads — the converter's quality verdict is the redesign's single source
    // of truth for "counts" (progress.md "Upload": "Degradada/parcial/skipped NÃO sobe"). Before PR4
    // the read path dropped success-partials via cleanRecords; that filter is gone (the app now reads
    // pre-converted logs/), so the gate moves HERE, onto the sealed verdict — a partial (under-counted)
    // or degraded (a critical read failed) success must never reach the public leaderboard. A
    // pre-PR3 legacy-mirror log has NO quality field (absent, not "counted"); we treat that as
    // uploadable (un-migrated runs kept uploading before this change) by excluding only the FLAGGED
    // verdicts rather than requiring quality==="counted" — the ingest/migration seals those mirrors
    // to a real verdict, after which a genuinely-bad one is excluded too.
    run.quality !== "partial" &&
    run.quality !== "degraded" &&
    run.quality !== "skipped" &&
    run.totalDamage > 0 && // zero-damage success = missed capture (issue #163)
    run.stageKey != null &&
    run.heroes.length > 0 &&
    failed[run.id] == null &&
    !isUploaded(run.id)
  );
}

async function runCycle(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Signed out: uploads continue anonymously (device-id) unless the user
    // opted out in Settings — then ticks are a no-op, like before.
    const token = await getAccessToken();
    if (!token && !getSettings().anonymousUpload) return;

    const state = readState();

    const candidates = getRunsSource()
      .all()
      .filter((r) => eligible(r, state.failed))
      .sort((a, b) => a.ts - b.ts) // oldest first
      .slice(0, MAX_PER_CYCLE);

    if (candidates.length === 0) {
      console.log("[auto-upload] tick: no eligible runs");
      return;
    }

    console.log(`[auto-upload] tick: ${candidates.length} eligible run(s)`);

    let uploaded = 0;
    for (let i = 0; i < candidates.length; i++) {
      const run = candidates[i];
      const result = await uploadRun(run);

      if (result.ok) {
        uploaded++;
        broadcastShareUpdated(run.id, result.url);
      } else if (result.code === "rate_limited" || result.code === "network") {
        // Transient: abort the cycle; remaining runs retry next tick.
        console.log(`[auto-upload] aborting cycle: ${result.code}`);
        break;
      } else if (result.code === "unauthorized") {
        // Signed out with anonymous upload off (uploadRun's pre-flight gate), or
        // the JWT just expired mid-cycle (uploadRun cleared the session on a 401).
        // Either way the run isn't marked failed — it retries once signed in again
        // (or anonymously, if that setting is turned back on).
        console.log("[auto-upload] aborting cycle: unauthorized");
        break;
      } else if (result.code === "bad_request") {
        // Permanent per-run rejection: record it so we never retry it again.
        state.failed[run.id] = result.code;
        writeState(state);
        console.log(`[auto-upload] run ${run.id} permanently rejected: ${result.message}`);
      } else {
        // Other errors (internal/not_found): leave for a later tick, don't record.
        console.log(`[auto-upload] run ${run.id} failed (${result.code}); will retry`);
      }

      if (i < candidates.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, PER_UPLOAD_SPACING_MS));
      }
    }

    console.log(`[auto-upload] tick done: ${uploaded} uploaded`);
  } finally {
    running = false;
  }
}
