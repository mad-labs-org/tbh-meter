import React from "react";
import { AbsoluteFill, Img, getInputProps, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { TransitionSeries, springTiming } from "@remotion/transitions";
import { ScrollText, Zap, Coins, Star, Search, Crown, Sparkles, DollarSign } from "lucide-react";
import {
  FPS, C, GRAD, SANS, MONO, clamp, ease, fmt, clock, CountUp, Cursor, useTyped,
  Bg, Wordmark, Caption, AppWindow, DiffPill, dissolve,
} from "./kit";

const T = (d: number, fps: number, f: number, dmp = 200) => spring({ frame: f - d, fps, config: { damping: dmp } });
const ITEMS = ["Item_110001", "Item_110002", "Item_110003", "Item_111001", "Item_111002", "Item_112001", "Item_112002", "Item_112003", "Item_113001", "Item_110004", "Item_111003", "Item_112004"];
const HEROES = [101, 201, 301];
const sprite = (n: string) => <Img src={staticFile(`sprites/${n}.png`)} style={{ width: "100%", height: "100%", imageRendering: "pixelated" as const, display: "block" }} />;

// ============================================================ 1. INTRO
export const Intro: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const word = (d: number) => { const s = T(d, fps, f); return { display: "inline-block", opacity: s, transform: `translateY(${interpolate(s, [0, 1], [46, 0])}px)` }; };
  const lineW = interpolate(f, [18, 44], [0, 380], { ...clamp, easing: ease });
  const sub = T(22, fps, f);
  const glow = 24 + 14 * Math.sin(f * 0.12);
  const version = String((getInputProps() as { version?: string }).version || "");
  const kicker = version ? `WHAT'S NEW · ${version}` : "THE COMMUNITY TOOLSET";
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, letterSpacing: 8, color: version ? C.b400 : C.z500, ...word(0) }}>{kicker}</div>
      <div style={{ marginTop: 22, fontSize: 142, fontWeight: 800, letterSpacing: -3, color: C.text, lineHeight: 1 }}>
        <span style={word(6)}>Task&nbsp;Bar&nbsp;</span>
        <span style={{ ...word(12), background: GRAD, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent", filter: `drop-shadow(0 0 ${glow}px rgba(116,133,255,0.5))` }}>Helper</span>
      </div>
      <div style={{ marginTop: 16, height: 4, width: lineW, background: GRAD, borderRadius: 2 }} />
      <div style={{ marginTop: 28, fontSize: 31, color: C.z400, fontWeight: 500, opacity: sub, transform: `translateY(${interpolate(sub, [0, 1], [16, 0])}px)` }}>everything for Task Bar Hero, in one place</div>
    </AbsoluteFill>
  );
};

