import { describe, expect, test } from "bun:test";
import {
  CALL_ERRORS,
  IDLE_CALL,
  canTalk,
  diffInbox,
  foldVoiceStatus,
  inboxItemId,
  offerErrorMessage,
  stepCall,
  micOpen,
  LEAD_IN_MS,
  approvalNeedingReadBack,
  newItemText,
  newsText,
  voicePushRequest,
  voiceStatusLine,
  VOICE_UNKNOWN,
  type CallEffect,
  type CallInput,
  type CallState,
  type VoiceInboxItem,
} from "./voiceCall";

const item = (n: number, extra: Partial<VoiceInboxItem> = {}): VoiceInboxItem => ({
  id: `s${n}:approval:r${n}`,
  sessionId: `s${n}`,
  kind: "approval",
  requestId: `r${n}`,
  folder: `repo${n}`,
  title: `Run thing ${n}`,
  since: n,
  ...extra,
});

function run(state: CallState, ...inputs: CallInput[]): { state: CallState; effects: CallEffect[] } {
  const effects: CallEffect[] = [];
  let current = state;
  for (const input of inputs) {
    const step = stepCall(current, input);
    current = step.state;
    effects.push(...step.effects);
  }
  return { state: current, effects };
}

const realtime = (effects: CallEffect[]) =>
  effects.flatMap((e) => (e.kind === "realtime" ? [e.event] : []));
const daemon = (effects: CallEffect[]) =>
  effects.flatMap((e) => (e.kind === "daemon" ? [e.message] : []));

const session = (items = [item(1)]) => ({
  type: "daemon" as const,
  message: { t: "voice.session", requestId: "v1", ok: true, secret: "ek_x", callId: "c1", expiresAt: 9e15, items },
});

function liveCall(items = [item(1)]) {
  return run(IDLE_CALL, { type: "start", requestId: "v1", focus: items[0]?.id }, session(items), { type: "open" });
}

/** A live call where the user has already asked for something: Pew may act. */
function askedCall(items = [item(1)]) {
  return run(
    liveCall(items).state,
    { type: "server", event: { type: "input_audio_buffer.committed", item_id: "u0" } },
    { type: "server", event: { type: "conversation.item.input_audio_transcription.completed", item_id: "u0", transcript: "go ahead" } },
  );
}

const timers = (effects: CallEffect[]) => effects.flatMap((e) => (e.kind === "timer" ? [e.key] : []));
const creates = (effects: CallEffect[]) => realtime(effects).filter((event) => event.type === "response.create").length;
const note = (about: string, reply = "Done.") => ({
  type: "daemon" as const,
  message: { t: "voice.note", callId: "c1", text: `${about} finished its turn. Its reply: ${reply}`, speak: true, about },
});
const gather = { type: "timeout" as const, what: "gather" as const };
const pause = { type: "timeout" as const, what: "pause" as const };
/** A live call after Pew's greeting has finished playing: nothing going on. */
function quietCall(items = [item(1)]): CallState {
  return run(
    liveCall(items).state,
    { type: "server", event: { type: "response.done", response: { output: [] } } },
    { type: "server", event: { type: "output_audio_buffer.started" } },
    { type: "server", event: { type: "output_audio_buffer.stopped" } },
  ).state;
}

describe("connecting", () => {
  test("start asks the daemon for a session, with focus, and arms a timeout", () => {
    const { state, effects } = run(IDLE_CALL, { type: "start", requestId: "v1", focus: "f" });
    expect(state.phase).toBe("connecting");
    expect(daemon(effects)).toEqual([{ t: "voice.session", requestId: "v1", focus: "f" }]);
    expect(effects.some((e) => e.kind === "timer" && e.key === "session")).toBe(true);
  });

  test("a second start during a call is ignored", () => {
    const first = run(IDLE_CALL, { type: "start", requestId: "v1" });
    const again = stepCall(first.state, { type: "start", requestId: "v2" });
    expect(again.state.requestId).toBe("v1");
    expect(again.effects).toEqual([]);
  });

  test("an ok session connects with the secret and shows the briefed items", () => {
    const { state, effects } = run(IDLE_CALL, { type: "start", requestId: "v1" }, session());
    expect(effects).toContainEqual({ kind: "connect", secret: "ek_x", expiresAt: 9e15 });
    expect(state.callId).toBe("c1");
    expect(state.items.map((i) => i.id)).toEqual([item(1).id]);
  });

  test("a session for another request is ignored", () => {
    const { state } = run(IDLE_CALL, { type: "start", requestId: "v1" }, {
      type: "daemon",
      message: { t: "voice.session", requestId: "other", ok: true, secret: "s" },
    });
    expect(state.callId).toBeUndefined();
  });

  test("a refused session fails with the daemon's reason and sends no voice.end", () => {
    const { state, effects } = run(IDLE_CALL, { type: "start", requestId: "v1" }, {
      type: "daemon",
      message: { t: "voice.session", requestId: "v1", ok: false, error: "Sign in to OpenAI to use voice." },
    });
    expect(state.phase).toBe("failed");
    expect(state.error).toBe("Sign in to OpenAI to use voice.");
    expect(daemon(effects).filter((m) => m.t === "voice.end")).toEqual([]);
  });

  test("an older daemon's unknown_message fails plainly", () => {
    const { state } = run(IDLE_CALL, { type: "start", requestId: "v1" }, {
      type: "daemon",
      message: { t: "error", code: "unknown_message", message: "?" },
    });
    expect(state.error).toBe(CALL_ERRORS.oldDaemon);
  });

  test("no answer times out", () => {
    const { state } = run(IDLE_CALL, { type: "start", requestId: "v1" }, { type: "timeout", what: "session" });
    expect(state.phase).toBe("failed");
    expect(state.error).toBe(CALL_ERRORS.noAnswer);
  });

  test("open makes it live and asks Pew to speak first, a greeting with no tools", () => {
    const { state, effects } = liveCall();
    expect(state.phase).toBe("live");
    expect(realtime(effects)).toEqual([{ type: "response.create", response: { tool_choice: "none" } }]);
    expect(state.responding).toBe(true);
  });
});

