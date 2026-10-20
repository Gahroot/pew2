import { expect, test } from "bun:test";
import { buildInbox, inboxSignature, ringWho } from "./inbox.js";
import { ringCaller, ringTitle, voipRingPayload } from "../push.js";

const permission = {
  toolCall: { title: "prisma migrate deploy (production database, customer-portal-prod)" },
  options: [
    { optionId: "allow", kind: "allow_once", name: "Allow once" },
    { optionId: "always", kind: "allow_always", name: "Always allow" },
    { optionId: "reject", kind: "reject_once", name: "Deny" },
    { optionId: "nameless", kind: "reject_once" },
  ],
};

const questions = [
  {
    id: "v1",
    question: "Keep v1 for a month, or remove it now?",
    kind: "choice",
    options: [{ label: "Keep for a month", value: "keep", recommended: true }, { label: "Remove now", value: "remove" }],
  },
  { id: "broken", kind: "choice" },
];

test("an approval carries its named choices and its whole request for the call screen's card", () => {
  const [item] = buildInbox([{ sessionId: "s1", permissions: new Map([["r1", permission]]) }], new Map(), 1000);
  expect(item?.kind).toBe("approval");
  expect(item?.options).toEqual([
    { optionId: "allow", kind: "allow_once", name: "Allow once" },
    { optionId: "always", kind: "allow_always", name: "Always allow" },
    { optionId: "reject", kind: "reject_once", name: "Deny" },
  ]);
  expect(item?.detail).toBe("prisma migrate deploy (production database, customer-portal-prod)");
});

test("a question carries its well-formed questions; malformed ones are dropped, not sent", () => {
  const [item] = buildInbox([{ sessionId: "s1", asks: new Map([["r2", questions]]) }], new Map(), 1000);
  expect(item?.kind).toBe("question");
  expect(item?.questions).toHaveLength(1);
  expect(item?.questions?.[0]?.options?.[0]).toEqual({ label: "Keep for a month", value: "keep", recommended: true });
});

test("an item with nothing drawable carries no card fields, so an old app sees exactly what it did", () => {
  const [approval, question] = buildInbox(
    [{ sessionId: "s1", permissions: new Map([["r1", {}]]), asks: new Map([["r2", [{ nope: true }]]]) }],
    new Map(),
    1000,
  );
  expect(approval && "options" in approval).toBe(false);
  expect(approval && "detail" in approval).toBe(false);
  expect(question && "questions" in question).toBe(false);
});

test("the card fields don't change the inbox signature (it broadcasts on items, not their contents)", () => {
  const bare = buildInbox([{ sessionId: "s1", permissions: new Map([["r1", {}]]) }], new Map(), 1000);
  const full = buildInbox([{ sessionId: "s1", permissions: new Map([["r1", { options: permission.options }]]) }], new Map(), 1000);
  expect(inboxSignature(full)).toBe(inboxSignature(bare));
});

test("a ring names the project waiting on the lock screen and the banner", () => {
  const at = (folder: string | undefined, since: number, id = folder ?? "x") =>
    ({ id, sessionId: id, kind: "question", requestId: "r", title: "Which db?", since, ...(folder ? { folder } : {}) }) as const;
  expect(ringWho([at("billing", 2)])).toBe("billing");
  expect(ringWho([at("docs", 5), at("billing", 1), at("billing", 3, "b2"), at("web", 9)])).toBe("billing +2");
  expect(ringWho([at(undefined, 1)])).toBeUndefined();
  expect(ringTitle({ who: "billing" })).toBe("billing needs you");
  expect(ringTitle({})).toBe("pew2 needs you");
  expect(ringCaller({ who: "billing +2" })).toBe("Pew · billing +2");
  expect(voipRingPayload({ body: "1 thing waiting", who: "billing" }, "r1").pew.title).toBe("Pew · billing");
  expect(voipRingPayload({ body: "1 thing waiting" }, "r1").pew.title).toBe("Pew");
});
