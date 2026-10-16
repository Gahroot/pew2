/**
 * The native call screen: CallKit (iOS, via `react-native-callkeep` plus
 * PushKit via `react-native-voip-push-notification`) and Android's Telecom
 * ConnectionService (the same callkeep API).
 *
 * Off unless the user turned on "Native call screen" (`preferences.ts`):
 * nothing here touches CallKit or Telecom until `enableNativeCalls` runs, and
 * `disableNativeCalls` makes every later event a no-op. The one exception is
 * native: `plugins/withVoiceCall.js` registers PushKit at launch and reports
 * any VoIP push to CallKit, because iOS kills an app that receives one and
 * does not. The daemon sends VoIP pushes only to a phone that registered with
 * the setting on, so with it off none arrive.
 *
 * Both libraries are native modules, probed before they are required (as
 * `speech.ts` does): Expo Go, web and builds that predate this have no call
 * screen, and `callKitAvailable()` answers false instead of the app crashing.
 * Merely *reading* a module off NativeModules can throw under the new
 * architecture, so that read is guarded too — the setting must cost the call
 * screen, never the app.
 *
 * Ported from AutomationGods/pew2 (`src/voice/callkit.ts`). UNTESTED ON DEVICE.
 */
import { NativeModules, Platform } from "react-native";
import Constants from "expo-constants";
import type RNCallKeepType from "react-native-callkeep";
import type RNVoipPushType from "react-native-voip-push-notification";
import { findCallPush } from "../voice/callPush";
import type { VoiceCallPush } from "../voice/types";

type CallKeep = typeof RNCallKeepType;
type VoipPush = typeof RNVoipPushType;
interface Natives {
  callKeep: CallKeep;
  /** iOS only: Android rings through an Expo push instead (`androidRing.ts`). */
  voip?: VoipPush;
}

export interface NativeCallHandlers {
  /**
   * The user answered a ringing call. `call` is undefined when its payload
   * never reached JavaScript; voice then opens unfocused rather than leaving a
   * connected call with nothing behind it.
   */
  onAnswer: (callId: string, call: VoiceCallPush | undefined) => void;
  /** The system ended a call: declined, hung up from the lock screen, or failed. */
  onEnd: (callId: string) => void;
  /** iOS: CallKit activated (true) or deactivated the audio session. */
  onAudioSession: (active: boolean) => void;
  onMute: (callId: string, muted: boolean) => void;
}

const isAndroid = Platform.OS === "android";

/**
 * Native module state. Module scope because the native side is a process-wide
 * singleton: listeners installed twice would deliver every answer twice.
 */
const state: {
  natives: Natives | null | undefined;
  installed: boolean;
  handlers: NativeCallHandlers | undefined;
  /** Calls the system knows about, by lowercase UUID, so an answer can find its payload. */
  known: Map<string, VoiceCallPush | undefined>;
  /** An answer that came before the app's handlers were ready (cold launch from the lock screen). */
  pendingAnswer: { callId: string; call: VoiceCallPush | undefined } | undefined;
  voipToken: string | undefined;
  tokenWaiters: ((token: string) => void)[];
} = {
  natives: undefined,
  installed: false,
  handlers: undefined,
  known: new Map(),
  pendingAnswer: undefined,
  voipToken: undefined,
  tokenWaiters: [],
};

function hasModule(name: string): boolean {
  try {
    return Boolean((NativeModules as Record<string, unknown>)[name]);
  } catch {
    return false;
  }
}

function natives(): Natives | null {
  if (state.natives !== undefined) return state.natives;
  const ios =
    Platform.OS === "ios" && hasModule("RNCallKeep") && hasModule("RNVoipPushNotificationManager");
  const android = isAndroid && hasModule("RNCallKeep");
  if (!ios && !android) {
    state.natives = null;
    return null;
  }
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const callKeep = (require("react-native-callkeep") as { default: CallKeep }).default;
    const voip = ios
      ? (require("react-native-voip-push-notification") as { default: VoipPush }).default
      : undefined;
    /* eslint-enable @typescript-eslint/no-require-imports */
    state.natives = { callKeep, ...(voip ? { voip } : null) };
  } catch {
    state.natives = null;
  }
  return state.natives;
}

