/**
 * Home Pew's life: how big it is, which mood it shows while nothing is
 * happening, and the rhythm of a press-and-hold. Pure and Expo-free (tested
 * under bun); the timers live in `ui/HomeDashboard.tsx` and `pew/Pew.tsx`.
 */
import type { PewMood } from "./engine";

export const HOME_PEW_MAX = 220;
export const HOME_PEW_MIN = 140;

export interface HomePewSpace {
  /** Window height. */
  height: number;
  /** Content inset above (safe area + top bar). */
  top: number;
  /** Content inset below (safe area). */
  bottom: number;
  /** Cards on home (0 = the centred message). */
  cards: number;
  cardHeight: number;
  /** Gap between card rows. */
  rowGap: number;
  /** Label plus its gap to the grid. */
  label: number;
  /** Everything else stacked vertically: section gap and paddings. */
  chrome: number;
}

/** Pew as large as fits above the cards, between min and max. */
export function homePewSize(s: HomePewSpace): number {
  if (s.cards <= 0) return HOME_PEW_MAX;
  const rows = Math.ceil(s.cards / 2);
  const grid = rows * s.cardHeight + (rows - 1) * s.rowGap;
  const room = s.height - s.top - s.bottom - s.label - grid - s.chrome;
  return Math.round(Math.max(HOME_PEW_MIN, Math.min(HOME_PEW_MAX, room)));
}

/** Short excursions from idle, and how long each lasts (ms). */
export const LIFE_MOODS: readonly { mood: PewMood; ms: number }[] = [
  { mood: "happy", ms: 2600 },
  { mood: "thinking", ms: 3200 },
  { mood: "reading", ms: 3600 },
  { mood: "listening", ms: 2600 },
  { mood: "celebrate", ms: 2200 },
];

export const LIFE_IDLE_MIN_MS = 6000;
export const LIFE_IDLE_MAX_MS = 10000;

export interface LifeBeat {
  mood: PewMood;
  /** How long to hold it before the next beat. */
  ms: number;
}

/**
 * The next beat after `current`: idle goes on an excursion, an excursion
 * comes back to idle for 6–10 s. `r` is a random number in [0, 1); the
 * previous excursion is never repeated straight away.
 */
export function nextLifeBeat(current: PewMood, last: PewMood | undefined, r: number): LifeBeat {
  const u = Math.min(Math.max(r, 0), 0.999999);
  if (current !== "idle") {
    return { mood: "idle", ms: Math.round(LIFE_IDLE_MIN_MS + u * (LIFE_IDLE_MAX_MS - LIFE_IDLE_MIN_MS)) };
  }
  const pool = LIFE_MOODS.filter((m) => m.mood !== last);
  const pick = pool[Math.floor(u * pool.length)] ?? LIFE_MOODS[0];
  return pick ? { mood: pick.mood, ms: pick.ms } : { mood: "idle", ms: LIFE_IDLE_MIN_MS };
}

/** The real state comes first; idle life and a hold only show over idle. */
export function homePewMood(real: PewMood, life: PewMood, holding: boolean): PewMood {
  if (real !== "idle") return real;
  if (holding) return "listening";
  return life;
}

/** A hold charges this long; past it the pulses stay at the fastest rate. */
export const HOLD_CHARGE_MS = 1600;

/** Kind of pulse at a moment of the hold: soft pokes, then firmer detents. */
export function holdPulseKind(elapsedMs: number): "poke" | "detent" {
  return elapsedMs >= HOLD_CHARGE_MS * 0.6 ? "detent" : "poke";
}

/** Gap before the next pulse: 260 ms at the start, closing to 90 ms at full charge. */
export function holdPulseGap(elapsedMs: number): number {
  const t = Math.min(1, Math.max(0, elapsedMs / HOLD_CHARGE_MS));
  return Math.round(260 - 170 * t);
}

/**
 * The first screen a new user ever sees: Pew putting on a little show, not
 * idling. A loop of short, lively moods with no long idle in between (home's
 * life is calmer: 6-10 s of idle between trips).
 */
export const WELCOME_SHOW: readonly LifeBeat[] = [
  { mood: "celebrate", ms: 1800 },
  { mood: "happy", ms: 2000 },
  { mood: "talking", ms: 2200 },
  { mood: "listening", ms: 1800 },
  { mood: "happy", ms: 1400 },
  { mood: "thinking", ms: 2000 },
  { mood: "celebrate", ms: 1600 },
  { mood: "idle", ms: 1500 },
];

/** The beat at position `i` of the welcome show (wraps). */
export function welcomeBeat(i: number): LifeBeat {
  const n = WELCOME_SHOW.length;
  return WELCOME_SHOW[((i % n) + n) % n]!;
}

// ── The spin toy ───────────────────────────────────────────────────────────

/**
 * Home Pew is a toy: spun hard enough, he bursts. Each stage is a spin speed
 * (radians a second, the engine's `spinV`), what the line under him says and
 * how he looks. Up a stage the line changes and a detent clicks, pitched
 * with it.
 */
export interface SpinStage {
  /** Reached at this speed (rad/s). */
  at: number;
  /** The line under Pew. */
  line: string;
  /** His face, over the idle life (the real state still comes first). */
  mood: PewMood | undefined;
}

export const SPIN_STAGES: readonly SpinStage[] = [
  { at: 0, line: "Spin me. Try it now", mood: undefined },
  { at: 4, line: "Yes, keep going!", mood: "happy" },
  { at: 13, line: "Faster!", mood: "working" },
  { at: 21, line: "Nearly there!", mood: "celebrate" },
];

/**
 * After the burst: delighted, cheering, then back to the invitation. Not
 * sleepy: a sleepy Pew on home reads as "not connected".
 */
export const SPIN_AFTER = { line: "Phew. Again?", mood: "celebrate" as PewMood, ms: 3200 };

/**
 * The line holds each stage at least this long before it may change again,
 * so a quick spin through two stages still reads as two lines, not a flicker.
 */
export const SPIN_LINE_MIN_MS = 900;

/** The stages' speeds alone, for the UI thread. */
const SPIN_AT: readonly number[] = SPIN_STAGES.map((stage) => stage.at);

/** The stage a spin speed is in. A dip below a stage's speed drops it only past a small margin, so the line never flickers. */
export function spinStage(speed: number, current = 0): number {
  "worklet";
  // The thresholds inline: a worklet can't read the stage table (it would
  // capture a frozen copy, and the table's objects aren't shareable).
  const at = SPIN_AT;
  const v = Math.abs(speed);
  let stage = 0;
  for (let i = at.length - 1; i > 0; i--) {
    if (v >= at[i]!) {
      stage = i;
      break;
    }
  }
  // Hysteresis: staying in a higher stage until 15% under where it starts.
  if (current > stage && current < at.length && v >= at[current]! * 0.85) return current;
  return stage;
}

