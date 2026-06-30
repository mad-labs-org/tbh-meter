import { app } from "electron";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getRun } from "./runs-store.js";
import { getAccessToken, clearSession, refreshAccessToken } from "./auth.js";
import { getDeviceId } from "./device-id.js";
import { signRequest } from "./request-signer.js";
import { API_URL, SITE_URL } from "./config.js";
import { reportError, describeCause } from "./error-report.js";
import { httpFetch } from "./net-fetch.js";
import { mapGear, mapSkillLevels, type IngestGearSlot } from "./ingest-map.js";
import { tsToMs } from "./sources/runs-source.js";
import type { RunRecord, RunHero, RunDrop } from "../shared/run-types.js";

// --------------------------------------------------------------------------- //
// Share service — maps a local RunRecord to the API's POST /runs payload, uploads
// it with the user's Discord access token, and remembers the resulting public URL.
//
// Upload REQUIRES sign-in (Phase 2): every request carries `Authorization: Bearer`
// AND an Ed25519 request signature (request-signer.ts; matches the API verifier in
// api/src/middleware/signature.ts). There is no anonymous upload path — signed out =
// a clean "sign in to sync" state. The install's device id (device-id.ts) lives on
// only to claim legacy anonymous runs via POST /runs/claim on a later sign-in.
//
// Network + auth live here in the MAIN process. The renderer only triggers
// shareRun / getShareStatus over IPC and receives a discriminated result.
//
// We never write to the reader-owned runs.jsonl. Our own upload bookkeeping lives
// in userData/uploads.json, keyed by the run's stable id.
// --------------------------------------------------------------------------- //

export type ShareResult =
  | { ok: true; url: string; duplicate: boolean }
  | { ok: false; code: string; message: string };

/**
 * Whether an HTTP upload failure is worth relaying to the #log-error channel.
 *
 * Report only client-side (4xx) rejections — those mean the API refused what the
 * meter SENT (a payload/contract bug we can actually fix). Suppress the transient
 * or expected states that auto-upload already retries on its own:
 *   - 401 expired token (uploadRun tries a refresh + one retry first; a terminal
 *     401 then clearSession()s to signed out and the next sign-in retries),
 *   - 408 request timeout, 429 rate-limit (backs off),
 *   - every 5xx server/gateway error (500/502/503/504 and Cloudflare 52x).
 * Relaying those just floods the channel with self-healing infra blips and buries
 * the failures that genuinely need a code change. (Server-side outages are owned by
 * the API's own monitoring, not the meter's error feed.)
 */
export function isReportableUploadFailure(status: number): boolean {
  return status < 500 && status !== 401 && status !== 408 && status !== 429;
}

// Telemetry for the involuntary-logout (401) path. 401 is deliberately suppressed
// from the upload-failed relay above (it is self-healing for noise purposes), so
// without an explicit ping a JWT_SECRET rotation or mass token expiry is INVISIBLE
// to us — the 2026-06 incident only surfaced via player DMs. error-report dedups per
// (context, message) per session, so keeping these identical at both 401 sites makes
// the ping fire AT MOST ONCE per session: a fleet logout-rate signal, not 401 noise.
const SESSION_EXPIRED_CONTEXT = "auth:session-expired";
const SESSION_EXPIRED_MESSAGE =
  "Bearer JWT rejected (401) — session cleared; user must re-sign-in (no refresh token).";

interface UploadEntry {
  id: string;
  url: string;
  sharedAt: number;
}
type UploadMap = Record<string, UploadEntry>;

