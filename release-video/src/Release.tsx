// Per-release FEATURE video — covers ONLY the surfaces that shipped in this release, recreated
// (animated) from the PR's screenshots. v0.38.0 = PR #52 "live time-to-level + the Leveling Planner
// (measured-first)" → two surfaces:
//   1. the live overlay's Team frame — each deployed hero shows its level + ETA to the next level,
//      with a hover card (within-level progress, measured xp/s, ETA, elemental resists).
//   2. the off-stage Leveling Planner (ListApp) — the fastest stage-by-stage route to a target,
//      built from your OWN runs; Practical (only farmed stages, real XP/s) vs Theoretical (estimates).
// Scope law: never show a product surface that this release did not touch (Mario, 2026-06-12). The
// chest-tracker scenes from the v0.33.0 video are intentionally gone.
import React from "react";
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { TransitionSeries } from "@remotion/transitions";
import { Pin, BarChart3, ScrollText, ShieldAlert, Info, Minus, Plus, X } from "lucide-react";
import { FPS, C, SANS, MONO, clamp, ease, CountUp, Bg, Wordmark, Caption, DiffPill } from "./kit";
import { Intro, SceneOutro, type SceneDef, buildSeries, seriesFrames } from "./Showcase";
import { Particles, Bloom, tr2, TR2 } from "./Showcase2";

const T = (d: number, fps: number, f: number, dmp = 200) => spring({ frame: f - d, fps, config: { damping: dmp } });
// loot sprites are square; hero sprites are 30×44 (portrait) → contain, never stretch.
const lootImg = (n: string) => <Img src={staticFile(`sprites/${n}.png`)} style={{ width: "100%", height: "100%", imageRendering: "pixelated" as const, display: "block" }} />;
const heroImg = (key: number) => <Img src={staticFile(`sprites/Hero_${key}.png`)} style={{ height: "100%", width: "auto", imageRendering: "pixelated" as const, display: "block", margin: "0 auto" }} />;

// ════════════════════════════════════════════════════════════════════════════════════════════════
// SCENE 1 — LIVE TIME-TO-LEVEL (the overlay Team frame: per-hero level + ETA + the hover card)
// Real numbers from the PR screenshot: stage 2-9 Torment #8, DPS 2.83M, GOLD 12.40K/s, EXP 221.00K/s,
// team Knight 91 (1h44m) / Ranger 101 (MAX) / Sorcerer 93 (34m), TIME 1231s. Knight hover: → 92 ·
// 1h44m, 106.00K xp/s · 60%, Torment resists Fire/Cold/Lightning -35%, Chaos -60%.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const TEAM = [
  { key: 101, name: "KNIGHT", lv: 91, eta: "1h44m", capped: false },
  { key: 201, lv: 101, eta: "MAX", capped: true },
  { key: 301, lv: 93, eta: "34m", capped: false },
] as const;

const RESISTS = [
  { el: "Fire", dot: "#fb923c", v: "-35%" },
  { el: "Cold", dot: C.sky, v: "-35%" },
  { el: "Lightning", dot: "#fde047", v: "-35%" },
  { el: "Chaos", dot: "#e879f9", v: "-60%" },
] as const;

const HeroFrame: React.FC<{ h: (typeof TEAM)[number]; delay: number }> = ({ h, delay }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = T(delay, fps, f);
  const pulse = h.capped ? 0 : 0.35 + 0.3 * Math.sin(f * 0.25 + h.key);
  return (
    <span style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, opacity: s, transform: `translateY(${interpolate(s, [0, 1], [-10, 0])}px)` }}>
      <span style={{ position: "relative" }}>
        <span style={{ display: "flex", width: 46, height: 46, alignItems: "center", justifyContent: "center", overflow: "hidden", borderRadius: 7, background: "rgba(13,14,26,0.8)", border: `1px solid ${C.s600}` }}>
          <span style={{ height: 38, display: "block" }}>{heroImg(h.key)}</span>
        </span>
        <span style={{ position: "absolute", right: -5, top: -6, borderRadius: 5, background: C.s700, padding: "1px 4px", fontFamily: MONO, fontSize: 13, fontWeight: 800, lineHeight: 1.2, color: C.z300, border: `1px solid ${C.s500}` }}>{h.lv}</span>
      </span>
      <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 700, lineHeight: 1, color: h.capped ? C.z600 : C.emerald300, textShadow: h.capped ? "none" : `0 0 ${7 * pulse}px rgba(110,231,183,${pulse})` }}>{h.eta}</span>
    </span>
  );
};