// ============================================================ 2. LIVE METER — recreated, ANIMATED, real sprites, glows
const Box: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 9, padding: "13px 16px", borderRadius: 11, background: "rgba(18,19,31,0.75)", border: `1px solid ${C.s600}`, fontFamily: MONO, fontSize: 19 }}>{children}</div>
);
const LiveOverlay: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const mobs = Math.round(interpolate(f, [0, 165], [384, 652], clamp));
  const dps = 107260 + 7000 * Math.sin(f * 0.4) + 3500 * Math.sin(f * 1.1 + 1);
  const dmg = 11_000_000 + (f / FPS) * 107000;
  const goldS = 13800 * (1 + 0.04 * Math.sin(f * 0.6));
  const xpS = 239630 * (1 + 0.04 * Math.sin(f * 0.5 + 1));
  const elapsed = Math.round(108 + f / FPS);
  const liveDot = 0.45 + 0.45 * Math.sin(f * 0.35);
  const bluePop = spring({ frame: f - 66, fps, config: { damping: 10, mass: 0.5 } });
  const cd2 = Math.max(0, 58 - f / FPS);
  const cds = [{ lv: 40, st: "1-9", d: "NM" as const, spots: "[1-9~3-4]·15%", ready: true }, { lv: 80, st: "3-9", d: "TO" as const, spots: "[1-3~3-9]·8%", ready: false }];
  return (
    <div style={{ width: 1000, fontFamily: MONO, borderRadius: 16, overflow: "hidden", border: `1px solid ${C.b600}66`, background: "rgba(13,14,26,0.96)", boxShadow: "0 50px 140px rgba(0,0,0,0.75), 0 0 150px rgba(79,93,255,0.2)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", borderBottom: `1px solid ${C.s700}` }}>
        <span style={{ display: "flex", gap: 7 }}><span style={{ width: 14, height: 14, borderRadius: 99, background: "rgba(248,113,113,0.85)" }} /><span style={{ width: 14, height: 14, borderRadius: 99, background: "rgba(52,211,153,0.85)" }} /></span>
        <span style={{ fontSize: 22, fontWeight: 800, color: C.text }}>3-9</span><DiffPill d="TORMENT" />
        <span style={{ flex: 1 }} />
        <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 16, fontWeight: 700, letterSpacing: 1, color: C.b300 }}><span style={{ width: 9, height: 9, borderRadius: 99, background: C.b300, opacity: liveDot, boxShadow: `0 0 ${10 * liveDot}px ${C.b300}` }} />LIVE</span>
      </div>
      <div style={{ padding: "18px 20px 14px" }}>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <span style={{ fontSize: 16, letterSpacing: 3, color: C.z500 }}>DPS</span>
          <span style={{ fontSize: 52, fontWeight: 800, color: C.b300, textShadow: `0 0 ${20 + 12 * Math.sin(f * 0.3)}px rgba(116,133,255,0.65)` }}>{fmt(dps)}</span>
        </div>
        <div style={{ marginTop: 10, height: 9, borderRadius: 99, background: C.s600, overflow: "hidden" }}><div style={{ height: "100%", width: `${(mobs / 652) * 100}%`, borderRadius: 99, background: `linear-gradient(90deg, ${C.b600}, ${C.b400})` }} /></div>
        <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", fontSize: 17, color: C.z400 }}><span>MOBS {mobs}/652</span><span style={{ color: C.z300 }}>{fmt(dmg)}</span></div>
      </div>
      <div style={{ display: "flex", gap: 10, padding: "0 20px 14px" }}>
        <Box><span style={{ color: C.z500 }}>GOLD</span><span style={{ color: C.amber, fontWeight: 700 }}>{fmt(goldS)}/s</span></Box>
        <Box><span style={{ color: C.z500 }}>EXP</span><span style={{ color: C.emerald, fontWeight: 700 }}>{fmt(xpS)}/s</span></Box>
        <Box>
          <span style={{ color: C.z500 }}>LOOT</span>
          <span style={{ width: 28, height: 28 }}>{sprite("Item_910011")}</span><span style={{ color: C.z400 }}>2×</span>
          <span style={{ width: 28, height: 28, transform: `scale(${interpolate(bluePop, [0, 1], [0.2, 1])})`, filter: `drop-shadow(0 0 ${12 * bluePop}px rgba(79,93,255,0.9))` }}>{sprite("Item_920011")}</span><span style={{ color: C.b300 }}>1×</span>
        </Box>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 20px 16px" }}>
        <span style={{ fontSize: 15, letterSpacing: 2, color: C.z500 }}>TEAM</span>
        {HEROES.map((h) => <span key={h} style={{ width: 34, height: 34, borderRadius: 7, overflow: "hidden", background: C.s800, border: `1px solid ${C.s600}` }}>{sprite(`Hero_${h}`)}</span>)}
        <span style={{ flex: 1 }} /><span style={{ fontSize: 17, color: C.z400 }}>TIME {elapsed}s</span>
      </div>
      {cds.map((c, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 20px", borderTop: `1px solid ${c.ready ? "rgba(16,185,129,0.4)" : C.s700}`, background: c.ready ? "rgba(16,185,129,0.08)" : "rgba(58,63,245,0.06)" }}>
          <span style={{ width: 30, height: 30 }}>{sprite("Item_920011")}</span>
          <span style={{ fontSize: 14, color: C.z400 }}>Lv{c.lv}</span><span style={{ fontSize: 19, fontWeight: 800, color: C.text }}>{c.st}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: c.d === "NM" ? C.sky300 : C.rose300 }}>{c.d}</span>
          <span style={{ flex: 1 }} /><span style={{ fontSize: 14, color: C.z500 }}>SPOTS {c.spots} {c.d}</span>
          {c.ready ? <span style={{ fontSize: 18, fontWeight: 800, color: C.emerald300, textShadow: `0 0 9px rgba(16,185,129,${0.4 + 0.35 * Math.sin(f * 0.4)})` }}>✓ READY</span> : <span style={{ fontSize: 20, fontWeight: 800, color: C.text, width: 96, textAlign: "right" }}>{clock(cd2)}</span>}
        </div>
      ))}
    </div>
  );
};
const SceneLive: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const e = T(2, fps, f);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <Wordmark />
      <div style={{ transform: `translateY(${interpolate(e, [0, 1], [40, 0])}px) scale(${interpolate(e, [0, 1], [0.94, 1])})`, opacity: e }}><LiveOverlay /></div>
      <Caption index="01" kicker="TBH Meter" title="See your run, live." sub="DPS, loot and the blue-chest cooldown, the moment it happens." />
    </AbsoluteFill>
  );
};