export function callKitAvailable(): boolean {
  return natives() !== null;
}

/** Android Telecom setup, without the in-app alert so it is safe in a headless task. */
const ANDROID_OPTIONS = {
  alertTitle: "Let pew2 ring you",
  alertDescription:
    "Turn on pew2 as a calling account so your agents can ring this phone when they need you.",
  cancelButton: "Not now",
  okButton: "Open settings",
  additionalPermissions: [] as string[],
  selfManaged: false,
  foregroundService: {
    channelId: "pew2-call-service",
    channelName: "Voice calls",
    notificationTitle: "pew2 call in progress",
  },
};

function remember(payload: unknown): VoiceCallPush | undefined {
  const call = findCallPush(payload);
  if (call) state.known.set(call.callId, call);
  return call;
}

function answered(rawId: string): void {
  const id = rawId.toLowerCase();
  const call = state.known.get(id);
  // A call we started ourselves is held with no payload; it cannot be "answered".
  if (state.known.has(id) && call === undefined) return;
  // Held from here on, so hanging up from the lock screen reaches `onEnd`.
  if (!state.known.has(id)) state.known.set(id, undefined);
  const m = natives();
  if (isAndroid && m) {
    // The system call screen sits above the app: bring pew2 forward so the
    // voice sheet is what the user sees, and tell Telecom the call is live.
    m.callKeep.backToForeground();
    m.callKeep.setCurrentCallActive(id);
  }
  if (state.handlers) state.handlers.onAnswer(id, call);
  else state.pendingAnswer = { callId: id, call };
}

function ended(rawId: string): void {
  const id = rawId.toLowerCase();
  // Not known means we ended it ourselves (`endNativeCall` forgets first), so
  // the conversation is already closing; reporting it back would be an echo.
  if (!state.known.has(id)) return;
  state.known.delete(id);
  state.handlers?.onEnd(id);
}

function install(m: Natives): void {
  if (state.installed) return;
  state.installed = true;
  const { callKeep, voip } = m;
  callKeep.addEventListener("didDisplayIncomingCall", (d) => {
    remember(d?.payload);
  });
  callKeep.addEventListener("answerCall", (d) => answered(d.callUUID));
  callKeep.addEventListener("endCall", (d) => ended(d.callUUID));
  callKeep.addEventListener("didActivateAudioSession", () => state.handlers?.onAudioSession(true));
  callKeep.addEventListener("didDeactivateAudioSession", () =>
    state.handlers?.onAudioSession(false),
  );
  callKeep.addEventListener("didPerformSetMutedCallAction", (d) =>
    state.handlers?.onMute(d.callUUID.toLowerCase(), d.muted),
  );
  // Events CallKit queued before JavaScript loaded: a cold launch from a VoIP
  // push answered on the lock screen.
  callKeep.addEventListener("didLoadWithEvents", (events) => {
    for (const event of events ?? []) {
      const data = event.data as
        { callUUID?: string; payload?: unknown; muted?: boolean } | undefined;
      if (event.name === "RNCallKeepDidDisplayIncomingCall") remember(data?.payload);
      if (event.name === "RNCallKeepPerformAnswerCallAction" && data?.callUUID)
        answered(data.callUUID);
      if (event.name === "RNCallKeepPerformEndCallAction" && data?.callUUID) ended(data.callUUID);
      if (event.name === "RNCallKeepDidActivateAudioSession") state.handlers?.onAudioSession(true);
    }
  });
  if (!voip) return;
  const onToken = (token: string) => {
    state.voipToken = token;
    for (const resolve of state.tokenWaiters.splice(0)) resolve(token);
  };
  const onPush = (payload: unknown) => {
    // The native side already reported the call to CallKit; tell PushKit it is handled.
    const call = remember(payload);
    if (call) voip.onVoipNotificationCompleted(call.callId);
  };
  voip.addEventListener("register", onToken);
  voip.addEventListener("notification", onPush);
  voip.addEventListener("didLoadWithEvents", (events) => {
    for (const event of events ?? []) {
      if (event.name === "RNVoipPushRemoteNotificationsRegisteredEvent")
        onToken(event.data as string);
      if (event.name === "RNVoipPushRemoteNotificationReceivedEvent") onPush(event.data);
    }
  });
}

