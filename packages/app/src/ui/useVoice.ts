/**
 * React side of voice: owns the controller, activation (deep link, notification),
 * audio-session events, cursor persistence and sync-on-reconnect.
 * UNTESTED ON DEVICE.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking } from "react-native";
import { randomUUID } from "expo-crypto";
import { RTCAudioSession } from "react-native-webrtc";
import { isRepeatLink, parseVoiceLink, type VoiceActivation } from "../voice/deepLink";
import { isOpen } from "../voice/voiceMachine";
import { loadVoiceCursor, saveVoiceCursor } from "../preferences";
import { listenToAudioSession } from "./audioSession";
import { createVoiceController, type VoiceController, type VoiceView } from "./voiceController";
import { onVoiceNotificationChoice } from "./voiceNotifier";
import { setVoicePresence } from "./notifier";
import { emptyStore } from "../voice/voiceStore";
import { initialState } from "../voice/voiceMachine";
import { pickPhotos } from "./attachmentPicker";
import type { ScreenshotCard } from "../voice/screenshots";
import { activationFor, OUTGOING_CALLER } from "../voice/callPush";
import { disableNativeCalls, enableNativeCalls, endNativeCall, startOutgoingCall } from "./callkit";
import { listenForegroundRings } from "./androidRing";

interface Options {
  send: (message: Record<string, unknown>) => boolean;
  online: boolean;
  /** The "Native call screen" setting: CallKit / Telecom carry the conversation. */
  nativeCall: boolean;
}

