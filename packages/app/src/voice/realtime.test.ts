import { describe, expect, test } from "bun:test";
import {
  createRealtimeSession,
  outputText,
  parseArguments,
  isRealSpeech,
  voiceOpenMessage,
  type RealtimeHandlers,
  type ToolCall,
} from "./realtime";
import { liveUpdateNote, shouldAnnounce } from "./liveUpdates";
import type { VoiceEvent, VoiceTask } from "./types";

function setup(speakFirst = false) {
  const sent: Record<string, unknown>[] = [];
  const log: string[] = [];
  const calls: ToolCall[] = [];
  const handlers: RealtimeHandlers = {
    onReady: () => log.push("ready"),
    onUserSpeech: () => log.push("user"),
    onModelSpeaking: () => log.push("speaking"),
    onModelDone: () => log.push("done"),
    onToolCall: (call) => calls.push(call),
    onEndSession: () => log.push("end"),
    onError: (message, fatal) => log.push(`error:${fatal}:${message}`),
  };
  const session = { instructions: "be brief", tools: [{ type: "function", name: "anything" }] };
  const rt = createRealtimeSession({
    channel: { send: (m) => (sent.push(m), true) },
    session,
    speakFirst,
    handlers,
  });
  const receive = (m: Record<string, unknown>) => rt.handleMessage(JSON.stringify(m));
  return { rt, sent, log, calls, receive, session };
}
const types = (sent: Record<string, unknown>[]) => sent.map((m) => m.type);

describe("session", () => {
  test("applies the daemon's session config verbatim", () => {
    const { rt, sent, session } = setup();
    rt.start();
    expect(sent).toEqual([{ type: "session.update", session }]);
  });
  test("ready fires once, and the model speaks first only when asked", () => {
    const a = setup();
    a.receive({ type: "session.updated" });
    a.receive({ type: "session.updated" });
    expect(a.log).toEqual(["ready"]);
    expect(a.sent).toEqual([]);
    const b = setup(true);
    b.receive({ type: "session.updated" });
    expect(types(b.sent)).toEqual(["response.create"]);
  });
  test("ignores junk", () => {
    const { rt, log } = setup();
    rt.handleMessage("not json");
    rt.handleMessage("[]");
    rt.handleMessage('{"type":"rate_limits.updated"}');
    expect(log).toEqual([]);
  });
});

describe("voice.open", () => {
  test("announces clientVad, so the daemon may hand turn-taking to this app", () => {
    expect(voiceOpenMessage("v1", { source: "in_app" })).toEqual({
      t: "voice.open",
      voiceSessionId: "v1",
      source: "in_app",
      clientVad: true,
    });
    expect(voiceOpenMessage("v2", { source: "notification", focusEventId: 0, focusTaskId: "t" })).toMatchObject({
      focusEventId: 0,
      focusTaskId: "t",
      clientVad: true,
    });
  });
});

