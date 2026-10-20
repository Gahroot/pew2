import { expect, test } from "bun:test";
import type { wire } from "@pew2/protocol";
import { runVoiceTool, spokenQuestions, type VoicePort, withoutCallback } from "./tools.js";

const question: wire.VoiceInboxItem = {
  id: "s1:question:r1",
  sessionId: "s1",
  kind: "question",
  requestId: "r1",
  folder: "pew2",
  title: "Which provider?",
  since: 0,
};

function port(overrides: Partial<VoicePort> = {}): VoicePort {
  return {
    items: () => [question],
    permissionOptions: () => undefined,
    answerPermission: () => false,
    answerAsk: () => true,
    decidePlan: () => {},
    tellAgent: () => ({ ok: true }),
    statuses: () => [],
    callMeBack: () => {},
    ...overrides,
  };
}

test("list_waiting carries a question's ids and options so the model can answer it", () => {
  const result = JSON.parse(
    runVoiceTool(
      "list_waiting",
      "{}",
      port({
        askQuestions: () => [
          {
            id: "q1",
            question: "Which provider?",
            kind: "choice",
            options: [{ label: "OpenAI", value: "openai", recommended: true }, { label: "Gemini" }],
          },
        ],
      }),
    ).output,
  );
  expect(result.items[0].questions).toEqual([
    {
      id: "q1",
      question: "Which provider?",
      kind: "choice",
      options: [
        { label: "OpenAI", value: "openai", recommended: true },
        { label: "Gemini", value: "Gemini" },
      ],
    },
  ]);
});

test("a port without askQuestions still lists the item", () => {
  const result = JSON.parse(runVoiceTool("list_waiting", "{}", port()).output);
  expect(result.items).toHaveLength(1);
  expect(result.items[0].questions).toBeUndefined();
});

test("malformed questions are dropped, not passed to the model", () => {
  expect(spokenQuestions([{ nope: true }, "x"] as unknown[])).toBeUndefined();
  expect(spokenQuestions(undefined)).toBeUndefined();
});

test("a session can be named by folder or agent, not just by id", async () => {
  const { resolveSession } = await import("./tools.js");
  const statuses = [
    { sessionId: "echo-1", folder: "pew2-voice", agentName: "Echo (test)", working: false, lastLines: [] },
    { sessionId: "gg-2", folder: "docs", agentName: "GG Coder", working: true, lastLines: [] },
    { sessionId: "gg-3", folder: "billing-api", agentName: "GG Coder", working: false, lastLines: [] },
  ];
  expect(resolveSession("gg-2", statuses)).toBe("gg-2");
  expect(resolveSession("the echo session", statuses)).toBe("echo-1");
  expect(resolveSession("docs", statuses)).toBe("gg-2");
  expect(resolveSession("Billing API", statuses)).toBe("gg-3");
  // Two GG Coder sessions: ambiguous, so no guess.
  expect(resolveSession("GG Coder", statuses)).toBeUndefined();
  expect(resolveSession("nothing like it", statuses)).toBeUndefined();
});

test("tell_agent finds the session the user named", () => {
  let sentTo = "";
  const result = JSON.parse(
    runVoiceTool("tell_agent", JSON.stringify({ session_id: "echo", text: "say hello" }), port({
      statuses: () => [{ sessionId: "echo-1", folder: "pew2-voice", agentName: "Echo (test)", working: false, lastLines: [] }],
      tellAgent: (id) => {
        sentTo = id;
        return { ok: true };
      },
    })).output,
  );
  expect(result.ok).toBe(true);
  expect(sentTo).toBe("echo-1");
});

test("set_ring arms a session by folder, and says when ringing is switched off", () => {
  const calls: [string, boolean][] = [];
  const statuses = () => [{ sessionId: "s9", folder: "billing-api", working: false, lastLines: [] }];
  const on = (ringing: boolean) =>
    port({
      statuses,
      setRing: (sessionId, value) => {
        calls.push([sessionId, value]);
        return { ringing };
      },
    });
  const armed = JSON.parse(runVoiceTool("set_ring", '{"session_id":"billing-api","on":true}', on(true)).output);
  expect(armed).toMatchObject({ ok: true, on: true, ringing: true });
  expect(calls).toEqual([["s9", true]]);
  const off = JSON.parse(runVoiceTool("set_ring", '{"session_id":"billing-api","on":true}', on(false)).output);
  expect(off.say).toContain("Ring me is off");
  const unknown = JSON.parse(runVoiceTool("set_ring", '{"session_id":"nope","on":true}', on(true)).output);
  expect(unknown.ok).toBe(false);
});

test("a call-me-back is taken out of the agent's message, and nothing else is", () => {
  expect(withoutCallback("Check the DB logs and call me back once it's done.")).toEqual({ text: "Check the DB logs.", asked: true });
  expect(withoutCallback("Check the DB logs. Then when it's done, call me back.")).toEqual({ text: "Check the DB logs.", asked: true });
  expect(withoutCallback("Check the DB logs and notify me when it's done.")).toEqual({ text: "Check the DB logs.", asked: true });
  expect(withoutCallback("Check the DB logs.")).toEqual({ text: "Check the DB logs.", asked: false });
  expect(withoutCallback("Add a phone field and call the API back on failure.").asked).toBe(false);
  expect(withoutCallback("Ring the bell component when the timer ends.").asked).toBe(false);
});