const HoverCard: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  // appears partway through, after the team frame has settled
  const s = T(74, fps, f, 18);
  const barFill = interpolate(f, [86, 116], [0, 60], { ...clamp, easing: ease });
  return (
    <div style={{ position: "absolute", left: 70, top: 250, width: 312, transformOrigin: "top left", opacity: s, transform: `translateY(${interpolate(s, [0, 1], [12, 0])}px) scale(${interpolate(s, [0, 1], [0.96, 1])})` }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 11, borderRadius: 12, border: `1px solid ${C.s500}`, background: "rgba(13,14,26,0.98)", padding: "14px 16px", boxShadow: "0 30px 80px rgba(0,0,0,0.7), 0 0 60px rgba(79,93,255,0.18)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, borderBottom: `1px solid ${C.s600}`, paddingBottom: 8 }}>
          <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 800, letterSpacing: 1, color: C.text }}>KNIGHT</span>
          <span style={{ fontFamily: MONO, fontSize: 13, letterSpacing: 1, color: C.z500 }}>LV 91</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, fontFamily: MONO, fontSize: 14 }}>
            <span style={{ letterSpacing: 1, color: C.z500 }}>TIME TO LEVEL</span>
            <span style={{ fontWeight: 700, color: C.emerald300 }}>→ 92 · 1h44m</span>
          </div>
          <div style={{ height: 5, overflow: "hidden", borderRadius: 99, background: C.s600 }}>
            <span style={{ display: "block", height: "100%", borderRadius: 99, width: `${barFill}%`, background: `linear-gradient(90deg, ${C.b600}, ${C.b400})` }} />
          </div>
          <span style={{ fontFamily: MONO, fontSize: 13, color: C.z500 }}>106.00K xp/s · {Math.round(barFill)}%</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontFamily: MONO, fontSize: 12, letterSpacing: 1, color: C.z500 }}>RESIST · TORMENT</span>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 16px", fontFamily: MONO, fontSize: 14 }}>
            {RESISTS.map((r, i) => {
              const rs = T(92 + i * 4, fps, f);
              return (
                <span key={r.el} style={{ display: "flex", alignItems: "center", gap: 7, opacity: rs }}>
                  <span style={{ width: 8, height: 8, flexShrink: 0, borderRadius: 99, background: r.dot }} />
                  <span style={{ flex: 1, color: C.z400 }}>{r.el}</span>
                  <span style={{ fontWeight: 700, color: C.rose300 }}>{r.v}</span>
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

const StatBox: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, padding: "11px 14px", borderRadius: 10, background: "rgba(18,19,31,0.75)", border: `1px solid ${C.s600}`, fontFamily: MONO, fontSize: 17 }}>{children}</div>
);

const SceneTimeToLevel: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const e = T(2, fps, f);
  const mobs = Math.round(interpolate(f, [0, 150], [441, 470], clamp));
  const liveDot = 0.45 + 0.45 * Math.sin(f * 0.35);
  const elapsed = Math.round(1231 + f / FPS);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <Wordmark />
      <div style={{ transform: `translateY(${interpolate(e, [0, 1], [40, -150])}px) scale(${interpolate(e, [0, 1], [0.95, 1])})`, opacity: e }}>
       <div style={{ position: "relative" }}>
        <div style={{ width: 960, fontFamily: MONO, borderRadius: 16, overflow: "hidden", border: `1px solid ${C.b600}55`, background: "rgba(13,14,26,0.97)", boxShadow: "0 50px 140px rgba(0,0,0,0.75), 0 0 130px rgba(79,93,255,0.16)" }}>
          {/* top bar — stage chip + run index + live status + window icons */}
          <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "13px 16px", borderBottom: `1px solid ${C.s700}` }}>
            <span style={{ display: "flex", gap: 7 }}><span style={{ width: 13, height: 13, borderRadius: 99, background: "rgba(248,113,113,0.85)" }} /><span style={{ width: 13, height: 13, borderRadius: 99, background: "rgba(52,211,153,0.85)" }} /></span>
            <span style={{ fontSize: 21, fontWeight: 800, color: C.text }}>2-9</span><DiffPill d="TORMENT" />
            <ShieldAlert style={{ width: 17, height: 17, color: C.z500 }} />
            <span style={{ fontSize: 16, color: C.z500 }}>#8</span>
            <span style={{ flex: 1 }} />
            <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, fontWeight: 700, letterSpacing: 1, color: C.emerald300 }}><span style={{ width: 9, height: 9, borderRadius: 99, background: C.emerald, opacity: liveDot, boxShadow: `0 0 ${10 * liveDot}px ${C.emerald}` }} />LIVE</span>
            <Pin style={{ width: 16, height: 16, color: C.z500, marginLeft: 6 }} />
            <BarChart3 style={{ width: 16, height: 16, color: C.z500 }} />
            <ScrollText style={{ width: 16, height: 16, color: C.z500 }} />
          </div>
          {/* DPS + mob progress */}
          <div style={{ padding: "16px 18px 12px" }}>
            <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
              <span style={{ fontSize: 16, letterSpacing: 3, color: C.z500 }}>DPS</span>
              <span style={{ display: "flex", alignItems: "flex-start" }}>
                <CountUp to={2.83e6} dur={34} format={(n) => `${(n / 1e6).toFixed(2)}M`} style={{ fontSize: 50, fontWeight: 800, color: C.b300, textShadow: `0 0 ${20 + 12 * Math.sin(f * 0.3)}px rgba(116,133,255,0.6)` }} />
                <span style={{ fontSize: 22, fontWeight: 800, color: C.b300, marginLeft: 2 }}>~</span>
              </span>
            </div>
            <div style={{ marginTop: 9, height: 9, borderRadius: 99, background: C.s600, overflow: "hidden" }}><div style={{ height: "100%", width: `${(mobs / 601) * 100}%`, borderRadius: 99, background: `linear-gradient(90deg, ${C.b600}, ${C.b400})` }} /></div>
            <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", fontSize: 16, color: C.z400 }}><span>MOBS {mobs}/601</span><span style={{ color: C.z300 }}>3.48B</span></div>
          </div>
          {/* stat pills */}
          <div style={{ display: "flex", gap: 10, padding: "0 18px 14px" }}>
            <StatBox><span style={{ color: C.z500 }}>GOLD</span><span style={{ color: C.amber, fontWeight: 700 }}>12.40K/s</span></StatBox>
            <StatBox><span style={{ color: C.z500 }}>EXP</span><span style={{ color: C.emerald, fontWeight: 700 }}>221.00K/s</span></StatBox>
            <StatBox>
              <span style={{ color: C.z500 }}>LOOT</span>
              <span style={{ color: C.z400 }}>4×</span><span style={{ width: 24, height: 24 }}>{lootImg("Item_910011")}</span>
              <span style={{ color: C.b300 }}>1×</span><span style={{ width: 24, height: 24 }}>{lootImg("Item_920011")}</span>
            </StatBox>
          </div>
          {/* TEAM — the feature: per-hero level badge + ETA-to-next-level */}
          <div style={{ display: "flex", alignItems: "center", gap: 18, padding: "10px 18px 18px", borderTop: `1px solid ${C.s700}` }}>
            <span style={{ fontSize: 15, letterSpacing: 2, color: C.z500 }}>TEAM</span>
            {TEAM.map((h, i) => <HeroFrame key={h.key} h={h} delay={14 + i * 8} />)}
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 17, color: C.z400 }}>TIME {elapsed}s</span>
          </div>
        </div>
        <HoverCard />
       </div>
      </div>
      <Caption index="01" kicker="Live leveling" title="Time to level, live." sub="Every hero shows its level and ETA to the next, from your measured XP per second." />
    </AbsoluteFill>
  );
};

