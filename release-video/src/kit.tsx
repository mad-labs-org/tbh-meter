import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig, Easing } from "remotion";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";

export const FPS = 30;
export const SANS = loadInter("normal", { weights: ["400", "500", "600", "700", "800"], subsets: ["latin"] }).fontFamily;
export const MONO = loadMono("normal", { weights: ["400", "500", "700"], subsets: ["latin"] }).fontFamily;

// real tokens from web/src/styles/globals.css + tailwind palette the meter UI uses
export const C = {
  bg: "#08090f",
  s900: "#0d0e1a",
  s800: "#12131f",
  s700: "#1a1b2e",
  s600: "#22233a",
  s500: "#2a2b46",
  b300: "#9db0ff",
  b400: "#7485ff",
  b500: "#4f5dff",
  b600: "#3a3ff5",
  violet: "#9b6dff",
  text: "#f5f6fb",
  z300: "#d4d4d8",
  z400: "#a1a1aa",
  z500: "#71717a",
  z600: "#52525b",
  amber: "#fbbf24",
  amber300: "#fcd34d",
  orange: "#fdba74",
  emerald: "#34d399",
  emerald300: "#6ee7b7",
  sky: "#38bdf8",
  sky300: "#7dd3fc",
  rose: "#fb7185",
  rose300: "#fda4af",
  red: "#f87171",
  discord: "#5865f2",
  line: "rgba(255,255,255,0.08)",
};
export const GRAD = `linear-gradient(95deg, ${C.b400}, ${C.violet})`;
export const clamp = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };
export const ease = Easing.out(Easing.cubic);

