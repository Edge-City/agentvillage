"""Synthesizes the soft ambient score for the explainer. Usage: python3 score.py out.wav"""
import sys
import wave

import numpy as np

SR, DUR = 44100, 47.0
n = int(SR * DUR)
t = np.arange(n) / SR
rng = np.random.default_rng(7)


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def env(start, length, attack, release):
    e = np.clip((t - start) / attack, 0, 1) * np.clip((start + length - t) / release, 0, 1)
    return e * e * (3 - 2 * e)


# Warm pad: Dmaj9, Bm7, Gmaj7, Asus, repeated. One chord per 5.875 s.
CHORDS = [[50, 57, 61, 66, 69], [47, 54, 57, 62, 66], [43, 50, 54, 59, 62], [45, 52, 57, 59, 64]]
L = DUR / 8
left = np.zeros(n)
right = np.zeros(n)
for i in range(8):
    e = env(i * L - 0.9, L + 1.8, 1.8, 2.2)
    for j, m in enumerate(CHORDS[i % 4]):
        f = hz(m)
        for det, pan in ((-0.0025, 0.3), (0.0025, 0.7)):
            ph = rng.uniform(0, 6.28)
            v = np.sin(2 * np.pi * f * (1 + det) * t + ph) + 0.25 * np.sin(4 * np.pi * f * (1 + det) * t + ph)
            v *= e * (0.16 if j else 0.26) * (1 + 0.15 * np.sin(2 * np.pi * 0.13 * t + j))
            left += v * (1 - pan)
            right += v * pan

# Bell notes on the story beats (D major pentatonic).
BEATS = [(1.0, 74), (3.2, 78), (6.4, 81), (9.6, 76), (13.6, 78), (15.0, 81), (16.3, 83), (17.0, 86),
         (17.6, 85), (18.1, 88), (20.8, 74), (22.0, 78), (23.2, 81), (24.4, 83), (25.4, 86), (25.5, 90),
         (29.3, 81), (30.0, 83), (30.9, 86), (32.7, 90), (32.9, 93), (36.2, 78), (37.6, 81), (39.0, 86),
         (42.2, 74), (42.8, 78), (43.4, 81), (43.9, 86), (44.4, 90)]
bell = np.zeros(n)
for at, m in BEATS:
    d = np.clip(t - at, 0, None)
    on = (t >= at) * np.clip(d / 0.008, 0, 1)
    f = hz(m)
    bell += on * np.exp(-d * 2.6) * (np.sin(2 * np.pi * f * d) + 0.3 * np.sin(2 * np.pi * f * 2.01 * d) * np.exp(-d * 5)) * 0.2
for delay, gain in ((0.33, 0.45), (0.66, 0.22), (0.99, 0.1)):
    k = int(delay * SR)
    echo = np.concatenate([np.zeros(k), bell[:-k]]) * gain
    left += echo * (0.8 if delay != 0.66 else 0.3)
    right += echo * (0.3 if delay != 0.66 else 0.8)
left += bell
right += bell

# Sea wash: smoothed noise with slow swells, strongest in the opening and close.
noise = rng.standard_normal(n)
k = np.ones(90) / 90
wash = np.convolve(noise, k, mode='same') * 6
swell = 0.5 + 0.5 * np.sin(2 * np.pi * t / 7.5 - 1.2)
amount = np.clip(1 - t / 9, 0.12, 1) + np.clip((t - 40) / 6, 0, 0.6)
left += wash * swell * amount * 0.06
right += np.roll(wash, 700) * swell * amount * 0.06

master = np.clip(t / 1.5, 0, 1) * np.clip((DUR - t) / 2.5, 0, 1)
out = np.stack([left, right], axis=1) * master[:, None]
out = np.tanh(out / np.abs(out).max() * 1.2) * 0.8
with wave.open(sys.argv[1], 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((out * 32767).astype('<i2').tobytes())
