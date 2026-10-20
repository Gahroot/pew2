/**
 * Speaker on/off for a live call (see `ios/PewAudioRouteModule.swift`).
 *
 * Optional, so a build without the native module (Android, web, a dev client
 * built before this module existed) reads as "no route switch here" and the
 * call screen hides the speaker button instead of showing a dead one.
 */
import { requireOptionalNativeModule } from "expo";

interface PewAudioRouteNative {
  setSpeaker(on: boolean): boolean;
  isSpeaker(): boolean;
  /** Absent from a build made before sounds moved native. */
  playCue?(uri: string, volume: number, at: number, activate: boolean): Promise<void>;
  prepareCues?(uris: string[]): Promise<void>;
  stopCue?(uri: string, ms: number): Promise<void>;
  /** Absent from a build made before voice barge-in. */
  isSimulator?(): boolean;
  /** Absent from a build made before the speaker kept its choice. */
  setVoiceChatMode?(): boolean;
  setProximity?(on: boolean): void;
  addListener?(event: "onRoute", listener: (event: { speaker: boolean; wanted: boolean }) => void): { remove(): void };
}

const native = requireOptionalNativeModule<PewAudioRouteNative>("PewAudioRoute");

/**
 * Whether a call can let the user talk over Pew: a real device, whose audio
 * cancels Pew's voice out of the mic. False on the simulator, and on a build
 * that can't tell (no native module, or one from before this), so those keep
 * the mic closed while Pew talks.
 */
export function cancelsEcho(): boolean {
  if (typeof native?.isSimulator !== "function") return false;
  try {
    return !native.isSimulator();
  } catch {
    return false;
  }
}

/** Whether this build can switch the call's audio route at all. */
export const canSwitchSpeaker = native !== null;

/** Route the call to the loudspeaker (true) or back to iOS's choice (false). False when nothing switched. */
export function setSpeaker(on: boolean): boolean {
  return native?.setSpeaker(on) ?? false;
}

/** Whether the call is on the loudspeaker now. */
export function isSpeaker(): boolean {
  return native?.isSpeaker() ?? false;
}

/** Whether sounds can play off the JS thread (a native build with `playCue`). */
export const canPlayCues = typeof native?.playCue === "function" && typeof native?.prepareCues === "function";

/** Play a sound file (a `file://` URI) without blocking the JS thread. Never throws. */
export function playCue(uri: string, options: { volume?: number; at?: number; activate?: boolean } = {}): void {
  void native?.playCue?.(uri, options.volume ?? 1, options.at ?? 0, options.activate ?? false).catch(() => {});
}

export function prepareCues(uris: string[]): void {
  void native?.prepareCues?.(uris).catch(() => {});
}

export function stopCue(uri: string, ms = 80): void {
  void native?.stopCue?.(uri, ms).catch(() => {});
}

/** The call's session mode (voice chat: system echo cancellation). Before the mic opens only. */
export function setVoiceChatMode(): boolean {
  try {
    return native?.setVoiceChatMode?.() ?? false;
  } catch {
    return false;
  }
}

/**
 * The call's real output whenever it changes (`speaker`: on the loudspeaker
 * now). Undefined on a build without route events: the screen then trusts
 * its own button.
 */
export function onRouteChange(listener: (speaker: boolean) => void): { remove(): void } | undefined {
  if (typeof native?.addListener !== "function") return undefined;
  return native.addListener("onRoute", (event) => listener(event.speaker === true));
}

/** Screen off at the ear during a call (as the Phone app does). No-op on an older build. */
export function setProximity(on: boolean): void {
  try {
    native?.setProximity?.(on);
  } catch {
    // Older build: nothing to switch.
  }
}