describe("tools", () => {
  // The approval below was already read back and the user said yes.
  const confirmed = () => {
    const state = askedCall().state;
    return { ...state, readBack: { [item(1).id]: state.userTurns - 1 } };
  };
  const fnDone = { type: "response.function_call_arguments.done", call_id: "fc1", name: "answer_permission", arguments: JSON.stringify({ item_id: item(1).id, decision: "allow" }) };

  test("a function call goes to the daemon once, even when response.done repeats it", () => {
    const { state, effects } = run(
      confirmed(),
      { type: "server", event: fnDone },
      { type: "server", event: { type: "response.done", response: { output: [{ type: "function_call", call_id: "fc1", name: "answer_permission", arguments: "{}" }] } } },
    );
    const tools = daemon(effects).filter((m) => m.t === "voice.tool");
    expect(tools).toEqual([{ t: "voice.tool", requestId: "v1:tool:1", callId: "c1", toolCallId: "fc1", name: "answer_permission", arguments: fnDone.arguments }]);
    expect(state.activity).toBe("working");
  });

  test("a function call only in response.done is still run", () => {
    const { effects } = run(confirmed(), {
      type: "server",
      event: { type: "response.done", response: { output: [{ type: "function_call", call_id: "fc9", name: "list_waiting", arguments: "{}" }] } },
    });
    expect(daemon(effects).map((m) => m.toolCallId)).toEqual(["fc9"]);
  });

  test("the result becomes function_call_output then response.create", () => {
    const started = run(confirmed(), { type: "server", event: { type: "response.done" } }, { type: "server", event: fnDone });
    const { state, effects } = run(started.state, {
      type: "daemon",
      message: { t: "voice.tool", requestId: "v1:tool:1", callId: "c1", toolCallId: "fc1", output: '{"say":"Approved."}' },
    });
    expect(realtime(effects)).toEqual([
      { type: "conversation.item.create", item: { type: "function_call_output", call_id: "fc1", output: '{"say":"Approved."}' } },
      { type: "response.create" },
    ]);
    expect(state.answeredHere).toEqual([item(1).id]);
    expect(state.activity).toBe("listening");
  });

  test("response.create waits for the response in progress", () => {
    // fnDone arrives mid-response; the result lands before response.done.
    const mid = run(confirmed(), { type: "server", event: fnDone }, {
      type: "daemon",
      message: { t: "voice.tool", requestId: "x", callId: "c1", toolCallId: "fc1", output: "{}" },
    });
    expect(realtime(mid.effects).filter((e) => e.type === "response.create")).toEqual([]); // the greeting is still in progress
    expect(mid.state.createQueued).toBe(true);
    const after = stepCall(mid.state, { type: "server", event: { type: "response.done" } });
    expect(realtime(after.effects)).toEqual([{ type: "response.create" }]);
  });

  test("a tool the daemon never answers is reported to the model as failed", () => {
    const started = run(confirmed(), { type: "server", event: { type: "response.done" } }, { type: "server", event: fnDone });
    const { effects } = run(started.state, { type: "timeout", what: "tool", toolCallId: "fc1" });
    const out = realtime(effects)[0] as unknown as { item: { output: string } };
    expect(JSON.parse(out.item.output).error).toBeTruthy();
  });

  test("hangUp waits for the goodbye to finish, then ends with voice.end", () => {
    const started = run(confirmed(), { type: "server", event: { type: "response.done" } }, {
      type: "server",
      event: { type: "response.function_call_arguments.done", call_id: "fc2", name: "end_call", arguments: "{}" },
    });
    const goodbye = run(
      started.state,
      { type: "daemon", message: { t: "voice.tool", requestId: "x", callId: "c1", toolCallId: "fc2", output: "{}", hangUp: true } },
      { type: "server", event: { type: "conversation.item.input_audio_transcription.completed", transcript: " that's all " } },
      { type: "server", event: { type: "response.output_audio_transcript.done", transcript: "Bye!" } },
      { type: "server", event: { type: "response.done" } },
      { type: "server", event: { type: "output_audio_buffer.started" } },
    );
    expect(goodbye.state.phase).toBe("ending");
    expect(goodbye.effects.some((e) => e.kind === "timer" && e.key === "goodbye")).toBe(true);
    const end = stepCall(goodbye.state, { type: "server", event: { type: "output_audio_buffer.stopped" } });
    expect(end.state.phase).toBe("ended");
    expect(end.effects).toContainEqual({ kind: "close" });
    expect(daemon(end.effects)).toContainEqual({
      t: "voice.end",
      callId: "c1",
      reason: "hangup",
      transcript: [{ role: "user", text: "go ahead" }, { role: "user", text: "that's all" }, { role: "assistant", text: "Bye!" }],
    });
  });

  test("the goodbye timer hangs up if audio never reports stopping", () => {
    const pending = { ...liveCall().state, hangUpPending: true, phase: "ending" as const, responding: false };
    expect(stepCall(pending, { type: "timeout", what: "goodbye" }).state.phase).toBe("ended");
  });
});