describe("turns", () => {
  test("reports speech boundaries", () => {
    const { receive, log } = setup();
    receive({ type: "input_audio_buffer.speech_started", item_id: "a" });
    receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: "stop" });
    receive({ type: "output_audio_buffer.started" });
    receive({ type: "output_audio_buffer.stopped" });
    expect(log).toEqual(["user", "speaking", "done"]);
  });
  test("a bump during the reply neither interrupts nor answers, and is deleted", () => {
    const { receive, log, sent } = setup();
    receive({ type: "response.created" });
    receive({ type: "output_audio_buffer.started" });
    receive({ type: "input_audio_buffer.speech_started", item_id: "n" });
    receive({ type: "input_audio_buffer.speech_stopped", item_id: "n" });
    receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "n", transcript: "" });
    expect(log).toEqual(["speaking"]);
    expect(sent).toEqual([{ type: "conversation.item.delete", item_id: "n" }]);
  });
  test("real words interrupt the reply once, then the model answers", () => {
    const { receive, log, sent } = setup();
    receive({ type: "response.created" });
    receive({ type: "output_audio_buffer.started" });
    receive({ type: "input_audio_buffer.speech_started", item_id: "s" });
    receive({ type: "conversation.item.input_audio_transcription.delta", item_id: "s", delta: "wait " });
    receive({ type: "conversation.item.input_audio_transcription.delta", item_id: "s", delta: "a second" });
    expect(types(sent)).toEqual(["response.cancel", "output_audio_buffer.clear"]);
    expect(log.filter((l) => l === "user")).toEqual(["user"]);
    receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "s", transcript: "wait a second" });
    expect(types(sent).filter((t) => t === "response.create")).toEqual([]);
    receive({ type: "response.done", response: { status: "cancelled", output: [] } });
    expect(types(sent).at(-1)).toBe("response.create");
  });
  test("a filler or a failed transcript: filler ignored, failure answered", () => {
    const a = setup();
    a.receive({ type: "input_audio_buffer.speech_started", item_id: "f" });
    a.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "f", transcript: "Hmm." });
    expect(a.log).toEqual([]);
    const b = setup();
    b.receive({ type: "input_audio_buffer.speech_started", item_id: "g" });
    b.receive({ type: "conversation.item.input_audio_transcription.failed", item_id: "g" });
    expect(types(b.sent)).toEqual(["response.create"]);
  });
  test("isRealSpeech", () => {
    for (const t of ["yes", "stop it", "Wait, what?", "42"]) expect(isRealSpeech(t)).toBe(true);
    for (const t of ["", "  ", "Hmm.", "uh... um", "[door closing]", "(scratching)", "*bump*", "..."]) {
      expect(isRealSpeech(t)).toBe(false);
    }
  });
  test("a response with audio is done when playback stops, not when generation does", () => {
    const { receive, log } = setup();
    receive({ type: "response.done", response: { output: [{ type: "message", content: [{ type: "output_audio" }] }] } });
    expect(log).toEqual([]);
  });
  test("a response with no audio and no calls is done immediately", () => {
    const { receive, log } = setup();
    receive({ type: "response.done", response: { output: [] } });
    expect(log).toEqual(["done"]);
  });
  test("errors: routine cancel races are silent, fatal ones are flagged", () => {
    const { receive, log } = setup();
    receive({ type: "error", error: { code: "response_cancel_not_active", message: "x" } });
    receive({ type: "error", error: { code: "invalid_api_key", message: "bad secret" } });
    expect(log).toEqual(["error:true:bad secret"]);
  });
});

