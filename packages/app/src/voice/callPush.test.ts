import { describe, expect, it } from "bun:test";
import { activationFor, fallbackData, findCallPush, parseCallPush } from "./callPush";

const CALL = {
  type: "voice.call",
  callId: "6F9619FF-8B86-4D11-B42D-00C04FC964FF",
  caller: "pew2 · fix/login: finished",
  eventId: 7,
  taskId: "t1",
  projectId: "p1",
  class: "completed",
} as const;

describe("parseCallPush", () => {
  it("accepts the daemon's payload and lowercases the id the way CallKit reports it", () => {
    expect(parseCallPush(CALL)?.callId).toBe("6f9619ff-8b86-4d11-b42d-00c04fc964ff");
  });

  it("reads Android's string-typed eventId", () => {
    expect(parseCallPush({ ...CALL, eventId: "7", pew2Call: "1" })?.eventId).toBe(7);
  });

  it("refuses what CallKit could not key a call by, and other pushes", () => {
    expect(parseCallPush({ ...CALL, callId: "not-a-uuid" })).toBeUndefined();
    expect(parseCallPush({ ...CALL, type: "voice.callback" })).toBeUndefined();
    expect(parseCallPush({ sessionId: "s1" })).toBeUndefined();
  });
});

describe("findCallPush", () => {
  it("finds the call nested in a notification or inside a JSON string body", () => {
    expect(findCallPush({ notification: { request: { content: { data: CALL } } } })?.taskId).toBe(
      "t1",
    );
    expect(
      findCallPush({ data: { body: JSON.stringify({ ...CALL, pew2Call: "1" }) } })?.eventId,
    ).toBe(7);
  });

  it("gives up rather than recursing for ever, and ignores unrelated strings", () => {
    let deep: unknown = CALL;
    for (let i = 0; i < 8; i++) deep = { inner: deep };
    expect(findCallPush(deep)).toBeUndefined();
    expect(findCallPush("hello")).toBeUndefined();
    expect(findCallPush(null)).toBeUndefined();
  });
});

it("answering opens voice where the banner would, and the fallback banner is an ordinary callback", () => {
  const call = parseCallPush(CALL);
  if (!call) throw new Error("fixture must parse");
  expect(activationFor(call)).toEqual({
    source: "notification",
    focusEventId: 7,
    focusTaskId: "t1",
  });
  expect(fallbackData(call)).toEqual({
    type: "voice.callback",
    eventId: 7,
    taskId: "t1",
    projectId: "p1",
    class: "completed",
  });
});
