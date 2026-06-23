import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { TransitionSeries, springTiming } from "@remotion/transitions";
import { C, SANS, clamp, Bg } from "./kit";
import { SCENES, buildSeries, seriesFrames, SceneDef } from "./Showcase";

// Punchy variant: snappier timing, dramatic transitions, particles + bloom.
export const TR2 = 16;
const PUNCHY: SceneDef[] = SCENES.map((s) => {
  const dur = Math.round(s.dur * 0.88);
  return { ...s, dur, props: s.props ? { ...s.props, dur } : undefined };
});
export const PUNCHY_DURATION = seriesFrames(PUNCHY, TR2);

// faster, bigger scale + blur than the calm dissolve
export const FlashDissolve: React.FC<any> = ({ children, presentationProgress: p, presentationDirection: dir }) => {
  const entering = dir === "entering";
  const opacity = entering ? interpolate(p, [0, 0.4, 1], [0, 1, 1], clamp) : interpolate(p, [0, 0.6, 1], [1, 0.1, 0], clamp);
  const scale = entering ? interpolate(p, [0, 1], [1.18, 1], clamp) : interpolate(p, [0, 1], [1, 0.88], clamp);
  const blur = entering ? interpolate(p, [0, 1], [24, 0], clamp) : interpolate(p, [0, 1], [0, 24], clamp);
  return <AbsoluteFill style={{ opacity }}><AbsoluteFill style={{ transform: `scale(${scale})`, filter: `blur(${blur}px)` }}>{children}</AbsoluteFill></AbsoluteFill>;
};
export const tr2 = (i: number) => <TransitionSeries.Transition key={`t${i}`} presentation={{ component: FlashDissolve, props: {} }} timing={springTiming({ config: { damping: 200, mass: 0.6 }, durationInFrames: TR2 })} />;

// drifting glow particles behind the scenes
export const Particles: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {Array.from({ length: 80 }).map((_, i) => {
        const x = (i * 37.5 + 7) % 100;
        const speed = 0.4 + (i % 5) * 0.16;
        const y = 106 - (((f * speed) + i * 53) % 128);
        const size = 2 + (i % 4);
        const op = 0.16 + 0.26 * (0.5 + 0.5 * Math.sin(f * 0.05 + i));
        const col = i % 2 ? C.b400 : C.violet;
        return <span key={i} style={{ position: "absolute", left: `${x}%`, top: `${y}%`, width: size, height: size, borderRadius: 99, background: col, opacity: op, boxShadow: `0 0 ${size * 3.5}px ${col}` }} />;
      })}
    </AbsoluteFill>
  );
};
export const Bloom: React.FC = () => {
  const f = useCurrentFrame();
  const o = 0.05 + 0.04 * Math.sin(f * 0.08);
  return <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 46%, rgba(116,133,255,${o}), transparent 58%)`, mixBlendMode: "screen", pointerEvents: "none" }} />;
};

export const ShowcasePunchy: React.FC = () => (
  <AbsoluteFill style={{ fontFamily: SANS, backgroundColor: C.bg }}>
    <Bg />
    <Particles />
    <TransitionSeries>{buildSeries(PUNCHY, tr2)}</TransitionSeries>
    <Bloom />
  </AbsoluteFill>
);