describe("function calls", () => {
  test("forwards a call verbatim without looking at its name", () => {
    const { receive, calls } = setup();
    receive({
      type: "response.function_call_arguments.done",
      call_id: "c1",
      name: "totally_unknown_tool",
      arguments: '{"project":"pew2","n":2}',
    });
    expect(calls).toEqual([{ callId: "c1", name: "totally_unknown_tool", args: { project: "pew2", n: 2 } }]);
  });
  test("the same call seen again in response.done is not forwarded twice", () => {
    const { receive, calls } = setup();
    receive({ type: "response.function_call_arguments.done", call_id: "c1", name: "t", arguments: "{}" });
    receive({
      type: "response.done",
      response: { output: [{ type: "function_call", call_id: "c1", name: "t", arguments: "{}" }] },
    });
    expect(calls.length).toBe(1);
  });
  test("a call seen only in response.done is still forwarded", () => {
    const { receive, calls } = setup();
    receive({
      type: "response.done",
      response: { output: [{ type: "function_call", call_id: "c9", name: "t", arguments: "" }] },
    });
    expect(calls).toEqual([{ callId: "c9", name: "t", args: {} }]);
  });
  test("a result becomes function_call_output then response.create, after the response ends", () => {
    const { rt, sent, receive } = setup();
    receive({ type: "response.created" });
    receive({ type: "response.function_call_arguments.done", call_id: "c1", name: "t", arguments: "{}" });
    rt.submitResult({ callId: "c1", ok: true, output: { started: true } });
    expect(sent).toEqual([
      {
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: "c1", output: '{"started":true}' },
      },
    ]);
    receive({ type: "response.done", response: { output: [{ type: "function_call", call_id: "c1", name: "t", arguments: "{}" }] } });
    expect(types(sent)).toEqual(["conversation.item.create", "response.create"]);
  });
  test("several calls in one response wait for every answer before continuing", () => {
    const { rt, sent, receive } = setup();
    for (const id of ["a", "b"]) {
      receive({ type: "response.function_call_arguments.done", call_id: id, name: "t", arguments: "{}" });
    }
    receive({ type: "response.done", response: { output: [] } });
    rt.submitResult({ callId: "a", ok: true, output: 1 });
    expect(types(sent)).toEqual(["conversation.item.create"]);
    rt.submitResult({ callId: "b", ok: true, output: 2 });
    expect(types(sent)).toEqual(["conversation.item.create", "conversation.item.create", "response.create"]);
  });
  test("a failed result tells the model, with the error text", () => {
    const { rt, sent, receive } = setup();
    receive({ type: "response.function_call_arguments.done", call_id: "c1", name: "t", arguments: "{}" });
    rt.submitResult({ callId: "c1", ok: false, output: null, error: "no such project" });
    const item = (sent[0] as { item: { output: string } }).item;
    expect(JSON.parse(item.output)).toEqual({ error: "no such project" });
  });
  test("an unknown or repeated result is dropped", () => {
    const { rt, sent, receive } = setup();
    rt.submitResult({ callId: "ghost", ok: true, output: 1 });
    receive({ type: "response.function_call_arguments.done", call_id: "c1", name: "t", arguments: "{}" });
    rt.submitResult({ callId: "c1", ok: true, output: 1 });
    rt.submitResult({ callId: "c1", ok: true, output: 1 });
    expect(types(sent).filter((t) => t === "conversation.item.create").length).toBe(1);
  });
  test("endSession is reported once", () => {
    const { rt, receive, log } = setup();
    receive({ type: "response.function_call_arguments.done", call_id: "c1", name: "t", arguments: "{}" });
    receive({ type: "response.function_call_arguments.done", call_id: "c2", name: "t", arguments: "{}" });
    rt.submitResult({ callId: "c1", ok: true, output: 1, endSession: true });
    rt.submitResult({ callId: "c2", ok: true, output: 1, endSession: true });
    expect(log.filter((l) => l === "end").length).toBe(1);
  });
  test("invalid JSON arguments are answered locally, not sent to the daemon", () => {
    const { sent, receive, calls } = setup();
    receive({ type: "response.function_call_arguments.done", call_id: "c1", name: "t", arguments: "{oops" });
    expect(calls).toEqual([]);
    expect(types(sent)).toEqual(["conversation.item.create", "response.create"]);
  });
});

