/**
 * When Pew may ring: the switch with its duration, quiet hours, and which
 * sessions are armed. Pure (no Expo), so `bun test` runs it.
 *
 * Every ring has to pass four gates, all decided on the computer: ringing is
 * on (and its time hasn't run out), the session is armed, the agent is
 * actually stopped on the user, and pacing/quiet hours allow it. The phone
 * only sets them; it never decides not to ring, because iOS requires every
 * call push to show a ringing call.
 */
import type { wire } from "@pew2/protocol";

type Prefs = wire.VoicePrefsValues;
type Status = wire.VoiceStatus;

const HOUR = 60 * 60_000;

export type RingChoice = "off" | "1h" | "3h" | "always";

export const RING_CHOICES: readonly { choice: RingChoice; label: string }[] = [
  { choice: "off", label: "Off" },
  { choice: "1h", label: "1 hour" },
  { choice: "3h", label: "3 hours" },
  { choice: "always", label: "Until I stop" },
];

/** The prefs patch for a choice. Off is `notify`: banners with a Talk action, as before. */
export function ringPatch(choice: RingChoice, now: number): Partial<Prefs> {
  switch (choice) {
    case "off":
      return { mode: "notify", ringUntil: 0 };
    case "1h":
      return { mode: "onthego", ringUntil: now + HOUR };
    case "3h":
      return { mode: "onthego", ringUntil: now + 3 * HOUR };
    case "always":
      return { mode: "onthego", ringUntil: 0 };
  }
}

/** Ringing is on right now (an expired `ringUntil` counts as off, before the daemon says so). */
export function ringing(prefs: Prefs | undefined, now: number): boolean {
  if (prefs?.mode !== "onthego") return false;
  return !prefs.ringUntil || now < prefs.ringUntil;
}

/**
 * Which choice to show as selected. A timed ring shows as the duration it was
 * set with; it can't be told apart once time has passed, so it shows as the
 * nearest that still covers what's left.
 */
export function selectedRing(prefs: Prefs | undefined, now: number): RingChoice {
  if (!ringing(prefs, now)) return "off";
  if (!prefs?.ringUntil) return "always";
  return prefs.ringUntil - now > HOUR ? "3h" : "1h";
}

/** "2h 14m left", "40m left", "<1m left"; undefined when not timed. */
export function ringTimeLeft(prefs: Prefs | undefined, now: number): string | undefined {
  if (!ringing(prefs, now) || !prefs?.ringUntil) return undefined;
  const minutes = Math.ceil((prefs.ringUntil - now) / 60_000);
  if (minutes <= 1) return "<1m left";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}

/** This daemon knows about arming (an older one sends no `armed`). */
export function armingSupported(status: Status | undefined): boolean {
  return Array.isArray(status?.armed);
}

/**
 * This conversation may ring. Without `now`, the daemon's list is trusted as
 * is: it drops an expired arming and broadcasts the change itself.
 */
export function isArmed(status: Status | undefined, sessionId: string | undefined, now?: number): boolean {
  if (!sessionId) return false;
  return status?.armed?.some((entry) => entry.sessionId === sessionId && (now === undefined || now < entry.until)) === true;
}

/** Armed sessions still running, for the sheet's list. */
export function armedCount(status: Status | undefined, now: number): number {
  return status?.armed?.filter((entry) => now < entry.until).length ?? 0;
}

/**
 * Which chats ring. An older daemon (no `ringScope`) only knows armed chats,
 * so it reads as "chosen".
 */
export type RingScope = NonNullable<Prefs["ringScope"]>;
export function ringScope(prefs: Prefs | undefined): RingScope {
  return prefs?.ringScope ?? "chosen";
}
/** This daemon can ring for every chat (an older one sends no `ringScope`). */
export function scopeSupported(prefs: Prefs | undefined): boolean {
  return prefs?.ringScope !== undefined;
}

export const RING_SCOPES: readonly { scope: RingScope; label: string }[] = [
  { scope: "all", label: "Any chat" },
  { scope: "chosen", label: "Chosen chats" },
];

/** The Settings row on the connection sheet: what calls will do, in a few words. */
export function callsLine(status: Status | undefined, now: number): string {
  if (!status?.available) return status?.login ? "Waiting for sign-in" : status?.canLogin ? "Sign in to OpenAI" : "Not available";
  const prefs = status.prefs;
  if (!ringing(prefs, now)) return "Ring me off";
  const left = ringTimeLeft(prefs, now);
  return left ? `Ring me on · ${left}` : "Ring me on";
}

/** Said once, above the first call's button (App Review 5.1.2(i), EU AI Act Art. 50). */
export const VOICE_CONSENT_LINE = "Pew is an AI. Your voice goes to OpenAI.";
