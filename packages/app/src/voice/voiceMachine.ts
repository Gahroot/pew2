/**
 * The life of one voice conversation, as a pure state machine.
 *
 *   idle -> opening -> connecting -> listening <-> speaking -> closing -> closed
 *                 \         \              \--> reconnecting (bounded) --/
 *                  \-> error  \-> error      \--> interrupted (phone call)
 *
 * `step(state, event)` returns the next state plus *effects* for `ui/useVoice`
 * to carry out. Nothing here touches a socket, timer or audio session, which is
 * what makes interruption, reconnect and auto-end testable.
 *
 * Rules worth knowing:
 *  - Every (re)connection begins with a fresh `voice.open`. Context is rebuilt
 *    by the daemon each time; transcripts are never replayed.
 *  - Reconnects are bounded (`MAX_RECONNECTS`, exponential delay), then a plain
 *    error. The user is never left in a silent retry loop.
 *  - A conversation ends by the user, by the model (`endSession` on a tool
 *    result, which waits for the model to finish speaking), by silence
 *    (`IDLE_TIMEOUT_MS` after the model's last turn), or by the platform
 *    (call, headset removed).
 */
import type { VoiceSource } from "./types";

export const IDLE_TIMEOUT_MS = 20_000;
export const MAX_RECONNECTS = 3;
export const RECONNECT_BASE_MS = 1_000;
/** How long after a call begins we still auto-resume rather than assume the user left. */
export const RESUME_WINDOW_MS = 60_000;
/** An opening that never gets `voice.ready` / connected is abandoned. */
export const OPEN_TIMEOUT_MS = 20_000;

export type Phase =
  | "idle"
  | "opening"
  | "connecting"
  | "listening"
  | "speaking"
  | "reconnecting"
  | "interrupted"
  | "closing"
  | "closed"
  | "error";

export type CloseReason = "user" | "model" | "idle" | "interrupted" | "error" | "app_background";

export interface Focus {
  source: VoiceSource;
  focusEventId?: number;
  focusTaskId?: string;
}

export type ErrorCode = "unavailable" | "old_daemon" | "offline" | "failed" | "mic_denied";

export interface MachineState {
  phase: Phase;
  voiceSessionId?: string;
  focus?: Focus;
  /** Consecutive reconnects spent on this conversation. Reset when audio flows. */
  reconnects: number;
  /** The model said the conversation is over; close once it stops speaking. */
  endAfterSpeech: boolean;
  /** Plain-language message for `error`. */
  message?: string;
  /** Stable code for the UI to branch on when `phase` is `error`. */
  errorCode?: ErrorCode;
  closeReason?: CloseReason;
  /** When an interruption began, to decide whether to resume. */
  interruptedAt?: number;
}

export type Effect =
  | { type: "sendOpen"; voiceSessionId: string; focus: Focus }
  | { type: "connectRealtime" }
  | { type: "teardownRealtime" }
  | { type: "sendClose"; voiceSessionId: string; reason: CloseReason }
  | { type: "audioActivate" }
  | { type: "audioDeactivate" }
  | { type: "startIdleTimer"; ms: number }
  | { type: "cancelIdleTimer" }
  | { type: "startOpenTimer"; ms: number }
  | { type: "cancelOpenTimer" }
  | { type: "scheduleRetry"; ms: number }
  | { type: "cancelRetry" };

export type MachineEvent =
  | { type: "activate"; voiceSessionId: string; focus: Focus }
  | { type: "ready" } // voice.ready arrived
  | { type: "unavailable"; code: string; message: string }
  | { type: "oldDaemon" }
  | { type: "offline" } // the daemon socket is down / could not send
  | { type: "micDenied" }
  | { type: "transportUp" } // Realtime session.updated
  | { type: "transportDown"; reason?: string } // data channel / peer died
  | { type: "networkLost" }
  | { type: "userSpeech" }
  | { type: "speechDetected" } // VAD heard sound start; not yet proven speech
  | { type: "modelSpeaking" }
  | { type: "modelDone" } // model finished speaking (audio actually stopped)
  | { type: "endSession" } // a tool result said endSession
  | { type: "userEnd" }
  | { type: "idleTimeout" }
  | { type: "openTimeout" }
  | { type: "interruptionBegan"; now: number }
  | { type: "interruptionEnded"; shouldResume: boolean; now: number; voiceSessionId: string }
  | { type: "routeLost" } // headset removed
  | { type: "background" }
  | { type: "retryDue"; voiceSessionId: string }
  | { type: "closeDone" }
  | { type: "reset" };

export interface StepResult {
  state: MachineState;
  effects: Effect[];
}