export const fmt = (v: number) => {
  const a = Math.abs(v);
  if (a < 1000) return String(Math.trunc(v));
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  return `${(v / 1e3).toFixed(2)}K`;
};
export const clock = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.trunc(Math.max(0, s) % 60)).padStart(2, "0")}`;

export const useEnter = (delay = 0, damping = 200) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: f - delay, fps, config: { damping } });
};

export const Cursor: React.FC<{ color?: string }> = ({ color = C.b300 }) => {
  const f = useCurrentFrame();
  return <span style={{ display: "inline-block", width: 3, height: "1.05em", background: color, marginLeft: 3, transform: "translateY(4px)", opacity: Math.floor(f / 15) % 2 === 0 ? 1 : 0 }} />;
};

export const useTyped = (text: string, start: number, cps = 16) => {
  const f = useCurrentFrame();
  const n = Math.max(0, Math.floor(((f - start) / FPS) * cps));
  return { shown: text.slice(0, Math.min(text.length, n)), done: n >= text.length };
};

export const CountUp: React.FC<{ to: number; from?: number; start?: number; dur?: number; format?: (n: number) => string; style?: React.CSSProperties }> = ({ to, from = 0, start = 0, dur = 38, format, style }) => {
  const f = useCurrentFrame();
  const p = interpolate(f, [start, start + dur], [0, 1], { ...clamp, easing: ease });
  const v = from + (to - from) * p;
  return <span style={{ fontVariantNumeric: "tabular-nums", ...style }}>{format ? format(v) : Math.round(v).toLocaleString("en-US")}</span>;
};

// animated dark background, continuous across the whole video
export const Bg: React.FC = () => {
  const f = useCurrentFrame();
  const t = f / FPS;
  const bx = 18 + Math.sin(t * 0.5) * 8, by = 16 + Math.cos(t * 0.4) * 6;
  const px = 82 + Math.sin(t * 0.45 + 2) * 8, py = 84 + Math.cos(t * 0.5 + 1) * 6;
  const drift = (f * 0.15) % 64;
  return (
    <AbsoluteFill style={{ backgroundColor: C.bg }}>
      <AbsoluteFill style={{ backgroundImage: `radial-gradient(950px circle at ${bx}% ${by}%, rgba(116,133,255,0.18), transparent 55%), radial-gradient(1050px circle at ${px}% ${py}%, rgba(155,109,255,0.16), transparent 55%)` }} />
      <AbsoluteFill style={{ backgroundImage: "linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)", backgroundSize: "64px 64px", backgroundPosition: `${drift}px ${drift}px`, opacity: 0.04, maskImage: "radial-gradient(ellipse 72% 68% at 50% 44%, black, transparent 80%)", WebkitMaskImage: "radial-gradient(ellipse 72% 68% at 50% 44%, black, transparent 80%)" }} />
      <AbsoluteFill style={{ boxShadow: "inset 0 0 340px 90px rgba(0,0,0,0.7)" }} />
    </AbsoluteFill>
  );
};

export const Wordmark: React.FC = () => (
  <div style={{ position: "absolute", top: 52, left: 64, display: "flex", alignItems: "center", gap: 11, opacity: 0.9 }}>
    <span style={{ width: 11, height: 11, borderRadius: 3, background: GRAD }} />
    <span style={{ fontSize: 21, fontWeight: 800, color: C.text }}>Task Bar <span style={{ color: C.b400 }}>Helper</span></span>
  </div>
);

export const Caption: React.FC<{ index: string; kicker: string; title: string; sub: string }> = ({ index, kicker, title, sub }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rise = (d: number) => { const s = spring({ frame: f - d, fps, config: { damping: 200 } }); return { opacity: s, transform: `translateY(${interpolate(s, [0, 1], [24, 0])}px)` }; };
  return (
    <div style={{ position: "absolute", left: 110, bottom: 92, maxWidth: 1240 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, ...rise(0) }}>
        <span style={{ fontFamily: MONO, fontSize: 20, fontWeight: 700, color: C.b400 }}>{index}</span>
        <span style={{ width: 30, height: 2, background: C.b400, opacity: 0.7 }} />
        <span style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700, letterSpacing: 4, textTransform: "uppercase", color: C.z400 }}>{kicker}</span>
      </div>
      <div style={{ marginTop: 14, fontSize: 62, fontWeight: 800, lineHeight: 1.03, color: C.text, letterSpacing: -1.6, ...rise(6) }}>{title}</div>
      <div style={{ marginTop: 12, fontSize: 26, color: C.z400, fontWeight: 500, ...rise(12) }}>{sub}</div>
    </div>
  );
};

// app-window chrome (DemoFrame port): traffic dots + mono label
export const AppWindow: React.FC<{ label: string; children: React.ReactNode; w?: number; style?: React.CSSProperties }> = ({ label, children, w, style }) => (
  <div style={{ width: w, borderRadius: 14, overflow: "hidden", border: `1px solid ${C.s500}`, background: C.s900, boxShadow: "0 50px 130px rgba(0,0,0,0.7), 0 0 120px rgba(79,93,255,0.10)", ...style }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8, borderBottom: `1px solid ${C.s600}`, background: C.s800, padding: "11px 16px" }}>
      <span style={{ width: 11, height: 11, borderRadius: 99, background: "rgba(239,68,68,0.7)" }} />
      <span style={{ width: 11, height: 11, borderRadius: 99, background: "rgba(251,191,36,0.7)" }} />
      <span style={{ width: 11, height: 11, borderRadius: 99, background: "rgba(16,185,129,0.7)" }} />
      <span style={{ marginLeft: 10, fontFamily: MONO, fontSize: 13, letterSpacing: 2, textTransform: "uppercase", color: C.z500 }}>{label}</span>
    </div>
    {children}
  </div>
);

export const DiffPill: React.FC<{ d: "HELL" | "NIGHTMARE" | "TORMENT" | "NORMAL" }> = ({ d }) => {
  const m: Record<string, string[]> = {
    HELL: [C.amber300, "rgba(245,158,11,0.4)", "rgba(245,158,11,0.1)"],
    NIGHTMARE: [C.sky300, "rgba(14,165,233,0.4)", "rgba(14,165,233,0.1)"],
    TORMENT: [C.rose300, "rgba(244,63,94,0.4)", "rgba(244,63,94,0.1)"],
    NORMAL: [C.z300, "rgba(113,113,122,0.4)", "rgba(113,113,122,0.1)"],
  };
  const [c, b, bg] = m[d];
  return <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase", color: c, border: `1px solid ${b}`, background: bg, borderRadius: 5, padding: "3px 9px" }}>{d}</span>;
};

// premium cross-dissolve transition (depth + blur + fade)
export const SoftDissolve: React.FC<any> = ({ children, presentationProgress: p, presentationDirection: dir }) => {
  const entering = dir === "entering";
  const opacity = entering ? interpolate(p, [0, 0.55, 1], [0, 0.72, 1], clamp) : interpolate(p, [0, 0.45, 1], [1, 0.28, 0], clamp);
  const scale = entering ? interpolate(p, [0, 1], [1.09, 1], clamp) : interpolate(p, [0, 1], [1, 0.93], clamp);
  const blur = entering ? interpolate(p, [0, 1], [16, 0], clamp) : interpolate(p, [0, 1], [0, 16], clamp);
  const dy = entering ? interpolate(p, [0, 1], [36, 0], clamp) : interpolate(p, [0, 1], [0, -24], clamp);
  return <AbsoluteFill style={{ opacity }}><AbsoluteFill style={{ transform: `scale(${scale}) translateY(${dy}px)`, filter: `blur(${blur}px)` }}>{children}</AbsoluteFill></AbsoluteFill>;
};
export const dissolve = () => ({ component: SoftDissolve, props: {} });