// Minimal local mirrors of @tbh/shared (the meter cannot import that package).
interface IngestRunHero {
  heroKey: number;
  classType: string;
  /** 0-based party slot (0/1/2) so the site can position heroes — incl. empty slots. Sent only
   *  when the run carries a known slot; omitted for legacy/unknown (never defaulted). */
  slot?: number;
  dps: number;
  damage: number;
  level?: number;
  skillLevels?: Record<string, number>;
  gear?: Record<string, IngestGearSlot>;
  runeKeys?: number[];
  /** The reader's live FINAL stats, keyed by StatType id (e.g. "1" AttackDamage). Read 100%
   *  faithfully from game memory — the hero's OWN, UNBUFFED values (reader 0x18 FINAL_STATS;
   *  party buffs like the Priest's Blessing of Might live only in the 0x20 dict). The site
   *  displays them directly and re-applies party buffs itself when deriving Basic Attack DPS,
   *  instead of recomputing from the build (the recompute can't reproduce account-wide stats). */
  stats?: Record<string, number>;
}
interface IngestRunBody {
  externalId: string;
  /** The app-derived grind label (Redesign 2) — the site's session dashboard groups by it. */
  session?: string;
  stageKey: number;
  gameVersion: string;
  clearTimeMs: number;
  /** When the run actually ended (epoch ms, from runs.jsonl `ts`) — the site
   *  shows this instead of the upload time, which batches on the 5-min tick. */
  endedAt?: number;
  /** Run-level team DPS — the meter has no per-hero breakdown. */
  teamDps?: number;
  party: IngestRunHero[];
  meta?: {
    meterVersion?: string;
    mode?: string;
    stage?: string;
    totalDamage?: number;
    durationMs?: number;
    mobs?: number;
    totalMobs?: number;
    goldGained?: number;
    goldPerSec?: number;
    xpGained?: number;
    xpPerSec?: number;
    normalChests?: number;
    bossChests?: number;
    actBossChests?: number;
  };
}
interface IngestRunResponse {
  id: string;
  duplicate: boolean;
}
interface ApiErrorBody {
  error: { code: string; message: string };
}

function uploadsPath(): string {
  return join(app.getPath("userData"), "uploads.json");
}

function readUploads(): UploadMap {
  const path = uploadsPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as UploadMap) : {};
  } catch {
    return {};
  }
}

function writeUploads(map: UploadMap): void {
  try {
    writeFileSync(uploadsPath(), JSON.stringify(map, null, 2), "utf-8");
  } catch {
    // best effort — never crash on an uploads write failure
  }
}

export function getShareStatus(runId: string): { sharedUrl: string | null } {
  const entry = readUploads()[runId];
  return { sharedUrl: entry?.url ?? null };
}

/** Whether a run already has an uploads.json entry (the dedup record). Used by the
 *  auto-uploader to skip runs that were already shared (manually or automatically). */
export function isUploaded(runId: string): boolean {
  return readUploads()[runId] != null;
}

// --------------------------------------------------------------------------- //
// RunRecord -> IngestRunBody mapping.
//
// Times: runs-source normalizes clear_time and duration to SECONDS in every
// schema era, so we convert to integer milliseconds here. clearTimeMs must be a
// positive integer; if the official clear time is missing/zero we fall back to
// the measured duration.
//
// Per-hero dps/damage: the meter does NOT break damage down per hero (RunHero has
// no dps/damage field), so each party member sends 0; the run totals go in meta.
// skillLevels/gear: mapped via ingest-map.ts (skillKey -> attributeKey; RunItem ->
// planner gear slot), so the website's run page renders the full build like a saved
// build. runeKeys is still omitted — the reader does not capture runes yet.
// --------------------------------------------------------------------------- //

function mapHero(hero: RunHero): IngestRunHero {
  const classType = hero.class && hero.class.trim() !== "" ? hero.class.slice(0, 40) : "Unknown";
  const out: IngestRunHero = {
    heroKey: Math.max(0, Math.trunc(hero.heroKey)),
    classType,
    dps: 0,
    damage: 0,
  };
  if (typeof hero.slot === "number") out.slot = hero.slot;
  if (Number.isFinite(hero.level) && hero.level >= 1) {
    out.level = Math.min(99999, Math.trunc(hero.level));
  }
  // v8 runs carry the full invested tree (skillLevels, already keyed by attributeKey);
  // older runs only have equipped `skills`, which mapSkillLevels resolves to that shape.
  const skillLevels =
    hero.skillLevels && Object.keys(hero.skillLevels).length > 0
      ? hero.skillLevels
      : mapSkillLevels(hero.skills);
  if (skillLevels && Object.keys(skillLevels).length > 0) out.skillLevels = skillLevels;
  const gear = mapGear(hero.items);
  if (gear) out.gear = gear;
  // The reader's live FINAL stats (keyed by StatType id) — uploaded so the site can show the
  // real in-game values instead of recomputing them from the build.
  if (hero.stats && Object.keys(hero.stats).length > 0) out.stats = hero.stats;
  return out;
}

