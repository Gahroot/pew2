/**
 * What to do when the phone loses, then regains, its link to the computer
 * during a voice conversation. Pure; `ui/voiceController.ts` runs the timers.
 *
 * Offline is not a failure to retry into: burning the machine's reconnect
 * budget while there is no network just ends the conversation in seconds.
 * So: hold while offline (up to a grace), say so once if audio is live, and
 * on return reconnect with a fresh budget and catch up from the cursor.
 */
import type { Phase } from "./voiceMachine";

/** How long a conversation waits for the network before giving up. */
export const OFFLINE_GRACE_MS = 45_000;
/** A drop shorter than this on return is resumed in place, longer starts afresh via the machine. */
export const SPEAK_LOST_MIN_MS = 1_500;

const AUDIO_LIVE: readonly Phase[] = ["listening", "speaking"];

export type OfflineDecision =
  | { kind: "ignore" }
  | { kind: "hold"; graceMs: number; announce: boolean };

/** `announce`: say "I lost connection" - only when audio is live so there is someone listening. */
export function onNetworkLost(phase: Phase, alreadyHolding: boolean): OfflineDecision {
  if (alreadyHolding) return { kind: "ignore" };
  const active = AUDIO_LIVE.includes(phase) || phase === "connecting" || phase === "opening";
  if (!active) return { kind: "ignore" };
  return { kind: "hold", graceMs: OFFLINE_GRACE_MS, announce: AUDIO_LIVE.includes(phase) };
}

export type OnlineDecision = { kind: "ignore" } | { kind: "resume"; sync: true };

/** Back online: resume only a conversation we were holding; always catch up. */
export function onNetworkRestored(holding: boolean, phase: Phase): OnlineDecision {
  if (!holding) return { kind: "ignore" };
  return phase === "idle" || phase === "closed" || phase === "error" || phase === "closing"
    ? { kind: "ignore" }
    : { kind: "resume", sync: true };
}

/** Exponential backoff with a ceiling and optional jitter (0..1) so retries do not synchronise. */
export function backoffMs(attempt: number, baseMs = 1_000, maxMs = 30_000, jitter = 0): number {
  const raw = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(raw * (1 - 0.25 * Math.min(1, Math.max(0, jitter))));
}

export const LOST_CONNECTION_LINE = "Say briefly: I lost connection, I'll pick up again when it's back.";
