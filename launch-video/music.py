"""Synthesizes a soft music bed: a pad over Am-F-C-G plus a plucked arpeggio.

    python3 music.py <seconds> <out.wav>
"""
import sys
import wave

import numpy as np

SR = 44100
seconds = float(sys.argv[1])
out = sys.argv[2]
n = int(seconds * SR)
t = np.arange(n) / SR

BPM = 96
beat = 60 / BPM
bar = beat * 4
midi = lambda m: 440 * 2 ** ((m - 69) / 12)
chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]  # Am F C G

mix = np.zeros(n)

# Pad: detuned sines per chord, crossfaded across bar lines.
for i in range(int(seconds / bar) + 2):
    chord = chords[i % 4]
    a, b = i * bar - 0.6, (i + 1) * bar + 0.6
    env = np.clip(np.minimum((t - a) / 0.9, (b - t) / 0.9), 0, 1)
    if not env.any():
        continue
    for m in chord + [chord[0] - 12]:
        f = midi(m)
        for d in (-0.15, 0.15):
            mix += env * 0.05 * np.sin(2 * np.pi * (f + d) * t)

# Plucked arpeggio on eighth notes, an octave up, fading in after the intro.
step = beat / 2
for k in range(int(seconds / step)):
    start = k * step
    chord = chords[int(start / bar) % 4]
    m = chord[[0, 1, 2, 1][k % 4]] + 12
    s = int(start * SR)
    length = int(1.2 * SR)
    seg = np.arange(min(length, n - s)) / SR
    tone = np.sin(2 * np.pi * midi(m) * seg) + 0.3 * np.sin(4 * np.pi * midi(m) * seg)
    gain = 0.06 * min(1, start / 4)
    mix[s : s + len(seg)] += gain * tone * np.exp(-seg * 5) * np.minimum(seg / 0.004, 1)

# Soft kick on each beat after the first two bars.
for k in range(int(seconds / beat)):
    start = k * beat
    if start < bar * 2:
        continue
    s = int(start * SR)
    seg = np.arange(min(int(0.3 * SR), n - s)) / SR
    freq = 50 + 70 * np.exp(-seg * 30)
    mix[s : s + len(seg)] += 0.22 * np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-seg * 12)

# Fade in/out and normalize.
fade = np.minimum(np.clip(t / 1.5, 0, 1), np.clip((seconds - t) / 2.5, 0, 1))
mix *= fade
mix /= np.abs(mix).max() + 1e-9
mix *= 0.5
pcm = (np.repeat(mix[:, None], 2, axis=1) * 32767).astype(np.int16)
with wave.open(out, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
