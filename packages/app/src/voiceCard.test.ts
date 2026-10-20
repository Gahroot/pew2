import { describe, expect, test } from "bun:test";
import { cardFor, reopenable, draftFromAnswers, isCardItem, optionForDecision, tappedAnswerText, tappedApprovalText, voicePick, type CardItem } from "./voiceCard";
import { IDLE_CALL, readInboxItems, stepCall, type CallState, type VoiceInboxItem } from "./voiceCall";
import { buildAskResult } from "./askUser";

const QUESTIONS = [
  {
    id: "v1",
    question: "Keep v1 for a month, or remove it now?",
    kind: "choice" as const,
    options: [
      { label: "Keep for a month", value: "keep", recommended: true },
      { label: "Remove now", value: "remove" },
    ],
  },
];
const OPTIONS = [
  { optionId: "allow", kind: "allow_once", name: "Allow once" },
  { optionId: "always", kind: "allow_always", name: "Always allow" },
  { optionId: "reject", kind: "reject_once", name: "Deny" },
];

const ask: VoiceInboxItem = { id: "bill:question:r1", sessionId: "bill", kind: "question", requestId: "r1", folder: "billing-api", title: QUESTIONS[0]!.question, since: 10, questions: QUESTIONS };
const perm: VoiceInboxItem = { id: "sf:approval:r2", sessionId: "sf", kind: "approval", requestId: "r2", folder: "storefront", title: "prisma migrate deploy", since: 20, options: OPTIONS };
const bare: VoiceInboxItem = { id: "old:approval:r3", sessionId: "old", kind: "approval", requestId: "r3", title: "npm publish", since: 5 };
const plan: VoiceInboxItem = { id: "p:plan:1", sessionId: "p", kind: "plan", requestId: "1", title: "Plan ready for review", since: 1 };

const tool = (name: string, args: Record<string, unknown>) => ({ toolCallId: "t1", name, arguments: JSON.stringify(args), requestId: "q1" });
const call = (extra: Partial<CallState> = {}): CallState => ({ ...IDLE_CALL, phase: "live", activity: "listening", callId: "c1", inbox: [bare, plan, ask, perm], ...extra });

describe("which item gets the card", () => {
  test("only items the daemon sent enough to draw; an older daemon's titles stay voice-only", () => {
    expect(isCardItem(ask)).toBe(true);
    expect(isCardItem(perm)).toBe(true);
    expect(isCardItem(bare)).toBe(false);
    expect(isCardItem(plan)).toBe(false);
  });

  test("oldest drawable first, the focus over that, and Pew's in-flight answer over both", () => {
    expect(cardFor(call(), new Set())?.id).toBe(ask.id);
    expect(cardFor(call({ focus: perm.id }), new Set())?.id).toBe(perm.id);
    const answering = call({ tools: [tool("answer_permission", { item_id: perm.id, decision: "allow" })] });
    expect(cardFor(answering, new Set())?.id).toBe(perm.id);
  });

  test("a card the user put away stays away, but comes back while Pew is answering it", () => {
    expect(cardFor(call(), new Set([ask.id]))?.id).toBe(perm.id);
    expect(cardFor(call(), new Set([ask.id, perm.id]))).toBeUndefined();
    const answering = call({ tools: [tool("answer_question", { item_id: ask.id, answers: { v1: "keep" } })] });
    expect(cardFor(answering, new Set([ask.id]))?.id).toBe(ask.id);
  });
});

describe("Pew's pick on the card", () => {
  test("spoken answers land on the matching option by value or label, else as typed text", () => {
    expect(draftFromAnswers(QUESTIONS, { v1: "keep" }).picks.v1).toEqual(["keep"]);
    expect(draftFromAnswers(QUESTIONS, { v1: "remove NOW" }).picks.v1).toEqual(["remove"]);
    const typed = draftFromAnswers(QUESTIONS, { v1: "keep it two weeks" });
    expect(typed.other.v1).toBe("keep it two weeks");
    expect(buildAskResult(QUESTIONS, typed)).toEqual({ action: "answer", answers: { v1: "keep it two weeks" } });
  });

  test("allow lands on allow-once, never always; deny on reject-once", () => {
    expect(optionForDecision(OPTIONS, "allow")).toBe("allow");
    expect(optionForDecision(OPTIONS, "deny")).toBe("reject");
    expect(optionForDecision(OPTIONS, "maybe")).toBeUndefined();
    // No kinds: falls back to the approval sheet's own rule.
    expect(optionForDecision([{ optionId: "yes", name: "Allow" }, { optionId: "no", name: "Deny" }], "allow")).toBe("yes");
  });

  test("a pick exists only while the matching tool is in flight", () => {
    const item = ask as CardItem;
    expect(voicePick(call(), item)).toBeUndefined();
    const pick = voicePick(call({ tools: [tool("answer_question", { item_id: ask.id, answers: { v1: "keep" } })] }), item);
    expect(pick?.draft?.picks.v1).toEqual(["keep"]);
    const approve = voicePick(call({ tools: [tool("answer_permission", { item_id: perm.id, decision: "allow" })] }), perm as CardItem);
    expect(approve?.optionId).toBe("allow");
  });
});