// ════════════════════════════════════════════════════════════════════════════════════════════════
// SCENE 2 — THE LEVELING PLANNER (off-stage ListApp): pick who → set a target → read the plan.
// The highlight beat (the one allowed zoom): the Practical → Theoretical flip, where the route's
// stages swap and the badges change from "● your runs" (your real XP) to "◔ estimated" (game data).
// Real values from the PR screenshots (seeded mid-game team: Knight 88 / Sorcerer 85 / Priest 82).
// ════════════════════════════════════════════════════════════════════════════════════════════════

const PRACTICAL_ROWS = [
  { code: "3-9", mode: "HELL", lvl: 77, eta: "2h11m" },
  { code: "3-7", mode: "HELL", lvl: 76, eta: "4h11m" },
  { code: "3-6", mode: "HELL", lvl: 75, eta: "4h39m" },
  { code: "3-5", mode: "HELL", lvl: 74, eta: "12h31m" },
  { code: "3-3", mode: "HELL", lvl: 72, eta: "15h" },
] as const;
const THEORETICAL_ROWS = [
  { code: "1-3", mode: "TORMENT", lvl: 80, eta: "1h22m" },
  { code: "1-2", mode: "TORMENT", lvl: 79, eta: "1h36m" },
  { code: "1-4", mode: "TORMENT", lvl: 81, eta: "1h43m" },
  { code: "1-5", mode: "TORMENT", lvl: 82, eta: "1h47m" },
  { code: "1-1", mode: "TORMENT", lvl: 78, eta: "2h11m" },
] as const;
const MODE_TEXT: Record<string, string> = { HELL: C.orange, TORMENT: C.rose300, NIGHTMARE: C.sky300, NORMAL: C.z300 };