export const initialState: MachineState = { phase: "idle", reconnects: 0, endAfterSpeech: false };

const LIVE: readonly Phase[] = ["connecting", "listening", "speaking"];
const ACTIVE: readonly Phase[] = [
  "opening",
  "connecting",
  "listening",
  "speaking",
  "reconnecting",
  "interrupted",
];

export function isActive(phase: Phase): boolean {
  return ACTIVE.includes(phase);
}

/** Phases where the user can see the orb and an End button. */
export function isOpen(phase: Phase): boolean {
  return isActive(phase) || phase === "closing";
}

export function reconnectDelay(attempt: number): number {
  return RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1);
}

const MESSAGES: Record<ErrorCode, string> = {
  unavailable: "Voice isn't available right now.",
  old_daemon: "Voice needs a newer pew2 on your computer. Update it and try again.",
  offline: "Can't reach your computer. Check that pew2 is running and try again.",
  failed: "The voice connection failed. Try again.",
  mic_denied: "PEW2 needs microphone access to talk. Allow it in Settings.",
};

const STOP_TIMERS: Effect[] = [
  { type: "cancelIdleTimer" },
  { type: "cancelOpenTimer" },
  { type: "cancelRetry" },
];

function fail(state: MachineState, code: ErrorCode, message?: string, notifyDaemon = true): StepResult {
  const effects: Effect[] = [...STOP_TIMERS, { type: "teardownRealtime" }, { type: "audioDeactivate" }];
  if (notifyDaemon && state.voiceSessionId && state.phase !== "opening") {
    effects.push({ type: "sendClose", voiceSessionId: state.voiceSessionId, reason: "error" });
  }
  return {
    state: {
      ...state,
      phase: "error",
      errorCode: code,
      message: message || MESSAGES[code],
      closeReason: "error",
      endAfterSpeech: false,
    },
    effects,
  };
}

function close(state: MachineState, reason: CloseReason): StepResult {
  if (state.phase === "closing" || state.phase === "closed" || state.phase === "idle" || state.phase === "error") {
    return { state, effects: [] };
  }
  const effects: Effect[] = [...STOP_TIMERS, { type: "teardownRealtime" }, { type: "audioDeactivate" }];
  if (state.voiceSessionId) {
    effects.push({ type: "sendClose", voiceSessionId: state.voiceSessionId, reason });
  }
  return {
    state: { ...state, phase: "closing", closeReason: reason, endAfterSpeech: false },
    effects,
  };
}

function reconnect(state: MachineState): StepResult {
  const attempt = state.reconnects + 1;
  if (attempt > MAX_RECONNECTS) {
    return fail(state, "failed", "Lost the voice connection and couldn't get it back. Try again.");
  }
  const effects: Effect[] = [
    { type: "cancelIdleTimer" },
    { type: "cancelOpenTimer" },
    { type: "teardownRealtime" },
  ];
  // The previous daemon-side session is told it is over; the next open is new.
  if (state.voiceSessionId) {
    effects.push({ type: "sendClose", voiceSessionId: state.voiceSessionId, reason: "interrupted" });
  }
  effects.push({ type: "scheduleRetry", ms: reconnectDelay(attempt) });
  return {
    state: { ...state, phase: "reconnecting", reconnects: attempt, endAfterSpeech: false, message: undefined },
    effects,
  };
}

function open(state: MachineState, voiceSessionId: string, focus: Focus): StepResult {
  return {
    state: { ...state, phase: "opening", voiceSessionId, focus, message: undefined, errorCode: undefined },
    effects: [
      { type: "audioActivate" },
      { type: "sendOpen", voiceSessionId, focus },
      { type: "startOpenTimer", ms: OPEN_TIMEOUT_MS },
    ],
  };
}

const NOTHING = (state: MachineState): StepResult => ({ state, effects: [] });