// ============================================================ 3. CHEST TRACKER (v0.33.0 — per-level cooldowns, a pinned route, a configurable timer)
// Cooldowns are keyed by chest LEVEL (the box), not stage — the same Lv80 chest across 1-3, 3-9, …
// is ONE cooldown. The route is the levels you pin to always track; the timer is configurable
// (13-min default). Real data: blue-box levels + cross-mode farm spots from data/stages.json.
export const COOLDOWN_MIN = 13;
const ROUTE_LEVELS = [4, 5, 7, 15, 20, 30, 40, 50, 65, 80];
const PINNED = [50, 65, 80];
export type Mode = "HELL" | "NIGHTMARE" | "TORMENT" | "NORMAL";
export const MODE_ABBR: Record<Mode, string> = { NORMAL: "NO", NIGHTMARE: "NM", HELL: "HE", TORMENT: "TO" };
export const MODE_COLOR: Record<Mode, string> = { NORMAL: C.z300, NIGHTMARE: C.sky300, HELL: C.amber300, TORMENT: C.rose300 };
export type Spot = { m: Mode; seg: string };
export type Box = { lv: number; rem: number; spots: Spot[] };
// Sorted soonest-ready first: a pinned-but-not-yet-dropped level shows as "available" (rem 0) on top.
export const BOXES: Box[] = [
  { lv: 80, rem: 0, spots: [{ m: "TORMENT", seg: "[1-3~3-9]·8%" }] },
  { lv: 65, rem: 7 * 60 + 41, spots: [{ m: "HELL", seg: "[2-5~3-9]·10%" }, { m: "TORMENT", seg: "[1-1~1-2]·8%" }] },
  { lv: 50, rem: 11 * 60 + 18, spots: [{ m: "NIGHTMARE", seg: "[3-5~3-9]·15%" }, { m: "HELL", seg: "[1-1~2-4]·10%" }] },
];

export const Spots: React.FC<{ spots: Spot[] }> = ({ spots }) => (
  <span style={{ fontFamily: MONO, fontSize: 16 }}>
    {spots.map((s, i) => (
      <span key={s.m} style={{ marginLeft: i ? 14 : 0 }}>
        <span style={{ color: C.text, fontWeight: 700 }}>{s.seg}</span>{" "}
        <span style={{ color: MODE_COLOR[s.m], fontWeight: 700, letterSpacing: 1 }}>{MODE_ABBR[s.m]}</span>
      </span>
    ))}
  </span>
);

// One per-level chest card: a draining sky fill = REMAINING (or full emerald when available/ready),
// the chest + "Lv80" label, its cross-mode farm spots, and the countdown / AVAILABLE state.
const ChestCard: React.FC<{ c: Box; delay: number }> = ({ c, delay }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = T(delay, fps, f);
  const available = c.rem <= 0;
  const rem = available ? 0 : Math.max(0, c.rem - f / FPS);
  const ready = rem <= 0;
  const lit = available || ready;
  const frac = available ? 1 : Math.max(0, Math.min(1, rem / (COOLDOWN_MIN * 60)));
  const pulse = 0.35 + 0.35 * Math.sin(f * 0.4);
  return (
    <div style={{ position: "relative", overflow: "hidden", borderRadius: 12, border: `1px solid ${lit ? "rgba(16,185,129,0.5)" : C.s600}`, background: lit ? "rgba(16,185,129,0.06)" : C.s800, opacity: s, transform: `translateX(${interpolate(s, [0, 1], [-20, 0])}px)` }}>
      <div style={{ position: "absolute", insetBlock: 0, left: 0, width: `${(lit ? 1 : frac) * 100}%`, background: lit ? "rgba(16,185,129,0.12)" : "rgba(56,189,248,0.15)" }} />
      <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 16, padding: "13px 18px" }}>
        <span style={{ width: 46, height: 46, flexShrink: 0, filter: lit ? `drop-shadow(0 0 9px rgba(16,185,129,0.55))` : "none" }}>{sprite("Item_920011")}</span>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 25, fontWeight: 800, color: C.text }}>Lv{c.lv}</span>
            <span style={{ flex: 1 }} />
            {available ? <span style={{ fontFamily: MONO, fontSize: 19, fontWeight: 800, letterSpacing: 2, color: C.emerald300, textShadow: `0 0 9px rgba(16,185,129,${pulse})` }}>AVAILABLE</span>
              : ready ? <span style={{ fontFamily: MONO, fontSize: 21, fontWeight: 800, color: C.emerald300, textShadow: `0 0 9px rgba(16,185,129,${pulse})` }}>✓ READY</span>
                : <span style={{ fontFamily: MONO, fontSize: 27, fontWeight: 800, color: C.sky300 }}>{clock(rem)}</span>}
          </div>
          <Spots spots={c.spots} />
        </div>
      </div>
    </div>
  );
};

