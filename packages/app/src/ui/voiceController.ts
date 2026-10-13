/**
 * Runs the voice machine's effects against the real world: the daemon socket,
 * WebRTC, the audio session and timers. A plain object rather than a hook so
 * its lifetime is explicit; `useVoice.ts` wraps it for React.
 *
 * All decisions are in `../voice/*`; this file only wires them. UNTESTED ON DEVICE.
 */
import { appendLine, type TranscriptLine } from "../voice/transcript";
import { createRealtimeSession, type RealtimeSession } from "../voice/realtime";
import {
  initialState,
  step,
  type Effect,
  type Focus,
  type MachineEvent,
  type MachineState,
} from "../voice/voiceMachine";
import { emptyStore, reduce, type StoreAction, type VoiceStore } from "../voice/voiceStore";
import { activateAudioSession, deactivateAudioSession } from "./audioSession";
import { LOST_CONNECTION_LINE, onNetworkLost, onNetworkRestored } from "../voice/connectivity";
import { offerLiveEvent } from "./voiceAlerts";
import { liveUpdateNote, shouldAnnounce } from "../voice/liveUpdates";
import { connectRealtime, type RealtimeTransport } from "./realtimeTransport";

export interface VoiceView {
  machine: MachineState;
  store: VoiceStore;
  transcript: TranscriptLine[];
}

export interface VoiceDeps {
  /** Sends one sealed message to the daemon; false when not connected. */
  send(message: Record<string, unknown>): boolean;
  /** Called after every change. */
  onChange(view: VoiceView): void;
  /** Called with the highest event id after each close, for the unheard re-offer. */
  onEnded?(): void;
}

interface Ready {
  secret: string;
  model: string;
  session: Record<string, unknown>;
  speakFirst: boolean;
}

type Message = Record<string, any>;

