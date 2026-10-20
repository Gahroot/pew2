/**
 * Voice on this daemon: whether it can call, the machine-wide inbox, the
 * sign-in and prefs actions, and the call itself.
 *
 * The decisions are `voiceCall.ts`'s; this hook only runs the effects it
 * returns — daemon messages, the WebRTC transport, timers — outside any state
 * updater, so a twice-run updater can never send a frame twice.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { wire } from "@pew2/protocol";
import {
  CALL_ERRORS,
  IDLE_CALL,
  VOICE_UNKNOWN,
  callActive,
  foldVoiceStatus,
  readInboxItems,
  stepCall,
  type CallEffect,
  type CallInput,
  type CallPlace,
  type CallState,
  type VoiceInboxItem,
  type VoiceKnowledge,
  type VoiceMode,
} from "../voiceCall";
import { IDLE_BOARD, boardFromInbox, foldBoard, type BoardState } from "../voiceBoard";
import { openTransport, type VoiceTransport } from "./voiceTransport";
import { cancelsEcho, onRouteChange, setProximity, setVoiceChatMode } from "../../modules/pew-audio-route";
import { setOnCall } from "./notifier";
import { sounds } from "./sounds";
import { setAudioModeAsync } from "expo-audio";
import { useSharedValue } from "react-native-reanimated";
import { NEW_CLOCK, tickClock, type SpeechClock } from "../speechSync";

/**
 * The call's audio session, set before the mic opens: expo-audio maps this to
 * AVAudioSession playAndRecord with allowBluetooth (HFP, so AirPods carry both
 * directions), no defaultToSpeaker, background audio so a locked screen keeps
 * the call. expo-audio cannot set a session *mode*; voiceChat (hardware echo
 * cancellation) is applied by the WebRTC framework's audio unit when it starts.
 */
/** After a call, app sounds stay quiet this long while WebRTC releases the audio session. */
const AUDIO_SETTLE_MS = 1500;
/** The hang-up tone's length: the call's audio stays up (silent) until it is over. */
const END_TONE_MS = 1200;

function enterCallAudio(): Promise<void> {
  return setAudioModeAsync({
    playsInSilentMode: true,
    allowsRecording: true,
    interruptionMode: "doNotMix",
    shouldPlayInBackground: true,
    shouldRouteThroughEarpiece: false,
  })
    // Voice chat mode (system echo cancellation), still before the mic opens.
    .then(() => void setVoiceChatMode())
    .catch(() => {});
}

interface Options {
  post: (message: unknown) => boolean;
  online: boolean;
}