describe("live notes", () => {
  const live = () => {
    const h = setup();
    h.receive({ type: "session.updated" });
    return h;
  };
  const system = (m: Record<string, unknown>) => (m.item as { role?: string } | undefined)?.role === "system";

  test("a note in a quiet moment goes out at once as a system message plus a response", () => {
    const { rt, sent } = live();
    rt.notify("[Update] billing: finished");
    expect(types(sent)).toEqual(["conversation.item.create", "response.create"]);
    expect(sent[0]).toEqual({
      type: "conversation.item.create",
      item: { type: "message", role: "system", content: [{ type: "input_text", text: "[Update] billing: finished" }] },
    });
  });
  test("never over the user, and not before the server answers what they said", () => {
    const { rt, sent, receive } = live();
    receive({ type: "input_audio_buffer.speech_started" });
    rt.notify("news");
    receive({ type: "input_audio_buffer.speech_stopped" });
    expect(sent).toEqual([]);
    receive({ type: "conversation.item.input_audio_transcription.completed", transcript: "hello there" });
    expect(types(sent)).toEqual(["conversation.item.create", "response.create"]);
    expect(sent.filter(system).length).toBe(1);
  });
  test("waits for the model's audio to stop, and that turn is not reported done", () => {
    const { rt, sent, receive, log } = live();
    receive({ type: "response.created" });
    receive({ type: "output_audio_buffer.started" });
    rt.notify("news");
    receive({ type: "response.done", response: { output: [{ type: "message", content: [{ type: "output_audio" }] }] } });
    expect(sent).toEqual([]);
    receive({ type: "output_audio_buffer.stopped" });
    expect(types(sent)).toEqual(["conversation.item.create", "response.create"]);
    expect(log).not.toContain("done");
  });
  test("waits for open tool calls, then rides the same response as their results", () => {
    const { rt, sent, receive } = live();
    receive({ type: "response.function_call_arguments.done", call_id: "c1", name: "t", arguments: "{}" });
    receive({ type: "response.done", response: { output: [] } });
    rt.notify("a");
    rt.notify("b");
    expect(sent).toEqual([]);
    rt.submitResult({ callId: "c1", ok: true, output: 1 });
    expect(types(sent)).toEqual(["conversation.item.create", "conversation.item.create", "conversation.item.create", "response.create"]);
    expect(sent.filter(system).length).toBe(2);
  });
  test("held until the session is ready, and dropped once the model is ending the call", () => {
    const h = setup();
    h.rt.notify("early");
    expect(h.sent).toEqual([]);
    h.receive({ type: "session.updated" });
    expect(h.sent.filter(system).length).toBe(1);

    const { rt, sent, receive } = live();
    receive({ type: "response.function_call_arguments.done", call_id: "c1", name: "t", arguments: "{}" });
    rt.submitResult({ callId: "c1", ok: true, output: 1, endSession: true });
    rt.notify("late");
    expect(sent.filter(system)).toEqual([]);
  });
});

describe("which events become notes", () => {
  const event = (over: Partial<VoiceEvent> = {}): VoiceEvent => ({
    eventId: 10,
    taskId: "task_1",
    projectId: "p1",
    projectName: "billing",
    kind: "task.completed",
    class: "completed",
    text: "The agent says it finished: added retries.",
    at: 0,
    ...over,
  });
  test("completions, failures and approvals after the snapshot, each once", () => {
    const state = { since: 9, sent: new Set<number>() };
    expect(shouldAnnounce(event(), state)).toBe(true);
    expect(shouldAnnounce(event({ class: "blocked", kind: "task.failed" }), state)).toBe(true);
    expect(shouldAnnounce(event({ class: "approval", kind: "task.approval" }), state)).toBe(true);
    expect(shouldAnnounce(event({ class: "informational", kind: "task.tool" }), state)).toBe(false);
    expect(shouldAnnounce(event({ eventId: 9 }), state)).toBe(false);
    expect(shouldAnnounce(event(), { since: 9, sent: new Set([10]) })).toBe(false);
  });
  test("a completion carries its debrief; an approval is checked before it is asked", () => {
    const debrief = { outcome: "unchecked_edits" as const, edits: 2, commands: 0, checks: "none" as const, nextStep: "Have it run the tests on that?" };
    const note = liveUpdateNote(event(), { debrief } as VoiceTask);
    expect(note).toContain("[Update] billing (taskId task_1)");
    expect(note).toContain('"nextStep":"Have it run the tests on that?"');
    expect(liveUpdateNote(event({ class: "approval", kind: "task.approval" }))).toContain("pending_approvals");
  });
  test("an update on a worktree branch is told as the repository's", () => {
    const note = liveUpdateNote(event({ projectName: "billing (fix/login)", repo: { name: "billing", branch: "fix/login" } }));
    expect(note).toContain("[Update] billing, on the fix/login branch (taskId task_1)");
    expect(note).not.toContain("(fix/login)");
  });
});

test("parseArguments / outputText", () => {
  expect(parseArguments('{"a":1}')).toEqual({ args: { a: 1 }, valid: true });
  expect(parseArguments("")).toEqual({ args: {}, valid: true });
  expect(parseArguments("[1]").valid).toBe(false);
  expect(outputText({ callId: "x", ok: true, output: undefined })).toBe("null");
});