describe("inbox mid-call", () => {
  test("diffInbox reports added and removed", () => {
    expect(diffInbox(["a", "b"], [item(2, { id: "b" }), item(3, { id: "c" })])).toEqual({
      added: [item(3, { id: "c" })],
      removed: ["a"],
    });
  });

  test("a new item is injected as a system message, without forcing a response", () => {
    const { state, effects } = run(liveCall().state, { type: "daemon", message: { t: "voice.inbox", items: [item(1), item(2)] } });
    const events = realtime(effects);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).toContain("New: repo2 · Run thing 2");
    expect(state.items.map((i) => i.id)).toEqual([item(1).id, item(2).id]);
  });

  test("an item answered elsewhere is ticked off and the model told to skip it", () => {
    const { state, effects } = run(liveCall().state, { type: "daemon", message: { t: "voice.inbox", items: [] } });
    expect(JSON.stringify(realtime(effects))).toContain("was handled elsewhere");
    expect(state.items[0]?.done).toBe(true);
  });

  test("an item this call answered is ticked off silently", () => {
    const answered = { ...liveCall().state, answeredHere: [item(1).id] };
    const { state, effects } = run(answered, { type: "daemon", message: { t: "voice.inbox", items: [] } });
    expect(realtime(effects)).toEqual([]);
    expect(state.items[0]?.done).toBe(true);
  });

  test("changes while connecting are caught up when the call opens", () => {
    const { effects } = run(
      IDLE_CALL,
      { type: "start", requestId: "v1" },
      session([item(1)]),
      { type: "daemon", message: { t: "voice.inbox", items: [item(1), item(2)] } },
      { type: "open" },
    );
    expect(JSON.stringify(realtime(effects))).toContain("New: repo2");
  });
});

describe("ending", () => {
  test("hanging up while live sends voice.end and closes", () => {
    const { state, effects } = run(liveCall().state, { type: "hangup" });
    expect(state.phase).toBe("ended");
    expect(daemon(effects)).toContainEqual({ t: "voice.end", callId: "c1", reason: "hangup" });
  });

  test("a dropped transport fails with the given message", () => {
    const { state, effects } = run(liveCall().state, { type: "failed", error: CALL_ERRORS.dropped });
    expect(state.phase).toBe("failed");
    expect(daemon(effects)).toContainEqual({ t: "voice.end", callId: "c1", reason: "failed" });
  });

  test("reset returns to idle but keeps the inbox", () => {
    const ended = run(liveCall().state, { type: "daemon", message: { t: "voice.inbox", items: [item(4)] } }, { type: "hangup" });
    const { state } = run(ended.state, { type: "reset" });
    expect(state.phase).toBe("idle");
    expect(state.inbox?.map((i) => i.id)).toEqual([item(4).id]);
  });

  test("mute is passed to the transport", () => {
    // Past the connect chime's tail, so the mic is open to be muted.
    const open = run(liveCall().state, { type: "echoTail" }).state;
    const { state, effects } = run(open, { type: "mute", muted: true });
    expect(state.muted).toBe(true);
    expect(effects).toEqual([{ kind: "mute", muted: true }]);
  });

  test("the mic stays closed through the connect chime, then opens", () => {
    const live = liveCall();
    expect(live.state.echoTail).toBe(true);
    expect(live.effects.some((e) => e.kind === "timer" && e.key === "echoTail")).toBe(true);
    const after = run(live.state, { type: "echoTail" });
    expect(after.effects).toContainEqual({ kind: "mute", muted: false });
  });
});