// The route picker: a chip per chest level, pinned ones lit (brand). Pinned chips pop in slightly
// later to read as "you pinned these".
const RouteChip: React.FC<{ lv: number; on: boolean; delay: number }> = ({ lv, on, delay }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = T(delay, fps, f);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, borderRadius: 7, border: `1px solid ${on ? "rgba(79,93,255,0.7)" : C.s600}`, background: on ? "rgba(58,63,245,0.18)" : C.s800, padding: "5px 9px", fontFamily: MONO, fontSize: 16, fontWeight: 700, color: on ? C.b300 : C.z500, opacity: s, transform: `scale(${interpolate(s, [0, 1], [0.6, 1])})` }}>
      <span style={{ width: 18, height: 18 }}>{sprite("Item_920011")}</span>Lv{lv}
    </span>
  );
};

export const SceneChest: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const e = T(2, fps, f);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <Wordmark />
      <div style={{ transform: `translateY(${interpolate(e, [0, 1], [40, 0])}px) scale(${interpolate(e, [0, 1], [0.95, 1])})`, opacity: e }}>
        <AppWindow label="TBH Meter — Blue-chest Tracker" w={1080}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 24 }}>
            {/* Header: title + the configurable timer + the master toggle (ON). */}
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ fontSize: 19, fontWeight: 800, color: C.text }}>Blue-chest tracker</span>
                <span style={{ fontSize: 14, color: C.z500 }}>Auto-detects drops, tracks each chest level's cooldown.</span>
              </div>
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 700, letterSpacing: 1, color: C.b300, border: `1px solid ${C.b600}66`, background: "rgba(58,63,245,0.12)", borderRadius: 6, padding: "5px 10px" }}>TIMER {COOLDOWN_MIN} MIN</span>
              <span style={{ position: "relative", width: 38, height: 20, borderRadius: 99, background: C.b600 }}><span style={{ position: "absolute", top: 2, left: 20, width: 16, height: 16, borderRadius: 99, background: "#fff" }} /></span>
            </div>
            {/* Route: pin the chest levels you farm — pinned ones show even before a drop. */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, letterSpacing: 2, textTransform: "uppercase", color: C.z500 }}>Route · pin the levels you farm</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                {ROUTE_LEVELS.map((lv, i) => {
                  const on = PINNED.includes(lv);
                  return <RouteChip key={lv} lv={lv} on={on} delay={10 + i * 3 + (on ? 14 : 0)} />;
                })}
              </div>
            </div>
            {/* The tracked chests: pinned-available on top, then live cooldowns, soonest first. */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {BOXES.map((c, i) => <ChestCard key={c.lv} c={c} delay={48 + i * 12} />)}
            </div>
          </div>
        </AppWindow>
      </div>
      <Caption index="01" kicker="Chest Tracker" title="One cooldown per chest level." sub="Pin a farming route, set your own timer. The same chest across every stage counts once." />
    </AbsoluteFill>
  );
};

