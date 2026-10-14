/**
 * React side of voice: owns the controller, activation (deep link, notification),
 * audio-session events, cursor persistence and sync-on-reconnect.
 * UNTESTED ON DEVICE.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking } from "react-native";
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

interface Options {
  send: (message: Record<string, unknown>) => boolean;
  online: boolean;
}

export function useVoice({ send, online }: Options) {
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
      if (s !== "active") get().background();
    });
    return () => sub.remove();
  }, []);

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