const FLIP = 156; // frame the mode toggles Practical → Theoretical

const StepBadge: React.FC<{ n: number }> = ({ n }) => (
  <span style={{ display: "flex", width: 22, height: 22, alignItems: "center", justifyContent: "center", borderRadius: 6, background: C.b500, fontSize: 13, fontWeight: 800, color: "#fff" }}>{n}</span>
);

const Pill: React.FC<{ active?: boolean; children: React.ReactNode; pad?: string }> = ({ active, children, pad = "7px 14px" }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 7, borderRadius: 9, padding: pad, fontSize: 15, fontWeight: 600, color: active ? "#fff" : C.z300, background: active ? C.b500 : C.s700, boxShadow: active ? `0 2px 10px -2px ${C.b500}` : "none" }}>{children}</span>
);

const SubjectChip: React.FC<{ heroKey: number; cls: string; lv: number; active?: boolean }> = ({ heroKey, cls, lv, active }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 8, borderRadius: 9, padding: "5px 12px 5px 6px", fontSize: 15, fontWeight: 600, color: active ? "#fff" : C.z300, background: active ? C.b500 : C.s700 }}>
    <span style={{ display: "flex", width: 30, height: 30, alignItems: "center", justifyContent: "center", overflow: "hidden" }}><span style={{ height: 28, display: "block" }}>{heroImg(heroKey)}</span></span>
    {cls}<span style={{ fontFamily: MONO, fontSize: 14, opacity: 0.8 }}>Lv {lv}</span>
  </span>
);

