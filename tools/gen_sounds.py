#!/usr/bin/env python3
"""
Synthesise the pack's audio as Ogg Vorbis, and write sound_definitions.json.

Up to now the pack borrowed vanilla Bedrock sound events at odd pitches. That
was a constraint, not a choice — there was no encoder in the toolchain. There
is one now (libsndfile via soundfile), so the frightening moments get purpose
built audio and the incidental ones keep using vanilla events, which still
blend into the game better than anything synthetic would.

Everything here is procedural: filtered noise, swept sines, formant banks and
envelopes. Nothing is sampled, so there is no licensing question about any of
it.

    python3 tools/gen_sounds.py

Requires: numpy, scipy, soundfile
"""

import json
import pathlib
import sys

try:
    import numpy as np
    import soundfile as sf
    from scipy.signal import butter, lfilter, sosfilt
except ImportError:  # pragma: no cover
    print("needs: python3 -m pip install numpy scipy soundfile", file=sys.stderr)
    raise SystemExit(1)

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "packs" / "notice_RP" / "sounds" / "nx"

SR = 22050  # plenty for material that is nearly all below 4 kHz
rng = np.random.default_rng(4)


# ---------------------------------------------------------------------------
# Building blocks
# ---------------------------------------------------------------------------

def secs(n):
    return int(SR * n)


def t(n):
    return np.arange(n) / SR


def noise(n):
    return rng.standard_normal(n)


def lp(x, cut, order=4):
    return sosfilt(butter(order, min(cut, SR / 2 - 100), "low", fs=SR, output="sos"), x)


def hp(x, cut, order=2):
    return sosfilt(butter(order, max(cut, 20), "high", fs=SR, output="sos"), x)


def bp(x, lo, hi, order=2):
    hi = min(hi, SR / 2 - 100)
    lo = max(lo, 20)
    if lo >= hi:
        return x
    return sosfilt(butter(order, [lo, hi], "band", fs=SR, output="sos"), x)


def sweep(n, f0, f1, curve=1.0):
    """Phase-continuous frequency sweep. Integrating avoids the clicks you get
    from naively feeding a changing frequency into sin(2*pi*f*t)."""
    k = np.linspace(0, 1, n) ** curve
    freq = f0 + (f1 - f0) * k
    return np.sin(2 * np.pi * np.cumsum(freq) / SR)


def env(n, attack, release, hold=0.0, curve=2.0):
    a, h = secs(attack), secs(hold)
    r = max(1, n - a - h)
    parts = [
        np.linspace(0, 1, max(1, a)) ** (1 / curve),
        np.ones(max(0, h)),
        np.linspace(1, 0, r) ** curve,
    ]
    out = np.concatenate(parts)
    return np.resize(out, n)


def formants(source, centres, widths, gains):
    out = np.zeros_like(source)
    for c, w, g in zip(centres, widths, gains):
        out += g * bp(source, c - w / 2, c + w / 2, order=2)
    return out


def norm(x, peak=0.85):
    m = np.max(np.abs(x))
    return x if m < 1e-9 else x / m * peak


def fade_edges(x, ms=12):
    k = max(2, secs(ms / 1000))
    x[:k] *= np.linspace(0, 1, k)
    x[-k:] *= np.linspace(1, 0, k)
    return x


def write(name, samples, gain=0.9):
    OUT.mkdir(parents=True, exist_ok=True)
    data = fade_edges(norm(np.asarray(samples, dtype=np.float64), gain))
    path = OUT / f"{name}.ogg"
    sf.write(path, data, SR, format="OGG", subtype="VORBIS")
    kb = path.stat().st_size / 1024
    print(f"  {path.relative_to(ROOT)}  {len(data)/SR:.1f}s  {kb:.0f} KiB")


# ---------------------------------------------------------------------------
# The sounds
# ---------------------------------------------------------------------------

def breath():
    """A slow wet inhale and a slower exhale. Nothing in it is above 1.2 kHz,
    so it reads as close and large rather than sharp."""
    n = secs(3.0)
    src = noise(n)
    body = formants(src, [280, 620, 1050], [180, 300, 420], [1.0, 0.55, 0.25])
    inhale = env(secs(1.2), 0.55, 0.6, curve=1.6)
    exhale = env(n - secs(1.2), 0.25, 1.4, curve=2.4) * 0.85
    shape = np.concatenate([inhale, exhale])
    rumble = lp(noise(n), 90) * 0.5
    return lp(body * shape + rumble * shape, 1400)