// ============================================================ 4. SESSIONS
const RUNS = [
  { t: "21:14", stage: "3-9", d: "TORMENT" as const, dps: "115.0K", gold: "1.83M" },
  { t: "21:06", stage: "3-9", d: "TORMENT" as const, dps: "121.4K", gold: "1.91M" },
  { t: "20:58", stage: "3-9", d: "HELL" as const, dps: "104.2K", gold: "1.62M" },
  { t: "20:49", stage: "2-9", d: "HELL" as const, dps: "98.7K", gold: "1.44M" },
];
const Stat: React.FC<{ Icon: any; c: string; label: string; to: number; fmtFn?: (n: number) => string; delay: number }> = ({ Icon, c, label, to, fmtFn, delay }) => (
  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 7, padding: "16px 18px", borderRadius: 12, background: C.s800, border: `1px solid ${C.s600}` }}>
    <span style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: MONO, fontSize: 13, letterSpacing: 1, textTransform: "uppercase", color: C.z500 }}><Icon style={{ width: 16, height: 16, color: c }} />{label}</span>
    <CountUp to={to} start={delay} dur={48} format={fmtFn} style={{ fontSize: 36, fontWeight: 800, color: C.text }} />
  </div>
);
const SceneSessions: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const e = T(2, fps, f);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <Wordmark />
      <div style={{ transform: `translateY(${interpolate(e, [0, 1], [40, 0])}px) scale(${interpolate(e, [0, 1], [0.95, 1])})`, opacity: e }}>
        <AppWindow label="TBH Meter — Session" w={1120}>
          <div style={{ display: "flex", flexDirection: "column", gap: 18, padding: 22 }}>
            <div style={{ display: "flex", gap: 12 }}>
              <Stat Icon={ScrollText} c={C.b400} label="Runs" to={357} delay={10} />
              <Stat Icon={Zap} c={C.b400} label="Damage" to={11.75e9} fmtFn={fmt} delay={14} />
              <Stat Icon={Coins} c={C.amber} label="Gold" to={4.9e8} fmtFn={fmt} delay={18} />
              <Stat Icon={Star} c={C.sky} label="XP" to={1.3e8} fmtFn={fmt} delay={22} />
            </div>
            <div style={{ borderRadius: 12, border: `1px solid ${C.s600}`, overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "11px 18px", fontFamily: MONO, fontSize: 13, letterSpacing: 1, textTransform: "uppercase", color: C.z500, background: C.s800 }}>
                <span style={{ width: 70 }}>Time</span><span style={{ width: 130 }}>Stage</span><span style={{ flex: 1 }}>Team</span><span style={{ width: 110, textAlign: "right" }}>DPS</span><span style={{ width: 110, textAlign: "right" }}>Gold</span>
              </div>
              {RUNS.map((r, i) => {
                const s = T(30 + i * 10, fps, f);
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 16, padding: "12px 18px", borderTop: `1px solid ${C.s700}`, opacity: s, transform: `translateY(${interpolate(s, [0, 1], [12, 0])}px)`, fontFamily: MONO, fontSize: 18 }}>
                    <span style={{ width: 70, color: C.z500 }}>{r.t}</span>
                    <span style={{ width: 130, display: "flex", alignItems: "center", gap: 8 }}><span style={{ color: C.text, fontWeight: 700 }}>{r.stage}</span><DiffPill d={r.d} /></span>
                    <span style={{ flex: 1, display: "flex", gap: 5 }}>{HEROES.map((h) => <span key={h} style={{ width: 26, height: 26, borderRadius: 5, overflow: "hidden", background: C.s800 }}>{sprite(`Hero_${h}`)}</span>)}</span>
                    <span style={{ width: 110, textAlign: "right", color: C.b300, fontWeight: 700 }}>{r.dps}</span>
                    <span style={{ width: 110, textAlign: "right", color: C.amber, fontWeight: 700 }}>{r.gold}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </AppWindow>
      </div>
      <Caption index="03" kicker="Sessions" title="Every run, every session, kept." sub="Gold, XP, damage and DPS, tracked per run." />
    </AbsoluteFill>
  );
};

