// Per-chest-type DROP notifier — fires an OS notification the moment a chest of an
// enabled type drops, for ANY stage. Independent of the blue-chest cooldown tracker
// (cooldown-tracker.ts): it is NOT gated by cooldownTrackerEnabled, owns its own
// per-(stage,type) baseline, and only fires on a true rising edge (never the first
// observation of a stage). The reader emits all three counters in live `drops`:
// [common(0), stageBoss/blue(1), actBoss(2)].

import { Notification } from "electron";
import type { LiveSnapshot } from "../shared/run-types.js";
import type { AppSettings } from "../shared/ipc-types.js";
import type { DictKey } from "../shared/i18n/index.js";
import { getSettings } from "./settings.js";
import { getLiveSource } from "./sources/live-source.js";
import { tMain } from "./i18n.js";
import { observeRisingEdge, type SeenCounts } from "./chest-cooldown.js";

/** A chest type the reader counts in live `drops`, with the setting flag that gates its
 *  notification and the i18n keys for its message. */
interface ChestType {
  /** Index into LiveSnapshot.drops: [common(0), stageBoss(1), actBoss(2)]. */
  index: number;
  /** Key into AppSettings.chestDropNotify. */
  setting: keyof AppSettings["chestDropNotify"];
  titleKey: DictKey;
  bodyKey: DictKey;
}

const CHEST_TYPES: ChestType[] = [
  { index: 0, setting: "common", titleKey: "notifications.commonTitle", bodyKey: "notifications.commonBody" },
  { index: 1, setting: "stageBoss", titleKey: "notifications.stageBossTitle", bodyKey: "notifications.stageBossBody" },
  { index: 2, setting: "actBoss", titleKey: "notifications.actBossTitle", bodyKey: "notifications.actBossBody" },
];

// Ephemeral (NOT persisted): one per-stage last-seen count per chest type, for rising-edge
// detection. Keyed by chest index so the three types stay independent on the same stage.
const seenByType = new Map<number, SeenCounts>();

function seenFor(index: number): SeenCounts {
  let seen = seenByType.get(index);
  if (!seen) {
    seen = new Map();
    seenByType.set(index, seen);
  }
  return seen;
}

/** Wire the notifier once (from registerIpcHandlers): subscribe to the live stream. */
export function initDropNotifier(): void {
  getLiveSource().on("live", onLive);
}

function onLive(snap: LiveSnapshot | null): void {
  if (!snap) return;
  const stageKey = snap.stageKey;
  if (stageKey == null) return;
  const drops = snap.drops;
  if (!drops) return;
  const enabled = getSettings().chestDropNotify;
  for (const type of CHEST_TYPES) {
    const count = drops[type.index];
    if (typeof count !== "number") continue;
    // Always feed the baseline (even when this type's notification is off) so the count is
    // tracked: a rising edge while the type is OFF must not later read as a fresh drop when
    // re-enabled. observeRisingEdge never fires on the first observation of a stage.
    const rose = observeRisingEdge(seenFor(type.index), stageKey, count);
    if (rose && enabled[type.setting]) notify(snap, type);
  }
}

/** Fire one OS notification for a dropped chest, localized via the type's title/body keys. */
function notify(snap: LiveSnapshot, type: ChestType): void {
  if (!Notification.isSupported()) return;
  const where = snap.mode ? `${snap.stage} · ${snap.mode}` : snap.stage;
  new Notification({
    title: tMain(type.titleKey),
    body: tMain(type.bodyKey, { where }),
  }).show();
}
