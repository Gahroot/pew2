import { expect, test } from "bun:test";
import { actionLine, actionTarget, callbackLines } from "./memory.js";

const T = 1_800_000_000_000;

test("a callback says so first", () => {
  expect(callbackLines(T + 60_000, { askedAt: T })[0]).toContain("THIS CALL: you rang them because 1 min ago they asked you to call them back");
  expect(callbackLines(T)).toEqual([]);
});

test("what Pew did on a call becomes one line, only when it worked", () => {
  const names = (id: string) => ({ s1: "billing-api" })[id];
  const ok = JSON.stringify({ ok: true });
  expect(actionLine("tell_agent", JSON.stringify({ session_id: "s1", text: "run the tests" }), ok, names)).toBe('Sent billing-api: "run the tests"');
  expect(actionLine("answer_permission", JSON.stringify({ item_id: "s1:approval:r1", decision: "allow" }), ok, names)).toBe("Approved billing-api's request");
  expect(actionLine("get_status", "{}", ok, names)).toBeUndefined();
  expect(actionLine("tell_agent", JSON.stringify({ session_id: "s1", text: "x" }), JSON.stringify({ ok: false }), names)).toBeUndefined();
});

test("the session an action touched: session_id, an item's session, or the chat a start opened", () => {
  const ok = JSON.stringify({ ok: true });
  expect(actionTarget("tell_agent", JSON.stringify({ session_id: "docs" }), ok)).toBe("docs");
  expect(actionTarget("answer_permission", JSON.stringify({ item_id: "s9:approval:r1" }), ok)).toBe("s9");
  expect(actionTarget("start_chat", JSON.stringify({ project: "web" }), JSON.stringify({ ok: true, session_id: "live7" }))).toBe("live7");
  expect(actionTarget("call_me_back", "{}", ok)).toBeUndefined();
});
