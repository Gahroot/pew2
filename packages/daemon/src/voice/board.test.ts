import { expect, test } from "bun:test";
import type { wire } from "@pew2/protocol";
import {
  BoardThrottle,
  buildBoard,
  deriveLines,
  mark,
  newMemory,
  type BoardSession,
  type BoardSource,
} from "./board.js";

let seq = 0;
const ev = (at: number, payload: unknown): wire.SessionEvent => ({
  t: "session.event",
  sessionId: "s",
  seq: seq++,
  at,
  payload,
});
const chunk = (at: number, text: string) =>
  ev(at, { sessionId: "a", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
const tool = (at: number, toolCallId: string, title: string) =>
  ev(at, { update: { sessionUpdate: "tool_call", toolCallId, title, status: "pending" } });
const toolUpdate = (at: number, toolCallId: string, status: string) =>
  ev(at, { update: { sessionUpdate: "tool_call_update", toolCallId, status } });

const source = (sessionId: string, extra: Partial<BoardSource> = {}): BoardSource => ({
  sessionId,
  working: false,
  events: [],
  ...extra,
});

test("streamed text keeps one line that updates in place", () => {
  const lines = deriveLines([chunk(1, "Looking at "), chunk(2, "the tests.\nRunning"), chunk(3, " them now.")]);
  expect(lines).toEqual([{ kind: "text", text: "Running them now.", at: 3 }]);
});

test("tool → result, a failed tool, then a fresh text line", () => {
  const lines = deriveLines([
    chunk(1, "On it."),
    tool(2, "t1", "npm test"),
    toolUpdate(3, "t1", "in_progress"),
    toolUpdate(4, "t1", "completed"),
    tool(5, "t2", "git push"),
    toolUpdate(6, "t2", "failed"),
    chunk(7, "Push failed."),
  ]);
  expect(lines.map((line) => [line.kind, line.text])).toEqual([
    ["text", "On it."],
    ["tool", "npm test"],
    ["result", "npm test"],
    ["tool", "git push"],
    ["result", "Failed: git push"],
    ["text", "Push failed."],
  ]);
});

test("permission and ask lines from the logged payloads", () => {
  const lines = deriveLines([
    ev(1, { kind: "permission_request", requestId: "p", params: { toolCall: { title: "rm -rf dist" }, options: [] } }),
    ev(2, { kind: "ask_user", requestId: "q", questions: [{ id: "a", question: "Which db?" }, { id: "b", question: "x" }] }),
  ]);
  expect(lines).toEqual([
    { kind: "perm", text: "rm -rf dist", at: 1 },
    { kind: "ask", text: "Which db?", at: 2 },
  ]);
});

test("lines are single-line, capped, and at most 12; pre-call lines are few", () => {
  const long = deriveLines([chunk(1, `a\nb ${"x".repeat(300)}`)]);
  expect(long[0]?.text.length).toBe(140);
  expect(long[0]?.text.endsWith("…")).toBe(true);
  const events = Array.from({ length: 30 }, (_, i) => tool(i < 10 ? i : 100 + i, `t${i}`, `tool ${i}`));
  const memory = newMemory(100);
  const [lane] = buildBoard([source("s", { events })], memory, 200);
  expect(lane?.lines).toHaveLength(12);
  const quiet = buildBoard([source("q", { events: events.slice(0, 10) })], newMemory(100), 200);
  expect(quiet[0]?.lines.map((l) => l.text)).toEqual(["tool 7", "tool 8", "tool 9"]);
});

test("status and since", () => {
  const memory = newMemory(1_000_000);
  const perms = new Map([["p", {}]]);
  const board = (now: number, sources: BoardSource[]) =>
    Object.fromEntries(buildBoard(sources, memory, now).map((s) => [s.sessionId, [s.status, s.since]]));
  expect(
    board(1_000_000, [
      source("n", { permissions: perms, working: true }),
      source("a", { asks: new Map([["q", []]]) }),
      source("w", { working: true }),
      source("old", { events: [chunk(1, "x")] }),
      source("recent", { events: [chunk(990_000, "x")] }),
    ]),
  ).toEqual({ n: ["needs", 1_000_000], a: ["asks", 1_000_000], w: ["working", 1_000_000], old: ["idle", 1], recent: ["done", 990_000] });
  // The working one finishes during the call; since is when it did.
  expect(board(1_005_000, [source("w", { working: false })]).w).toEqual(["done", 1_005_000]);
  expect(board(1_009_000, [source("w", { working: false })]).w).toEqual(["done", 1_005_000]);
});

test("a pending plan asks", () => {
  const plan = { t: "plan.state", sessionId: "p", planMode: true, pending: { planPath: "x", content: "", generation: 1 } };
  expect(buildBoard([source("p", { plan: plan as wire.PlanState })], newMemory(0), 1)[0]?.status).toBe("asks");
});

test("ranking: touched, then waiting, then working, then done; capped at 8", () => {
  const memory = newMemory(1_000_000);
  mark(memory, "t1", 1_000_100);
  mark(memory, "t2", 1_000_200);
  const sources = [
    source("idle", { events: [chunk(1, "x")] }),
    source("done", { events: [chunk(999_000, "x")] }),
    source("work", { working: true }),
    source("needs", { permissions: new Map([["p", {}]]) }),
    source("t1"),
    source("t2"),
    ...Array.from({ length: 4 }, (_, i) => source(`z${i}`)),
  ];
  const order = buildBoard(sources, memory, 1_000_300).map((s) => s.sessionId);
  expect(order.slice(0, 5)).toEqual(["t2", "t1", "needs", "work", "done"]);
  expect(order).toHaveLength(8);
});

test("Pew's marks land on the lane, interleaved by time", () => {
  const memory = newMemory(100);
  mark(memory, "s", 150, { kind: "pew", text: "run the\ntests" });
  mark(memory, "s", 160);
  const [lane] = buildBoard([source("s", { events: [tool(120, "t", "ls"), toolUpdate(170, "t", "completed")] })], memory, 200);
  expect(lane?.touchedAt).toBe(160);
  expect(lane?.lines).toEqual([
    { kind: "tool", text: "ls", at: 120 },
    { kind: "pew", text: "run the tests", at: 150 },
    { kind: "result", text: "ls", at: 170 },
  ]);
});

test("throttle: at most one per 250ms, and only on change", () => {
  let now = 0;
  let content = "a";
  const sent: string[] = [];
  const timers: { fn: () => void; at: number; cancelled: boolean }[] = [];
  const throttle = new BoardThrottle({
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { fn, at: now + ms, cancelled: false };
      timers.push(timer);
      return { cancel: () => (timer.cancelled = true) };
    },
    build: () => [{ sessionId: content } as BoardSession],
    send: (sessions) => sent.push(sessions[0]?.sessionId ?? ""),
  });
  const advance = (to: number) => {
    now = to;
    for (const timer of timers.splice(0)) {
      if (!timer.cancelled && timer.at <= now) timer.fn();
      else if (!timer.cancelled) timers.push(timer);
    }
  };
  throttle.flushNow();
  expect(sent).toEqual(["a"]);
  content = "b";
  throttle.request();
  throttle.request();
  expect(sent).toEqual(["a"]);
  advance(100);
  content = "c";
  throttle.request();
  advance(249);
  expect(sent).toEqual(["a"]);
  advance(250);
  expect(sent).toEqual(["a", "c"]);
  advance(1000);
  throttle.request();
  expect(sent).toEqual(["a", "c"]);
  content = "d";
  throttle.request();
  expect(sent).toEqual(["a", "c", "d"]);
});