// ============================================================ 5. LEADERBOARD — recreated, with a zoom into #1
const LB = [
  { r: 1, name: "erK", time: "140s", dps: "148.3K" },
  { r: 2, name: "denny8126", time: "166s", dps: "121.4K" },
  { r: 3, name: "lizdwiz", time: "169s", dps: "119.7K" },
  { r: 4, name: "kkrios", time: "171s", dps: "118.0K" },
];
const SceneLeaderboard: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const e = T(2, fps, f);
  const zoom = interpolate(f, [120, 168], [1, 1.34], { ...clamp, easing: ease });
  const glow = 0.35 + 0.35 * Math.sin(f * 0.35);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <Wordmark />
      <div style={{ transform: `translateY(${interpolate(e, [0, 1], [40, 0])}px) scale(${interpolate(e, [0, 1], [0.95, 1]) * zoom})`, transformOrigin: "42% 34%", opacity: e }}>
        <AppWindow label="tbherohelper.com — Leaderboard" w={900}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 22px", borderBottom: `1px solid ${C.s700}` }}>
            <span style={{ fontSize: 22, fontWeight: 800, color: C.text }}>3-9</span><DiffPill d="TORMENT" /><span style={{ flex: 1 }} /><span style={{ fontFamily: MONO, fontSize: 14, color: C.z500 }}>fastest clears</span>
          </div>
          {LB.map((row, i) => {
            const s = T(14 + i * 11, fps, f);
            const top = row.r === 1;
            return (
              <div key={row.r} style={{ display: "flex", alignItems: "center", gap: 16, padding: "15px 22px", borderTop: i ? `1px solid ${C.s700}` : "none", background: top ? `rgba(245,158,11,${0.05 + 0.05 * glow})` : "transparent", opacity: s, transform: `translateX(${interpolate(s, [0, 1], [-18, 0])}px)`, boxShadow: top ? `inset 3px 0 0 ${C.amber300}` : "none" }}>
                <span style={{ width: 34, height: 34, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: MONO, fontWeight: 800, fontSize: 18, background: top ? "rgba(245,158,11,0.2)" : C.s800, color: top ? C.amber300 : C.z500 }}>{top ? <Crown style={{ width: 19, height: 19, filter: `drop-shadow(0 0 ${6 * glow}px ${C.amber300})` }} /> : row.r}</span>
                <span style={{ display: "flex", gap: 5 }}>{HEROES.map((h) => <span key={h} style={{ width: 22, height: 22, borderRadius: 5, overflow: "hidden", background: C.s800 }}>{sprite(`Hero_${h}`)}</span>)}</span>
                <span style={{ fontSize: 20, fontWeight: 600, color: top ? C.text : C.z300 }}>{row.name}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontFamily: MONO, fontSize: 22, fontWeight: 800, color: C.text }}>{row.time}</span>
                <span style={{ fontFamily: MONO, fontSize: 16, color: C.b300, width: 90, textAlign: "right" }}>{row.dps}</span>
              </div>
            );
          })}
        </AppWindow>
      </div>
      <Caption index="04" kicker="Leaderboard" title="Every clear, ranked worldwide." sub="Fastest 3-9 Torment: 140s, by erK. Auto-uploaded from the meter." />
    </AbsoluteFill>
  );
};

// ============================================================ 6. DATABASE — counters + search + real item grid
const SceneDatabase: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const e = T(2, fps, f);
  const { shown, done } = useTyped("fire damage", 16, 9);
  const counters: [number, string][] = [[5934, "items"], [197, "runes"], [130, "stages"], [286, "skills"]];
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <Wordmark />
      <div style={{ width: 1000, transform: `translateY(${interpolate(e, [0, 1], [30, 0])}px)`, opacity: e }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "20px 26px", borderRadius: 16, background: C.s800, border: `1px solid ${done ? C.b500 : C.s500}`, boxShadow: done ? "0 0 0 4px rgba(79,93,255,0.15)" : "none" }}>
          <Search style={{ width: 28, height: 28, color: C.z500 }} />
          <span style={{ fontSize: 31, fontWeight: 500, color: shown ? C.text : C.z500 }}>{shown || "Search items, runes, skills, stages..."}{!done && <Cursor />}</span>
        </div>
        <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12 }}>
          {ITEMS.map((it, i) => {
            const s = T(40 + i * 5, fps, f);
            return <span key={it} style={{ aspectRatio: "1", borderRadius: 12, background: C.s800, border: `1px solid ${C.s600}`, padding: 12, opacity: s, transform: `scale(${interpolate(s, [0, 1], [0.5, 1])})` }}>{sprite(it)}</span>;
          })}
        </div>
        <div style={{ marginTop: 26, display: "flex", justifyContent: "center", gap: 50 }}>
          {counters.map(([n, l], i) => (
            <span key={l} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <CountUp to={n} start={56 + i * 6} dur={42} style={{ fontFamily: MONO, fontSize: 34, fontWeight: 800, color: C.b300 }} />
              <span style={{ fontFamily: MONO, fontSize: 14, letterSpacing: 2, textTransform: "uppercase", color: C.z500 }}>{l}</span>
            </span>
          ))}
          <span style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <span style={{ fontFamily: MONO, fontSize: 34, fontWeight: 800, color: C.b300 }}>16</span>
            <span style={{ fontFamily: MONO, fontSize: 14, letterSpacing: 2, textTransform: "uppercase", color: C.z500 }}>languages</span>
          </span>
        </div>
      </div>
      <Caption index="05" kicker="Database" title="Every item, every drop." sub="5,934 items, searchable, in 16 languages." />
    </AbsoluteFill>
  );
};