export function step(state: MachineState, event: MachineEvent): StepResult {
  switch (event.type) {
    case "activate":
      // A second activation while one is running is a no-op: a double-tapped
      // Action Button must not open two conversations.
      if (isOpen(state.phase)) return NOTHING(state);
      return open({ ...initialState }, event.voiceSessionId, event.focus);

    case "ready":
      if (state.phase !== "opening") return NOTHING(state);
      return {
        state: { ...state, phase: "connecting" },
        effects: [{ type: "connectRealtime" }, { type: "startOpenTimer", ms: OPEN_TIMEOUT_MS }],
      };

    case "unavailable":
      if (state.phase !== "opening") return NOTHING(state);
      return fail(state, "unavailable", event.message, false);

    case "oldDaemon":
      if (state.phase !== "opening") return NOTHING(state);
      return fail(state, "old_daemon", undefined, false);

    case "offline":
      if (state.phase === "opening" && state.reconnects === 0) return fail(state, "offline", undefined, false);
      if (isActive(state.phase) && state.phase !== "interrupted") return reconnect(state);
      return NOTHING(state);

    case "micDenied":
      return isActive(state.phase) ? fail(state, "mic_denied") : NOTHING(state);

    case "transportUp":
      if (state.phase !== "connecting") return NOTHING(state);
      return {
        // Audio is flowing: the reconnect budget refills.
        state: { ...state, phase: "listening", reconnects: 0 },
        effects: [{ type: "cancelOpenTimer" }],
      };

    case "transportDown":
    case "networkLost":
      if (LIVE.includes(state.phase) || state.phase === "opening") return reconnect(state);
      return NOTHING(state);

    case "userSpeech":
      if (state.phase !== "listening" && state.phase !== "speaking") return NOTHING(state);
      // Talking over the model is a barge-in: the Realtime server truncates the
      // reply, so the phase falls back to listening.
      return { state: { ...state, phase: "listening" }, effects: [{ type: "cancelIdleTimer" }] };

    case "speechDetected":
      // The user may be talking: never close on idle mid-sentence. No phase
      // change and no barge-in until the transcript proves it was speech.
      if (state.phase !== "listening" && state.phase !== "speaking") return NOTHING(state);
      return { state, effects: [{ type: "cancelIdleTimer" }] };

    case "modelSpeaking":
      if (state.phase !== "listening" && state.phase !== "speaking") return NOTHING(state);
      return { state: { ...state, phase: "speaking" }, effects: [{ type: "cancelIdleTimer" }] };

    case "modelDone":
      if (state.phase !== "speaking" && state.phase !== "listening") return NOTHING(state);
      if (state.endAfterSpeech) return close({ ...state, phase: "listening" }, "model");
      return {
        state: { ...state, phase: "listening" },
        effects: [{ type: "startIdleTimer", ms: IDLE_TIMEOUT_MS }],
      };

    case "endSession":
      if (!LIVE.includes(state.phase)) return NOTHING(state);
      // The goodbye is still being spoken (or about to be): wait for it.
      return { state: { ...state, endAfterSpeech: true }, effects: [{ type: "cancelIdleTimer" }] };

    case "userEnd":
      return close(state, "user");

    case "idleTimeout":
      return state.phase === "listening" ? close(state, "idle") : NOTHING(state);

    case "openTimeout":
      if (state.phase === "opening") return fail(state, "offline", undefined, false);
      if (state.phase === "connecting") return reconnect(state);
      return NOTHING(state);

    case "interruptionBegan": {
      if (!isActive(state.phase) || state.phase === "interrupted") return NOTHING(state);
      // Hand the audio hardware over cleanly; the conversation is rebuilt, not paused.
      const effects: Effect[] = [...STOP_TIMERS, { type: "teardownRealtime" }];
      if (state.voiceSessionId) {
        effects.push({ type: "sendClose", voiceSessionId: state.voiceSessionId, reason: "interrupted" });
      }
      return {
        state: { ...state, phase: "interrupted", interruptedAt: event.now, endAfterSpeech: false },
        effects,
      };
    }

    case "interruptionEnded": {
      if (state.phase !== "interrupted") return NOTHING(state);
      const recent = state.interruptedAt !== undefined && event.now - state.interruptedAt <= RESUME_WINDOW_MS;
      if (event.shouldResume && recent) {
        return open(state, event.voiceSessionId, { source: state.focus?.source ?? "in_app" });
      }
      return {
        state: { ...state, phase: "closing", closeReason: "interrupted" },
        effects: [{ type: "audioDeactivate" }],
      };
    }

    case "routeLost":
      return isActive(state.phase) ? close(state, "interrupted") : NOTHING(state);

    case "background":
      // A live conversation survives backgrounding (UIBackgroundModes: audio).
      // One that has not yet got audio flowing cannot be trusted to finish.
      if (state.phase === "opening" || state.phase === "connecting" || state.phase === "reconnecting") {
        return close(state, "app_background");
      }
      return NOTHING(state);

    case "retryDue":
      if (state.phase !== "reconnecting") return NOTHING(state);
      return open(state, event.voiceSessionId, state.focus ?? { source: "in_app" });

    case "closeDone":
      return state.phase === "closing" ? { state: { ...state, phase: "closed" }, effects: [] } : NOTHING(state);

    case "reset":
      return { state: { ...initialState }, effects: [] };
  }
}