export function useVoice({ send, online, nativeCall }: Options) {
  const [view, setView] = useState<VoiceView>({ machine: initialState, store: emptyStore, transcript: [], screenshots: [], pickerRequests: 0 });
  const [sheetOpen, setSheetOpen] = useState(false);
  // Bumped on every activation: with the sheet already open, setSheetOpen(true) changes nothing, so the queued request would never run.
  const [activationTick, setActivationTick] = useState(0);
  const sendRef = useRef(send);
  sendRef.current = send;
  const controller = useRef<VoiceController | null>(null);
  const pending = useRef<VoiceActivation | undefined>(undefined);
  const lastLink = useRef<{ url: string; at: number } | undefined>(undefined);
  const endedAt = useRef<number | undefined>(undefined);
  /** The system call (CallKit / Telecom) carrying the current conversation, if any. */
  const nativeCallId = useRef<string | undefined>(undefined);

  const get = (): VoiceController => {
    controller.current ??= createVoiceController({
      send: (m) => sendRef.current(m),
      onChange: setView,
      onEnded: () => {
        endedAt.current = Date.now();
      },
    });
    return controller.current;
  };

  const activate = useCallback((activation: VoiceActivation) => {
    pending.current = activation;
    setSheetOpen(true);
    setActivationTick((t) => t + 1);
  }, []);

  // Runs a queued activation once the daemon is reachable: a cold-start link
  // arrives before the socket does.
  useEffect(() => {
    const next = pending.current;
    if (!next || !online) return;
    pending.current = undefined;
    get().start(next);
  }, [online, sheetOpen, activationTick]);

  // Cursor: restore once, persist on change.
  useEffect(() => {
    void loadVoiceCursor().then((c) => get().restore(c.cursor, c.heardEventId));
  }, []);
  useEffect(() => {
    if (view.store.cursor > 0) {
      void saveVoiceCursor({ cursor: view.store.cursor, heardEventId: view.store.heardEventId });
    }
  }, [view.store.cursor, view.store.heardEventId]);

  // Catch up whenever the socket comes back, and when a gap was seen.
  useEffect(() => {
    if (online) get().sync();
  }, [online]);
  useEffect(() => {
    if (online && view.store.needsSync) get().sync();
  }, [online, view.store.needsSync]);
  useEffect(() => {
    get().setOnline(online);
  }, [online]);

  // Deep links, cold and warm.
  useEffect(() => {
    const handle = (url: string | null) => {
      if (!url) return;
      const parsed = parseVoiceLink(url);
      if (!parsed) return;
      if (isRepeatLink(lastLink.current, url, Date.now())) return;
      lastLink.current = { url, at: Date.now() };
      activate(parsed);
    };
    void Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener("url", (e) => handle(e.url));
    return () => sub.remove();
  }, [activate]);

  // Notification taps and actions.
  useEffect(
    () =>
      onVoiceNotificationChoice((route) => {
        if (route.kind === "voice") {
          activate({ source: "notification", focusEventId: route.focusEventId, focusTaskId: route.focusTaskId });
        } else {
          setSheetOpen(true);
        }
      }),
    [activate],
  );

  // Audio interruptions, route changes, headset button.
  useEffect(
    () =>
      listenToAudioSession({
        onInterruption: (action) => {
          const c = get();
          if (action.kind === "suspend") c.dispatch({ type: "interruptionBegan", now: Date.now() });
          else {
            c.dispatch({
              type: "interruptionEnded",
              shouldResume: action.resume,
              now: Date.now(),
              voiceSessionId: `v-${Date.now().toString(36)}`,
            });
          }
        },
        onRoute: (action) => {
          if (action === "end") get().dispatch({ type: "routeLost" });
        },
        onRemoteToggle: () => get().end(),
      }),
    [],
  );

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      // A system call keeps the app running in the background, so a
      // conversation it carries is not at risk mid-connect.
      if (s !== "active" && !nativeCallId.current) get().background();
    });
    return () => sub.remove();
  }, []);

  // Native call screen: answering a ring opens voice, hanging up from the
  // system UI ends it, and its mute button mutes the mic. Off means CallKit
  // and Telecom are never touched (see `callkit.ts`).
  useEffect(() => {
    if (!nativeCall) {
      disableNativeCalls();
      if (nativeCallId.current) endNativeCall(nativeCallId.current);
      nativeCallId.current = undefined;
      return;
    }
    enableNativeCalls({
      onAnswer: (callId, call) => {
        nativeCallId.current = callId;
        activate(call ? activationFor(call) : { source: "notification" });
      },
      onEnd: (callId) => {
        if (nativeCallId.current !== callId) return;
        nativeCallId.current = undefined;
        get().end();
      },
      // CallKit owns the audio session during a system call; WebRTC must be told
      // when it is live, or the microphone records silence.
      onAudioSession: (active) => {
        if (active) RTCAudioSession.audioSessionDidActivate();
        else RTCAudioSession.audioSessionDidDeactivate();
      },
      onMute: (callId, muted) => {
        if (nativeCallId.current === callId) get().setMuted(muted);
      },
    });
    return listenForegroundRings();
  }, [nativeCall, activate]);

  // A conversation started in the app becomes a system call too (iOS), and the
  // system call ends when the conversation does. Only an open -> closed edge
  // ends it: an answered call exists before voice has opened.
  const live = isOpen(view.machine.phase);
  const wasLive = useRef(false);
  useEffect(() => {
    if (live && nativeCall && !nativeCallId.current) {
      const callId = randomUUID().toLowerCase();
      if (startOutgoingCall(callId, OUTGOING_CALLER)) nativeCallId.current = callId;
    }
    if (!live && wasLive.current && nativeCallId.current) {
      endNativeCall(nativeCallId.current);
      nativeCallId.current = undefined;
    }
    wasLive.current = live;
  }, [live, nativeCall]);

  // Tells the notification handler what the user is hearing or seeing.
  useEffect(() => {
    setVoicePresence({
      voiceActive: isOpen(view.machine.phase),
      voiceSheetOpen: sheetOpen,
      heardEventId: view.store.heardEventId,
      voiceEndedAt: endedAt.current,
    });
  }, [view.machine.phase, sheetOpen, view.store.heardEventId]);

  /**
   * Pick one screenshot and upload it. Uses the chat composer's picker, so it
   * is downscaled to a vision model's working size before its bytes are read.
   * One at a time: each is something to say where it goes.
   */
  const pickingRef = useRef(false);
  const pickScreenshot = useCallback(async () => {
    if (pickingRef.current) return;
    pickingRef.current = true;
    try {
      const outcome = await pickPhotos(1);
      if (outcome.status === "picked") {
        for (const file of outcome.attachments) get().attachScreenshot(file);
      } else if (outcome.status === "denied" || outcome.status === "error") {
        get().screenshotFailed("Screenshot", outcome.message);
      }
    } finally {
      pickingRef.current = false;
    }
  }, []);

  // The model asked for one (`request_screenshot`): open the sheet and the picker.
  const lastPickerRequest = useRef(0);
  useEffect(() => {
    if (view.pickerRequests === lastPickerRequest.current) return;
    lastPickerRequest.current = view.pickerRequests;
    setSheetOpen(true);
    void pickScreenshot();
  }, [view.pickerRequests, pickScreenshot]);

  // Whatever arrives while the sheet is open or voice is live has been seen.
  useEffect(() => {
    if (sheetOpen || isOpen(view.machine.phase)) get().fold({ type: "heard", eventId: view.store.cursor });
  }, [sheetOpen, view.machine.phase, view.store.cursor]);

  return {
    view,
    sheetOpen,
    open: () => setSheetOpen(true),
    /** Starts a conversation from the in-app button. */
    talk: () => activate({ source: "in_app" }),
    end: () => get().end(),
    /** Closes the sheet; a live conversation keeps going (and can be ended from the sheet). */
    close: () => {
      setSheetOpen(false);
      const phase = get().view().machine.phase;
      if (phase === "error" || phase === "closed") get().reset();
    },
    handleMessage: (message: Record<string, unknown>) => get().handleMessage(message),
    /** Opens the photo picker and uploads what is chosen. Fire-and-forget: failures become a card. */
    pickScreenshot: () => void pickScreenshot(),
    removeScreenshot: (card: ScreenshotCard) => get().removeScreenshot(card),
    sendScreenshot: (attachmentId: string, taskId: string) => get().sendScreenshot(attachmentId, taskId),
    /** On unpair: forget everything tied to that machine. */
    clear: () => get().clear(),
  };
}
