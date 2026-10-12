import { describe, expect, test } from "bun:test";
import {
  createRealtimeSession,
  outputText,
  parseArguments,
  type RealtimeHandlers,
  type ToolCall,
} from "./realtime";

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

describe("turns", () => {
  test("reports speech boundaries", () => {
    const { receive, log } = setup();
    receive({ type: "input_audio_buffer.speech_started" });
    receive({ type: "output_audio_buffer.started" });
    receive({ type: "output_audio_buffer.stopped" });
    expect(log).toEqual(["user", "speaking", "done"]);
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

test("parseArguments / outputText", () => {
  expect(parseArguments('{"a":1}')).toEqual({ args: { a: 1 }, valid: true });
  expect(parseArguments("")).toEqual({ args: {}, valid: true });
  expect(parseArguments("[1]").valid).toBe(false);
  expect(outputText({ callId: "x", ok: true, output: undefined })).toBe("null");
});