describe("status and entry points", () => {
  test("hidden until the daemon answers available", () => {
    expect(canTalk(VOICE_UNKNOWN)).toBe(false);
    const known = foldVoiceStatus({ kind: "unknown", asked: "q" }, { t: "voice.status", available: true, source: "ggcoder" });
    expect(canTalk(known)).toBe(true);
  });

  test("unknown_message while asking means an older daemon", () => {
    expect(foldVoiceStatus({ kind: "unknown", asked: "q" }, { t: "error", code: "unknown_message", message: "" })).toEqual({ kind: "unsupported" });
    expect(foldVoiceStatus(VOICE_UNKNOWN, { t: "error", code: "unknown_message", message: "" })).toEqual(VOICE_UNKNOWN);
  });

  test("status line names the login it borrows", () => {
    expect(voiceStatusLine({ t: "voice.status", available: true, source: "codex" })).toBe("Using your Codex OpenAI login");
    expect(voiceStatusLine({ t: "voice.status", available: false, canLogin: true })).toBe("Sign in to OpenAI");
  });

  test("push data opens a call only when voice is true", () => {
    expect(voicePushRequest({ voice: true, focus: "x" })).toEqual({ focus: "x" });
    expect(voicePushRequest({ voice: true })).toEqual({});
    expect(voicePushRequest({ sessionId: "s" })).toBeUndefined();
  });

  test("item ids match the daemon's format", () => {
    expect(inboxItemId("s", "question", "r")).toBe("s:question:r");
  });

  test("offer failures read plainly", () => {
    expect(offerErrorMessage(429)).toContain("Try again");
    expect(offerErrorMessage(400)).toContain("400");
  });
});

describe("talk visibility", () => {
  const known = (status: Partial<import("./voiceCall").VoiceStatus>): import("./voiceCall").VoiceKnowledge => ({
    kind: "known",
    status: { t: "voice.status", available: false, ...status } as import("./voiceCall").VoiceStatus,
  });
  test("Talk shows with a login, and one sign-in away; a call starts only with a login", async () => {
    const { canTalk, talkVisible } = await import("./voiceCall");
    expect(talkVisible(known({ available: true, source: "ggcoder" }))).toBe(true);
    expect(canTalk(known({ available: true, source: "ggcoder" }))).toBe(true);
    // A Claude Code-only machine: no login anywhere, but one sign-in fixes it.
    expect(talkVisible(known({ canLogin: true }))).toBe(true);
    expect(canTalk(known({ canLogin: true }))).toBe(false);
    expect(talkVisible(known({ login: { userCode: "ABCD-1234", verificationUrl: "https://auth.openai.com/codex/device" } }))).toBe(true);
    expect(talkVisible(known({}))).toBe(false);
    expect(talkVisible({ kind: "unsupported" })).toBe(false);
    expect(talkVisible({ kind: "unknown" })).toBe(false);
  });
});

describe("echo guard", () => {
  const live = async () => {
    const { IDLE_CALL } = await import("./voiceCall");
    return { ...IDLE_CALL, phase: "live" as const, activity: "listening" as const, callId: "c1" };
  };
  const mutes = (effects: import("./voiceCall").CallEffect[]) => effects.filter((e) => e.kind === "mute");

  test("the mic closes while Pew speaks and reopens only after the tail", async () => {
    const { stepCall, micOpen, ECHO_TAIL_MS } = await import("./voiceCall");
    let step = stepCall(await live(), { type: "server", event: { type: "output_audio_buffer.started" } });
    expect(mutes(step.effects)).toEqual([{ kind: "mute", muted: true }]);
    expect(micOpen(step.state)).toBe(false);
    step = stepCall(step.state, { type: "server", event: { type: "output_audio_buffer.stopped" } });
    // Still closed: the room is still ringing with Pew's last word.
    expect(mutes(step.effects)).toEqual([]);
    expect(step.effects.some((e) => e.kind === "timer" && e.key === "echoTail" && e.ms === ECHO_TAIL_MS)).toBe(true);
    step = stepCall(step.state, { type: "echoTail" });
    expect(mutes(step.effects)).toEqual([{ kind: "mute", muted: false }]);
    expect(micOpen(step.state)).toBe(true);
  });

  test("Pew starting again inside the tail keeps the mic closed (no flicker open)", async () => {
    const { stepCall } = await import("./voiceCall");
    let step = stepCall(await live(), { type: "server", event: { type: "output_audio_buffer.started" } });
    step = stepCall(step.state, { type: "server", event: { type: "output_audio_buffer.stopped" } });
    step = stepCall(step.state, { type: "server", event: { type: "output_audio_buffer.started" } });
    expect(mutes(step.effects)).toEqual([]);
    expect(step.effects.some((e) => e.kind === "cancelTimer" && e.key === "echoTail")).toBe(true);
    // The stale tail timer, had it fired, changes nothing.
    expect(mutes(stepCall(step.state, { type: "echoTail" }).effects)).toEqual([]);
  });

  test("tapping Pew stops the reply, clears what's queued, and listens at once", async () => {
    const { stepCall, micOpen } = await import("./voiceCall");
    let step = stepCall({ ...(await live()), responding: true }, { type: "server", event: { type: "output_audio_buffer.started" } });
    step = stepCall(step.state, { type: "interrupt" });
    const sent = step.effects.flatMap((e) => (e.kind === "realtime" ? [e.event.type] : []));
    expect(sent).toEqual(["response.cancel", "output_audio_buffer.clear"]);
    expect(micOpen(step.state)).toBe(true);
    expect(mutes(step.effects)).toEqual([{ kind: "mute", muted: false }]);
  });

  test("muting stays muted through Pew speaking and stopping", async () => {
    const { stepCall, micOpen } = await import("./voiceCall");
    let step = stepCall(await live(), { type: "mute", muted: true });
    expect(mutes(step.effects)).toEqual([{ kind: "mute", muted: true }]);
    step = stepCall(step.state, { type: "server", event: { type: "output_audio_buffer.started" } });
    step = stepCall(step.state, { type: "server", event: { type: "output_audio_buffer.stopped" } });
    step = stepCall(step.state, { type: "echoTail" });
    expect(micOpen(step.state)).toBe(false);
    expect(mutes(step.effects)).toEqual([]);
  });
});

