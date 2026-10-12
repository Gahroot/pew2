import { describe, expect, test } from "bun:test";
import {
  IDLE_TIMEOUT_MS,
  MAX_RECONNECTS,
  RESUME_WINDOW_MS,
  initialState,
  reconnectDelay,
  step,
  type Effect,
  type MachineEvent,
  type MachineState,
} from "./voiceMachine";

const focus = { source: "airpods" as const };

function run(events: MachineEvent[], from: MachineState = initialState) {
  let state = from;
  const effects: Effect[] = [];
  for (const event of events) {
    const out = step(state, event);
    state = out.state;
    effects.push(...out.effects);
  }
  return { state, effects };
}
const types = (effects: Effect[]) => effects.map((e) => e.type);
const live: MachineEvent[] = [
  { type: "activate", voiceSessionId: "v1", focus },
  { type: "ready" },
  { type: "transportUp" },
];

describe("happy path", () => {
  test("opens, connects, listens", () => {
    const { state, effects } = run(live);
    expect(state.phase).toBe("listening");
    expect(types(effects)).toEqual([
      "audioActivate",
      "sendOpen",
      "startOpenTimer",
      "connectRealtime",
      "startOpenTimer",
      "cancelOpenTimer",
    ]);
  });
  test("a second activation does nothing", () => {
    const { state } = run(live);
    expect(step(state, { type: "activate", voiceSessionId: "v2", focus })).toEqual({ state, effects: [] });
  });
  test("model speech toggles speaking/listening and arms the idle timer", () => {
    const a = run([{ type: "modelSpeaking" }], run(live).state);
    expect(a.state.phase).toBe("speaking");
    const b = run([{ type: "modelDone" }], a.state);
    expect(b.state.phase).toBe("listening");
    expect(b.effects).toEqual([{ type: "startIdleTimer", ms: IDLE_TIMEOUT_MS }]);
  });
  test("user speech cancels the idle timer and barges in", () => {
    const a = run([{ type: "modelSpeaking" }, { type: "userSpeech" }], run(live).state);
    expect(a.state.phase).toBe("listening");
    expect(types(a.effects)).toContain("cancelIdleTimer");
  });
});

describe("ending", () => {
  test("user end tears down, tells the daemon, restores audio", () => {
    const { state, effects } = run([{ type: "userEnd" }], run(live).state);
    expect(state.phase).toBe("closing");
    expect(effects).toContainEqual({ type: "sendClose", voiceSessionId: "v1", reason: "user" });
    expect(types(effects)).toContain("audioDeactivate");
    expect(run([{ type: "closeDone" }], state).state.phase).toBe("closed");
  });
  test("endSession waits for the model to finish speaking", () => {
    const a = run([{ type: "modelSpeaking" }, { type: "endSession" }], run(live).state);
    expect(a.state.phase).toBe("speaking");
    expect(a.state.endAfterSpeech).toBe(true);
    const b = run([{ type: "modelDone" }], a.state);
    expect(b.state.phase).toBe("closing");
    expect(b.effects).toContainEqual({ type: "sendClose", voiceSessionId: "v1", reason: "model" });
  });
  test("silence after the model's turn ends the conversation", () => {
    const a = run([{ type: "modelSpeaking" }, { type: "modelDone" }, { type: "idleTimeout" }], run(live).state);
    expect(a.state.phase).toBe("closing");
    expect(a.state.closeReason).toBe("idle");
  });
  test("idle timeout is ignored while the model is speaking", () => {
    const a = run([{ type: "modelSpeaking" }, { type: "idleTimeout" }], run(live).state);
    expect(a.state.phase).toBe("speaking");
  });
  test("closing twice is harmless", () => {
    const a = run([{ type: "userEnd" }], run(live).state);
    expect(step(a.state, { type: "userEnd" }).effects).toEqual([]);
  });
});

describe("errors", () => {
  test("unavailable shows the daemon's message", () => {
    const a = run([
      { type: "activate", voiceSessionId: "v1", focus },
      { type: "unavailable", code: "no_api_key", message: "Add an OpenAI key on your computer." },
    ]);
    expect(a.state.phase).toBe("error");
    expect(a.state.message).toBe("Add an OpenAI key on your computer.");
    expect(types(a.effects)).not.toContain("sendClose");
  });
  test("an older daemon gets a plain upgrade message", () => {
    const a = run([{ type: "activate", voiceSessionId: "v1", focus }, { type: "oldDaemon" }]);
    expect(a.state.errorCode).toBe("old_daemon");
    expect(a.state.message).toContain("newer pew2");
  });
  test("offline while opening is an error, not a retry loop", () => {
    const a = run([{ type: "activate", voiceSessionId: "v1", focus }, { type: "offline" }]);
    expect(a.state.errorCode).toBe("offline");
  });
  test("mic denied", () => {
    const a = run([{ type: "micDenied" }], run(live).state);
    expect(a.state.errorCode).toBe("mic_denied");
  });
  test("an open that never completes is abandoned", () => {
    expect(run([{ type: "activate", voiceSessionId: "v1", focus }, { type: "openTimeout" }]).state.phase).toBe("error");
  });
  test("can start again after an error", () => {
    const a = run([{ type: "activate", voiceSessionId: "v1", focus }, { type: "oldDaemon" }]);
    const b = run([{ type: "activate", voiceSessionId: "v2", focus }], a.state);
    expect(b.state.phase).toBe("opening");
    expect(b.state.errorCode).toBeUndefined();
  });
});