const SegToggle: React.FC<{ left: string; right: string; rightActive: boolean }> = ({ left, right, rightActive }) => (
  <div style={{ display: "inline-flex", gap: 2, borderRadius: 10, border: `1px solid ${C.s600}`, background: C.s700, padding: 3 }}>
    <span style={{ borderRadius: 7, padding: "6px 16px", fontSize: 15, fontWeight: 700, color: !rightActive ? "#fff" : C.z400, background: !rightActive ? C.b500 : "transparent", transition: "all .2s" }}>{left}</span>
    <span style={{ borderRadius: 7, padding: "6px 16px", fontSize: 15, fontWeight: 700, color: rightActive ? "#fff" : C.z400, background: rightActive ? C.b500 : "transparent", transition: "all .2s" }}>{right}</span>
  </div>
);

const PlanRow: React.FC<{ r: { code: string; mode: string; lvl: number; eta: string }; rank: number; estimated: boolean; delay: number }> = ({ r, rank, estimated, delay }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = T(delay, fps, f);
  const top = rank === 0;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "20px 1fr auto auto", alignItems: "center", gap: 12, borderRadius: 10, border: `1px solid ${top ? "rgba(52,211,153,0.32)" : C.s700}`, background: top ? "rgba(52,211,153,0.07)" : "rgba(18,19,31,0.45)", padding: "9px 12px", opacity: s, transform: `translateY(${interpolate(s, [0, 1], [8, 0])}px)` }}>
      <span style={{ display: "flex", width: 20, height: 20, alignItems: "center", justifyContent: "center", borderRadius: 5, fontFamily: MONO, fontSize: 12, fontWeight: 800, color: top ? "#06281d" : C.z400, background: top ? C.emerald : C.s600 }}>{rank + 1}</span>
      <span style={{ fontSize: 15 }}>
        <span style={{ fontWeight: 700, color: C.text }}>{r.code}</span>{" "}
        <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.5, color: MODE_TEXT[r.mode] }}>{r.mode}</span>
        <span style={{ marginLeft: 6, fontFamily: MONO, fontSize: 12, color: C.z600 }}>L{r.lvl}</span>
      </span>
      <span style={{ textAlign: "right", fontFamily: MONO, fontSize: 16, fontWeight: 700, color: C.text }}>{estimated ? "~" : ""}{r.eta}</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13, color: estimated ? C.amber300 : C.emerald }}>
        <span>{estimated ? "◔" : "●"}</span>{estimated ? "estimated" : "your runs"}
      </span>
    </div>
  );
};