describe("voice.note: what the daemon tells Pew mid-call", () => {
  test("a finished turn is told to the model at once, but not spoken yet", () => {
    const { state, effects } = run(quietCall(), note("drjones", "Tests pass."));
    const events = realtime(effects);
    expect(events.map((event) => event.type)).toEqual(["conversation.item.create"]);
    expect(JSON.stringify(events[0])).toContain("Tests pass.");
    expect(state.held.finished).toEqual(["drjones"]);
    expect(timers(effects)).toContain("gather");
  });

  test("a quiet note is told but never spoken; another call's note is ignored", () => {
    const quiet = run(liveCall().state, { type: "daemon", message: { t: "voice.note", callId: "c1", text: "app started working." } });
    expect(realtime(quiet.effects).map((event) => event.type)).toEqual(["conversation.item.create"]);
    const other = run(liveCall().state, { type: "daemon", message: { t: "voice.note", callId: "zzz", text: "x", speak: true } });
    expect(realtime(other.effects)).toEqual([]);
  });

  test("the call is started with the open conversation", () => {
    const { effects } = run(IDLE_CALL, { type: "start", requestId: "v9", sessionId: "s1" });
    expect(daemon(effects)[0]).toEqual({ t: "voice.session", requestId: "v9", sessionId: "s1" });
  });

  test("from a new chat with nothing sent, the call carries the project and agent on screen", () => {
    const { effects } = run(IDLE_CALL, { type: "start", requestId: "v9", place: { cwd: "/w/storefront", providerId: "claude" } });
    expect(daemon(effects)[0]).toEqual({ t: "voice.session", requestId: "v9", cwd: "/w/storefront", providerId: "claude" });
  });
});