// ============================================================ 7. BUILDS — heroes + rune slots filling in
const SceneBuilds: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const e = T(2, fps, f);
  const copy = T(120, fps, f, 180);
  const names = ["Sorcerer", "Priest", "Ranger"];
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <Wordmark />
      <div style={{ transform: `translateY(${interpolate(e, [0, 1], [40, 0])}px) scale(${interpolate(e, [0, 1], [0.95, 1])})`, opacity: e }}>
        <AppWindow label="tbherohelper.com — Build Planner" w={1000}>
          <div style={{ display: "flex", flexDirection: "column", gap: 18, padding: 24 }}>
            <div style={{ display: "flex", gap: 16 }}>
              {HEROES.map((h, i) => {
                const s = T(10 + i * 9, fps, f);
                return (
                  <div key={h} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12, padding: 16, borderRadius: 12, background: C.s800, border: `1px solid ${C.s600}`, opacity: s, transform: `translateY(${interpolate(s, [0, 1], [16, 0])}px)` }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}><span style={{ width: 42, height: 42, borderRadius: 9, overflow: "hidden", background: C.s900 }}>{sprite(`Hero_${h}`)}</span><span style={{ fontSize: 21, fontWeight: 700, color: C.text }}>{names[i]}</span></div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 7 }}>
                      {Array.from({ length: 12 }).map((_, j) => {
                        const rs = T(28 + i * 6 + j * 2, fps, f);
                        const it = ITEMS[(i * 4 + j) % ITEMS.length];
                        return <span key={j} style={{ aspectRatio: "1", borderRadius: 6, background: C.s900, border: `1px solid ${C.s600}`, padding: 3, opacity: rs, transform: `scale(${interpolate(rs, [0, 1], [0.3, 1])})` }}>{sprite(it)}</span>;
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontFamily: MONO, fontSize: 16, color: C.z500 }}>nightmare 3-10 · 3 heroes</span><span style={{ flex: 1 }} />
              <span style={{ display: "flex", alignItems: "center", gap: 9, padding: "11px 20px", borderRadius: 10, background: GRAD, color: "#fff", fontSize: 19, fontWeight: 700, opacity: copy, transform: `scale(${interpolate(copy, [0, 1], [0.9, 1])})` }}><Sparkles style={{ width: 18, height: 18 }} />Copy build</span>
            </div>
          </div>
        </AppWindow>
      </div>
      <Caption index="06" kicker="Build Planner" title="Plan and share your team." sub="Community builds, copied into the planner in one click." />
    </AbsoluteFill>
  );
};

// ============================================================ 8. PROFILE — market value count-up + formation
const SceneProfile: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const e = T(2, fps, f);
  const glow = 14 + 10 * Math.sin(f * 0.2);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <Wordmark />
      <div style={{ transform: `translateY(${interpolate(e, [0, 1], [40, 0])}px) scale(${interpolate(e, [0, 1], [0.95, 1])})`, opacity: e }}>
        <AppWindow label="tbherohelper.com — Profile" w={1040}>
          <div style={{ padding: 26 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
              <span style={{ width: 64, height: 64, borderRadius: 16, background: GRAD, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 30, fontWeight: 800, color: "#fff" }}>e</span>
              <span style={{ display: "flex", flexDirection: "column", gap: 4 }}><span style={{ fontSize: 32, fontWeight: 800, color: C.text }}>erK</span><span style={{ fontFamily: MONO, fontSize: 16, color: C.z500 }}>top run · 3-9 Torment · 140s</span></span>
              <span style={{ flex: 1 }} />
              <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                <span style={{ fontFamily: MONO, fontSize: 14, letterSpacing: 2, textTransform: "uppercase", color: C.z500 }}>Formation value</span>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}><DollarSign style={{ width: 30, height: 30, color: C.emerald }} /><CountUp to={87.4} start={16} dur={48} format={(n) => n.toFixed(2)} style={{ fontSize: 46, fontWeight: 800, color: C.text, textShadow: `0 0 ${glow}px rgba(52,211,153,0.4)` }} /></span>
                <span style={{ fontFamily: MONO, fontSize: 14, color: C.z600 }}>Steam market · 12 of 14 priced</span>
              </span>
            </div>
            <div style={{ marginTop: 22, display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 12 }}>
              {ITEMS.concat(["Item_113001", "Item_110005"]).slice(0, 14).map((it, j) => {
                const s = T(28 + j * 4, fps, f);
                return <span key={j} style={{ aspectRatio: "1", borderRadius: 10, background: C.s800, border: `1px solid ${C.s600}`, padding: 8, opacity: s, transform: `scale(${interpolate(s, [0, 1], [0.5, 1])})` }}>{sprite(it)}</span>;
              })}
            </div>
          </div>
        </AppWindow>
      </div>
      <Caption index="07" kicker="Profile" title="Your gear, valued in real time." sub="Formation worth, priced from the Steam market." />
    </AbsoluteFill>
  );
};

