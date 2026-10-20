/**
 * Pew's body: the dots, their springs, moods, touch and whole-body motion.
 *
 * Split out of `engine.ts`, which re-exports the public half; painting a frame
 * lives in `enginePaint.ts`. Same rules as the rest of the engine: pure,
 * Expo-free, and every function a `"worklet"` because `Pew.tsx` runs it on
 * the UI thread.
 */
export type PewMood =
  | "idle"
  | "thinking"
  | "working"
  | "talking"
  | "happy"
  | "sleepy"
  | "oops"
  // Voice-call moods.
  | "listening"
  | "typing"
  | "reading"
  | "dialing"
  | "celebrate"
  | "goodbye"
  | "muted";

export const PEW_MOODS: readonly PewMood[] = [
  "idle",
  "thinking",
  "working",
  "talking",
  "happy",
  "sleepy",
  "oops",
  "listening",
  "typing",
  "reading",
  "dialing",
  "celebrate",
  "goodbye",
  "muted",
];

/** 0..255 per channel. */
export type RGB = [number, number, number];

export interface PewPalette {
  /** The brightest lit LED. */
  light: RGB;
  /** A lit LED. */
  base: RGB;
  dark: RGB;
  /** Glow around lit dots and the face. */
  glow: RGB;
  /** The face at small sizes. */
  eye: RGB;
  /** An unlit LED: the body's resting colour. */
  off: RGB;
}

export interface PewPainter {
  dot(x: number, y: number, r: number, c: RGB, a: number): void;
  /** A soft additive halo of radius `r`. */
  glow(x: number, y: number, r: number, c: RGB, a: number): void;
  /** A filled ellipse, rotated by `rot` radians, with an optional halo `glowR` in `gc`. */
  oval(cx: number, cy: number, rx: number, ry: number, rot: number, c: RGB, a: number, glowR: number, gc: RGB): void;
  /** A round-capped polyline `[x0, y0, x1, y1, …]`, with an optional halo. */
  line(pts: number[], width: number, c: RGB, a: number, glowR: number, gc: RGB): void;
  /** A filled polygon `[x0, y0, …]`. */
  poly(pts: number[], c: RGB, a: number): void;
  /** The soft ground shadow: an ellipse fading out from its centre. */
  shadow(cx: number, cy: number, w: number, h: number, a: number): void;
}

/** Everything one Pew remembers between frames. Lives on the UI thread. */
export interface PewBody {
  S: number;
  n: number;
  home: Float32Array;
  p: Float32Array;
  v: Float32Array;
  rnd: Float32Array;
  lat: Float32Array;
  lon: Float32Array;
  /** Per point after projection: sx, sy, z, f (perspective), lambert, nx, ny. */
  scr: Float32Array;
  order: number[];
  yaw: number;
  pitch: number;
  spinV: number;
  yawExtra: number;
  pitchExtra: number;
  pitchV: number;
  dragging: boolean;
  /** Until when a poke keeps it happy (seconds, same clock as `t`). */
  reactUntil: number;
  mood: PewMood | "";
  since: number;
  /**
   * The mood it was showing before the current one, and the face blends out
   * of it over FACE_BLEND seconds: a poke's smile eases back to the resting
   * face, a working face eases into a happy one, rather than snapping.
   */
  prevMood: PewMood | "";
  /** Last time it was advanced; also "now" for gestures. */
  last: number;
  lookX: number;
  lookY: number;
  /** Sleeping style 0..9 (`PEW_SLEEP_STYLES`): how it dozes in the sleepy mood. */
  sleep: number;
  /** The seed it was built from (-1 for none), so a host can tell when to rebuild. */
  seed: number;
  /** Breathing phase (radians) and rate so two dozing Pews never move in sync. */
  sleepPh: number;
  sleepRate: number;
  /**
   * Spin toy (home's Pew): spun like a basketball on a finger. Each flick
   * adds speed instead of setting it, the spin keeps going under the finger,
   * it slows only gently, and the faster it goes the more it flattens, wobbles
   * and trembles (`spinFeel`), up to SPIN_BURST.
   */
  toy: boolean;
  /**
   * A finger on it (`touchPew`): where, in box points, and how far it has
   * pressed in (0..1, eased). The dots under the finger dent in, the rest
   * bulge a little, the body squashes and leans with a drag, and a release
   * wobbles it back: squishy, like pressing a soft ball.
   */
  touching: boolean;
  touchX: number;
  touchY: number;
  press: number;
  /** The drag's horizontal speed (points a second, smoothed), for the lean. */
  dragVX: number;
  /** The release wobble: how strong, and when it started. */
  jiggle: number;
  jiggleAt: number;
}

/** How deep the dent under a finger goes, as a share of the radius. */
const DENT = 0.3;
/** How far the rest of the body bulges while pressed (squishing keeps its volume). */
const BULGE = 0.045;