describe("pacing: news waits for a pause", () => {
  test("finished sessions are gathered and said together, once, after a pause", () => {
    let step = run(quietCall(), note("drjones"), note("billing"));
    expect(creates(step.effects)).toBe(0);
    step = run(step.state, gather);
    expect(timers(step.effects)).toEqual(["pause"]);
    expect(creates(step.effects)).toBe(0);
    step = run(step.state, pause);
    expect(creates(step.effects)).toBe(1);
    const said = JSON.stringify(realtime(step.effects)[0]);
    expect(said).toContain("drjones, billing");
    expect(said).toContain("together");
    expect(step.state.held.finished).toEqual([]);
    // Nothing left to say: a stray pause fires nothing.
    expect(creates(run(step.state, pause).effects)).toBe(0);
  });

  test("something that needs the user is said at the first pause, without the gather wait", () => {
    const step = run(quietCall(), { type: "daemon", message: { t: "voice.inbox", items: [item(1), item(2)] } });
    expect(timers(step.effects)).toEqual(["pause"]);
    const spoken = run(step.state, pause);
    expect(creates(spoken.effects)).toBe(1);
    expect(JSON.stringify(realtime(spoken.effects).at(-2))).toContain("repo2");
  });

  test("an urgent item takes the finished news along with it", () => {
    const step = run(quietCall(), note("drjones"), { type: "daemon", message: { t: "voice.inbox", items: [item(1), item(2)] } }, pause);
    const said = JSON.stringify(realtime(step.effects).at(-2));
    expect(said).toContain("repo2");
    expect(said).toContain("drjones");
    expect(step.state.held).toMatchObject({ urgent: [], finished: [] });
  });

  test("never over the user: speech disarms the wait, the next quiet re-arms it", () => {
    let step = run(quietCall(), { type: "daemon", message: { t: "voice.inbox", items: [item(1), item(2)] } });
    step = run(step.state, { type: "server", event: { type: "input_audio_buffer.speech_started" } });
    expect(step.effects).toContainEqual({ kind: "cancelTimer", key: "pause" });
    expect(creates(run(step.state, pause).effects)).toBe(0);
    step = run(step.state, { type: "server", event: { type: "input_audio_buffer.speech_stopped" } });
    expect(timers(step.effects)).toEqual(["pause"]);
  });

  test("news Pew already said (the user asked) is dropped", () => {
    let step = run(quietCall(), note("drjones"), { type: "server", event: { type: "response.created" } });
    step = run(step.state, {
      type: "server",
      event: { type: "response.output_audio_transcript.done", transcript: "Drjones is done, tests pass.", response_id: "r1" },
    });
    expect(step.state.held.finished).toEqual([]);
  });

  test("an item answered elsewhere before the pause is not brought up", () => {
    let step = run(quietCall(), { type: "daemon", message: { t: "voice.inbox", items: [item(1), item(2)] } });
    step = run(step.state, { type: "daemon", message: { t: "voice.inbox", items: [item(1)] } });
    expect(step.state.held.urgent).toEqual([]);
    expect(creates(run(step.state, pause).effects)).toBe(0);
  });

  test("an older daemon's unnamed note still gets said", () => {
    const old = { type: "daemon" as const, message: { t: "voice.note", callId: "c1", text: "app finished its turn.", speak: true } };
    const step = run(quietCall(), old, gather, pause);
    expect(creates(step.effects)).toBe(1);
    expect(newsText({ urgent: [], finished: [""] })).toContain("Sessions finished.");
  });
});

describe("talking over Pew", () => {
  const speaking = (echoGuard: boolean) =>
    run(
      IDLE_CALL,
      { type: "start", requestId: "v1", echoGuard },
      session(),
      { type: "open" },
      { type: "echoTail" },
      { type: "server", event: { type: "response.created" } },
      { type: "server", event: { type: "output_audio_buffer.started" } },
    ).state;

  test("on a phone (echo cancelled) the mic stays open while Pew talks, after its first moment", () => {
    const state = run(speaking(false), { type: "leadIn" }).state;
    expect(state.pewAudio).toBe(true);
    expect(micOpen(state)).toBe(true);
  });

  test("the user's voice cuts Pew off at once, like a tap", () => {
    const { state, effects } = run(speaking(false), { type: "server", event: { type: "input_audio_buffer.speech_started", item_id: "u1" } });
    expect(realtime(effects).map((event) => event.type)).toEqual(["response.cancel", "output_audio_buffer.clear"]);
    expect(state).toMatchObject({ pewAudio: false, userSpeaking: true, activity: "listening" });
    expect(micOpen(state)).toBe(true);
  });

  test("no echo tail after Pew stops when echo is cancelled", () => {
    const { state, effects } = run(speaking(false), { type: "server", event: { type: "output_audio_buffer.stopped" } });
    expect(state.echoTail).toBe(false);
    expect(effects.some((effect) => effect.kind === "timer" && effect.key === "echoTail")).toBe(false);
  });

  test("with the guard (simulator, older build) the mic closes while Pew talks, as before", () => {
    const state = speaking(true);
    expect(micOpen(state)).toBe(false);
    const heard = run(state, { type: "server", event: { type: "input_audio_buffer.speech_started", item_id: "u1" } });
    expect(realtime(heard.effects)).toEqual([]);
    expect(IDLE_CALL.echoGuard).toBe(true);
  });
});

describe("Pew never acts before the user asks", () => {
  const toolCall = (name: string, args: object, id = "fc1") => ({
    type: "server" as const,
    event: { type: "response.function_call_arguments.done", call_id: id, name, arguments: JSON.stringify(args) },
  });
  const said = { type: "server" as const, event: { type: "input_audio_buffer.committed", item_id: "u1" } };

  test("before a word from the user, an acting tool is refused on the phone and never reaches the computer", () => {
    for (const [name, args] of [
      ["start_chat", { project: "linktree-harmony", text: "Hey GG Coder, what should we do first?" }],
      ["tell_agent", { session_id: "s1", text: "run the tests" }],
      ["answer_question", { item_id: "i1", answers: { first_task: "baseline" } }],
      ["answer_permission", { item_id: "i1", decision: "allow" }],
      ["open_chat", { project: "docs" }],
    ] as const) {
      const { state, effects } = run(liveCall().state, toolCall(name, args));
      expect(daemon(effects).filter((m) => m.t === "voice.tool")).toEqual([]);
      expect(state.tools).toEqual([]);
      expect(JSON.stringify(realtime(effects))).toContain("not_asked");
    }
  });

  test("looking is fine before they speak", () => {
    const { effects } = run(liveCall().state, toolCall("get_status", {}));
    expect(daemon(effects).filter((m) => m.t === "voice.tool")).toHaveLength(1);
  });

  test("once they have spoken, Pew may act", () => {
    // The reply's tool call can come before the words' transcript: the committed audio is what counts.
    const { effects } = run(liveCall().state, said, toolCall("tell_agent", { session_id: "s1", text: "run the tests" }));
    expect(daemon(effects).filter((m) => m.t === "voice.tool")).toHaveLength(1);
  });

});