describe("reconnect", () => {
  test("network loss reconnects with a fresh open and a new id", () => {
    const a = run([{ type: "networkLost" }], run(live).state);
    expect(a.state.phase).toBe("reconnecting");
    expect(a.effects).toContainEqual({ type: "scheduleRetry", ms: reconnectDelay(1) });
    expect(types(a.effects)).toContain("teardownRealtime");
    const b = run([{ type: "retryDue", voiceSessionId: "v2" }], a.state);
    expect(b.state.phase).toBe("opening");
    expect(b.effects).toContainEqual({ type: "sendOpen", voiceSessionId: "v2", focus });
  });
  test("is bounded, then gives a plain error", () => {
    let state = run(live).state;
    for (let i = 1; i <= MAX_RECONNECTS; i++) {
      state = run([{ type: "transportDown" }], state).state;
      expect(state.phase).toBe("reconnecting");
      state = run([{ type: "retryDue", voiceSessionId: `r${i}` }, { type: "ready" }], state).state;
      expect(state.phase).toBe("connecting");
    }
    const last = run([{ type: "transportDown" }], state);
    expect(last.state.phase).toBe("error");
    expect(last.state.message).toContain("Try again");
  });
  test("the daemon being unreachable during a retry counts against the budget", () => {
    let state = run([{ type: "networkLost" }], run(live).state).state;
    state = run([{ type: "retryDue", voiceSessionId: "v2" }, { type: "offline" }], state).state;
    expect(state.phase).toBe("reconnecting");
    expect(state.reconnects).toBe(2);
  });
  test("budget refills once audio flows", () => {
    const state = run(
      [{ type: "transportDown" }, { type: "retryDue", voiceSessionId: "v2" }, { type: "ready" }, { type: "transportUp" }],
      run(live).state,
    ).state;
    expect(state.reconnects).toBe(0);
    expect(state.phase).toBe("listening");
  });
  test("backoff doubles", () => {
    expect([1, 2, 3].map(reconnectDelay)).toEqual([1000, 2000, 4000]);
  });
  test("transport loss while closing does not reconnect", () => {
    const a = run([{ type: "userEnd" }], run(live).state);
    expect(run([{ type: "transportDown" }], a.state).state.phase).toBe("closing");
  });
});

describe("interruptions", () => {
  test("a phone call tears everything down and tells the daemon", () => {
    const a = run([{ type: "interruptionBegan", now: 1000 }], run(live).state);
    expect(a.state.phase).toBe("interrupted");
    expect(a.effects).toContainEqual({ type: "sendClose", voiceSessionId: "v1", reason: "interrupted" });
  });
  test("a short call resumes with a fresh open", () => {
    const a = run(
      [
        { type: "interruptionBegan", now: 1000 },
        { type: "interruptionEnded", shouldResume: true, now: 2000, voiceSessionId: "v2" },
      ],
      run(live).state,
    );
    expect(a.state.phase).toBe("opening");
    expect(a.state.voiceSessionId).toBe("v2");
  });
  test("a long call, or shouldResume=false, ends instead", () => {
    const base = run([{ type: "interruptionBegan", now: 0 }], run(live).state).state;
    const long = step(base, {
      type: "interruptionEnded",
      shouldResume: true,
      now: RESUME_WINDOW_MS + 1,
      voiceSessionId: "v2",
    });
    expect(long.state.phase).toBe("closing");
    expect(long.effects).toEqual([{ type: "audioDeactivate" }]);
    const no = step(base, { type: "interruptionEnded", shouldResume: false, now: 10, voiceSessionId: "v2" });
    expect(no.state.phase).toBe("closing");
  });
  test("losing the headset ends the conversation", () => {
    expect(run([{ type: "routeLost" }], run(live).state).state.closeReason).toBe("interrupted");
  });
  test("backgrounding mid-connect closes; a live conversation survives", () => {
    const connecting = run([{ type: "activate", voiceSessionId: "v1", focus }, { type: "ready" }]).state;
    expect(run([{ type: "background" }], connecting).state.closeReason).toBe("app_background");
    expect(run([{ type: "background" }], run(live).state).state.phase).toBe("listening");
  });
});