/** Count a run's chest drops by EMonsterLogType (0 common, 1 stage boss, 2 act boss).
 *  Returns null when the run predates drop capture (reader schema < 10) so the
 *  fields are omitted rather than reported as a false zero. */
function countChests(drops: RunDrop[] | undefined): { normal: number; boss: number; actBoss: number } | null {
  if (!drops) return null;
  const out = { normal: 0, boss: 0, actBoss: 0 };
  for (const d of drops) {
    if (d.monsterType === 0) out.normal++;
    else if (d.monsterType === 1) out.boss++;
    else if (d.monsterType === 2) out.actBoss++;
  }
  return out;
}

// Sanity window mirroring the API schema bounds (2020..2100). A run.ts outside
// it (corrupt record / wrong clock) is omitted rather than failing the whole
// upload with a permanent 400.
const ENDED_AT_MIN_MS = 1_577_836_800_000;
const ENDED_AT_MAX_MS = 4_102_444_800_000;

/** Exported for tests only — production callers go through shareRun/uploadRun. */
export function buildPayload(run: RunRecord): IngestRunBody {
  const clearSec = run.clearTime > 0 ? run.clearTime : run.duration;
  const clearTimeMs = Math.max(1, Math.round(clearSec * 1000));

  // `ts` is the run's end time. v2 emits epoch MS; legacy v1 is seconds — tsToMs unifies to ms
  // (idempotent), so this is correct whether `run` came normalized from RunsSource or straight off a log.
  const endedAtMs = Number.isFinite(run.ts) ? tsToMs(run.ts) : NaN;
  const endedAt =
    endedAtMs >= ENDED_AT_MIN_MS && endedAtMs <= ENDED_AT_MAX_MS ? endedAtMs : undefined;

  const party = run.heroes.slice(0, 3).map(mapHero);
  const chests = countChests(run.drops);

  const meta: NonNullable<IngestRunBody["meta"]> = {
    meterVersion: app.getVersion().slice(0, 40),
    mode: run.mode ? run.mode.slice(0, 40) : undefined,
    stage: run.stage ? run.stage.slice(0, 100) : undefined,
    totalDamage: run.totalDamage >= 0 ? run.totalDamage : undefined,
    durationMs: run.duration > 0 ? Math.round(run.duration * 1000) : undefined,
    mobs: run.mobs >= 0 ? Math.trunc(run.mobs) : undefined,
    totalMobs: run.totalMobs != null && run.totalMobs >= 0 ? Math.trunc(run.totalMobs) : undefined,
    goldGained: run.goldGained >= 0 ? run.goldGained : undefined,
    goldPerSec: run.goldPerSec >= 0 ? run.goldPerSec : undefined,
    xpGained: run.xpGained >= 0 ? run.xpGained : undefined,
    xpPerSec: run.xpPerSec >= 0 ? run.xpPerSec : undefined,
    normalChests: chests ? chests.normal : undefined,
    bossChests: chests ? chests.boss : undefined,
    actBossChests: chests ? chests.actBoss : undefined,
  };

  // external_id = the leaderboard's idempotency/dedup key. v2: the run id is the end-ts, unique only
  // PER MACHINE -> prefix the device so it's globally unique (`device:ts`). v1/legacy: keep the
  // original `session:run` verbatim so an already-uploaded run is never re-uploaded under a new id.
  const externalId = (run.schemaVersion === 2 ? `${getDeviceId()}:${run.id}` : run.id).slice(0, 200);

  return {
    externalId,
    // The app-derived grind label (v2) / legacy session id (v1) — the site's session view groups by it.
    session: run.sessionId ? run.sessionId.slice(0, 190) : undefined,
    stageKey: run.stageKey as number,
    gameVersion: run.gameVersion && run.gameVersion.trim() !== "" ? run.gameVersion.slice(0, 40) : "unknown",
    clearTimeMs,
    endedAt,
    teamDps: Number.isFinite(run.dps) && run.dps >= 0 ? run.dps : undefined,
    party,
    meta,
  };
}

