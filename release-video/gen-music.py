#!/usr/bin/env python3
# Synthesize an upbeat, royalty-free soundtrack (C-major arpeggio + 4-on-floor kick + walking
# bass + off-beat hats) plus transition whooshes + an outro impact, and write a stereo WAV.
# Usage: gen-music.py <out.wav> <durationSec> <whooshMs...>
import sys, wave
import numpy as np

out = sys.argv[1]
dur = float(sys.argv[2])
whooshes = [int(x) / 1000.0 for x in sys.argv[3:]]
sr = 44100
n = int(dur * sr)
t = np.arange(n) / sr
mix = np.zeros(n)
rng = np.random.default_rng(7)

bpm = 120.0
beat = 60.0 / bpm          # 0.5s
six = beat / 4             # 0.125s (16th)

# --- arpeggio: C major, 16th notes, pluck envelope (+ a 2nd harmonic for body) ---
arp_notes = np.array([523.25, 659.25, 783.99, 1046.50, 783.99, 659.25])  # C5 E5 G5 C6 G5 E5
step = (t // six).astype(int)
ph = t % six
freq = arp_notes[step % len(arp_notes)]
pluck = np.exp(-ph * 14)
arp = (np.sin(2 * np.pi * freq * ph) + 0.28 * np.sin(4 * np.pi * freq * ph)) * pluck * 0.26
mix += arp

# --- bass: walking roots C2 G2 A2 F2 (one per bar = 2s), pulsed per 8th ---
roots = np.array([65.41, 98.00, 110.00, 87.31])
bar = (t // 2.0).astype(int)
bf = roots[bar % len(roots)]
bph = t % (beat / 2)       # 8th-note pulse
bass = np.sin(2 * np.pi * bf * bph) * np.exp(-bph * 8) * 0.40
mix += bass

# --- kick: 4-on-the-floor with a quick pitch drop ---
kph = t % beat
kpitch = 110 * np.exp(-kph * 40) + 45
kick = np.sin(2 * np.pi * kpitch * kph) * np.exp(-kph * 24) * 0.55
mix += kick

# --- hats: white noise gated on the off-beats (every 8th, offset half) ---
noise = rng.uniform(-1, 1, n)
hph = (t - beat / 4) % (beat / 2)
hat = noise * np.exp(-hph * 80) * 0.10
mix += hat

# --- master fade in/out ---
env = np.ones(n)
fin, fout = int(0.5 * sr), int(2.4 * sr)
env[:fin] = np.linspace(0, 1, fin)
env[-fout:] *= np.linspace(1, 0, fout)
mix *= env

# --- transition whooshes (filtered-ish noise: attack then decay) ---
for ws in whooshes:
    i0 = int(ws * sr)
    L = min(int(0.6 * sr), n - i0)
    if L <= 0:
        continue
    tw = np.arange(L) / sr
    wn = rng.uniform(-1, 1, L)
    # crude high-pass: emphasize fast changes
    wn = np.diff(wn, prepend=wn[0])
    wenv = np.minimum(tw / 0.10, 1.0) * np.exp(-np.maximum(tw - 0.10, 0) * 6)
    wn = wn / (np.max(np.abs(wn)) or 1)
    mix[i0:i0 + L] += wn * wenv * 0.55

# --- outro impact (sub boom) at the last transition ---
if whooshes:
    i0 = int(whooshes[-1] * sr)
    L = min(int(0.9 * sr), n - i0)
    if L > 0:
        ti = np.arange(L) / sr
        mix[i0:i0 + L] += np.sin(2 * np.pi * 46 * ti) * np.exp(-ti * 4) * 0.5

# --- soft-clip (tanh) keeps a healthy average level without crushing the whole mix ---
mix = np.tanh(mix * 0.95) * 0.94
peak = float(np.max(np.abs(mix)))
stereo = np.column_stack([mix, mix])
data = (np.clip(stereo, -1, 1) * 32767).astype("<i2")
with wave.open(out, "w") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(sr)
    w.writeframes(data.tobytes())
print(f"wrote {out} dur={dur}s peak={peak:.2f} whooshes={len(whooshes)}")
