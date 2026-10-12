/**
 * Native binding for the voice audio session. Decisions are in
 * `../voice/audioPolicy.ts`; the AVAudioSession calls are in
 * `modules/pew2-voice` (Swift). Absent on Android, in Expo Go and in a build
 * made before the module existed — every call then does nothing, and the
 * WebRTC layer's own session handling is what is left.
 *
 * UNTESTED ON DEVICE.
 */
import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import {
  interruptionAction,
  routeChangeAction,
  voiceSessionConfig,
  type AudioRoute,
  type InterruptionAction,
  type RouteAction,
  type RouteChangeReason,
} from "../voice/audioPolicy";

interface NativeVoice {
  activate(options: string[]): Promise<void>;
  deactivate(): Promise<void>;
  currentRoute(): AudioRoute;
  addListener(
    event: "interruption" | "routeChange" | "remoteToggle",
    listener: (body: Record<string, unknown>) => void,
  ): { remove(): void };
}

const native: NativeVoice | null =
  Platform.OS === "ios" ? requireOptionalNativeModule<NativeVoice>("Pew2Voice") : null;

export const audioSessionAvailable = native !== null;

export async function activateAudioSession(): Promise<void> {
  await native?.activate(voiceSessionConfig().options);
}

/** Releases the session with `notifyOthersOnDeactivation`, so other apps resume. */
export async function deactivateAudioSession(): Promise<void> {
  try {
    await native?.deactivate();
  } catch {
    // Nothing useful to do; the conversation is already over.
  }
}

export function currentRoute(): AudioRoute | undefined {
  try {
    return native?.currentRoute();
  } catch {
    return undefined;
  }
}

export interface AudioSessionListeners {
  onInterruption(action: InterruptionAction): void;
  onRoute(action: RouteAction, route: AudioRoute): void;
  /** Headset play/pause pressed during a conversation. */
  onRemoteToggle(): void;
}

const ROUTE_KINDS = new Set(["builtin_speaker", "builtin_receiver", "bluetooth", "wired", "other", "builtin_mic"]);
const asKind = (value: unknown, fallback: AudioRoute["output"]): AudioRoute["output"] =>
  typeof value === "string" && ROUTE_KINDS.has(value) ? (value as AudioRoute["output"]) : fallback;

export function listenToAudioSession(listeners: AudioSessionListeners): () => void {
  if (!native) return () => {};
  const subs = [
    native.addListener("interruption", (body) => {
      listeners.onInterruption(interruptionAction(body.phase === "began" ? "began" : "ended", body.shouldResume === true));
    }),
    native.addListener("routeChange", (body) => {
      const current: AudioRoute = {
        output: asKind(body.output, "other"),
        input: asKind(body.input, "other"),
      };
      const previous: AudioRoute | undefined =
        typeof body.previousOutput === "string"
          ? { output: asKind(body.previousOutput, "other"), input: asKind(body.previousInput, "other") }
          : undefined;
      const reason = (typeof body.reason === "string" ? body.reason : "unknown") as RouteChangeReason;
      listeners.onRoute(routeChangeAction(reason, previous, current), current);
    }),
    native.addListener("remoteToggle", () => listeners.onRemoteToggle()),
  ];
  return () => subs.forEach((s) => s.remove());
}