/**
 * Upload one RunRecord to the leaderboard. Shared by the manual shareRun(runId)
 * flow and the background auto-uploader (see auto-upload.ts) so the validation +
 * mapping + upload logic lives in one place. Records the resulting public URL in
 * uploads.json on success, which is also the dedup record for the auto-uploader.
 */
export async function uploadRun(run: RunRecord): Promise<ShareResult> {
  if (run.status !== "success") {
    return { ok: false, code: "bad_request", message: "Only successful runs can be shared." };
  }
  if (run.totalDamage <= 0) {
    // A success with zero measured damage is a missed capture (short boss runs
    // could slip past the reader's partial flag — issue #163); the API rejects
    // these too, so don't even send them.
    return {
      ok: false,
      code: "bad_request",
      message: "This run has no recorded damage and cannot be shared.",
    };
  }
  if (run.stageKey == null) {
    return {
      ok: false,
      code: "bad_request",
      message: "This run has no stage id and cannot be shared.",
    };
  }
  if (run.heroes.length === 0) {
    return { ok: false, code: "bad_request", message: "This run has no party data to share." };
  }

  // Upload REQUIRES sign-in (Phase 2): only an attributed, signed request reaches
  // the leaderboard. Signed out = a clean "sign in to sync" state, never an
  // anonymous upload — the old X-Device-Id ingest path is gone. (device-id.ts +
  // POST /runs/claim stay, to claim any legacy anonymous runs on a later sign-in.)
  const token = await getAccessToken();
  if (!token) {
    return { ok: false, code: "unauthorized", message: "Sign in with Discord to sync runs." };
  }

  const payload = buildPayload(run);
  // Serialize ONCE: the SAME string is both hashed (for X-Signature) and sent as
  // the body. Re-stringifying would risk a hash/body mismatch → a 401 on every
  // signed request once the API enforces signatures. See request-signer.ts.
  const bodyString = JSON.stringify(payload);
  const endpoint = `${API_URL}/runs`;

  // POST the run with a given bearer. A fresh X-Signature is computed per attempt
  // (timestamp + nonce must be current; the body string is constant), so the retry
  // after a refresh is a fully valid signed request — not a replay.
  const postRun = (bearer: string): Promise<GlobalResponse> =>
    httpFetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
        // Ed25519 request signature (always-on; ignored by the API until its flag flips).
        ...signRequest("POST", endpoint, bodyString),
      },
      body: bodyString,
    });

  let res: GlobalResponse;
  try {
    res = await postRun(token);

    // 401 = the access token expired / was rejected. With refresh tokens, this is
    // recoverable: refresh ONCE (single-flight in auth.ts, so a concurrent
    // getAccessToken refresh is shared, never doubled) and retry the upload exactly
    // once with the new token. Only if there's no refresh token (legacy session) or
    // the refresh itself fails do we fall through to the terminal 401 handling below.
    // (No loop: a second 401 after a successful refresh is terminal.)
    if (res.status === 401 && (await refreshAccessToken())) {
      const refreshed = await getAccessToken();
      if (refreshed) res = await postRun(refreshed);
    }
  } catch (err) {
    // The transport reason (AV TLS interception, proxy, DNS) is buried in
    // err.cause — surface its message + code so the Discord report is diagnosable
    // instead of just "fetch failed".
    const cause = describeCause(err);
    reportError("share:upload-network", err, {
      externalId: payload.externalId,
      causeCode: cause.code,
      causeMessage: cause.message,
    });
    const detail = err instanceof Error ? err.message : "unknown";
    const causeSuffix = cause.message ? ` (${cause.code ?? "cause"}: ${cause.message})` : "";
    return {
      ok: false,
      code: "network",
      message: `Network error: ${detail}${causeSuffix}`,
    };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const errBody = body as ApiErrorBody | null;
    // A 401 still here means the session is genuinely dead: either there was no
    // refresh token (legacy ~30d HS256 token expired) or the refresh + retry above
    // already failed. Terminal for the session: clear it as "expired" (broadcasts
    // meter:session-expired so the renderer prompts a re-sign-in instead of going
    // silently OFFLINE) + ping telemetry (the 401 is suppressed from the relay
    // below). The run is NOT marked failed — it stays queued and uploads on the
    // next sign-in.
    //
    // ONLY 401 clears the session. A run-signature rejection comes back as 403
    // (signature.ts), NOT 401 — a bad/expired/clock-skewed signature on an
    // otherwise-valid token must not sign the user out. (It used to: the API
    // returned 401 for signature failures, so a logged-in meter went OFFLINE the
    // moment a signature tripped — the 2026-06-19 regression. 403 is handled below
    // by auto-upload as terminal-for-this-attempt, with the session left intact.)
    if (res.status === 401) {
      clearSession("expired");
      reportError(SESSION_EXPIRED_CONTEXT, SESSION_EXPIRED_MESSAGE, {
        externalId: payload.externalId,
        status: 401,
      });
    }
    // Relay only actionable (client-side) failures; transient/infra ones are
    // already retried by auto-upload and would just be noise. See helper.
    if (isReportableUploadFailure(res.status)) {
      reportError("share:upload-failed", errBody?.error ?? `HTTP ${res.status} (non-JSON body)`, {
        status: res.status,
        externalId: payload.externalId,
      });
    }
    return {
      ok: false,
      code: errBody?.error?.code ?? "internal",
      message: errBody?.error?.message ?? `Upload failed (HTTP ${res.status}).`,
    };
  }

  const data = body as IngestRunResponse | null;
  if (!data?.id) {
    reportError("share:upload-no-id", "Upload succeeded but no run id was returned.", {
      status: res.status,
      externalId: payload.externalId,
    });
    return { ok: false, code: "internal", message: "Upload succeeded but no run id was returned." };
  }

  const url = `${SITE_URL}/leaderboards/${data.id}`;
  const map = readUploads();
  map[run.id] = { id: data.id, url, sharedAt: Date.now() };
  writeUploads(map);

  return { ok: true, url, duplicate: Boolean(data.duplicate) };
}

