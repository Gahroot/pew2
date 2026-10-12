/**
 * What the audio session should be, and what to do when iOS changes it.
 *
 * Expo-free decisions; `ui/audioSession.ts` binds them to the native module
 * (`modules/pew2-voice`), which is the only code that touches AVAudioSession.
 *
 * Goals, in order:
 *  1. Voice interrupts other audio while it talks (music ducks, podcasts pause).
 *  2. A headset (AirPods, any Bluetooth HFP route, wired) is preferred for both
 *     mic and speaker; the loudspeaker is the fallback, never the first choice
 *     over a connected headset.
 *  3. When the conversation ends the session is released with
 *     `notifyOthersOnDeactivation`, which is what makes Music/Podcasts resume.
 */

export type RouteKind = "builtin_speaker" | "builtin_receiver" | "bluetooth" | "wired" | "other";

export interface AudioRoute {
  output: RouteKind;
  input: RouteKind | "builtin_mic";
}

/** The category options the native layer maps onto AVAudioSession. Names, not bit flags. */
export interface AudioSessionConfig {
  category: "playAndRecord";
  /** `voiceChat` enables the system echo canceller, which a hands-free loop needs. */
  mode: "voiceChat";
  options: AudioOption[];
}

export type AudioOption =
  | "allowBluetooth" // HFP: lets AirPods supply the microphone
  | "allowBluetoothA2DP"
  | "defaultToSpeaker" // only applies when no headset is connected
  | "duckOthers" // lowers music while we talk (restored by notifyOthersOnDeactivation)
  | "interruptSpokenAudioAndMixWithOthers"; // pauses podcasts/audiobooks

export function voiceSessionConfig(): AudioSessionConfig {
  return {
    category: "playAndRecord",
    mode: "voiceChat",
    // `defaultToSpeaker` is safe to always request: iOS applies it only when
    // there is no headset, so AirPods still win over the loudspeaker.
    options: [
      "allowBluetooth",
      "allowBluetoothA2DP",
      "defaultToSpeaker",
      "duckOthers",
      "interruptSpokenAudioAndMixWithOthers",
    ],
  };
}

/** What deactivating must do so other apps resume. */
export interface DeactivateOptions {
  notifyOthersOnDeactivation: true;
}
export const DEACTIVATE: DeactivateOptions = { notifyOthersOnDeactivation: true };

export type RouteChangeReason =
  | "newDeviceAvailable"
  | "oldDeviceUnavailable"
  | "categoryChange"
  | "override"
  | "wakeFromSleep"
  | "noSuitableRouteForCategory"
  | "routeConfigurationChange"
  | "unknown";

export type RouteAction =
  /** Nothing to do. */
  | "ignore"
  /** Re-assert our category/options so a headset is picked up. */
  | "reconfigure"
  /** The headset the user was talking into went away: stop rather than shout from the speaker. */
  | "end";

/**
 * iOS convention: when the output device the user was listening on disappears
 * (AirPods out of the ear, cable pulled), playback stops instead of moving to
 * the speaker. A voice assistant should respect that.
 */
export function routeChangeAction(
  reason: RouteChangeReason,
  previous: AudioRoute | undefined,
  current: AudioRoute,
): RouteAction {
  switch (reason) {
    case "oldDeviceUnavailable": {
      const hadHeadset = previous?.output === "bluetooth" || previous?.output === "wired";
      const hasHeadset = current.output === "bluetooth" || current.output === "wired";
      return hadHeadset && !hasHeadset ? "end" : "ignore";
    }
    case "newDeviceAvailable":
    case "noSuitableRouteForCategory":
    case "routeConfigurationChange":
    case "wakeFromSleep":
      return "reconfigure";
    case "categoryChange":
    case "override":
    case "unknown":
      return "ignore";
  }
}

export type InterruptionAction =
  /** Stop talking and listening; hand the session to the call/alarm/Siri. */
  | { kind: "suspend" }
  /** Interruption over. `resume` is whether iOS says it is appropriate to carry on. */
  | { kind: "resume"; resume: boolean };

export function interruptionAction(
  phase: "began" | "ended",
  shouldResume: boolean,
): InterruptionAction {
  return phase === "began" ? { kind: "suspend" } : { kind: "resume", resume: shouldResume };
}

/** Plain label for the route, shown in the voice sheet. */
export function routeLabel(route: AudioRoute | undefined): string {
  switch (route?.output) {
    case "bluetooth":
      return "Headset";
    case "wired":
      return "Wired headset";
    case "builtin_receiver":
      return "Phone earpiece";
    case "builtin_speaker":
      return "Speaker";
    default:
      return "";
  }
}

/**
 * How to announce an event without taking over the audio. The voice session
 * ducks music and pauses podcasts, which is too much for "a build finished":
 * low-priority events get a haptic (or nothing); only a decision or a blocker
 * justifies speaking, and only if a conversation is already live.
 */
export type Cue = "speak" | "haptic" | "none";

export function cueFor(
  tier: "interrupt" | "batch" | "silent",
  ctx: { audioLive: boolean; foreground: boolean; quiet: boolean },
): Cue {
  if (ctx.audioLive) return tier === "silent" ? "none" : "speak"; // already talking: no extra interruption
  if (ctx.quiet) return "none";
  if (tier === "interrupt") return ctx.foreground ? "haptic" : "none"; // backgrounded: the notification does it
  if (tier === "batch") return ctx.foreground ? "haptic" : "none";
  return "none";
}

/** A route that carries a session we should not restart on our own (call audio, CarPlay etc. aside). */
export function shouldResumeAfterInterruption(shouldResume: boolean, wasSuspendedByApp: boolean): boolean {
  return shouldResume && !wasSuspendedByApp;
}