def drone(seconds=9.0):
    """Sub-bass bed. Three detuned partials beat against each other slowly, so
    the texture never quite settles into a pitch you can name."""
    n = secs(seconds)
    x = t(n)
    out = np.zeros(n)
    for f, g in ((37.0, 1.0), (55.3, 0.5), (74.6, 0.28), (111.1, 0.12)):
        wobble = 1 + 0.004 * np.sin(2 * np.pi * (0.07 + f / 900) * x)
        out += g * np.sin(2 * np.pi * f * x * wobble)
    out += lp(noise(n), 160) * 0.35
    swell = 0.65 + 0.35 * np.sin(2 * np.pi * 0.055 * x)
    return lp(out * swell, 400)


def whisper(seconds=3.2, base=1.0):
    """Syllables without words: a formant bank driven by noise, gated into
    bursts of speech-like length. The brain supplies the language."""
    n = secs(seconds)
    src = noise(n)
    f1 = 420 * base + 120 * np.sin(2 * np.pi * 1.7 * t(n))
    voiced = np.zeros(n)
    for centre, gain in ((f1.mean(), 1.0), (1150 * base, 0.6), (2400 * base, 0.3)):
        voiced += gain * bp(src, centre * 0.75, centre * 1.3, order=2)

    gate = np.zeros(n)
    pos = 0
    while pos < n:
        syl = secs(rng.uniform(0.06, 0.19))
        gap = secs(rng.uniform(0.03, 0.14))
        end = min(n, pos + syl)
        gate[pos:end] = env(end - pos, 0.02, 0.05, curve=1.4) * rng.uniform(0.5, 1.0)
        pos = end + gap
    return hp(voiced * gate, 220) * env(n, 0.3, 0.7, curve=1.2)


def stare():
    """Plays when you look at it, never when it arrives.

    A sub-bass swell with a thin high shimmer riding on top. It is a presence
    tone rather than a sting: no transient, nothing to flinch at, it simply
    becomes true that a low sound is happening and has been for a while."""
    n = secs(3.6)
    low = sweep(n, 24, 46, curve=1.4) * 1.0
    low += sweep(n, 36, 69, curve=1.4) * 0.4
    shimmer = bp(noise(n), 3200, 6000) * 0.07 * np.linspace(0, 1, n) ** 3
    return lp(low, 300) * env(n, 2.2, 1.1, curve=1.5) + shimmer


def maw():
    """The grin coming apart. Wet, low, and descending — the pitch falls as it
    opens, which is the opposite of what a scream does."""
    n = secs(2.4)
    creak = sweep(n, 190, 58, curve=0.7)
    creak *= 0.5 + 0.5 * np.sign(np.sin(2 * np.pi * 27 * t(n)))  # dry rasp
    wet = bp(noise(n), 220, 1600) * 0.7
    wet *= 0.4 + 0.6 * np.abs(np.sin(2 * np.pi * 6.5 * t(n)))
    thud = sweep(secs(0.5), 90, 32, curve=1.2) * env(secs(0.5), 0.005, 0.45, curve=3)
    body = lp(creak * 0.5 + wet, 1900) * env(n, 0.18, 1.5, curve=1.6)
    body[: len(thud)] += thud * 0.8
    return body


def gaunt_call():
    """Enormous and far away. Long, slow vibrato and almost no high end, which
    is what distance does to a big sound."""
    n = secs(5.5)
    x = t(n)
    vib = 1 + 0.02 * np.sin(2 * np.pi * 1.1 * x) + 0.008 * np.sin(2 * np.pi * 0.31 * x)
    voice = np.zeros(n)
    for h, g in ((1, 1.0), (2, 0.45), (3, 0.22), (5, 0.08)):
        voice += g * np.sin(2 * np.pi * 52 * h * np.cumsum(vib) / SR)
    air = lp(noise(n), 700) * 0.25
    shape = env(n, 1.3, 2.6, hold=0.4, curve=1.7)
    return lp((voice * 0.8 + air) * shape, 900)


def far_step():
    """A footfall from something with a long stride and a lot of mass."""
    n = secs(1.6)
    thump = sweep(n, 74, 26, curve=1.6) * env(n, 0.004, 0.55, curve=3.5)
    grit = lp(noise(n), 900) * env(n, 0.002, 0.16, curve=4) * 0.35
    tail = lp(noise(n), 200) * env(n, 0.05, 1.2, curve=2.5) * 0.18
    return lp(thump + grit + tail, 1100)