export async function shareRun(runId: string): Promise<ShareResult> {
  const run = getRun(runId);
  if (!run) {
    return { ok: false, code: "not_found", message: "Run not found." };
  }
  return uploadRun(run);
}

/**
 * Re-attribute this install's anonymous uploads to the signed-in account
 * (POST /runs/claim). Fired on every sign-in event; idempotent server-side
 * (claimed rows lose their device hash), so repeats are a cheap no-op.
 * Best-effort: a failure only delays the claim to the next sign-in/start.
 */
export async function claimDeviceRuns(): Promise<void> {
  const token = await getAccessToken();
  if (!token) return;
  try {
    // Claim is Bearer-only (the JWT is the real lock) and unsigned: it only re-attributes
    // the caller's own legacy anonymous runs, and request signing is scoped to the run
    // ingest path (POST /runs). Don't sign here — the API never verifies it on /claim.
    const postClaim = (bearer: string): Promise<GlobalResponse> =>
      httpFetch(`${API_URL}/runs/claim`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({ deviceId: getDeviceId() }),
      });

    let res = await postClaim(token);
    // Same recoverable-401 path as uploadRun: refresh once (single-flight) and retry
    // before treating the session as dead.
    if (res.status === 401 && (await refreshAccessToken())) {
      const refreshed = await getAccessToken();
      if (refreshed) res = await postClaim(refreshed);
    }

    if (res.ok) {
      const data = (await res.json().catch(() => null)) as { claimed?: number } | null;
      if (data?.claimed) console.log(`[share] claimed ${data.claimed} anonymous run(s)`);
    } else {
      // A 401 still here means the session is dead: no refresh token (legacy token
      // expired / JWT_SECRET rotated) or the refresh + retry above failed. Treat the
      // session as gone, surface it (claim runs at startup, so this is often the FIRST
      // path to detect a dead restored token), and ping telemetry.
      if (res.status === 401) {
        clearSession("expired");
        reportError(SESSION_EXPIRED_CONTEXT, SESSION_EXPIRED_MESSAGE, { phase: "claim" });
      }
      console.warn(`[share] claim failed (HTTP ${res.status})`);
    }
  } catch (err) {
    console.warn(
      `[share] claim network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