export function useVoice({ post, online }: Options) {
  const [knowledge, setKnowledge] = useState<VoiceKnowledge>(VOICE_UNKNOWN);
  const knowledgeRef = useRef<VoiceKnowledge>(VOICE_UNKNOWN);
  const [inbox, setInbox] = useState<VoiceInboxItem[]>([]);
  const [call, setCall] = useState<CallState>(IDLE_CALL);
  /** Mission control's lanes: `voice.board`, or `voice.inbox` from an older daemon. */
  const [board, setBoardState] = useState<BoardState>(IDLE_BOARD);
  const boardRef = useRef<BoardState>(IDLE_BOARD);
  const setBoard = useCallback((next: BoardState) => {
    if (next === boardRef.current) return;
    boardRef.current = next;
    setBoardState(next);
  }, []);
  const callRef = useRef<CallState>(IDLE_CALL);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const transport = useRef<VoiceTransport | undefined>(undefined);
  /** The call's audio session being applied; the transport waits for it. */
  const audioReady = useRef<Promise<unknown>>(Promise.resolve());
  /**
   * The previous call's teardown (`VoiceTransport.released`). A new call sets
   * its audio session only after it: configured while WebRTC was still
   * stopping the last call's audio unit and releasing the session ("Call
   * again" straight from the end card), the new call's audio raced the old
   * one's shutdown.
   */
  const lastReleased = useRef<Promise<void>>(Promise.resolve());
  /** The mic's loudness, 0..1, for the listening animation; -1 when unknown. */
  const micLevel = useSharedValue(-1);
  /** Pew's speaking clock (ms its voice has sounded), read by the call screen's captions. */
  const speech = useRef<SpeechClock>(NEW_CLOCK);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const counter = useRef(0);
  const postRef = useRef(post);
  postRef.current = post;

  const nextId = useCallback(() => `voice-${Date.now().toString(36)}-${++counter.current}`, []);

  const dispatchRef = useRef<(input: CallInput) => void>(() => {});
  const run = useCallback((effects: CallEffect[]) => {
    const dispatch = (input: CallInput) => dispatchRef.current(input);
    for (const effect of effects) {
      switch (effect.kind) {
        case "daemon":
          if (!postRef.current(effect.message) && effect.message.t === "voice.session") {
            dispatch({ type: "failed", error: CALL_ERRORS.offline });
          }
          break;
        case "connect":
          transport.current?.close();
          transport.current = openTransport(
            effect.secret,
            effect.expiresAt,
            {
              onOpen: () => dispatch({ type: "open" }),
              onEvent: (event) => dispatch({ type: "server", event }),
              onFailed: (error) => dispatch({ type: "failed", error }),
            },
            audioReady.current,
          );
          break;
        case "realtime":
          transport.current?.send(effect.event);
          break;
        case "mute":
          transport.current?.setMuted(effect.muted);
          break;
        case "timer": {
          const existing = timers.current.get(effect.key);
          if (existing) clearTimeout(existing);
          timers.current.set(
            effect.key,
            setTimeout(() => {
              timers.current.delete(effect.key);
              dispatch(effect.input);
            }, effect.ms),
          );
          break;
        }
        case "cancelTimer": {
          const existing = timers.current.get(effect.key);
          if (existing) clearTimeout(existing);
          timers.current.delete(effect.key);
          break;
        }
        case "close":
          // The hang-up tone is already playing (see `dispatch`); the call
          // goes silent now and its audio shuts down once the tone is over.
          if (transport.current) {
            transport.current.close(END_TONE_MS);
            lastReleased.current = transport.current.released;
          }
          transport.current = undefined;
          // Restore: the next chime re-applies the app's ambient, mixing mode.
          // Not at once: WebRTC is still shutting its audio down, and an app
          // sound played now (the end card's swish, a tap) waits on the audio
          // session synchronously, which froze the screen for seconds. The
          // call's own end cue plays natively and is unaffected.
          clearTimeout(settleTimer.current);
          settleTimer.current = setTimeout(() => {
            if (!callActive(callRef.current)) sounds.setListening(false);
          }, AUDIO_SETTLE_MS);
          break;
      }
    }
  }, []);

  const dispatch = useCallback(
    (input: CallInput) => {
      const before = callRef.current.phase;
      const step = stepCall(callRef.current, input);
      // The hang-up tone first, while the call's audio is still up: played
      // after the connection closes, it waited seconds for WebRTC to let go.
      const after = step.state.phase;
      if ((after === "ended" && (before === "live" || before === "ending")) || (after === "failed" && before !== "failed")) {
        sounds.callCue("call-end");
      }
      callRef.current = step.state;
      setCall(step.state);
      run(step.effects);
    },
    [run],
  );
  dispatchRef.current = dispatch;

  const setKnown = useCallback((next: VoiceKnowledge) => {
    if (next === knowledgeRef.current) return;
    knowledgeRef.current = next;
    setKnowledge(next);
  }, []);

  /** Every opened daemon frame; wired through `useDaemon`'s `onFrame`. */
  const onFrame = useCallback(
    (message: unknown) => {
      if (typeof message !== "object" || message === null) return;
      const t = (message as { t?: unknown }).t;
      if (t !== "error" && (typeof t !== "string" || !t.startsWith("voice."))) return;
      setKnown(foldVoiceStatus(knowledgeRef.current, message));
      if (t === "voice.inbox") {
        const items = readInboxItems((message as { items?: unknown }).items);
        if (items) setInbox(items);
      }
      if (t === "voice.board" || t === "voice.inbox") setBoard(foldBoard(boardRef.current, message, Date.now()));
      dispatch({ type: "daemon", message });
    },
    [dispatch, setKnown, setBoard],
  );

  // The call's real output route, from iOS: the state machine closes the mic
  // while Pew talks on the loudspeaker, and the speaker button shows it.
  const inCall = call.phase === "connecting" || call.phase === "live" || call.phase === "ending";
  useEffect(() => {
    if (!inCall) return;
    const subscription = onRouteChange((speaker) => dispatch({ type: "route", speaker }));
    // Screen off at the ear for the whole call, back on when it ends.
    setProximity(true);
    return () => {
      subscription?.remove();
      setProximity(false);
    };
  }, [inCall, dispatch]);

  // Back online mid-call: resend tool requests the drop may have lost.
  useEffect(() => {
    if (online) dispatch({ type: "reconnected" });
  }, [online, dispatch]);

  // Ask on every (re)connect: the login may have changed while away. A daemon
  // that never answers leaves this "unknown", and voice stays hidden.
  useEffect(() => {
    if (!online) return;
    const requestId = nextId();
    if (!postRef.current({ t: "voice.status", requestId })) return;
    if (knowledgeRef.current.kind === "unknown") setKnown({ kind: "unknown", asked: requestId });
  }, [online, nextId, setKnown]);

  // Leaving the screen ends the call and every timer with it.
  useEffect(
    () => () => {
      transport.current?.close();
      transport.current = undefined;
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  /**
   * `system`: answered on the system's call screen (CallKit). CallKit already
   * rang and owns the audio session, so no dial tone and no session change
   * here (the native side set voice chat before it activated the session).
   */
  const startCall = useCallback(
    (focus?: string, system = false, sessionId?: string, place?: CallPlace) => {
      if (callActive(callRef.current)) return;
      clearTimeout(settleTimer.current);
      sounds.setListening(true);
      const previous = lastReleased.current;
      audioReady.current = system ? previous : previous.then(enterCallAudio);
      // The dialing ring, once the call's audio session is in place (it is
      // played inside that session, never switching it).
      if (!system) {
        void audioReady.current.then(() => {
          if (callRef.current.phase === "connecting") sounds.callCue("call-dial");
        });
      }
      // A new call starts from the inbox in hand; the daemon's board replaces it within a frame.
      setBoard(boardFromInbox(callRef.current.inbox ?? []));
      dispatch({ type: "start", requestId: nextId(), focus, sessionId, ...(place ? { place } : {}), echoGuard: !cancelsEcho() });
    },
    [dispatch, nextId, setBoard],
  );
  const hangUp = useCallback(() => dispatch({ type: "hangup" }), [dispatch]);
  // DEV: hang up by itself N ms after going live, to time the end of a call.
  const devHangup = __DEV__ ? Number(process.env.EXPO_PUBLIC_DEV_HANGUP_MS ?? 0) : 0;
  useEffect(() => {
    if (!devHangup || call.phase !== "live") return;
    const timer = setTimeout(() => hangUp(), devHangup);
    return () => clearTimeout(timer);
  }, [devHangup, call.phase, hangUp]);
  const setMuted = useCallback((muted: boolean) => dispatch({ type: "mute", muted }), [dispatch]);
  const dismiss = useCallback(() => dispatch({ type: "reset" }), [dispatch]);
  /** Tap Pew mid-sentence: stop it and listen (the mic is closed while it talks). */
  const interrupt = useCallback(() => dispatch({ type: "interrupt" }), [dispatch]);
  /** The user answered the call screen's card by tapping: send it, and tell Pew. */
  const answerOnScreen = useCallback(
    (input: Omit<Extract<CallInput, { type: "answeredOnScreen" }>, "type">) => dispatch({ type: "answeredOnScreen", ...input }),
    [dispatch],
  );
  const login = useCallback(
    (action: "start" | "cancel" | "logout") => postRef.current({ t: "voice.login", requestId: nextId(), action }),
    [nextId],
  );
  const setMode = useCallback((mode: VoiceMode) => postRef.current({ t: "voice.prefs", prefs: { mode } }), []);
  /** Forget what was said on earlier calls (the threads kept per chat on the computer). */
  const forgetHistory = useCallback(() => postRef.current({ t: "voice.forget" } satisfies wire.VoiceForget), []);
  /** Change any of the call policy's settings; the `voice.status` broadcast confirms. */
  const setPrefs = useCallback(
    (prefs: Partial<wire.VoicePrefsValues>) => postRef.current({ t: "voice.prefs", prefs } satisfies wire.VoicePrefs),
    [],
  );
  /** Let a conversation ring (or stop it). Answered by a `voice.status` with `armed`. */
  const arm = useCallback(
    (sessionId: string, on: boolean) => postRef.current({ t: "voice.arm", sessionId, on } satisfies wire.VoiceArm),
    [],
  );

  // The call's cues, on its moments: connected, ended (the dial is started
  // with the call). The dial is cut as soon as the call picks up or fails.
  const phase = call.phase;
  const lastPhase = useRef(phase);
  useEffect(() => {
    const from = lastPhase.current;
    lastPhase.current = phase;
    if (from === phase) return;
    if (from === "connecting") sounds.stopCue("call-dial");
    if (phase === "live") sounds.callCue("call-connect");
  }, [phase]);

  // Loaded while nothing is playing (off a call), so the first ring isn't late.
  const voiceAvailable = knowledge.kind === "known" && knowledge.status.available;
  useEffect(() => {
    if (voiceAvailable && !callActive(callRef.current)) sounds.prepareCues(["call-dial", "call-connect", "call-end"]);
  }, [voiceAvailable]);

  // No banners over the call (they still reach Notification Center).
  const onCallNow = callActive(call);
  useEffect(() => {
    setOnCall(onCallNow);
    return () => setOnCall(false);
  }, [onCallNow]);

  // Read the mic's level about 12 times a second while the call is live, for
  // the listening waves. Stats calls are cheap but not free: only while live.
  const live = call.phase === "live";
  useEffect(() => {
    if (!live) {
      micLevel.value = -1;
      return;
    }
    let stopped = false;
    // 20 times a second: the speaking clock decides when a caption word
    // appears, so its resolution is the captions' sync.
    const timer = setInterval(() => {
      void transport.current?.levels().then((levels) => {
        if (stopped) return;
        micLevel.value = levels.mic ?? -1;
        speech.current = tickClock(speech.current, levels.outEnergy, levels.outDuration);
      });
    }, 50);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [live, micLevel]);

  return { knowledge, inbox, call, board, micLevel, speech, startCall, hangUp, setMuted, dismiss, interrupt, answerOnScreen, login, setMode, setPrefs, arm, forgetHistory, onFrame };
}

export type Voice = ReturnType<typeof useVoice>;
