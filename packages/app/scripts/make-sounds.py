#!/usr/bin/env python3
"""
pew2's sound effects, synthesised from scratch (no samples, nothing licensed).

    python3 packages/app/scripts/make-sounds.py

Writes `packages/app/assets/sounds/*.wav` (mono, 44.1 kHz, 16-bit). WAV on
purpose: AAC pads the start of a file with ~45 ms of silence, and the goal
launch's charge has to finish on the exact frame Ken blows.

One palette for all of them so they sound like one thing: soft FM bells and
sine tones in D major pentatonic (D E F# A B), filtered noise for air, and one
small shared room. The timings are the app's own: `charge` is HOLD_MS long
with a tick on each of the ring's 24 dots, `burst` lands with the blast and
`reveal` with the opening (`launchFx.ts`, `NewGoalSheet.tsx`).

Needs numpy and scipy. Deterministic: the same script writes the same files.
"""
import os
import sys
import zlib

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, fftconvolve, sosfilt

SR = 44100
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "sounds")
RNG = np.random.default_rng(7)

# Must match NewGoalSheet.tsx (HOLD_MS) and launchFx.ts (RING_DOTS).
HOLD_S = 1.6
RING_DOTS = 24

# D major pentatonic, from D3 up.
def note(semis_from_d3: float) -> float:
    return 146.83 * 2 ** (semis_from_d3 / 12)