def scrape():
    """Stone on bone. A bandpass sweeping across granular noise."""
    n = secs(2.0)
    src = noise(n)
    out = np.zeros(n)
    chunk = secs(0.05)
    for i in range(0, n - chunk, chunk):
        lo = rng.uniform(300, 1400)
        out[i:i + chunk] = bp(src[i:i + chunk], lo, lo * 2.6, order=2) * rng.uniform(0.3, 1.0)
    return lp(out, 3000) * env(n, 0.15, 1.2, curve=1.4)


def heart():
    """Two thumps. The player's own, which is why it has no reverb tail."""
    n = secs(1.3)
    out = np.zeros(n)
    for offset, gain in ((0.0, 1.0), (0.34, 0.62)):
        i = secs(offset)
        d = secs(0.34)
        beat = sweep(d, 62, 34, curve=1.5) * env(d, 0.006, 0.3, curve=3.2)
        out[i:i + d] += beat * gain
    return lp(out, 420)


def knock():
    """One hollow knock on something you did not build."""
    n = secs(0.7)
    src = noise(n) * env(n, 0.001, 0.14, curve=5)
    body = bp(src, 140, 340, order=2) * 1.0 + bp(src, 600, 900, order=2) * 0.25
    ring = np.sin(2 * np.pi * 172 * t(n)) * env(n, 0.002, 0.35, curve=4) * 0.4
    return lp(body + ring, 2200)


def chorus():
    """Several whispers at once, at different pitches and offsets. Used only by
    the incident that puts three more of them around you."""
    n = secs(4.8)
    out = np.zeros(n)
    for pitch, delay, gain in ((0.82, 0.0, 1.0), (1.0, 0.5, 0.8), (1.25, 1.1, 0.6), (0.7, 1.9, 0.5)):
        w = whisper(3.0, base=pitch)
        i = secs(delay)
        end = min(n, i + len(w))
        out[i:end] += w[: end - i] * gain
    return out * env(n, 0.4, 1.6, curve=1.3)


def vanish():
    """Air closing on the space where it was standing. Only ever heard after
    it has already gone."""
    n = secs(1.6)
    body = lp(noise(n), 1200) * env(n, 0.5, 0.6, curve=1.8)
    drop = sweep(n, 140, 40, curve=1.2) * env(n, 0.35, 0.7, curve=2) * 0.5
    return lp(body * 0.5 + drop, 1500)


def listen():
    """A short, dry, upward tick. The sound of something orienting."""
    n = secs(1.1)
    up = sweep(n, 44, 96, curve=1.8) * env(n, 0.45, 0.5, curve=2)
    tick = bp(noise(n), 900, 2600) * env(n, 0.002, 0.08, curve=5) * 0.25
    return lp(up, 600) + tick


SOUNDS = {
    "breath": (breath, "hostile"),
    "drone": (drone, "ambient"),
    "whisper": (whisper, "ambient"),
    "stare": (stare, "hostile"),
    "maw": (maw, "hostile"),
    "gaunt_call": (gaunt_call, "hostile"),
    "far_step": (far_step, "hostile"),
    "scrape": (scrape, "ambient"),
    "heart": (heart, "player"),
    "knock": (knock, "ambient"),
    "chorus": (chorus, "hostile"),
    "vanish": (vanish, "hostile"),
    "listen": (listen, "ambient"),
}


def main():
    print("generating sounds:")
    definitions = {}
    for name, (fn, category) in SOUNDS.items():
        write(name, fn())
        definitions[f"nx.{name}"] = {
            "category": category,
            # max_distance keeps the big sounds audible from where the Gaunt
            # actually stands; Bedrock's default rolloff would swallow them.
            "max_distance": 96.0 if name in ("gaunt_call", "far_step", "drone") else 32.0,
            "sounds": [{"name": f"sounds/nx/{name}", "volume": 1.0, "stream": False}],
        }

    defs_path = ROOT / "packs" / "notice_RP" / "sounds" / "sound_definitions.json"
    defs_path.write_text(json.dumps({
        "format_version": "1.14.0",
        "sound_definitions": definitions,
    }, indent=2) + "\n")
    print(f"  {defs_path.relative_to(ROOT)}  ({len(definitions)} events)")
    print("done.")


if __name__ == "__main__":
    main()