const ScenePlanner: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const e = T(2, fps, f);
  const theo = f >= FLIP;
  const rows = theo ? THEORETICAL_ROWS : PRACTICAL_ROWS;
  // a quick crossfade on the ranked list as the mode flips
  const swap = interpolate(f, [FLIP - 5, FLIP, FLIP + 9], [1, 0.15, 1], clamp);
  // the ONE allowed zoom (Law 3): a gentle push into the plan panel across the flip, easing back out.
  const zoom = interpolate(f, [FLIP - 18, FLIP + 6, 232, 250], [1, 1.06, 1.06, 1.0], { ...clamp, easing: ease });
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <Wordmark />
      <div style={{ transform: `translateY(${interpolate(e, [0, 1], [40, -22])}px) scale(${interpolate(e, [0, 1], [0.95, 1])})`, opacity: e }}>
        <div style={{ width: 1480, borderRadius: 16, overflow: "hidden", border: `1px solid ${C.s500}`, background: C.s900, boxShadow: "0 50px 140px rgba(0,0,0,0.75), 0 0 130px rgba(79,93,255,0.14)" }}>
          {/* app nav */}
          <div style={{ display: "flex", alignItems: "center", gap: 22, padding: "13px 20px", borderBottom: `1px solid ${C.s700}` }}>
            <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: 1, color: C.b400 }}>TBH</span>
            <span style={{ fontSize: 15, color: C.z500 }}>Runs</span>
            <span style={{ fontSize: 15, color: C.z500 }}>Tracker</span>
            <span style={{ borderRadius: 7, border: `1px solid ${C.s600}`, background: C.s800, padding: "5px 12px", fontSize: 15, fontWeight: 600, color: C.text }}>Leveling Planner</span>
            <span style={{ fontSize: 15, color: C.z500 }}>Settings</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontFamily: MONO, fontSize: 14, color: C.z600 }}>v0.38.0</span>
            <span style={{ borderRadius: 8, background: C.discord, padding: "6px 14px", fontSize: 14, fontWeight: 700, color: "#fff" }}>Sign in</span>
            <X style={{ width: 17, height: 17, color: C.z500 }} />
          </div>
          {/* two-column body */}
          <div style={{ display: "grid", gridTemplateColumns: "0.9fr 1.1fr", gap: 30, padding: "22px 24px 26px", alignItems: "start" }}>
            {/* LEFT — pick + target + how it works */}
            <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
              <Left delay={8}>
                <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}><StepBadge n={1} /><span style={{ fontSize: 17, fontWeight: 700, color: C.text }}>Who do you want to level?</span></div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <Pill active>Whole team</Pill>
                  <SubjectChip heroKey={101} cls="Knight" lv={88} />
                  <SubjectChip heroKey={301} cls="Sorcerer" lv={85} />
                  <SubjectChip heroKey={401} cls="Priest" lv={82} />
                </div>
                <p style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 11, fontSize: 13.5, color: C.z500 }}><Info style={{ width: 13, height: 13, flexShrink: 0 }} />Your 3 most-recently-played heroes, from your run history.</p>
              </Left>

              <Left delay={16}>
                <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}><StepBadge n={2} /><span style={{ fontSize: 17, fontWeight: 700, color: C.text }}>How far?</span></div>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 14, color: C.z400 }}>Target level</span>
                    <span style={{ display: "flex", width: 28, height: 28, alignItems: "center", justifyContent: "center", borderRadius: 6, background: C.s700, color: C.z400 }}><Minus style={{ width: 13, height: 13 }} /></span>
                    <span style={{ width: 38, textAlign: "center", fontFamily: MONO, fontSize: 19, fontWeight: 800, color: "#fff" }}>90</span>
                    <span style={{ display: "flex", width: 28, height: 28, alignItems: "center", justifyContent: "center", borderRadius: 6, background: C.s700, color: C.z400 }}><Plus style={{ width: 13, height: 13 }} /></span>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {["→93", "→94", "→98", "Max 101"].map((p) => <span key={p} style={{ borderRadius: 6, border: `1px solid ${C.s600}`, background: C.s700, padding: "3px 9px", fontFamily: MONO, fontSize: 13, color: C.z400 }}>{p}</span>)}
                  </div>
                </div>
              </Left>

              <Left delay={24}>
                <div style={{ borderRadius: 12, border: `1px solid ${C.s700}`, background: "rgba(18,19,31,0.6)", padding: "16px 18px" }}>
                  <div style={{ marginBottom: 10, fontSize: 12, letterSpacing: 1, textTransform: "uppercase", color: C.z500 }}>How it works</div>
                  <ol style={{ display: "flex", flexDirection: "column", gap: 8, margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.35, color: C.z400 }}>
                    <li>Reads your runs — your levels, clear times, and the real XP you gained per stage.</li>
                    <li>Finds the fastest route — the best stage for each level as you climb (the sweet spot rises with you).</li>
                    <li>Honest about confidence — <span style={{ color: C.emerald }}>●</span> from your runs where you've farmed; <span style={{ color: C.amber300 }}>◔</span> estimated from game data elsewhere.</li>
                  </ol>
                </div>
              </Left>
            </div>

            {/* RIGHT — the plan (the star; zoomed during the mode flip) */}
            <div style={{ transformOrigin: "center 38%", transform: `scale(${zoom})` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}><StepBadge n={3} /><span style={{ fontSize: 17, fontWeight: 700, color: C.text }}>Team's plan</span></div>

              <div style={{ marginBottom: 8 }}><SegToggle left="Practical" right="Theoretical" rightActive={theo} /></div>
              <p style={{ display: "flex", alignItems: "flex-start", gap: 7, marginBottom: 14, fontSize: 13.5, lineHeight: 1.35, color: C.z500 }}>
                <Info style={{ width: 13, height: 13, flexShrink: 0, marginTop: 2 }} />
                <span style={{ opacity: swap }}>{theo ? "Every stage, including ones you've never farmed — times are game-data estimates." : "Only stages you've farmed — ranked by your real XP/s. No estimates."}</span>
              </p>

              <div style={{ marginBottom: 14 }}><SegToggle left="Full Climb" right="Next Level" rightActive /></div>

              <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 12, letterSpacing: 1, textTransform: "uppercase", color: C.b400 }}>Next level-up</div>
                  <div style={{ fontSize: 24, fontWeight: 800, lineHeight: 1.1, color: "#fff" }}>Lv 82 → 83<span style={{ marginLeft: 8, fontSize: 13, fontWeight: 500, color: C.z500 }}>· Priest (gating hero)</span></div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 13, color: C.z400 }}>best route</div>
                  <div style={{ fontFamily: MONO, fontSize: 20, fontWeight: 800, color: "#fff", opacity: swap }}>{theo ? "1h22m" : "2h11m"}</div>
                </div>
              </div>
              <p style={{ marginBottom: 10, fontSize: 13.5, color: C.z500 }}>Where to farm it — fastest first:</p>

              <div style={{ display: "flex", flexDirection: "column", gap: 8, opacity: swap }}>
                {rows.map((r, i) => <PlanRow key={`${theo}-${r.code}-${i}`} r={r} rank={i} estimated={theo} delay={theo ? FLIP + i * 3 : 30 + i * 5} />)}
              </div>
              <div style={{ marginTop: 11, fontSize: 13.5, color: C.z400, opacity: swap }}>{theo ? "Show all 95" : "Show all 6"}</div>
              <p style={{ display: "flex", alignItems: "flex-start", gap: 7, marginTop: 14, fontSize: 12.5, lineHeight: 1.4, color: C.z500 }}>
                <Info style={{ width: 13, height: 13, flexShrink: 0, marginTop: 2 }} />
                <span>From your runs <span style={{ color: C.emerald }}>●</span> the real XP you earned there. Estimated <span style={{ color: C.amber300 }}>◔</span> stages you haven't farmed, projected from game data.</span>
              </p>
            </div>
          </div>
        </div>
      </div>
      <Caption index="02" kicker="Leveling Planner" title="The fastest route, from your runs." sub="Practical ranks only the stages you have farmed, by your real XP per second." />
    </AbsoluteFill>
  );
};

const Left: React.FC<{ delay: number; children: React.ReactNode }> = ({ delay, children }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = T(delay, fps, f);
  return <div style={{ opacity: s, transform: `translateY(${interpolate(s, [0, 1], [14, 0])}px)` }}>{children}</div>;
};

// ════════════════════════════════════════════════════════════════════════════════════════════════
// COMPOSE — intro (version-stamped) → this release's 2 surfaces → outro
// ════════════════════════════════════════════════════════════════════════════════════════════════
const RELEASE_SCENES: SceneDef[] = [
  { C: Intro, dur: 92 },
  { C: SceneTimeToLevel, dur: 200 },
  { C: ScenePlanner, dur: 250 },
  { C: SceneOutro, dur: 116, props: { dur: 116 } },
];
export const RELEASE_DURATION = seriesFrames(RELEASE_SCENES, TR2);

export const Release: React.FC = () => (
  <AbsoluteFill style={{ fontFamily: SANS, backgroundColor: C.bg }}>
    <Bg />
    <Particles />
    <TransitionSeries>{buildSeries(RELEASE_SCENES, tr2)}</TransitionSeries>
    <Bloom />
  </AbsoluteFill>
);