PENTA = [0, 2, 4, 7, 9]  # D E F# A B
def penta(i: int) -> float:
    return note(PENTA[i % 5] + 12 * (i // 5))


def t_axis(dur: float) -> np.ndarray:
    return np.arange(int(dur * SR)) / SR


def osc(freq, dur: float) -> np.ndarray:
    """A sine whose frequency may change over time (array or scalar)."""
    n = int(dur * SR)
    f = np.broadcast_to(np.asarray(freq, dtype=float), (n,))
    return np.sin(2 * np.pi * np.cumsum(f) / SR)


def bell(freq: float, dur: float, bright: float = 1.0, decay: float = 4.0) -> np.ndarray:
    """A soft FM bell: carrier with an inharmonic modulator whose depth dies away."""
    t = t_axis(dur)
    index = bright * 1.3 * np.exp(-t * decay * 1.6)
    mod = np.sin(2 * np.pi * freq * 3.5 * t)
    env = np.exp(-t * decay) * np.minimum(1, t / 0.003)
    return np.sin(2 * np.pi * freq * t + index * mod) * env


def noise(dur: float) -> np.ndarray:
    return RNG.standard_normal(int(dur * SR))


def band(x: np.ndarray, lo: float, hi: float, order: int = 2) -> np.ndarray:
    sos = butter(order, [lo, min(hi, SR / 2 - 100)], btype="band", fs=SR, output="sos")
    return sosfilt(sos, x)


def low(x: np.ndarray, hz: float, order: int = 2) -> np.ndarray:
    return sosfilt(butter(order, hz, btype="low", fs=SR, output="sos"), x)


def high(x: np.ndarray, hz: float, order: int = 2) -> np.ndarray:
    return sosfilt(butter(order, hz, btype="high", fs=SR, output="sos"), x)


def sweep_band(x: np.ndarray, lo: np.ndarray, hi: np.ndarray, blocks: int = 48) -> np.ndarray:
    """Band-pass with moving edges, block by block with crossfades."""
    n = len(x)
    out = np.zeros(n)
    size = n // blocks + 1
    win = np.hanning(size * 2)
    for b in range(blocks + 1):
        start = max(0, b * size - size)
        end = min(n, b * size + size)
        if end <= start:
            continue
        k = min(n - 1, b * size)
        seg = band(x[start:end], float(lo[k]), float(hi[k]))
        out[start:end] += seg * win[: end - start]
    return out


def place(dst: np.ndarray, src: np.ndarray, at: float, gain: float = 1.0) -> None:
    i = int(at * SR)
    if i >= len(dst):
        return
    j = min(len(dst), i + len(src))
    dst[i:j] += src[: j - i] * gain


def fade(x: np.ndarray, fin: float = 0.004, fout: float = 0.02) -> np.ndarray:
    x = x.copy()
    a = int(fin * SR)
    b = int(fout * SR)
    if a:
        x[:a] *= np.linspace(0, 1, a)
    if b:
        x[-b:] *= np.linspace(1, 0, b)
    return x


# One small room for everything.
_IR_T = t_axis(0.9)
ROOM = noise(0.9) * np.exp(-_IR_T * 6.5)
ROOM = low(ROOM, 6000)
ROOM /= np.sqrt(np.sum(ROOM**2))


def room(x: np.ndarray, wet: float = 0.18, tail: float = 0.5) -> np.ndarray:
    padded = np.concatenate([x, np.zeros(int(tail * SR))])
    w = fftconvolve(padded, ROOM)[: len(padded)]
    return padded * (1 - wet * 0.4) + w * wet


def master(x: np.ndarray, peak_db: float) -> np.ndarray:
    """Soft-clip, then set the peak level. Quiet by default: these are UI sounds."""
    x = np.tanh(x * 1.2)
    x = x / (np.max(np.abs(x)) + 1e-9)
    return x * 10 ** (peak_db / 20)


def write(name: str, x: np.ndarray, peak_db: float) -> None:
    x = master(fade(x), peak_db)
    os.makedirs(OUT, exist_ok=True)
    wavfile.write(os.path.join(OUT, f"{name}.wav"), SR, (x * 32767).astype(np.int16))
    print(f"{name:14s} {len(x) / SR:5.2f}s")


AGENT_RMS_DB = -33.0

# --- Loudness tiers -----------------------------------------------------------
#
# Every sound is levelled by its loudest 50 ms (what the ear calls "loud"), to
# one of four tiers, so nothing drifts louder than its job. The slide (swish,
# the reference Ken picked) sits at -40: everything touched often lives there.
TOUCH_DB = -40.0   # under every touch: never noticed as a sound
CUE_DB = -32.0     # a moment: sent, done, careful, failed, Pew poked
ALERT_DB = -26.0   # wants you: an agent needs you, a call
# The launch (charge, burst, drain) is a show and keeps its own level.

# Never regenerated: the sounds Ken signed off (the slide, the launch, the
# agents' signatures, the typing). Their files are the reference; rewriting
# them would change their noise and their level for nothing.
FROZEN = {
    "charge", "drain", "burst", "swish-up", "swish-down", "choose",
    "key-0", "key-1", "key-2", "key-3",
    *(f"agent-{a}" for a in (
        "claude-code", "codex", "gemini-cli", "ggcoder", "opencode", "cursor-agent", "cline",
        "goose", "hermes", "openclaw", "qwen-code", "echo", "gg-goals", "ezcoder",
    )),
}


def seed(name: str) -> None:
    """Each sound draws its own noise, so changing one never changes another."""
    global RNG
    RNG = np.random.default_rng(zlib.crc32(name.encode()))


def loudest(x: np.ndarray, window: float = 0.05) -> float:
    w = int(window * SR)
    best = 0.0
    for i in range(0, max(1, len(x) - w), w // 2):
        best = max(best, float(np.sqrt(np.mean(x[i : i + w] ** 2))))
    return best + 1e-12


def write_level(name: str, x: np.ndarray, level_db: float, ceiling_db: float = -12.0) -> None:
    """Levelled by its loudest 50 ms to a tier, the peak capped. No soft-clip:
    these are quiet, and clipping is where harshness comes from."""
    y = fade(x)
    gain = min(10 ** (level_db / 20) / loudest(y), 10 ** (ceiling_db / 20) / (np.max(np.abs(y)) + 1e-9))
    y = y * gain
    os.makedirs(OUT, exist_ok=True)
    wavfile.write(os.path.join(OUT, f"{name}.wav"), SR, (y * 32767).astype(np.int16))
    print(f"{name:14s} {len(y) / SR:5.2f}s  {20 * np.log10(loudest(y)):6.1f} dB")


def write_rms(name: str, x: np.ndarray, rms_db: float, ceiling_db: float, window: float = 0.2) -> None:
    """Like `write`, but levelled by loudness over the first `window` seconds,
    with the peak capped, so sounds of different shapes sit at one volume."""
    y = master(fade(x), 0.0)
    rms = np.sqrt(np.mean(y[: int(window * SR)] ** 2)) + 1e-9
    gain = min(10 ** (rms_db / 20) / rms, 10 ** (ceiling_db / 20) / (np.max(np.abs(y)) + 1e-9))
    y = y * gain
    os.makedirs(OUT, exist_ok=True)
    wavfile.write(os.path.join(OUT, f"{name}.wav"), SR, (y * 32767).astype(np.int16))
    print(f"{name:14s} {len(y) / SR:5.2f}s")


# --- Pew's palette ------------------------------------------------------------
#
# Pew is a sphere of warm LED dots, so its sounds are the same thing: a
# "pip", one dot of light turning on. A warm sine with a breath of its octave,
# a soft 4 ms rise (no click), gone in a tenth of a second, low-passed so it
# never glints. Built from these, three gestures carry every meaning: rising
# is good / on / open, falling is careful / off / closed, and Pew's own voice
# (the poke) is Pew. Everything sits in D major pentatonic, mostly between A4
# and B5: below the range that pierces on a phone speaker.

def pip(freq: float, dur: float = 0.11, decay: float = 34.0, warmth: float = 0.16, glide: float = 0.0) -> np.ndarray:
    """One LED dot of sound. `glide` bends the pitch (in octaves) over the first 30 ms."""
    t = t_axis(dur)
    bend = 2 ** (glide * np.minimum(1, t / 0.03))
    f = freq * bend
    tone = osc(f, dur) + warmth * osc(f * 2, dur) + 0.04 * osc(f * 3, dur)
    env = np.minimum(1, t / 0.004) * np.exp(-t * decay)
    return low(tone * env, 2600)


def dots(pitches, gap: float = 0.07, dur: float = 0.11, decay: float = 34.0, gains=None, glide: float = 0.0) -> np.ndarray:
    """A few pips in a row: the cues are all made of these."""
    x = np.zeros(int((gap * (len(pitches) - 1) + dur + 0.02) * SR))
    for k, f in enumerate(pitches):
        place(x, pip(f, dur, decay, glide=glide), k * gap, 1.0 if gains is None else gains[k])
    return x


def air(dur: float, up: bool = True, lo: float = 500, hi: float = 2700) -> np.ndarray:
    """The slide's air (swish), any length: soft filtered noise, rising or falling."""
    t = t_axis(dur)
    u = t / dur if up else 1 - t / dur
    env = np.sin(np.pi * np.minimum(1, t / dur)) ** 2
    return sweep_band(noise(dur), lo + (hi - lo) * 0.8 * u, lo * 2.4 + (hi * 2 - lo * 2.4) * u, blocks=24) * env


def glow(pitches, dur: float, rise: float = 0.15, fall: float = 3.0) -> np.ndarray:
    """A soft chord blooming and fading: the launch's light, without the blast."""
    t = t_axis(dur)
    x = np.zeros(len(t))
    for f in pitches:
        x += osc(f, dur) + 0.12 * osc(f * 2, dur)
    env = np.minimum(1, t / rise) ** 1.5 * np.exp(-np.maximum(0, t - rise) * fall)
    return low(x * env / len(pitches), 2000)


# --- The goal launch ---------------------------------------------------------

def charge() -> np.ndarray:
    """Hold: a tone climbing three octaves, air rising with it, a tick per ring dot."""
    dur = HOLD_S
    t = t_axis(dur)
    u = t / dur
    f = 110 * 2 ** (3 * u**1.25)
    trem_rate = 5 + 26 * u**2
    trem = 0.75 + 0.25 * np.sin(2 * np.pi * np.cumsum(trem_rate) / SR)
    tone = (osc(f, dur) + 0.35 * osc(f * 2, dur) + 0.12 * osc(f * 3.01, dur)) * (0.08 + 0.55 * u**1.6) * trem
    sub = osc(55 + 30 * u, dur) * 0.25 * u**2
    air = sweep_band(noise(dur), 700 + 3000 * u**1.5, 1100 + 4500 * u**1.5) * (0.01 + 0.16 * u**2.4)
    x = tone + sub + air
    for k in range(RING_DOTS):
        at = (k + 1) / RING_DOTS * dur - 0.01
        x_tick = bell(penta(5 + k // 2), 0.08, bright=0.6, decay=40)
        place(x, x_tick, at, 0.18 + 0.32 * (k / RING_DOTS))
    # Cut clean at the blast: the burst takes over on the same frame.
    x[-int(0.012 * SR):] *= np.linspace(1, 0, int(0.012 * SR))
    return room(x, wet=0.12, tail=0.05)


def drain() -> np.ndarray:
    """Let go early: the charge winds down."""
    dur = 0.42
    t = t_axis(dur)
    u = t / dur
    tone = osc(660 * 2 ** (-2.2 * u), dur) * (1 - u) ** 1.5
    air = low(noise(dur), 2500) * 0.15 * (1 - u) ** 2
    return room(tone * 0.6 + air, wet=0.2, tail=0.3)


def burst() -> np.ndarray:
    """The blast: a deep thump, a crack, a ringing chord and sparks raining down."""
    dur = 2.4
    t = t_axis(dur)
    x = np.zeros(len(t))
    # Thump: a sine falling from 120 to 38 Hz.
    thump_f = 38 + 82 * np.exp(-t * 9)
    x += osc(thump_f, dur) * np.exp(-t * 3.2) * 1.3
    # Crack: noise, bright for a moment, then dark.
    crack = noise(dur)
    x += high(crack, 900) * np.exp(-t * 38) * 0.9
    x += low(crack, 1800) * np.exp(-t * 6) * 0.35
    # Chord: D major, bells, opening out.
    for i, semis in enumerate([0, 7, 12, 16, 19, 24]):
        place(x, bell(note(semis), 2.2, bright=0.8, decay=1.6), 0.01 * i, 0.22)
    # Sparks: high pentatonic bells, dense at first and thinning out.
    for k in range(70):
        at = 0.04 + 1.7 * (RNG.random() ** 1.8)
        f = penta(10 + int(RNG.integers(0, 9)))
        place(x, bell(f, 0.35, bright=0.5, decay=11), at, 0.08 * (1 - at / 1.9))
    return room(x, wet=0.28, tail=0.6)


def reveal() -> np.ndarray:
    """The goal sheet opening: the slide's air, longer, and a warm glow under it."""
    x = air(0.5, up=True) * 0.9
    x = np.concatenate([x, np.zeros(int(0.25 * SR))])
    place(x, glow((note(12), note(19)), 0.7, rise=0.25, fall=4.0), 0.08, 0.5)
    return room(x, wet=0.1, tail=0.15)


# --- The spin toy (home Pew) -------------------------------------------------
#
# Its own family, nothing like the goal launch's charge and blast: a toy, not
# a show. A spinning top's whirr that climbs with each stage, a round "pop"
# with his dots raining down after it, and a happy sigh.

def whirr(stage: int) -> np.ndarray:
    """One stage up: a quick whirr, faster and higher each stage (a top speeding up)."""
    dur = 0.32
    t = t_axis(dur)
    rate = 9 + stage * 7          # flutter: the top's wobble, quicker each stage
    base = penta(7 + stage * 2)
    f = base * (1 + 0.06 * t / dur)
    flutter = 0.55 + 0.45 * np.sin(2 * np.pi * rate * t) ** 2
    tone = (osc(f, dur) + 0.22 * osc(f * 2, dur)) * flutter
    env = np.minimum(1, t / 0.03) * np.exp(-np.maximum(0, t - 0.06) * 9)
    x = low(tone * env, 2400) + air(dur, up=True, lo=700, hi=2600) * 0.12
    return room(x, wet=0.08, tail=0.12)


def spin_pop() -> np.ndarray:
    """The burst: a round, bubbly pop, then his dots raining down as tiny pips."""
    dur = 0.12
    t = t_axis(dur)
    f = 900 * np.exp(-t * 22) + 260
    pop = (osc(f, dur) + 0.25 * osc(f * 1.5, dur)) * np.minimum(1, t / 0.002) * np.exp(-t * 30)
    x = np.zeros(int(1.1 * SR))
    place(x, low(pop, 3000), 0.0, 1.0)
    place(x, air(0.18, up=True, lo=800, hi=3000) * 0.3, 0.0)
    rain = [note(31), note(28), note(26), note(24), note(21), note(19), note(17), note(14)]
    for k, f0 in enumerate(rain):
        place(x, pip(f0, 0.09, 40), 0.1 + k * 0.055 + 0.012 * np.sin(k * 2.3), 0.55 * (0.92 ** k))
    return room(x, wet=0.12, tail=0.2)


def spin_sigh() -> np.ndarray:
    """After: a contented "phew", a soft breath sliding down under one warm dot."""
    x = air(0.55, up=False, lo=450, hi=1800) * 0.6
    x = np.concatenate([x, np.zeros(int(0.2 * SR))])
    place(x, pip(note(12), 0.3, 7, glide=-0.12), 0.18, 0.5)
    return room(x, wet=0.1, tail=0.15)


# --- The thinking dial -------------------------------------------------------

LEVEL_STEPS = 5


def level_up(i: int) -> np.ndarray:
    """One dot, bending up, pitched with the level."""
    return room(pip(penta(9 + i), 0.12, 30, glide=0.08), wet=0.06, tail=0.08)


def level_max() -> np.ndarray:
    """The top: the dot, and three tiny dots glinting after it."""
    x = np.concatenate([level_up(LEVEL_STEPS - 1), np.zeros(int(0.3 * SR))])
    place(x, dots([penta(15), penta(16), penta(17)], gap=0.05, dur=0.08, decay=45, gains=[0.35, 0.28, 0.2]), 0.09)
    return room(x, wet=0.08, tail=0.1)


def level_down(i: int) -> np.ndarray:
    """One dot, bending down, pitched with the level it left."""
    return room(pip(penta(9 + i), 0.12, 30, glide=-0.1), wet=0.06, tail=0.08)


# --- Everyday ----------------------------------------------------------------

def send() -> np.ndarray:
    """A message leaves: Pew's "pew", soft. A warm dot sliding down under a
    breath of the slide's air, the way the bubble lifts away."""
    dur = 0.16
    t = t_axis(dur)
    f = 520 + 520 * np.exp(-t * 26)
    tone = (osc(f, dur) + 0.15 * osc(f * 2, dur)) * np.minimum(1, t / 0.004) * np.exp(-t * 20)
    x = low(tone, 2400) + air(dur, up=True, lo=900, hi=3200) * 0.18
    return room(x, wet=0.06, tail=0.08)


def ok() -> np.ndarray:
    """Done (a reply finished, copied, saved, signed in): two dots rising a fourth."""
    return room(dots([note(19), note(24)], gap=0.075), wet=0.06, tail=0.1)


def attention() -> np.ndarray:
    """An agent needs you: three dots climbing, a little brighter. Noticed, never sharp."""
    return room(dots([note(24), note(28), note(31)], gap=0.08, dur=0.13, decay=26, gains=[0.8, 0.9, 1.0]), wet=0.08, tail=0.12)


def warn() -> np.ndarray:
    """Careful (stop, deny, can't yet): two dots stepping down."""
    return room(dots([note(24), note(19)], gap=0.09, decay=30), wet=0.06, tail=0.1)


def error() -> np.ndarray:
    """Something failed: two low, muffled dots falling. A shrug, never a buzzer."""
    x = dots([note(14), note(7)], gap=0.11, dur=0.16, decay=22)
    return room(low(x, 1200), wet=0.06, tail=0.1)


# --- Calls with Pew -----------------------------------------------------------
#
# Heard in the ear as often as on the speaker: the gentlest of all.

def call_dial() -> np.ndarray:
    """Calling: two soft rings, one a second, breathing with the calling glow
    (launchFx.ts `paintCalling`). Each ring is a pair of dots a fifth apart."""
    x = np.zeros(int(2.0 * SR))
    for k in range(2):
        at = 0.18 + k * 1.0
        ring = dots([note(19), note(26)], gap=0.12, dur=0.2, decay=14, gains=[0.85, 1.0])
        place(x, ring, at)
    return room(x, wet=0.08, tail=0.15)


def call_connect() -> np.ndarray:
    """Connected: the launch's light, gentled. A soft glow and three dots climbing."""
    x = np.concatenate([glow((note(7), note(14)), 0.5, rise=0.04, fall=6) * 0.5, np.zeros(int(0.2 * SR))])
    place(x, dots([note(19), note(24), note(28)], gap=0.06), 0.03)
    return room(x, wet=0.08, tail=0.12)


def call_end() -> np.ndarray:
    """Call ended: the connect, reversed. Two dots stepping down, the light going out."""
    x = np.concatenate([dots([note(24), note(19)], gap=0.1, dur=0.14, decay=24), np.zeros(int(0.15 * SR))])
    place(x, glow((note(7),), 0.35, rise=0.02, fall=8) * 0.35, 0.08)
    return room(x, wet=0.08, tail=0.12)


# --- Touch: one sound per kind of haptic (ui/haptics.ts) ----------------------
#
# Soft sounds sit under every ordinary touch and must never be noticed as
# sounds: one short pip, low, at the slide's level.

def tick() -> np.ndarray:
    """A button: one LED dot turning on. Barely there."""
    return room(pip(note(21), 0.05, 70), wet=0.04, tail=0.04)


def select() -> np.ndarray:
    """Moving between options: a dot, a step higher than a tap."""
    return room(pip(note(24), 0.07, 55), wet=0.04, tail=0.05)


def detent(i: int) -> np.ndarray:
    """A dial clicking onto a stop; five pitches, climbing with the position."""
    return room(pip(penta(10 + i), 0.06, 60), wet=0.04, tail=0.05)


def toggle(on: bool) -> np.ndarray:
    """A switch: two dots, up for on, down for off."""
    lo, hi = note(19), note(24)
    return room(dots([lo, hi] if on else [hi, lo], gap=0.05, dur=0.07, decay=50), wet=0.04, tail=0.05)


def swish(up: bool) -> np.ndarray:
    """A sheet or the drawer sliding: soft air, rising in, falling away."""
    dur = 0.2
    t = t_axis(dur)
    u = t / dur if up else 1 - t / dur
    env = np.sin(np.pi * np.minimum(1, t / dur)) ** 2
    x = sweep_band(noise(dur), 500 + 2200 * u, 1200 + 4200 * u, blocks=24) * env
    return room(x * 0.8, wet=0.1, tail=0.1)


def poke(i: int) -> np.ndarray:
    """Pew poked: a round little 'boop' that bends up, four voices so it never
    sounds like a recording. Pew's own voice, warmer than before."""
    dur = 0.16
    t = t_axis(dur)
    base = penta(7 + i)
    f = base * (0.82 + 0.3 * (1 - np.exp(-t * 38))) * (1 + 0.012 * np.sin(2 * np.pi * 24 * t))
    env = np.minimum(1, t / 0.006) * np.exp(-t * 17)
    tone = (osc(f, dur) + 0.25 * osc(f * 2, dur) + 0.05 * osc(f * 3, dur)) * env
    return room(low(tone, 2600), wet=0.08, tail=0.12)


def choose() -> np.ndarray:
    """An agent without a signature of its own: three small dots climbing."""
    x = np.zeros(int(0.3 * SR))
    for k, semis in enumerate((19, 24, 28)):
        place(x, bell(note(semis), 0.12, bright=0.5, decay=28), k * 0.045, 0.45)
    return room(x, wet=0.12, tail=0.15)


# --- Agents: one signature each -----------------------------------------------
#
# Heard when an agent is landed on in the switcher or picked from the rail, so
# each agent has a voice of its own. All short (under ~0.6 s), all in the
# same key and room, each a different instrument and gesture.

def pluck(freq: float, dur: float, bright: float = 0.5, decay: float = 7.0) -> np.ndarray:
    """A plucked string (Karplus-Strong): a koto or guitar-ish note."""
    n = int(dur * SR)
    period = max(2, int(SR / freq))
    buf = low(noise(period / SR + 0.01), 2000 + 6000 * bright)[:period]
    out = np.zeros(n)
    for i in range(n):
        v = buf[i % period]
        out[i] = v
        buf[i % period] = 0.5 * (v + buf[(i + 1) % period]) * (1 - 0.6 / (decay * period))
    return out * np.minimum(1, t_axis(dur) / 0.002)


def square(freq, dur: float, duty: float = 0.5) -> np.ndarray:
    """A soft (filtered) square wave: the 8-bit voice."""
    n = int(dur * SR)
    f = np.broadcast_to(np.asarray(freq, dtype=float), (n,))
    phase = np.cumsum(f) / SR % 1.0
    return low(np.where(phase < duty, 1.0, -1.0), 3500)


def env_ad(dur: float, attack: float = 0.004, decay: float = 10.0) -> np.ndarray:
    t = t_axis(dur)
    return np.minimum(1, t / attack) * np.exp(-t * decay)


def dot(freq: float, dur: float = 0.12, bright: float = 0.5, decay: float = 26.0) -> np.ndarray:
    """One LED dot of sound: a tiny bell. Every agent signature is built from these."""
    return bell(freq, dur, bright=bright, decay=decay)


# Each signature is two or three dots, under ~0.3 s, the size of the app's
# own blips: an agent's accent, not a jingle. The character is in the timbre
# and the gesture, never in loudness or length.

def agent_claude() -> np.ndarray:
    """Claude Code: warm wood, a gentle rising third."""
    x = np.zeros(int(0.3 * SR))
    for k, semis in enumerate((16, 19)):
        d = 0.16
        t = t_axis(d)
        f = note(semis)
        wood = (osc(f, d) + 0.25 * osc(f * 4, d) * np.exp(-t * 40)) * env_ad(d, 0.003, 20)
        place(x, low(wood, 2600), k * 0.075, 0.6)
    return room(x, wet=0.12, tail=0.15)


def agent_codex() -> np.ndarray:
    """Codex: two exact glass pings, an octave apart."""
    x = np.zeros(int(0.3 * SR))
    for k, semis in enumerate((19, 31)):
        d = 0.14
        t = t_axis(d)
        f = note(semis)
        place(x, (osc(f, d) + 0.12 * osc(f * 2.76, d) * np.exp(-t * 30)) * env_ad(d, 0.002, 24), k * 0.06, 0.55)
    return room(x, wet=0.1, tail=0.15)


def agent_gemini() -> np.ndarray:
    """Gemini CLI: twin voices a hair apart, a quick lift and a glint."""
    dur = 0.2
    t = t_axis(dur)
    f = note(19) * 2 ** (0.5 * np.minimum(1, t / 0.08))
    x = (osc(f, dur) + osc(f * 1.008, dur)) * 0.5 * env_ad(dur, 0.006, 18)
    x = np.concatenate([x, np.zeros(int(0.1 * SR))])
    place(x, dot(penta(18), 0.1, 0.4, 34), 0.09, 0.3)
    return room(x * 0.7, wet=0.14, tail=0.15)


def agent_ggcoder() -> np.ndarray:
    """GG Coder: a soft 8-bit 'g-g'."""
    x = np.zeros(int(0.25 * SR))
    for k, semis in enumerate((19, 26)):
        d = 0.055
        place(x, square(note(semis), d, 0.25) * env_ad(d, 0.002, 18), k * 0.07, 0.35)
    return room(x, wet=0.08, tail=0.12)


def agent_opencode() -> np.ndarray:
    """OpenCode: an open fifth, both notes at once, airy."""
    d = 0.24
    x = (osc(note(14), d) + osc(note(21), d)) * env_ad(d, 0.012, 14) * 0.4
    return room(x, wet=0.16, tail=0.15)


def agent_cursor() -> np.ndarray:
    """Cursor Agent: a cursor blinking twice."""
    x = np.zeros(int(0.22 * SR))
    for k in range(2):
        place(x, dot(penta(18), 0.05, 0.3, 80), k * 0.08, 0.6)
    return room(x, wet=0.08, tail=0.1)


def agent_cline() -> np.ndarray:
    """Cline: two small harp plucks, stepping up."""
    x = np.zeros(int(0.3 * SR))
    for k, semis in enumerate((19, 24)):
        place(x, pluck(note(semis), 0.22, bright=0.35, decay=3), k * 0.07, 0.5)
    return room(x, wet=0.12, tail=0.12)


def agent_goose() -> np.ndarray:
    """goose: one tiny, friendly honk."""
    d = 0.09
    t = t_axis(d)
    f = note(12) * (1 + 0.03 * np.sin(2 * np.pi * 10 * t))
    x = band(square(f, d, 0.3) * env_ad(d, 0.006, 20), 500, 1800) * 2.0
    return room(x * 0.6, wet=0.1, tail=0.12)


def agent_hermes() -> np.ndarray:
    """Hermes: a feather of air, then one clear bell."""
    dur = 0.08
    t = t_axis(dur)
    flick = band(noise(dur), 2500, 8000) * np.sin(np.pi * t / dur) ** 2 * 0.12
    x = np.concatenate([flick, np.zeros(int(0.2 * SR))])
    place(x, dot(note(31), 0.16, 0.6, 20), 0.045, 0.55)
    return room(x, wet=0.12, tail=0.15)


def agent_openclaw() -> np.ndarray:
    """OpenClaw: a soft snap and a low knock."""
    x = np.zeros(int(0.22 * SR))
    place(x, band(noise(0.015), 1500, 5000) * np.exp(-t_axis(0.015) * 320), 0, 0.5)
    t = t_axis(0.14)
    place(x, osc(note(7) * (1 + 0.2 * np.exp(-t * 50)), 0.14) * env_ad(0.14, 0.002, 26), 0.05, 0.6)
    return room(x, wet=0.08, tail=0.1)


def agent_qwen() -> np.ndarray:
    """Qwen Code: two koto plucks, falling a fourth."""
    x = np.zeros(int(0.3 * SR))
    for k, semis in enumerate((26, 21)):
        place(x, pluck(note(semis), 0.22, bright=0.6, decay=3), k * 0.07, 0.5)
    return room(x, wet=0.12, tail=0.12)


def agent_echo() -> np.ndarray:
    """Echo: one dot and its echo."""
    x = np.zeros(int(0.28 * SR))
    for k in range(3):
        place(x, dot(note(24), 0.08, 0.4, 40), k * 0.08, 0.55 * 0.4 ** k)
    return room(x, wet=0.1, tail=0.12)


def agent_goals() -> np.ndarray:
    """GG Goals (Ken's crew): three dots climbing the chord."""
    x = np.zeros(int(0.3 * SR))
    for k, semis in enumerate((12, 16, 19)):
        place(x, dot(note(semis + 12), 0.12, 0.5, 28), k * 0.05, 0.45)
    return room(x, wet=0.12, tail=0.15)


def agent_ezcoder() -> np.ndarray:
    """EZ Coder: an easy pluck, then a bright dot a fifth above it."""
    x = np.zeros(int(0.3 * SR))
    place(x, pluck(note(17), 0.2, bright=0.45, decay=4), 0, 0.5)
    place(x, dot(note(24), 0.12, 0.55, 30), 0.08, 0.45)
    return room(x, wet=0.1, tail=0.12)


AGENT_SOUNDS = {
    "claude-code": agent_claude,
    "codex": agent_codex,
    "gemini-cli": agent_gemini,
    "ggcoder": agent_ggcoder,
    "opencode": agent_opencode,
    "cursor-agent": agent_cursor,
    "cline": agent_cline,
    "goose": agent_goose,
    "hermes": agent_hermes,
    "openclaw": agent_openclaw,
    "qwen-code": agent_qwen,
    "echo": agent_echo,
    "gg-goals": agent_goals,
    "ezcoder": agent_ezcoder,
}


# --- Onboarding scenes --------------------------------------------------------

def banner() -> np.ndarray:
    """A notification landing (onboarding's demo): two dots down a third."""
    return room(dots([note(28), note(24)], gap=0.1, dur=0.13, decay=26), wet=0.06, tail=0.1)


def key(i: int) -> np.ndarray:
    """One key typed on a terminal: a soft plastic tick, four slight variants."""
    dur = 0.05
    t = t_axis(dur)
    body = band(noise(dur), 1800 + 250 * i, 5200 + 400 * i) * np.exp(-t * (420 + 30 * i))
    thock = osc(180 + 25 * i, dur) * np.exp(-t * 160) * 0.25
    return room(body * 0.8 + thock, wet=0.04, tail=0.03)


def pairing() -> np.ndarray:
    """The two Pews linking: two dots meeting on a fifth, then one more glint."""
    x = dots([note(19), note(26), note(31)], gap=0.08, dur=0.13, decay=28, gains=[0.85, 1.0, 0.6])
    return room(x, wet=0.08, tail=0.12)


def main() -> None:
    every = "--all" in sys.argv
    jobs = [
        ("charge", charge, None),
        ("drain", drain, None),
        ("burst", burst, None),
        ("reveal", reveal, ALERT_DB - 4),
    *((f"whirr-{i}", lambda i=i: whirr(i), CUE_DB - 2) for i in range(4)),
    ("spin-pop", spin_pop, ALERT_DB),
    ("spin-sigh", spin_sigh, CUE_DB - 2),
        *((f"level-up-{i}", lambda i=i: level_up(i), TOUCH_DB + 2) for i in range(LEVEL_STEPS)),
        *((f"level-down-{i}", lambda i=i: level_down(i), TOUCH_DB + 2) for i in range(LEVEL_STEPS)),
        ("level-max", level_max, CUE_DB),
        ("send", send, CUE_DB),
        ("done", ok, CUE_DB),
        ("confirm", ok, CUE_DB),
        ("attention", attention, ALERT_DB),
        ("call-dial", call_dial, CUE_DB + 2),
        ("call-connect", call_connect, ALERT_DB - 2),
        ("call-end", call_end, CUE_DB + 2),
        ("tick", tick, TOUCH_DB - 2),
        ("select", select, TOUCH_DB),
        *((f"detent-{i}", lambda i=i: detent(i), TOUCH_DB) for i in range(5)),
        ("toggle-on", lambda: toggle(True), TOUCH_DB + 2),
        ("toggle-off", lambda: toggle(False), TOUCH_DB + 2),
        ("swish-up", lambda: swish(True), None),
        ("swish-down", lambda: swish(False), None),
        *((f"poke-{i}", lambda i=i: poke(i), CUE_DB + 2) for i in range(4)),
        ("warn", warn, CUE_DB),
        ("error", error, CUE_DB),
        ("banner", banner, CUE_DB),
        ("pairing", pairing, ALERT_DB - 2),
    ]
    for name, make, level in jobs:
        if name in FROZEN and not every:
            continue
        seed(name)
        if level is None:
            write(name, make(), {"charge": -4, "drain": -10, "burst": -1.5, "swish-up": -29, "swish-down": -31}[name])
        else:
            write_level(name, make(), level)
    if every:
        for i in range(4):
            seed(f"key-{i}")
            write(f"key-{i}", key(i), -30)
        seed("choose")
        write_rms("choose", choose(), AGENT_RMS_DB, ceiling_db=-14)
        for agent_id, make in AGENT_SOUNDS.items():
            seed(f"agent-{agent_id}")
            write_rms(f"agent-{agent_id}", make(), AGENT_RMS_DB, ceiling_db=-14)


if __name__ == "__main__":
    sys.exit(main())