// ============================================================ 9. OUTRO
const Chip: React.FC<{ label: string; delay: number }> = ({ label, delay }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = T(delay, fps, f);
  return <span style={{ opacity: s, transform: `translateY(${interpolate(s, [0, 1], [16, 0])}px)`, padding: "12px 26px", borderRadius: 999, border: `1px solid ${C.line}`, background: "rgba(255,255,255,0.04)", fontSize: 25, fontWeight: 600, color: C.text }}>{label}</span>;
};
export const SceneOutro: React.FC<{ dur: number }> = ({ dur }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = T(0, fps, f);
  const out = interpolate(f, [dur - 14, dur], [1, 0], clamp);
  const glow = 24 + 14 * Math.sin(f * 0.15);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity: out }}>
      <div style={{ fontFamily: MONO, fontSize: 23, fontWeight: 700, letterSpacing: 6, color: C.z500, opacity: s }}>FREE · OPEN · COMMUNITY-BUILT</div>
      <div style={{ marginTop: 20, fontSize: 112, fontWeight: 800, letterSpacing: -2, transform: `scale(${interpolate(s, [0, 1], [0.94, 1])})`, background: GRAD, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent", filter: `drop-shadow(0 0 ${glow}px rgba(116,133,255,0.5))` }}>tbherohelper.com</div>
      <div style={{ marginTop: 40, display: "flex", gap: 16 }}>
        <Chip label="Free" delay={10} /><Chip label="Windows" delay={15} /><Chip label="Read-only" delay={20} /><Chip label="16 languages" delay={25} />
      </div>
    </AbsoluteFill>
  );
};

// ============================================================ TIMELINE
export type SceneDef = { C: React.FC<any>; dur: number; props?: Record<string, unknown> };
export const SCENES: SceneDef[] = [
  { C: Intro, dur: 100 },
  { C: SceneLive, dur: 210 },
  { C: SceneChest, dur: 165 },
  { C: SceneSessions, dur: 175 },
  { C: SceneLeaderboard, dur: 200 },
  { C: SceneDatabase, dur: 185 },
  { C: SceneBuilds, dur: 165 },
  { C: SceneProfile, dur: 180 },
  { C: SceneOutro, dur: 125, props: { dur: 125 } },
];
export const seriesFrames = (scenes: SceneDef[], tr: number) => scenes.reduce((a, s) => a + s.dur, 0) - tr * (scenes.length - 1);
export const SHOWCASE_DURATION = seriesFrames(SCENES, 24);

export const buildSeries = (scenes: SceneDef[], mkTr: (i: number) => React.ReactNode) => {
  const out: React.ReactNode[] = [];
  scenes.forEach((s, i) => {
    if (i > 0) out.push(mkTr(i));
    out.push(<TransitionSeries.Sequence key={`s${i}`} durationInFrames={s.dur}><s.C {...(s.props || {})} /></TransitionSeries.Sequence>);
  });
  return out;
};

const tr = (i: number) => <TransitionSeries.Transition key={`t${i}`} presentation={dissolve()} timing={springTiming({ config: { damping: 200, mass: 0.95 }, durationInFrames: 24 })} />;

export const Showcase: React.FC = () => (
  <AbsoluteFill style={{ fontFamily: SANS, backgroundColor: C.bg }}>
    <Bg />
    <TransitionSeries>{buildSeries(SCENES, tr)}</TransitionSeries>
  </AbsoluteFill>
);
