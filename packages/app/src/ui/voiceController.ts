/**
 * Runs the voice machine's effects against the real world: the daemon socket,
 * WebRTC, the audio session and timers. A plain object rather than a hook so
 * its lifetime is explicit; `useVoice.ts` wraps it for React.
 *
 * All decisions are in `../voice/*`; this file only wires them. UNTESTED ON DEVICE.
 */
import { appendLine, type TranscriptLine } from "../voice/transcript";
import { createRealtimeSession, voiceOpenMessage, type RealtimeSession } from "../voice/realtime";
import {
  initialState,
  step,
  type Effect,
  type Focus,
  type MachineEvent,
  type MachineState,
} from "../voice/voiceMachine";
import { emptyStore, finishedTaskIds, reduce, type StoreAction, type VoiceStore } from "../voice/voiceStore";
import { activateAudioSession, deactivateAudioSession } from "./audioSession";
import { LOST_CONNECTION_LINE, onNetworkLost, onNetworkRestored } from "../voice/connectivity";
import { offerLiveEvent } from "./voiceAlerts";
import { liveUpdateNote, shouldAnnounce } from "../voice/liveUpdates";
import { connectRealtime, type RealtimeTransport } from "./realtimeTransport";
import {
  arrivalNote,
  readHeld,
  screenshotCards,
  sentNote,
  type HeldScreenshot,
  type ScreenshotCard,
  type Upload,
} from "../voice/screenshots";
import type { PendingAttachment } from "../attachments";

export interface VoiceView {
  machine: MachineState;
  store: VoiceStore;
  transcript: TranscriptLine[];
  /** Screenshots shared with voice, newest first. */
  screenshots: ScreenshotCard[];
  /** Bumped each time the model asks for a screenshot; the sheet opens the picker. */
  pickerRequests: number;
}

/** Not a voice session: tool calls the sheet makes on the user's behalf. */
const SHEET_SESSION = "sheet";

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

/** A `voice.dismiss`, as the sheet or the dashboard asks for it. */
export interface DismissRequest {
  taskIds: string[];
  projectIds?: string[];
  allFinished?: boolean;
}