describe("answering on screen", () => {
  test("Pew is told what was tapped, in words, and that it is already sent", () => {
    const text = tappedAnswerText(ask as CardItem & { kind: "question" }, { action: "answer", answers: { v1: "keep" } });
    expect(text).toContain("Keep for a month");
    expect(text).toContain(ask.id);
    expect(tappedApprovalText(perm as CardItem & { kind: "approval" }, "reject")).toContain('"Deny"');
  });

  test("the answer goes to the daemon, Pew hears it and replies, and it is on the end card", () => {
    const message = { t: "session.ask", sessionId: "bill", requestId: "r1", result: { action: "answer", answers: { v1: "keep" } } };
    const step = stepCall(call(), { type: "answeredOnScreen", itemId: ask.id, message, tell: "told", tool: "answer_question", arguments: { item_id: ask.id } });
    expect(step.effects[0]).toEqual({ kind: "daemon", message });
    expect(step.effects.some((e) => e.kind === "realtime" && e.event.type === "conversation.item.create")).toBe(true);
    expect(step.effects.some((e) => e.kind === "realtime" && e.event.type === "response.create")).toBe(true);
    expect(step.state.answeredHere).toContain(ask.id);
    expect(step.state.completed.at(-1)?.item?.title).toBe(ask.title);
  });

  test("its leaving the inbox afterwards is not reported to Pew as handled elsewhere", () => {
    const told = call({ told: [ask.id, perm.id] });
    const after = stepCall(told, { type: "answeredOnScreen", itemId: ask.id, message: { t: "session.ask" }, tool: "answer_question", arguments: {}, tell: "told" }).state;
    const gone = stepCall({ ...after, responding: false }, { type: "daemon", message: { t: "voice.inbox", items: [perm] } });
    const said = gone.effects.flatMap((e) => (e.kind === "realtime" ? [JSON.stringify(e.event)] : []));
    expect(said.some((text) => text.includes("handled elsewhere"))).toBe(false);
  });

  test("the card's data survives the wire reader, and junk in it is dropped, not fatal", () => {
    const [read] = readInboxItems([{ ...ask, options: [{ optionId: 1 }], detail: 5 }]) ?? [];
    expect(read?.questions?.[0]?.options?.[0]?.value).toBe("keep");
    expect(read && "options" in read).toBe(false);
    expect(read && "detail" in read).toBe(false);
    const [broken] = readInboxItems([{ ...perm, questions: [{ id: "x" }] }]) ?? [];
    expect(broken?.options).toHaveLength(3);
    expect(broken && "questions" in broken).toBe(false);
  });
});

describe("a put-away card comes back from its lane", () => {
  test("only a hidden, drawable item of that session is reopenable", () => {
    expect(reopenable([ask], "bill", new Set([ask.id]))).toBe(ask.id);
    expect(reopenable([ask], "bill", new Set())).toBeUndefined();
    expect(reopenable([ask], "other", new Set([ask.id]))).toBeUndefined();
    const titleOnly: VoiceInboxItem = { ...ask, questions: undefined };
    expect(reopenable([titleOnly], "bill", new Set([ask.id]))).toBeUndefined();
  });
  test("the reopened item takes the card, ahead of the oldest", () => {
    const other: VoiceInboxItem = { ...ask, id: "x:question:r9", sessionId: "x", since: 1 };
    const call = { ...IDLE_CALL, inbox: [other, ask] };
    expect(cardFor(call, new Set())?.id).toBe(other.id);
    expect(cardFor({ ...call, focus: ask.id }, new Set())?.id).toBe(ask.id);
  });
});
