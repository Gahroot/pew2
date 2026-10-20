/**
 * Timing for the onboarding scenes: what each step's little show is doing at
 * a moment in its loop. Pure (no Expo), so `bun test` runs it; the scenes in
 * `ui/OnboardingScenes.tsx` only draw it.
 */
import { noticeBody, noticeTitle, type NoticeKind, type NoticeOrigin } from "@pew2/protocol";
import type { PewMood } from "./pew/engine";
import type { Step } from "./onboarding";

/** Pew sits dead centre of the stage on every step; each scene fits around him. */
export const PEW_SHIFT: Record<Step, number> = {
  welcome: 0,
  alerts: 0,
  install: 0,
  pair: 0,
  voice: 0,
  done: 0,
};

// ── Notifications: real banners arrive, like on the lock screen ─────────

/**
 * The banners the onboarding plays, worded exactly as the real ones are
 * (`noticeTitle` / `noticeBody`, the copy pushes use), so what it promises is
 * what arrives.
 */
export interface SampleAlert {
  title: string;
  body: string;
}

const SAMPLES: readonly { origin: NoticeOrigin; kind: NoticeKind; text: string }[] = [
  { origin: { folder: "storefront", agentName: "Claude Code" }, kind: "finished", text: "Added the cart tests. All 42 pass." },
  { origin: { folder: "billing-api", agentName: "Codex" }, kind: "approval", text: "npm run migrate" },
  { origin: { folder: "docs", agentName: "GG Coder" }, kind: "finished", text: "The README now covers Windows setup." },
  { origin: { folder: "ios-app", agentName: "Gemini CLI" }, kind: "question", text: "Keep the old onboarding or replace it?" },
];

export const SAMPLE_ALERTS: readonly SampleAlert[] = SAMPLES.map((sample) => ({
  title: noticeTitle(sample.origin),
  body: noticeBody(sample.text, sample.kind),
}));

/** A new banner every this long: time to read it. */
export const ALERT_EVERY_MS = 2600;

/**
 * The banners at `ms`, newest first: the one in front, the one stacked behind
 * it, and the one leaving the stack (drawn fading out).
 */
export function alertsAt(ms: number): { index: number; alert: SampleAlert }[] {
  const n = Math.floor(Math.max(0, ms) / ALERT_EVERY_MS);
  const out: { index: number; alert: SampleAlert }[] = [];
  for (let i = n; i >= 0 && out.length < 3; i--) out.push({ index: i, alert: SAMPLE_ALERTS[i % SAMPLE_ALERTS.length]! });
  return out;
}

/** Pew's mood while banners arrive: a beat of talk as each one lands. */
export function alertsMood(ms: number): PewMood {
  return Math.max(0, ms) % ALERT_EVERY_MS < 600 ? "talking" : "happy";
}

// ── Install: setup finds the agents, then pair shows the code ───────────

/** The terminal's script: `pew2 setup` and its answer, then `pew2 pair` and the code. */
export const INSTALL_TYPE = "pew2 setup";
export const PAIR_TYPE = "pew2 pair";
export const SETUP_REPLY = "✓ 2 agents ready";
const TYPE_START_MS = 500;
const TYPE_CPS = 10;
const LOOP_MS = 7600;

export interface InstallFrame {
  /** How much of `pew2 setup` is typed. */
  typed: number;
  /** Setup has answered. */
  setupDone: boolean;
  /** How much of `pew2 pair` is typed. */
  pairTyped: number;
  /** The pairing code is showing. */
  qr: boolean;
  /** A packet runs down the wire to Pew (the phone reads the code). */
  linking: boolean;
  mood: PewMood;
}

export function installAt(ms: number): InstallFrame {
  const t = Math.max(0, ms) % LOOP_MS;
  const typeFor = (start: number, text: string) => Math.max(0, Math.min(text.length, Math.floor(((t - start) * TYPE_CPS) / 1000)));
  const typed = typeFor(TYPE_START_MS, INSTALL_TYPE);
  const setupTypedAt = TYPE_START_MS + (INSTALL_TYPE.length * 1000) / TYPE_CPS;
  const setupDone = t >= setupTypedAt + 700;
  const pairStart = setupTypedAt + 1300;
  const pairTyped = t >= pairStart ? typeFor(pairStart, PAIR_TYPE) : 0;
  const pairTypedAt = pairStart + (PAIR_TYPE.length * 1000) / TYPE_CPS;
  const qr = t >= pairTypedAt + 400;
  const linking = t >= pairTypedAt + 1000;
  return { typed, setupDone, pairTyped, qr, linking, mood: linking ? "reading" : qr ? "happy" : "typing" };
}

// ── Voice: Pew talks, then listens ──────────────────────────────────────

export const VOICE_TURN_MS = 2000;

/** Whose turn it is at `ms`: Pew talking, then the user (the wave lights up). */
export function voiceAt(ms: number): { userSpeaking: boolean; mood: PewMood } {
  const userSpeaking = Math.floor(Math.max(0, ms) / VOICE_TURN_MS) % 2 === 1;
  return { userSpeaking, mood: userSpeaking ? "listening" : "talking" };
}

/** A 7x7 dot code with three finder corners, drawn on the computer's screen. */
export const DOT_CODE: readonly (readonly number[])[] = [
  [1, 1, 1, 0, 1, 1, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 1, 1, 0, 1, 1, 1],
  [0, 1, 0, 1, 0, 1, 0],
  [1, 1, 1, 0, 1, 0, 1],
  [1, 0, 1, 1, 0, 1, 1],
  [1, 1, 1, 0, 1, 1, 0],
];