describe("a reply Pew starts on its own can talk, never act", () => {
  const creates = (effects: CallEffect[]) => realtime(effects).filter((event) => event.type === "response.create");
  test("the greeting is sent with no tools", () => {
    expect(creates(liveCall().effects)).toEqual([{ type: "response.create", response: { tool_choice: "none" } }]);
  });

  test("news at a pause is sent with no tools; the user's next words bring them back", () => {
    let step = run(
      liveCall().state,
      { type: "server", event: { type: "response.done", response: { output: [] } } },
      { type: "daemon", message: { t: "voice.inbox", items: [item(1), item(2)] } },
      { type: "timeout", what: "pause" },
    );
    expect(creates(step.effects)).toEqual([{ type: "response.create", response: { tool_choice: "none" } }]);
    expect(step.state.unprompted).toBe(true);
    step = run(step.state, { type: "server", event: { type: "response.done", response: { output: [] } } }, { type: "server", event: { type: "input_audio_buffer.committed", item_id: "u1" } });
    expect(step.state.unprompted).toBe(false);
  });

  test("an acting tool that slips through an unprompted reply is refused on the phone", () => {
    const asked = run(liveCall().state, { type: "server", event: { type: "input_audio_buffer.committed", item_id: "u1" } }).state;
    const unprompted = { ...asked, unprompted: true, responding: false };
    const { effects } = run(unprompted, {
      type: "server",
      event: { type: "response.function_call_arguments.done", call_id: "x1", name: "answer_question", arguments: JSON.stringify({ item_id: "i", answers: { a: "baseline" } }) },
    });
    expect(daemon(effects).filter((m) => m.t === "voice.tool")).toEqual([]);
  });

  test("a new question carries its options, so Pew can read them out without a tool", () => {
    const question = {
      ...item(3),
      kind: "question" as const,
      title: "What first?",
      questions: [{ id: "first", question: "What first?", kind: "choice" as const, options: [{ label: "Run the checks (recommended)", value: "baseline" }, { label: "A feature", value: "feature" }] }],
    };
    const text = newItemText(question);
    expect(text).toContain(`Question id "first": What first? Option values: "baseline" (Run the checks (recommended)), "feature" (A feature).`);
    expect(text).toContain(`item_id "${question.id}"`);
    expect(text).toContain("wait for their answer");
  });
});

describe("the start of each reply can't cut Pew off", () => {
  const start = () =>
    run(IDLE_CALL, { type: "start", requestId: "v1", echoGuard: false }, session(), { type: "open" }, { type: "echoTail" }, { type: "server", event: { type: "response.created" } }).state;
  test("the mic closes for the first moment of Pew's audio, then opens so the user can talk over it", () => {
    const started = run(start(), { type: "server", event: { type: "output_audio_buffer.started" } });
    expect(micOpen(started.state)).toBe(false);
    expect(started.effects).toContainEqual({ kind: "timer", key: "leadIn", ms: LEAD_IN_MS, input: { type: "leadIn" } });
    const opened = run(started.state, { type: "leadIn" });
    expect(micOpen(opened.state)).toBe(true);
    expect(opened.effects).toContainEqual({ kind: "mute", muted: false });
  });
  test("a reply that ends inside the lead-in leaves the mic open", () => {
    const step = run(start(), { type: "server", event: { type: "output_audio_buffer.started" } }, { type: "server", event: { type: "output_audio_buffer.stopped" } });
    expect(step.state.leadIn).toBe(false);
    expect(micOpen(step.state)).toBe(true);
  });
  test("on the simulator (echo guard) nothing changes: closed for the whole reply", () => {
    const guarded = run(IDLE_CALL, { type: "start", requestId: "v1", echoGuard: true }, session(), { type: "open" }, { type: "echoTail" }, { type: "server", event: { type: "output_audio_buffer.started" } });
    expect(guarded.state.leadIn).toBe(false);
    expect(micOpen(run(guarded.state, { type: "leadIn" }).state)).toBe(false);
  });
});