export function createVoiceController(deps: VoiceDeps) {
  let machine: MachineState = initialState;
  let store: VoiceStore = emptyStore;
  let transcript: TranscriptLine[] = [];
  let ready: Ready | undefined;
  let transport: RealtimeTransport | undefined;
  let realtime: RealtimeSession | undefined;
  let abort: AbortController | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let holding = false;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  /** Live news for this Realtime leg: what the opening snapshot covered, and what was since told. */
  let announceSince = 0;
  let announced = new Set<number>();

  const publish = () => deps.onChange({ machine, store, transcript });

  const newId = () => `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  function dispatch(event: MachineEvent): void {
    const result = step(machine, event);
    machine = result.state;
    publish();
    for (const effect of result.effects) run(effect);
    if (machine.phase === "closing") {
      // Teardown is synchronous from here; nothing is left to wait for.
      dispatch({ type: "closeDone" });
      deps.onEnded?.();
    }
  }

  function teardown(): void {
    generation++;
    abort?.abort();
    abort = undefined;
    transport?.close();
    transport = undefined;
    realtime = undefined;
    ready = undefined;
    holding = false;
    clearTimeout(holdTimer);
  }

  function run(effect: Effect): void {
    switch (effect.type) {
      case "sendOpen": {
        const ok = deps.send({
          t: "voice.open",
          voiceSessionId: effect.voiceSessionId,
          source: effect.focus.source,
          ...(effect.focus.focusEventId !== undefined ? { focusEventId: effect.focus.focusEventId } : {}),
          ...(effect.focus.focusTaskId ? { focusTaskId: effect.focus.focusTaskId } : {}),
        });
        if (!ok) queueMicrotask(() => dispatch({ type: "offline" }));
        return;
      }
      case "connectRealtime":
        void connect();
        return;
      case "teardownRealtime":
        teardown();
        return;
      case "sendClose":
        deps.send({
          t: "voice.close",
          voiceSessionId: effect.voiceSessionId,
          reason: effect.reason,
          ...(store.heardEventId > 0 ? { heardEventId: store.heardEventId } : {}),
        });
        return;
      case "audioActivate":
        void activateAudioSession().catch(() => dispatch({ type: "micDenied" }));
        return;
      case "audioDeactivate":
        void deactivateAudioSession();
        return;
      case "startIdleTimer":
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => dispatch({ type: "idleTimeout" }), effect.ms);
        return;
      case "cancelIdleTimer":
        clearTimeout(idleTimer);
        return;
      case "startOpenTimer":
        clearTimeout(openTimer);
        openTimer = setTimeout(() => dispatch({ type: "openTimeout" }), effect.ms);
        return;
      case "cancelOpenTimer":
        clearTimeout(openTimer);
        return;
      case "scheduleRetry":
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => dispatch({ type: "retryDue", voiceSessionId: newId() }), effect.ms);
        return;
      case "cancelRetry":
        clearTimeout(retryTimer);
        return;
    }
  }

  async function connect(): Promise<void> {
    const current = ready;
    const voiceSessionId = machine.voiceSessionId;
    if (!current || !voiceSessionId) return;
    const mine = ++generation;
    abort = new AbortController();
    const alive = () => mine === generation;
    try {
      const rt = await connectRealtime(
        current.secret,
        current.model,
        {
          onOpen: () => alive() && realtime?.start(),
          onMessage: (raw) => alive() && realtime?.handleMessage(raw),
          onClosed: () => alive() && dispatch({ type: "transportDown" }),
          onMicDenied: () => alive() && dispatch({ type: "micDenied" }),
        },
        abort.signal,
      );
      if (!alive()) {
        rt.close();
        return;
      }
      transport = rt;
    } catch {
      if (alive() && machine.phase === "connecting") dispatch({ type: "transportDown" });
    }
  }

  function startRealtime(payload: Ready): void {
    ready = payload;
    announced = new Set();
    realtime = createRealtimeSession({
      channel: { send: (m) => transport?.send(m) ?? false },
      session: payload.session,
      speakFirst: payload.speakFirst,
      handlers: {
        onReady: () => dispatch({ type: "transportUp" }),
        onUserSpeech: () => dispatch({ type: "userSpeech" }),
        onModelSpeaking: () => dispatch({ type: "modelSpeaking" }),
        onModelDone: () => dispatch({ type: "modelDone" }),
        onEndSession: () => dispatch({ type: "endSession" }),
        onTranscript: (role, text) => {
          transcript = appendLine(transcript, role, text);
          publish();
        },
        onError: (_message, fatal) => fatal && dispatch({ type: "transportDown" }),
        onToolCall: (call) => {
          const id = machine.voiceSessionId;
          const sent = id !== undefined && deps.send({ t: "voice.tool", voiceSessionId: id, ...call });
          if (!sent) {
            realtime?.submitResult({
              callId: call.callId,
              ok: false,
              output: null,
              error: "Your computer is not reachable right now.",
            });
          }
        },
      },
    });
  }

  function fold(action: StoreAction): void {
    store = reduce(store, action);
    publish();
  }

  return {
    view: (): VoiceView => ({ machine, store, transcript }),

    start(focus: Focus): void {
      transcript = [];
      dispatch({ type: "activate", voiceSessionId: newId(), focus });
    },
    end(): void {
      dispatch({ type: "userEnd" });
    },
    reset(): void {
      dispatch({ type: "reset" });
    },
    background(): void {
      dispatch({ type: "background" });
    },
    dispatch,
    fold,
    restore(cursor: number, heardEventId: number): void {
      fold({ type: "restore", cursor, heardEventId });
    },
    clear(): void {
      teardown();
      machine = initialState;
      transcript = [];
      store = reduce(store, { type: "clear" });
      publish();
    },
    /**
     * Network up/down. Offline holds the conversation (no retry budget burnt)
     * and says so once if audio is live; coming back reconnects with a fresh
     * budget and catches up from the cursor. A long outage falls through to the
     * machine's own bounded failure.
     */
    setOnline(online: boolean): void {
      if (!online) {
        const d = onNetworkLost(machine.phase, holding);
        if (d.kind !== "hold") return;
        holding = true;
        if (d.announce) {
          transport?.send({ type: "response.create", response: { instructions: LOST_CONNECTION_LINE } });
        }
        clearTimeout(holdTimer);
        holdTimer = setTimeout(() => {
          holding = false;
          dispatch({ type: "networkLost" });
        }, d.graceMs);
        return;
      }
      const d = onNetworkRestored(holding, machine.phase);
      holding = false;
      clearTimeout(holdTimer);
      if (d.kind === "resume") {
        dispatch({ type: "networkLost" }); // rebuilds the Realtime leg: fresh voice.open, fresh budget
        deps.send({ t: "voice.sync", since: store.cursor });
      }
    },
    /** Asks the daemon for what this phone missed. */
    sync(): void {
      deps.send({ t: "voice.sync", since: store.cursor });
    },

    /** Every `voice.*` message, and `unknown_message` errors. */
    handleMessage(message: Message): void {
      switch (message.t) {
        case "voice.ready": {
          if (message.voiceSessionId !== machine.voiceSessionId || machine.phase !== "opening") return;
          const rt = message.realtime;
          fold({ type: "state", snapshot: message.snapshot, events: [] });
          announceSince = typeof message.snapshot?.eventId === "number" ? message.snapshot.eventId : store.cursor;
          startRealtime({
            secret: rt.secret,
            model: rt.model,
            session: rt.session,
            speakFirst: machine.focus?.source === "notification" || (message.snapshot?.unheard?.length ?? 0) > 0,
          });
          dispatch({ type: "ready" });
          return;
        }
        case "voice.unavailable":
          dispatch({ type: "unavailable", code: message.code, message: message.message });
          return;
        case "voice.tool.result":
          if (message.voiceSessionId !== machine.voiceSessionId) return;
          fold({ type: "toolResult", output: message.output });
          realtime?.submitResult({
            callId: message.callId,
            ok: message.ok,
            output: message.output,
            error: message.error,
            endSession: message.endSession,
          });
          return;
        case "voice.event":
          // A live conversation hears it from the model; nothing else would tell it.
          if (realtime && message.event && shouldAnnounce(message.event, { since: announceSince, sent: announced })) {
            announced.add(message.event.eventId);
            realtime.notify(liveUpdateNote(message.event, message.task));
          }
          offerLiveEvent(message.event);
          fold({ type: "event", event: message.event, task: message.task });
          return;
        case "voice.state":
          fold({ type: "state", snapshot: message.snapshot, events: message.events ?? [] });
          return;
        case "error":
          if (message.code === "unknown_message" && machine.phase === "opening") dispatch({ type: "oldDaemon" });
          return;
        default:
          return;
      }
    },
  };
}

export type VoiceController = ReturnType<typeof createVoiceController>;
