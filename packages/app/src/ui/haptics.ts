/**
 * Touch feedback, named by meaning rather than by waveform.
 *
 * Call sites say what happened — `sent()`, `failed()`, `finished()` — so the
 * physical vocabulary stays consistent across the app instead of every screen
 * picking its own impact style. Changing how "something failed" feels is then
 * one edit here, not twenty.
 *
 * This matters more than usual for pew2: the agent runs for minutes on another
 * machine while the phone is in a pocket. A pulse when a turn lands, an approval
 * is needed, or something breaks is the difference between a remote control and
 * a screen you have to keep watching.
 *
 * No platform check: expo-haptics maps to `navigator.vibrate` on web and checks
 * availability itself, so a desktop browser silently does nothing.
 */
import * as Haptics from "expo-haptics";
import { shouldFire } from "../hapticsPolicy";
import { hapticSound, type HapticKind, type SoundName } from "../soundsPolicy";
import { sounds } from "./sounds";

let lastFiredAt: number | undefined;
let pokes = 0;

/**
 * Which sound goes with a pulse: the kind's own, another named by the call
 * site, or `null` for silence (the thinking dial and the goal launch play
 * their own). Anything else is ignored, so a handler passed by reference
 * (`onPress={haptics.tap}` hands it an event) still plays the default.
 */
type Cue = SoundName | null | undefined;
const cueOf = (cue: unknown): Cue => (typeof cue === "string" || cue === null ? (cue as Cue) : undefined);

/**
 * Play one pulse and its sound, unless it would arrive on top of the previous
 * one. Felt and heard in the same call, so they never drift apart, and a pulse
 * that's dropped as too close drops its sound with it.
 *
 * Deliberately not awaited, and failures are swallowed: haptics are decoration.
 * A device with the motor disabled, a denied permission, or a simulator without
 * hardware must never delay or break the action that triggered the feedback.
 */
function fire(kind: HapticKind, play: () => Promise<void>, cue: unknown, detentAt?: number): void {
  const now = Date.now();
  if (!shouldFire(now, lastFiredAt)) return;
  lastFiredAt = now;
  void play().catch(() => {});
  const chosen = cueOf(cue);
  if (chosen === null) return;
  sounds.play(chosen ?? hapticSound(kind, kind === "poke" ? pokes++ : 0, detentAt));
}

export const haptics = {
  /** Any ordinary button press. The default. A dot clicking, barely heard. */
  tap: (cue?: Cue) => fire("tap", () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light), cue),

  /** Moving between options in a picker. */
  select: (cue?: Cue) => fire("select", () => Haptics.selectionAsync(), cue),

  /** A switch turned on / off: two blips, up or down. */
  toggleOn: (cue?: Cue) => fire("toggleOn", () => Haptics.selectionAsync(), cue),
  toggleOff: (cue?: Cue) => fire("toggleOff", () => Haptics.selectionAsync(), cue),

  /** Committing something: sending a prompt, approving, submitting a pairing link. A soft "pew". */
  sent: (cue?: Cue) => fire("sent", () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium), cue),

  /** Choosing who you talk to: an agent picked. A firm tap; pass the agent's own sound (`agentSound`) where it isn't already playing. */
  chosen: (cue?: Cue) => fire("chosen", () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium), cue),

  /** A code scanned, a device paired, something copied. (A turn landing plays `done`.) */
  finished: (cue?: Cue) => fire("finished", () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success), cue),

  /** The agent is blocked and needs an answer. Distinct on purpose: this one
   *  is a request for the user, not a report about something already done. */
  attention: (cue?: Cue) => fire("attention", () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy), cue),

  /** Something destructive or refused: unpairing, rejecting a permission. */
  warned: (cue?: Cue) => fire("warned", () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning), cue),

  /** Pew was poked, or something small and alive answered a touch. Softer
   *  than a tap, so touching a mascot never feels like pressing a button.
   *  Pew answers in one of four little voices. */
  poke: (cue?: Cue) => fire("poke", () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft), cue),

  /** A dial or carousel clicked onto its next detent. */
  detent: (cue?: Cue) => fire("detent", () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid), cue),

  /** A detent at a position (a page): the click climbs in pitch with it. */
  detentAt: (at: number) => fire("detent", () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid), undefined, at),

  /** Something went wrong. A low, soft "bonk", never a buzzer. */
  failed: (cue?: Cue) => fire("failed", () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error), cue),
};

/** The haptics a press can name as its `feel` (they take no argument). */
export type Feel = Exclude<keyof typeof haptics, "detentAt">;