describe("approving by voice needs a read-back and a yes", () => {
  const approve = (id = "fa") => ({
    type: "server" as const,
    event: { type: "response.function_call_arguments.done", call_id: id, name: "answer_permission", arguments: JSON.stringify({ item_id: item(1).id, decision: "allow" }) },
  });
  const yes = { type: "server" as const, event: { type: "input_audio_buffer.committed", item_id: "u9" } };
  const sent = (effects: CallEffect[]) => daemon(effects).filter((m) => m.t === "voice.tool");

  test("the first approve is refused on the phone, with what to read back", () => {
    const { state, effects } = run(askedCall().state, approve());
    expect(sent(effects)).toEqual([]);
    expect(JSON.stringify(realtime(effects))).toContain("read_back_first");
    expect(JSON.stringify(realtime(effects))).toContain(item(1).title);
    expect(state.readBack[item(1).id]).toBe(state.userTurns);
  });

  test("after the user's next words, the same approve goes through", () => {
    const step = run(askedCall().state, approve("f1"), yes, approve("f2"));
    expect(sent(step.effects)).toHaveLength(1);
  });

  test("a second try with no new words from the user is refused again", () => {
    const step = run(askedCall().state, approve("f1"), approve("f2"));
    expect(sent(step.effects)).toEqual([]);
  });

  test("denying, rejecting and answering need no read-back; accepting a plan does", () => {
    expect(approvalNeedingReadBack("answer_permission", JSON.stringify({ item_id: "i", decision: "deny" }))).toBeUndefined();
    expect(approvalNeedingReadBack("decide_plan", JSON.stringify({ item_id: "i", action: "reject" }))).toBeUndefined();
    expect(approvalNeedingReadBack("answer_question", JSON.stringify({ item_id: "i" }))).toBeUndefined();
    expect(approvalNeedingReadBack("decide_plan", JSON.stringify({ item_id: "i", action: "accept" }))).toBe("i");
  });
});

describe("on the loudspeaker the mic closes while Pew talks", () => {
  const live = () =>
    run(IDLE_CALL, { type: "start", requestId: "v1", echoGuard: false }, session(), { type: "open" }, { type: "echoTail" }).state;
  test("speaker on: no barge-in, Pew's own voice can't be heard as the user", () => {
    let step = run(live(), { type: "route", speaker: true }, { type: "server", event: { type: "output_audio_buffer.started" } }, { type: "leadIn" });
    expect(micOpen(step.state)).toBe(false);
    step = run(step.state, { type: "server", event: { type: "input_audio_buffer.speech_started", item_id: "u1" } });
    expect(realtime(step.effects)).toEqual([]);
  });
  test("switching to the speaker mid-reply closes the mic at once; back to the receiver opens it", () => {
    let step = run(live(), { type: "server", event: { type: "output_audio_buffer.started" } }, { type: "leadIn" });
    expect(micOpen(step.state)).toBe(true);
    step = run(step.state, { type: "route", speaker: true });
    expect(step.effects).toContainEqual({ kind: "mute", muted: true });
    step = run(step.state, { type: "route", speaker: false });
    expect(step.effects).toContainEqual({ kind: "mute", muted: false });
  });
});

describe("a message asking an agent for something that can't be undone is read back first", () => {
  const send = (text: string, id = "s1") => ({
    type: "server" as const,
    event: { type: "response.function_call_arguments.done", call_id: id, name: "tell_agent", arguments: JSON.stringify({ session_id: "billing", text }) },
  });
  const yes = { type: "server" as const, event: { type: "input_audio_buffer.committed", item_id: "u9" } };
  const sent = (effects: CallEffect[]) => daemon(effects).filter((m) => m.t === "voice.tool");

  test("a force push or delete waits for the user's yes; the same words then go", () => {
    const words = "Run git push --force to main and delete the staging database.";
    let step = run(askedCall().state, send(words, "a"));
    expect(sent(step.effects)).toEqual([]);
    expect(JSON.stringify(realtime(step.effects))).toContain("word for word");
    step = run(step.state, yes, send(words, "b"));
    expect(sent(step.effects)).toHaveLength(1);
  });

  test("a different risky message is not covered by an earlier yes", () => {
    const step = run(askedCall().state, send("Delete the logs.", "a"), yes, send("Delete the database.", "b"));
    expect(sent(step.effects)).toEqual([]);
  });

  test("everyday messages go straight through", () => {
    expect(sent(run(askedCall().state, send("Run the tests and fix the failing one.")).effects)).toHaveLength(1);
    expect(approvalNeedingReadBack("tell_agent", JSON.stringify({ text: "Add a delete button to the settings page." }))).toBeDefined();
    expect(approvalNeedingReadBack("tell_agent", JSON.stringify({ text: "Check the DB logs." }))).toBeUndefined();
  });
});