const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((v) => typeof v === "string") ? value : undefined;

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
  /** The system call screen's mute, re-applied to each new Realtime leg. */
  let muted = false;
  /** Live news for this Realtime leg: what the opening snapshot covered, and what was since told. */
  let announceSince = 0;
  let announced = new Set<number>();
  /** Screenshots: uploads in flight, what the computer holds, and which phone file became which. */
  let uploads: Upload[] = [];
  let held: HeldScreenshot[] = [];
  let localUris: Record<string, { localUri?: string; key: string }> = {};
  let pickerRequests = 0;
  /** Dismissals made while the computer was unreachable, sent once it answers again. */
  let pendingDismissals: DismissRequest[] = [];
  /** Sheet sends waiting on their answer: callId -> what was sent where. */
  const sheetSends = new Map<string, { attachmentId: string; taskId: string }>();

  const view = (): VoiceView => ({
    machine,
    store,
    transcript,
    screenshots: screenshotCards(uploads, held, localUris, store.tasks),
    pickerRequests,
  });
  const publish = () => deps.onChange(view());

  /** Tell a live conversation something; nothing to do when there is none. */
  const tellModel = (note: string) => realtime?.notify(note);

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
        const ok = deps.send(voiceOpenMessage(effect.voiceSessionId, effect.focus));
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
      if (muted) rt.setMuted(true);
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
        onSpeechDetected: () => dispatch({ type: "speechDetected" }),
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
    view,

    /**
     * Upload a picked screenshot. The card shows at once; the daemon's answer
     * turns it into a held screenshot, or a reason it was refused.
     */
    attachScreenshot(file: PendingAttachment): void {
      const requestId = `shot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const sent = deps.send({ t: "voice.attach", requestId, name: file.name, mimeType: file.mimeType, data: file.data });
      uploads = [
        {
          requestId,
          name: file.name,
          ...(file.localUri ? { localUri: file.localUri } : null),
          status: sent ? "uploading" : "failed",
          ...(sent ? null : { error: "Your computer is not reachable right now. Try again when it is." }),
          at: Date.now(),
        },
        ...uploads,
      ];
      publish();
    },
    /** A picker that could not open or read the file, shown as a refused card. */
    screenshotFailed(name: string, error: string): void {
      uploads = [{ requestId: `failed-${Date.now().toString(36)}`, name, status: "failed", error, at: Date.now() }, ...uploads];
      publish();
    },
    /** Remove a card: a refused upload here, or a held screenshot on the computer too. */
    removeScreenshot(card: Pick<ScreenshotCard, "key" | "attachmentId">): void {
      uploads = uploads.filter((u) => u.requestId !== card.key);
      if (card.attachmentId) {
        deps.send({ t: "voice.detach", attachmentId: card.attachmentId });
        held = held.filter((h) => h.attachmentId !== card.attachmentId);
      }
      publish();
    },
    /**
     * Send a held screenshot to a task from the sheet, through the same tool
     * the model uses — so the checks, the journal and the task's history are
     * identical whichever of them did it.
     */
    sendScreenshot(attachmentId: string, taskId: string): void {
      const callId = `sheet-${attachmentId}-${taskId}-${Date.now().toString(36)}`;
      const ok = deps.send({
        t: "voice.tool",
        voiceSessionId: SHEET_SESSION,
        callId,
        name: "attach_screenshot",
        args: { attachmentId, taskId, instruction: "Here is a screenshot the user forwarded, likely a fix from a partner. Look at it and apply it to this task." },
      });
      if (!ok) return;
      sheetSends.set(callId, { attachmentId, taskId });
    },

    /**
     * Clear finished tasks off the screen, and off every other one. Shown gone
     * at once; the daemon persists it and tells every client. Unreachable, it
     * waits and goes with the next catch-up, so a tap is never lost.
     */
    dismiss(request: DismissRequest): void {
      if (!store.canDismiss) return;
      const taskIds = request.allFinished ? [...new Set([...request.taskIds, ...finishedTaskIds(store)])].sort() : request.taskIds;
      const message = { ...request, t: "voice.dismiss", taskIds };
      // Later, only what was on screen: "all" or a whole project then could
      // take something that finished since, which nobody has read.
      if (!deps.send(message)) pendingDismissals = [...pendingDismissals, { taskIds }];
      fold({ type: "dismissed", taskIds });
    },

    start(focus: Focus): void {
      transcript = [];
      muted = false;
      dispatch({ type: "activate", voiceSessionId: newId(), focus });
    },
    end(): void {
      dispatch({ type: "userEnd" });
    },
    /** Mute from the native call screen. Kept across reconnects; a new conversation starts unmuted. */
    setMuted(next: boolean): void {
      muted = next;
      transport?.setMuted(next);
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
      uploads = [];
      held = [];
      localUris = {};
      pendingDismissals = [];
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
        case "voice.tool.result": {
          const fromSheet = typeof message.callId === "string" ? sheetSends.get(message.callId) : undefined;
          if (message.voiceSessionId === SHEET_SESSION && fromSheet) {
            sheetSends.delete(message.callId);
            const shot = held.find((h) => h.attachmentId === fromSheet.attachmentId);
            const task = store.tasks[fromSheet.taskId];
            if (message.ok && shot && task) tellModel(sentNote(shot, task));
            if (!message.ok && shot) {
              uploads = [{ requestId: `send-${message.callId}`, name: shot.name, status: "failed", error: typeof message.error === "string" ? message.error : "It could not be sent.", at: Date.now() }, ...uploads];
              publish();
            }
            return;
          }
          if (message.voiceSessionId !== machine.voiceSessionId) return;
          if (message.openPicker === true) {
            pickerRequests++;
            publish();
          }
          fold({ type: "toolResult", output: message.output });
          realtime?.submitResult({
            callId: message.callId,
            ok: message.ok,
            output: message.output,
            error: message.error,
            endSession: message.endSession,
          });
          return;
        }
        case "voice.attached": {
          const upload = uploads.find((u) => u.requestId === message.requestId);
          if (!upload) return;
          const attachment = message.attachment as HeldScreenshot | undefined;
          if (message.ok === true && attachment && typeof attachment.attachmentId === "string") {
            uploads = uploads.filter((u) => u.requestId !== message.requestId);
            localUris = { ...localUris, [attachment.attachmentId]: { localUri: upload.localUri, key: upload.requestId } };
            if (!held.some((h) => h.attachmentId === attachment.attachmentId)) held = [...held, ...(readHeld([attachment]) ?? [])];
            // The user is in a conversation: the model hears it arrived and asks where it goes.
            tellModel(arrivalNote(attachment));
          } else {
            uploads = uploads.map((u) =>
              u.requestId === message.requestId
                ? { ...u, status: "failed", error: typeof message.error === "string" ? message.error : "Your computer refused that picture." }
                : u,
            );
          }
          publish();
          return;
        }
        case "voice.attachments": {
          const list = readHeld(message.attachments);
          if (!list) return;
          held = list;
          publish();
          return;
        }
        case "voice.event":
          // A live conversation hears it from the model; nothing else would tell it.
          if (realtime && message.event && shouldAnnounce(message.event, { since: announceSince, sent: announced })) {
            announced.add(message.event.eventId);
            realtime.notify(liveUpdateNote(message.event, message.task));
          }
          offerLiveEvent(message.event);
          fold({ type: "event", event: message.event, task: message.task });
          return;
        case "voice.state": {
          // Absent from an older daemon, which holds none: leave what is shown alone.
          const list = readHeld(message.attachments);
          if (list) held = list;
          fold({ type: "state", snapshot: message.snapshot, events: message.events ?? [], dismissed: stringList(message.dismissed) });
          // Taps made offline: the snapshot just brought those tasks back.
          if (pendingDismissals.length > 0 && store.canDismiss) {
            const waiting = pendingDismissals;
            pendingDismissals = waiting.filter((request) => !deps.send({ ...request, t: "voice.dismiss" }));
            fold({ type: "dismissed", taskIds: waiting.flatMap((request) => request.taskIds) });
          }
          return;
        }
        case "voice.dismissed": {
          const taskIds = stringList(message.taskIds);
          if (taskIds) fold({ type: "dismissed", taskIds });
          return;
        }
        case "error":
          if (message.code === "unknown_message" && machine.phase === "opening") dispatch({ type: "oldDaemon" });
          // An older daemon has no `voice.attach`, and its refusal names no
          // request: without this every upload would spin for ever.
          if (message.code === "unknown_message" && uploads.some((u) => u.status === "uploading")) {
            uploads = uploads.map((u) =>
              u.status === "uploading" ? { ...u, status: "failed", error: "Your computer's pew2 is too old for screenshots. Update it, then try again." } : u,
            );
            publish();
          }
          return;
        default:
          return;
      }
    },
  };
}

export type VoiceController = ReturnType<typeof createVoiceController>;