/** Turn the native call screen on. Safe on every mount; the latest handlers win. */
export function enableNativeCalls(handlers: NativeCallHandlers): void {
  state.handlers = handlers;
  const m = natives();
  if (!m) return;
  install(m);
  void m.callKeep
    .setup({
      ios: { appName: "pew2", includesCallsInRecents: false, supportsVideo: false },
      android: ANDROID_OPTIONS,
    })
    .then(() => {
      if (isAndroid) m.callKeep.setAvailable(true);
    })
    .catch(() => undefined);
  m.voip?.registerVoipToken();
  if (state.pendingAnswer) {
    const { callId, call } = state.pendingAnswer;
    state.pendingAnswer = undefined;
    handlers.onAnswer(callId, call);
  }
}

/** Turn it off: every later system event is ignored, and no VoIP address is handed out. */
export function disableNativeCalls(): void {
  state.handlers = undefined;
  state.pendingAnswer = undefined;
  const m = natives();
  if (isAndroid && m) {
    try {
      m.callKeep.setAvailable(false);
    } catch {
      // Nothing registered yet.
    }
  }
}

/**
 * This phone's VoIP push address, or undefined (Android, Expo Go, simulator,
 * or no PushKit token within a few seconds). Asked only with the setting on
 * (`push.ts`), so the daemon never learns it otherwise.
 *
 * `sandbox` for development builds: those are signed with the development
 * `aps-environment`. Release and TestFlight builds are production.
 */
export async function voipAddress(): Promise<
  { token: string; environment: "production" | "sandbox"; bundleId: string } | undefined
> {
  const m = natives();
  const voip = m?.voip;
  const bundleId = Constants.expoConfig?.ios?.bundleIdentifier;
  if (!m || !voip || !bundleId) return undefined;
  // The token listener, in case registration runs before the screen enabled calls.
  install(m);
  const token =
    state.voipToken ??
    (await new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), 8000);
      state.tokenWaiters.push((t) => {
        clearTimeout(timer);
        resolve(t);
      });
      voip.registerVoipToken();
    }));
  if (!token || !/^[0-9a-fA-F]{32,200}$/.test(token)) return undefined;
  return { token, environment: __DEV__ ? "sandbox" : "production", bundleId };
}

/**
 * Android: show the Telecom incoming-call screen. Runs in the headless push
 * task too, where no handlers exist yet; an answer then waits in `pendingAnswer`.
 *
 * @returns false when Telecom cannot ring (no callkeep in this build, or pew2
 * is not enabled as a calling account); the caller falls back to a banner.
 */
export async function ringAndroid(call: VoiceCallPush): Promise<boolean> {
  const m = natives();
  if (!m || !isAndroid) return false;
  try {
    m.callKeep.registerPhoneAccount({ ios: { appName: "pew2" }, android: ANDROID_OPTIONS });
    m.callKeep.registerAndroidEvents();
    m.callKeep.setAvailable(true);
    if (!(await m.callKeep.checkPhoneAccountEnabled())) return false;
    install(m);
    if (state.known.has(call.callId)) return true;
    state.known.set(call.callId, call);
    m.callKeep.displayIncomingCall(call.callId, "pew2", call.caller, "generic", false);
    return true;
  } catch {
    return false;
  }
}

/**
 * iOS: register a conversation the user started in the app, so CallKit owns
 * its audio session (lock screen controls, survives backgrounding) the same
 * way an answered one does. Android keeps in-app calls in-app: registering one
 * with Telecom needs the calling account and buys nothing the sheet lacks.
 */
export function startOutgoingCall(callId: string, caller: string): boolean {
  const m = natives();
  if (!m || isAndroid || !state.handlers) return false;
  state.known.set(callId, undefined);
  m.callKeep.startCall(callId, "pew2", caller, "generic", false);
  m.callKeep.reportConnectedOutgoingCallWithUUID(callId);
  return true;
}

/** End a call from the app's side. Forgets it first, so the system's echo is ignored. */
export function endNativeCall(callId: string): void {
  state.known.delete(callId);
  try {
    natives()?.callKeep.endCall(callId);
  } catch {
    // Already gone.
  }
}
