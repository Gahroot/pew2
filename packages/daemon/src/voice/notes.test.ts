import { expect, test } from "bun:test";
import type { wire } from "@pew2/protocol";
import { sessionName, turnNote } from "./notes.js";
import { currentActivity, lastAgentLines } from "./replies.js";

const chunk = (text: string, seq: number): wire.SessionEvent =>
  ({ seq, at: seq, payload: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } }) as never;
const tool = (title: string, seq: number): wire.SessionEvent =>
  ({ seq, at: seq, payload: { update: { sessionUpdate: "tool_call", toolCallId: `t${seq}`, title } } }) as never;

test("a session is named by its project folder and agent, never as a person", () => {
  expect(sessionName({ folder: "drjones", agentName: "Claude Code" })).toBe("drjones (Claude Code)");
  expect(sessionName({})).toBe("a session");
});

test("a finished turn carries the reply in plain text, and is spoken", () => {
  const note = turnNote({ folder: "drjones", agentName: "Codex", events: [chunk("**All 42 tests pass.** No `lint` errors.", 1)] }, false, false);
  expect(note.speak).toBe(true);
  expect(note.text).toContain("drjones (Codex) finished its turn.");
  expect(note.text).toContain("All 42 tests pass. No lint errors.");
  expect(note.text).not.toContain("**");
});

test("a finished turn that now waits on them is told but not spoken (its item is)", () => {
  const note = turnNote({ folder: "app", events: [] }, false, true);
  expect(note.speak).toBeUndefined();
  expect(note.text).toContain("waiting on them");
});

test("a turn starting is a quiet note", () => {
  expect(turnNote({ folder: "app", events: [] }, true, false)).toEqual({ text: "app started working.", about: "app" });
});

test("what a working agent is doing now: its latest tool or line", () => {
  expect(currentActivity([chunk("Looking around.", 1), tool("Edit src/cart.tsx", 2)])).toBe("Edit src/cart.tsx");
  expect(currentActivity([tool("Read a.ts", 1), chunk("## Plan\nFix the *cart*", 2)])).toBe("Fix the cart");
  expect(currentActivity([])).toBeUndefined();
});

test("last reply lines are plain text", () => {
  expect(lastAgentLines([chunk("- **Fixed** the [bug](http://x)\n- `npm test` green", 1)])).toEqual(["Fixed the bug", "npm test green"]);
});