/** Spin toy: past this many radians a second, Pew bursts (about 4.5 turns a second). */
export const SPIN_BURST = 28;
/** The most it can spin: a little over the burst, so the burst is reachable. */
export const SPIN_MAX = 34;
/** Each radian of a flick adds this many radians a second. */
const SPIN_PUMP = 2.2;
/** How fast a toy spin dies away on its own (per second): slow, so flicks add up. */
const SPIN_DECAY = 0.35;

/** 0 at rest, 1 at the burst: how hard a toy spin is going. */
export function spinFeel(B: PewBody): number {
  "worklet";
  return B.toy ? Math.min(1, Math.abs(B.spinV) / SPIN_BURST) : 0;
}

/** How many sleeping styles there are. */
export const PEW_SLEEP_STYLES = 10;

/** A stable 32-bit hash of a string (FNV-1a): seeds a Pew's sleeping style. */
export function pewSleepSeed(key: string): number {
  "worklet";
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Final avalanche so ids differing only in their last char spread out.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

/** The sleeping style (0..9) for a key such as a provider id. */
export function pewSleepStyle(key: string): number {
  "worklet";
  return pewSleepSeed(key) % PEW_SLEEP_STYLES;
}

// ── constants ───────────────────────────────────────────────

export const TAU = Math.PI * 2;
/** Body radius as a share of the box. */
export const SCALE = 0.29;
/**
 * Where the body's centre sits in its box at rest, as a fraction of the size:
 * it stands on a ground line (0.86) at 1.08 radii up, so it is below the
 * middle. A layout that wants Pew himself centred, not his box, offsets by
 * `(PEW_BODY_CY - 0.5) * size`.
 */
export const PEW_BODY_CY = 0.86 - SCALE * 1.08;
const SPRING_K = 90;
const SPRING_C = 11;
const SEED = 1.6;
export const PEW_AMBER: RGB = [242, 180, 90];

// ── small maths ─────────────────────────────────────────────

export function clamp(v: number, a: number, b: number): number {
  "worklet";
  return v < a ? a : v > b ? b : v;
}
function lerp(a: number, b: number, t: number): number {
  "worklet";
  return a + (b - a) * t;
}
export function smooth(e0: number, e1: number, x: number): number {
  "worklet";
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
export function fract(x: number): number {
  "worklet";
  return x - Math.floor(x);
}
export function hash(n: number): number {
  "worklet";
  return fract(Math.sin(n * 127.1 + 311.7) * 43758.5453);
}
// ORDER MATTERS. On the UI thread each worklet captures the helpers it calls
// at the moment it is defined, so a helper declared further down is captured
// as undefined: "fract is not a function", "talkOpen is not a function".
// bun tests run on the JS thread, where order doesn't matter, so the test
// "no worklet calls a helper declared below it" guards this instead.

/** Sleep time: the clock run at this Pew's own breathing rate and phase. */
export function sleepClock(B: PewBody, t: number): number {
  "worklet";
  return t * B.sleepRate + B.sleepPh;
}

/** Nodding off (style 5): 0 upright .. 1 head dropped; a slow dip then a jerk back up. */
function nodDip(T: number): number {
  "worklet";
  const p = fract(T / 4.6);
  return p < 0.82 ? smooth(0.1, 0.82, p) : 1 - smooth(0.82, 0.88, p);
}

/** How open the mouth is while talking, 0..1: syllables, not a metronome. */
export function talkOpen(t: number): number {
  "worklet";
  const syllable = 0.5 + 0.5 * Math.sin(t * 13.5);
  const phrase = 0.55 + 0.45 * Math.sin(t * 2.3 + Math.sin(t * 0.7) * 2);
  const pause = fract(t / 3.1) > 0.82 ? 0.15 : 1;
  return clamp(syllable * phrase * pause, 0, 1);
}

// ── call moods: shared clocks ───────────────────────────────

/** Typing: how hard a key is being hit, 0..1. Irregular bursts with pauses, like real typing. */
export function typeTap(t: number): number {
  "worklet";
  const burst = Math.floor(t / 0.9);
  if (fract(t / 0.9) > 0.4 + 0.45 * hash(burst * 1.7 + 0.3)) return 0;
  const key = Math.floor(t * 11);
  if (hash(key * 0.73 + 3.1) < 0.3) return 0;
  return 1 - fract(t * 11);
}

/** Which of eight keys the current tap hits. */
export function typeKey(t: number): number {
  "worklet";
  return Math.floor(hash(Math.floor(t * 11) * 1.31 + 0.7) * 8);
}

/** Reading: the eyes' sweep along a line, 0 (left) .. 1 (right), with a quick return. */
export function readSweep(t: number): number {
  "worklet";
  const ph = fract(t / 1.5);
  return ph < 0.85 ? ph / 0.85 : 1 - (ph - 0.85) / 0.15;
}

/** Reading: which line it is on, 0 (top) .. 1 (fourth line down). */
export function readLine(t: number): number {
  "worklet";
  return (Math.floor(t / 1.5) % 4) / 3;
}

/** Celebrate loops every 2.2 s: hop, burst on landing, settle. Phase 0..1 from the mood's age. */
export function cheerPhase(age: number): number {
  "worklet";
  return fract(age / 2.2);
}
export function cheerHop(p: number): number {
  "worklet";
  return p < 0.3 ? Math.sin((p / 0.3) * Math.PI) : 0;
}
/** The sparkle burst, 1 at landing and fading as it settles. */
export function cheerBurst(p: number): number {
  "worklet";
  return p < 0.3 ? 0 : Math.exp(-(p - 0.3) * 6);
}

/** Goodbye repeats every 6 s: the wink (right eye shut), 0..1. */
export function goodbyeWink(age: number): number {
  "worklet";
  const p = age % 6;
  return smooth(0, 0.1, p) * (1 - smooth(1, 1.2, p));
}
/** The wave ripple on one side, 0..1. */
export function goodbyeWave(age: number): number {
  "worklet";
  const p = age % 6;
  return p < 1.6 ? Math.sin((p / 1.6) * Math.PI) : 0;
}
/** After the wink the face softens: 0 alert .. 1 soft. */
export function goodbyeSoft(age: number): number {
  "worklet";
  const p = age % 6;
  return smooth(1.2, 2, p) * (1 - smooth(5.5, 6, p));
}

/** Muted: an occasional slow blink, 0 shut .. 1 open. */
export function slowBlink(t: number): number {
  "worklet";
  const p = t % 5.5;
  return p < 0.7 ? 1 - 0.92 * Math.sin((p / 0.7) * Math.PI) : 1;
}

function wrapAngle(a: number): number {
  "worklet";
  let r = (a + Math.PI) % TAU;
  if (r < 0) r += TAU;
  return r - Math.PI;
}

// ── the body ────────────────────────────────────────────────

/** How many dots a Pew of edge `S` is made of. */
export function pewCount(S: number): number {
  "worklet";
  return S > 140 ? 1000 : S > 50 ? 420 : S > 28 ? 180 : 120;
}

/**
 * Rows of dots, like an LED globe: the pew2 icon wrapped round a ball.
 * Alternate rows are offset half a dot so the grid reads as a weave.
 */
export function gridPoints(target: number): Float32Array {
  "worklet";
  const rows = Math.max(7, Math.round(Math.sqrt(target / 1.27)));
  const pts: number[] = [];
  for (let r = 0; r < rows; r++) {
    const lat = -Math.PI / 2 + ((r + 0.5) / rows) * Math.PI;
    const cols = Math.max(4, Math.round(rows * 2 * Math.cos(lat)));
    for (let c = 0; c < cols; c++) {
      const lon = (c / cols) * TAU + (r % 2) * (Math.PI / cols);
      pts.push(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
    }
  }
  return Float32Array.from(pts);
}

/**
 * A new Pew. It starts as a speck at its centre and bursts out to its full
 * size on the first frames, which is its "coming alive" entrance.
 */
export function makePewBody(S: number, seed?: number): PewBody {
  "worklet";
  const sd = Math.abs(Math.floor(seed ?? 0));
  const sleep = sd % PEW_SLEEP_STYLES;
  // Style 0 with no seed keeps the original timing exactly.
  const ph = seed === undefined ? 0 : hash(Math.floor(sd / PEW_SLEEP_STYLES) * 0.013 + sleep * 3.7);
  const home = gridPoints(pewCount(S));
  const n = home.length / 3;
  const rnd = new Float32Array(n);
  const lat = new Float32Array(n);
  const lon = new Float32Array(n);
  const p = new Float32Array(n * 3);
  const order: number[] = [];
  for (let i = 0; i < n; i++) {
    rnd[i] = hash(i * 1.37 + 0.5);
    lat[i] = Math.asin(clamp(home[i * 3 + 1]!, -1, 1));
    lon[i] = Math.atan2(home[i * 3 + 2]!, home[i * 3]!);
    order.push(i);
  }
  for (let i = 0; i < n * 3; i++) p[i] = home[i]! * 0.05;
  return {
    S,
    n,
    home,
    p,
    v: new Float32Array(n * 3),
    rnd,
    lat,
    lon,
    scr: new Float32Array(n * 7),
    order,
    yaw: 0,
    pitch: 0,
    spinV: 0,
    yawExtra: 0,
    pitchExtra: 0,
    pitchV: 0,
    dragging: false,
    reactUntil: -1,
    mood: "",
    since: 0,
    prevMood: "",
    last: 0,
    lookX: 0,
    lookY: 0,
    sleep,
    toy: false,
    touching: false,
    touchX: 0,
    touchY: 0,
    press: 0,
    dragVX: 0,
    jiggle: 0,
    jiggleAt: 0,
    seed: seed === undefined ? -1 : sd,
    sleepPh: ph * TAU,
    sleepRate: seed === undefined ? 1 : 0.82 + 0.36 * hash(ph * 91.7 + 2.1),
  };
}

export interface MoodState {
  mood: PewMood;
  age: number;
  decay: number;
}

/** The mood it is actually showing: a poke makes it happy for a moment. */
export function effectiveMood(B: PewBody, t: number, mood: PewMood): MoodState {
  "worklet";
  const shown: PewMood = t < B.reactUntil ? "happy" : mood;
  if (shown !== B.mood) {
    B.prevMood = B.mood;
    B.mood = shown;
    B.since = t;
  }
  const age = Math.max(0, t - B.since);
  return { mood: shown, age, decay: Math.max(0, 1 - age / 0.8) };
}

/** Where point `i` wants to be, for this mood. */
function target(o: Float32Array, i: number, B: PewBody, t: number, st: MoodState): void {
  "worklet";
  const h = B.home;
  const x = h[i * 3]!;
  const y = h[i * 3 + 1]!;
  const z = h[i * 3 + 2]!;
  const lat = B.lat[i]!;
  const r = B.rnd[i]!;
  let k = 1 + 0.015 * Math.sin(t * 2 + y * 3);
  let sx = 1;
  let sy = 1;
  switch (st.mood) {
    case "thinking":
      k = 1 + 0.045 * Math.sin(lat * 7 - t * 3);
      break;
    case "working":
      k = 1 + 0.07 * Math.sin(lat * 7 - t * 7);
      break;
    case "talking":
      k = 1 + 0.015 * Math.sin(t * 2 + y * 3) + 0.012 * talkOpen(t) * (y < 0 ? 1 : 0.3);
      break;
    case "happy":
      k = 1 + 0.04 * Math.sin(t * 8) + 0.03 * Math.sin(lat * 5 + t * 10);
      break;
    case "sleepy":
      k = 1 + 0.02 * Math.sin(sleepClock(B, t) * (B.sleep === 6 ? 0.6 : 1.1));
      sy = B.sleep === 6 ? 0.8 : 0.88;
      sx = B.sleep === 6 ? 1.1 : 1.06;
      break;
    case "oops":
      k = 1 + 0.2 * st.decay * st.decay * (r - 0.3) + 0.012 * Math.sin(t * 40 + r * 30);
      break;
    case "listening":
      // A ripple running in toward the face's centre: taking sound in.
      k = 1 + 0.012 * Math.sin(t * 2 + y * 3) + 0.022 * Math.sin(Math.acos(clamp(z, -1, 1)) * 5 + t * 5.5);
      break;
    case "typing":
      k = 1 + 0.012 * Math.sin(t * 2 + y * 3) - (y < -0.4 && z > 0 ? 0.03 * typeTap(t) : 0);
      break;
    case "reading": {
      const d = y - (1 - 2 * fract(t / 2.6));
      k = 1 + 0.012 * Math.sin(t * 2 + y * 3) + 0.025 * Math.exp(-(d * d) / 0.02);
      break;
    }
    case "dialing": {
      const d = Math.acos(clamp(z, -1, 1)) - fract(t) * Math.PI;
      k = 1 + 0.045 * Math.exp(-(d * d) / 0.08) * (1 - fract(t) * 0.5);
      break;
    }
    case "celebrate":
      k = 1 + 0.03 * Math.sin(t * 9) + 0.14 * cheerBurst(cheerPhase(st.age)) * (r - 0.2);
      break;
    case "goodbye":
      k = 1 + 0.015 * Math.sin(t * 2 + y * 3) + (x > 0 ? 0.07 * goodbyeWave(st.age) * x * Math.sin(lat * 6 - t * 12) : 0);
      break;
    case "muted":
      k = 1 + 0.01 * Math.sin(t * 1.4 + y * 2);
      break;
    default:
      break;
  }
  o[0] = x * k * sx;
  o[1] = y * k * sy;
  o[2] = z * k * sx;
}

const TMP = new Float32Array(3);

function step(B: PewBody, t: number, dt: number, st: MoodState): void {
  "worklet";
  const p = B.p;
  const v = B.v;
  const o = TMP;
  const pressed = B.press > 0.01;
  const reach = B.S * SCALE * 0.75;
  for (let i = 0; i < B.n; i++) {
    target(o, i, B, t, st);
    if (pressed) {
      // In under the finger (front dots only), out a little everywhere else:
      // the springs below carry it there and bounce it back on release.
      const sx = B.scr[i * 7]! - B.touchX;
      const sy = B.scr[i * 7 + 1]! - B.touchY;
      const d = Math.sqrt(sx * sx + sy * sy);
      const fall = d < reach && B.scr[i * 7 + 2]! > -0.2 ? 1 - d / reach : 0;
      const k = 1 - DENT * B.press * fall * fall + BULGE * B.press * (1 - fall);
      o[0] = o[0]! * k;
      o[1] = o[1]! * k;
      o[2] = o[2]! * k;
    }
    const kk = SPRING_K * (0.75 + 0.5 * B.rnd[i]!);
    for (let a = 0; a < 3; a++) {
      const j = i * 3 + a;
      v[j] = v[j]! + ((o[a]! - p[j]!) * kk - v[j]! * SPRING_C) * dt;
      p[j] = p[j]! + v[j]! * dt;
    }
  }
}

/**
 * Idle life: every so often it glances to one side, and now and then it hops.
 * Deterministic in `t` so it needs no state.
 */
function idleGlance(t: number): number {
  "worklet";
  const period = 9.7;
  const ph = fract(t / period);
  if (ph > 0.14) return 0;
  const side = hash(Math.floor(t / period)) > 0.5 ? 1 : -1;
  return side * 0.75 * Math.sin((ph / 0.14) * Math.PI);
}
function idleHop(t: number): number {
  "worklet";
  const ph = fract(t / 13.3 + 0.4);
  return ph < 0.09 ? Math.sin((ph / 0.09) * Math.PI) : 0;
}

function turn(B: PewBody, t: number, dt: number, st: MoodState): void {
  "worklet";
  let yawT = 0;
  let pitchT: number;
  let spin = 0;
  switch (st.mood) {
    case "thinking":
      yawT = Math.sin(t * 0.9) * 0.85;
      pitchT = 0.25 + Math.sin(t * 1.3) * 0.08;
      break;
    case "working":
      spin = 2.3;
      pitchT = Math.sin(t * 1.7) * 0.12;
      break;
    case "sleepy": {
      const sl = B.sleep;
      yawT = sl === 3 ? -0.3 : sl === 4 ? 0.4 : sl === 1 ? 0.04 : 0.12;
      pitchT = sl === 5 ? -0.2 - 0.45 * nodDip(sleepClock(B, t)) : sl === 6 ? -0.42 : -0.3;
      break;
    }
    case "listening":
      // Steady and looking up at the user.
      yawT = B.lookX * 0.25 + Math.sin(t * 0.5) * 0.05;
      pitchT = 0.22 + Math.sin(t * 1.1) * 0.02;
      break;
    case "typing":
      yawT = -0.32 + Math.sin(t * 0.8) * 0.04;
      pitchT = -0.22 + 0.03 * typeTap(t);
      break;
    case "reading":
      yawT = -0.2 + 0.4 * readSweep(t);
      pitchT = 0.05 - 0.12 * readLine(t);
      break;
    case "dialing":
      yawT = Math.sin(t * 0.6) * 0.08;
      pitchT = 0.06;
      break;
    case "goodbye":
      yawT = 0.15;
      pitchT = 0.05;
      break;
    case "muted":
      yawT = Math.sin(t * 0.4) * 0.08;
      pitchT = -0.06;
      break;
    default:
      yawT = B.lookX * 0.6 + Math.sin(t * 0.7) * 0.15 + (st.mood === "idle" ? idleGlance(t) : 0);
      pitchT = B.lookY * 0.38 + Math.sin(t * 0.9) * 0.05;
  }
  if (st.mood === "happy") yawT += Math.sin(t * 10) * 0.1;
  if (st.mood === "celebrate") yawT += Math.sin(t * 12) * 0.14 * cheerBurst(cheerPhase(st.age));
  if (spin) B.yaw += spin * dt;
  else B.yaw += wrapAngle(yawT - B.yaw) * (1 - Math.exp(-dt * 5));
  B.pitch += (pitchT - B.pitch) * (1 - Math.exp(-dt * 5));
  // A toy keeps spinning under the finger (a basketball does); anything else
  // follows the finger while it's down and coasts once it lifts.
  if (B.toy) {
    B.yawExtra += B.spinV * dt;
    B.spinV *= Math.exp(-dt * SPIN_DECAY);
    if (Math.abs(B.spinV) < 0.6 && !B.dragging) {
      const home = Math.round(B.yawExtra / TAU) * TAU;
      B.yawExtra += (home - B.yawExtra) * (1 - Math.exp(-dt * 3));
    }
    if (!B.dragging) {
      B.pitchV += (-B.pitchExtra * 40 - B.pitchV * 9) * dt;
      B.pitchExtra += B.pitchV * dt;
    }
  } else if (!B.dragging) {
    B.yawExtra += B.spinV * dt;
    B.spinV *= Math.exp(-dt * 1.4);
    if (Math.abs(B.spinV) < 0.6) {
      const home = Math.round(B.yawExtra / TAU) * TAU;
      B.yawExtra += (home - B.yawExtra) * (1 - Math.exp(-dt * 3));
    }
    B.pitchV += (-B.pitchExtra * 40 - B.pitchV * 9) * dt;
    B.pitchExtra += B.pitchV * dt;
  }
}

/**
 * One frame of life. `look` is where something interesting is, -1..1 on each
 * axis (a finger, the composer); without one it drifts and glances by itself.
 */
export function advancePew(B: PewBody, t: number, dt: number, mood: PewMood, lookX?: number, lookY?: number): void {
  "worklet";
  const step_ = clamp(dt, 0.001, 1 / 30);
  B.last = t;
  const st = effectiveMood(B, t, mood);
  const tx = lookX ?? Math.sin(t * 0.5) * 0.3;
  const ty = lookY ?? Math.sin(t * 0.37) * 0.2;
  const ease = 1 - Math.exp(-step_ * 5);
  B.lookX += (clamp(tx, -1, 1) - B.lookX) * ease;
  B.lookY += (clamp(ty, -1, 1) - B.lookY) * ease;
  // Pressing in is quick; letting go is quicker, so the springs overshoot.
  B.press += ((B.touching ? 1 : 0) - B.press) * (1 - Math.exp(-step_ * (B.touching ? 16 : 22)));
  if (!B.touching) B.dragVX *= Math.exp(-step_ * 9);
  B.jiggle *= Math.exp(-step_ * 4.5);
  turn(B, t, step_, st);
  step(B, t, step_, st);
}

/** Jump straight to the resting pose for `mood` (reduced motion, paused). */
export function settlePew(B: PewBody, t: number, mood: PewMood, lookX = 0, lookY = 0): void {
  "worklet";
  B.last = t;
  const st = effectiveMood(B, t, mood);
  B.lookX = lookX;
  B.lookY = lookY;
  const o = TMP;
  for (let i = 0; i < B.n; i++) {
    target(o, i, B, t, st);
    for (let a = 0; a < 3; a++) {
      B.p[i * 3 + a] = o[a]!;
      B.v[i * 3 + a] = 0;
    }
  }
  B.yaw = mood === "sleepy" ? (B.sleep === 3 ? -0.3 : B.sleep === 4 ? 0.4 : B.sleep === 1 ? 0.04 : 0.12) : lookX * 0.6;
  B.pitch = mood === "sleepy" ? (B.sleep === 5 ? -0.45 : B.sleep === 6 ? -0.42 : -0.3) : mood === "thinking" ? 0.25 : lookY * 0.38;
}

// ── touch ───────────────────────────────────────────────────

/** A tap at (x, y) in the box: a ripple out from the finger, and a happy moment. */
export function pokePew(B: PewBody, x: number, y: number): void {
  "worklet";
  const R = B.S * SCALE;
  const reach = R * 0.6;
  const s = B.scr;
  const p = B.p;
  const v = B.v;
  for (let i = 0; i < B.n; i++) {
    const d = Math.hypot(s[i * 7]! - x, s[i * 7 + 1]! - y);
    if (d > reach || s[i * 7 + 2]! < -0.3) continue;
    const fall = 1 - d / reach;
    const len = Math.hypot(p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!) || 1;
    const push = 3.4 * fall * fall;
    v[i * 3] = v[i * 3]! - (p[i * 3]! / len) * push;
    v[i * 3 + 1] = v[i * 3 + 1]! - (p[i * 3 + 1]! / len) * push;
    v[i * 3 + 2] = v[i * 3 + 2]! - (p[i * 3 + 2]! / len) * push;
  }
  B.reactUntil = B.last + 1.3;
}

/**
 * Something arriving at (x, y) in the box: a small inward ripple on that side,
 * a fraction of a poke and with no happy flash. Pew is being *fed*, not
 * played with, so it takes the hit and keeps whatever mood it was in. Mission
 * control calls this as each light packet lands in a session's Pew.
 */
export function feedPew(B: PewBody, x: number, y: number, strength = 1): void {
  "worklet";
  const R = B.S * SCALE;
  const reach = R * 0.6;
  const s = B.scr;
  const p = B.p;
  const v = B.v;
  const k = Math.max(0, Math.min(1.5, strength));
  for (let i = 0; i < B.n; i++) {
    const d = Math.hypot(s[i * 7]! - x, s[i * 7 + 1]! - y);
    if (d > reach || s[i * 7 + 2]! < -0.3) continue;
    const fall = 1 - d / reach;
    const len = Math.hypot(p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!) || 1;
    const push = 0.7 * k * fall * fall;
    v[i * 3] = v[i * 3]! - (p[i * 3]! / len) * push;
    v[i * 3 + 1] = v[i * 3 + 1]! - (p[i * 3 + 1]! / len) * push;
    v[i * 3 + 2] = v[i * 3 + 2]! - (p[i * 3 + 2]! / len) * push;
  }
}

/**
 * A flick on a toy spin, as a hand on a basketball: moving with the spin and
 * at least a third of its speed adds to it (a longer, faster flick adds
 * more); moving with it but slower is a hand resting on the ball, which
 * brakes it; against it slows it and can turn it round.
 */
function spinFlick(B: PewBody, angle: number, dt: number): void {
  "worklet";
  const hand = angle / dt;
  const v = B.spinV;
  const along = Math.abs(v) < 1 || Math.sign(angle) === Math.sign(v);
  if (along && Math.abs(hand) >= Math.abs(v) * 0.34) B.spinV = clamp(v + angle * SPIN_PUMP, -SPIN_MAX, SPIN_MAX);
  else if (along) B.spinV = v * Math.exp(-dt * 3);
  else B.spinV = clamp(v + angle * SPIN_PUMP * 1.4, -SPIN_MAX, SPIN_MAX);
}

/**
 * A finger landing on it (`down`), moving across it, or lifting, at (x, y) in
 * box points. Pressing dents it under the finger; lifting wobbles it back,
 * harder the faster it was being dragged.
 */
export function touchPew(B: PewBody, x: number, y: number, down: boolean): void {
  "worklet";
  if (down) {
    // A finger just off him (the touch area reaches past his edge) presses
    // the nearest part of him, never the air beside him.
    const R = B.S * SCALE;
    const cx = B.S / 2;
    const cy = B.S * 0.47;
    const dx = x - cx;
    const dy = y - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    const k = d > R * 0.92 ? (R * 0.92) / d : 1;
    B.touching = true;
    B.touchX = cx + dx * k;
    B.touchY = cy + dy * k;
    return;
  }
  if (!B.touching) return;
  B.touching = false;
  B.jiggle = clamp(0.35 + Math.abs(B.dragVX) / (B.S * 7), 0, 1);
  B.jiggleAt = B.last;
}

/** A drag of (dx, dy) points taking `dt` seconds: spins it, with momentum. */
export function dragPew(B: PewBody, dx: number, dy: number, dt: number): void {
  "worklet";
  B.dragging = true;
  B.dragVX = lerp(B.dragVX, dx / Math.max(0.008, dt), 0.3);
  if (B.toy) {
    spinFlick(B, dx * 0.013, Math.max(0.008, dt));
    B.pitchExtra = clamp(B.pitchExtra + dy * 0.009, -0.9, 0.9);
    return;
  }
  B.yawExtra += dx * 0.013;
  B.pitchExtra = clamp(B.pitchExtra + dy * 0.009, -0.9, 0.9);
  B.spinV = lerp(B.spinV, (dx * 0.013) / Math.max(0.008, dt), 0.5);
}

/** The finger lifted: it keeps spinning and springs back upright. */
export function releasePew(B: PewBody): void {
  "worklet";
  B.dragging = false;
}

// ── motion, light and projection ────────────────────────────

export interface Motion {
  hop: number;
  sx: number;
  sy: number;
  rot: number;
  dx: number;
}

export function motion(mood: PewMood, t: number, age: number, S: number, B: PewBody): Motion {
  "worklet";
  let hop = 0;
  let sx = 1;
  let sy = 1;
  let rot = 0;
  let dx = 0;
  switch (mood) {
    case "idle": {
      const b = Math.sin(t * 2.1) * 0.02;
      sy = 1 + b;
      sx = 1 - b * 0.6;
      rot = Math.sin(t * 1.1) * 0.025;
      const h = idleHop(t);
      hop = h * S * 0.045;
      if (h > 0) {
        const squash = Math.pow(1 - h, 4) * 0.08;
        sy -= squash;
        sx += squash * 0.8;
      }
      break;
    }
    case "talking": {
      const b = Math.sin(t * 2.1) * 0.015 + talkOpen(t) * 0.012;
      sy = 1 + b;
      sx = 1 - b * 0.6;
      rot = Math.sin(t * 1.4) * 0.03;
      break;
    }
    case "thinking": {
      rot = -0.08 + Math.sin(t * 1.4) * 0.035;
      const b = Math.sin(t * 1.6) * 0.018;
      sy = 1 + b;
      sx = 1 - b * 0.6;
      break;
    }
    case "working": {
      const h = Math.abs(Math.sin(t * 6.4));
      hop = h * S * 0.05;
      const k = Math.pow(1 - h, 6) * 0.13;
      sy = 1 - k + 0.03 * h;
      sx = 1 + k * 0.8 - 0.015 * h;
      rot = Math.sin(t * 3.2) * 0.03;
      break;
    }
    case "happy": {
      const h = Math.abs(Math.sin(t * 5));
      hop = h * S * 0.05;
      const k = Math.pow(1 - h, 6) * 0.12;
      sy = 1 - k;
      sx = 1 + k * 0.8;
      rot = Math.sin(t * 10) * 0.06;
      break;
    }
    case "sleepy": {
      const T = sleepClock(B, t);
      const sl = B.sleep;
      const b = Math.sin(T * (sl === 6 ? 0.6 : sl === 2 ? 0.9 : 1.1)) * (sl === 2 ? 0.04 : 0.03);
      sy = 1 + b;
      sx = 1 - b * 0.5;
      switch (sl) {
        case 1:
          rot = 0.04;
          break;
        case 3:
          rot = -0.24 + Math.sin(T * 0.5) * 0.015;
          dx = -S * 0.025;
          break;
        case 4:
          rot = 0.24 + Math.sin(T * 0.5) * 0.015;
          dx = S * 0.025;
          break;
        case 5: {
          const d = nodDip(T);
          hop = -d * S * 0.04;
          rot = 0.05 + d * 0.05;
          break;
        }
        case 6:
          sy = 0.9 + b * 0.6;
          sx = 1.08 - b * 0.3;
          rot = 0;
          break;
        case 7:
          rot = 0.05 + Math.sin(T * 0.5) * 0.03;
          break;
        case 9:
          hop = Math.abs(Math.sin(T * 1.6)) * S * 0.015;
          dx = Math.sin(T * 0.8) * S * 0.03;
          rot = Math.sin(T * 0.8) * 0.07;
          break;
        default:
          rot = 0.08;
      }
      break;
    }
    case "oops": {
      const s = age < 0.7 ? 1 - age / 0.7 : 0;
      dx = Math.sin(t * 45) * S * 0.02 * s;
      rot = Math.sin(t * 45) * 0.04 * s;
      break;
    }
    case "listening": {
      const b = Math.sin(t * 1.8) * 0.012;
      sy = 1 + b;
      sx = 1 - b * 0.6;
      rot = Math.sin(t * 0.9) * 0.02;
      break;
    }
    case "typing": {
      const k = typeTap(t);
      sy = 1 - 0.025 * k;
      sx = 1 + 0.015 * k;
      rot = -0.05 + Math.sin(t * 1.3) * 0.01;
      break;
    }
    case "reading": {
      const b = Math.sin(t * 1.6) * 0.012;
      sy = 1 + b;
      sx = 1 - b * 0.6;
      rot = -0.03 + 0.05 * readSweep(t);
      break;
    }
    case "dialing": {
      // A swell on every ring.
      const b = Math.exp(-fract(t) * 7) * 0.045;
      sy = 1 + b;
      sx = 1 + b;
      rot = Math.sin(t * 0.8) * 0.02;
      break;
    }
    case "celebrate": {
      const p = cheerPhase(age);
      const h = cheerHop(p);
      const land = p > 0.3 && p < 0.48 ? Math.sin(((p - 0.3) / 0.18) * Math.PI) : 0;
      const crouch = p > 0.9 ? Math.sin(((p - 0.9) / 0.1) * Math.PI) : 0;
      hop = h * S * 0.13;
      const k = 0.17 * land + 0.08 * crouch;
      sy = 1 - k + 0.07 * h;
      sx = 1 + k * 0.85 - 0.04 * h;
      rot = Math.sin(t * 12) * 0.06 * cheerBurst(p);
      break;
    }
    case "goodbye": {
      const b = Math.sin(t * 1.6) * 0.012;
      sy = 1 + b;
      sx = 1 - b * 0.6;
      rot = 0.04 + 0.07 * goodbyeWave(age) * Math.sin(age * 9);
      break;
    }
    case "muted": {
      const b = Math.sin(t * 1.4) * 0.012;
      sy = 1 + b;
      sx = 1 - b * 0.5;
      rot = 0.02;
      break;
    }
  }
  // A toy spin shows its speed in the body, the way a spun ball does: it
  // flattens at the middle, wobbles on its axis, lifts a little, and near the
  // burst it trembles.
  const f = spinFeel(B);
  if (f > 0.02) {
    const flat = 0.13 * f * f;
    sx *= 1 + flat;
    sy *= 1 - flat * 0.8;
    rot += Math.sin(t * (5 + 13 * f)) * 0.06 * f;
    hop += S * 0.035 * f;
    const shake = Math.max(0, (f - 0.7) / 0.3);
    dx += Math.sin(t * 61) * S * 0.012 * shake * shake;
    hop += Math.sin(t * 53) * S * 0.008 * shake * shake;
  }
  // Pressed: a little squashed down, and leaning into a drag, stretched along
  // it. Let go: a wobble that rings out (`touchPew`).
  if (B.press > 0.01) {
    sy *= 1 - 0.05 * B.press;
    sx *= 1 + 0.04 * B.press;
  }
  const lean = clamp(B.dragVX / (S * 9), -1, 1);
  if (Math.abs(lean) > 0.01) {
    rot += lean * 0.14;
    sx *= 1 + 0.06 * Math.abs(lean);
    sy *= 1 - 0.035 * Math.abs(lean);
    dx += lean * S * 0.02;
  }
  if (B.jiggle > 0.01) {
    const w = Math.sin((t - B.jiggleAt) * 24) * 0.06 * B.jiggle;
    sx *= 1 + w;
    sy *= 1 - w;
  }
  return { hop, sx, sy, rot, dx };
}

/** Eye openness 0..1: a blink every few seconds, sometimes a double. */
export function blink(t: number, seedIn?: number): number {
  "worklet";
  // Not a default parameter: the worklet compiler does not capture module
  // constants that appear only in a parameter default.
  const seed = seedIn ?? SEED;
  const period = 3.4 + seed * 1.7;
  const p = (t + seed * 7.3) % period;
  if (p < 0.15) return 1 - Math.sin((p / 0.15) * Math.PI);
  const q = (t + seed * 7.3 + 0.32) % (period * 3);
  if (q < 0.15) return 1 - Math.sin((q / 0.15) * Math.PI);
  return 1;
}
