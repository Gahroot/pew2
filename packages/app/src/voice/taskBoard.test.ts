import { describe, expect, test } from "bun:test";
import { currentLine, formatAge, goalLine, groupTasks, summarize, taskStatus, taskTimeline } from "./taskBoard";
import { emptyStore, type VoiceStore } from "./voiceStore";
import type { VoiceEvent, VoiceTask } from "./types";

const task = (o: Partial<VoiceTask> & { taskId: string }): VoiceTask => ({
  projectId: "p1",
  projectName: "pew2",
  title: "Do it",
  state: "queued",
  priority: 0,
  createdAt: 0,
  updatedAt: 0,
  ...o,
});
const ev = (o: Partial<VoiceEvent> & { eventId: number }): VoiceEvent => ({
  taskId: "t1",
  projectId: "p1",
  projectName: "pew2",
  kind: "task.tool",
  class: "informational",
  text: "editing App.tsx",
  at: 0,
  ...o,
});
const store = (tasks: VoiceTask[], recent: VoiceEvent[] = []): VoiceStore => ({
  ...emptyStore,
  tasks: Object.fromEntries(tasks.map((t) => [t.taskId, t])),
  recent,
});

describe("groupTasks", () => {
  test("orders groups by what needs the user, and drops empty ones", () => {
    const groups = groupTasks(
      store([
        task({ taskId: "done", state: "completed" }),
        task({ taskId: "run", state: "running" }),
        task({ taskId: "ask", state: "blocked", approval: { requestId: "r", risk: "shell", summary: "rm" } }),
        task({ taskId: "q", state: "queued" }),
      ]),
    );
    expect(groups.map((g) => g.key)).toEqual(["attention", "working", "waiting", "finished"]);
    expect(groupTasks(store([task({ taskId: "q" })])).map((g) => g.key)).toEqual(["waiting"]);
    expect(groupTasks(emptyStore)).toEqual([]);
  });
  test("an approval is attention even if the state still says running", () => {
    const [g] = groupTasks(store([task({ taskId: "a", state: "running", approval: { requestId: "r", risk: "edit", summary: "x" } })]));
    expect(g?.key).toBe("attention");
  });
});

describe("summarize", () => {
  test("counts each group and failures separately", () => {
    expect(
      summarize(store([task({ taskId: "a", state: "failed" }), task({ taskId: "b", state: "verified" }), task({ taskId: "c", state: "running" })])),
    ).toEqual({ attention: 0, working: 1, waiting: 0, finished: 2, failed: 1 });
  });
});

describe("formatAge", () => {
  test("scales and clamps skew", () => {
    expect(formatAge(-5000)).toBe("just now");
    expect(formatAge(4_000)).toBe("just now");
    expect(formatAge(45_000)).toBe("45s");
    expect(formatAge(3 * 60_000 + 5)).toBe("3m");
    expect(formatAge(2 * 3_600_000)).toBe("2h");
    expect(formatAge(5 * 86_400_000)).toBe("5d");
  });
});

describe("taskStatus", () => {
  test("completed is the agent's claim; only verified is checked", () => {
    expect(taskStatus(task({ taskId: "a", state: "completed" }), 60_000).label).toBe("Agent says done");
    expect(taskStatus(task({ taskId: "a", state: "verified" }), 60_000).label).toBe("Verified");
  });
  test("running reports its duration from creation", () => {
    expect(taskStatus(task({ taskId: "a", state: "running", createdAt: 0 }), 125_000).timing).toBe("Running for 2m");
  });
  test("an approval outranks the state", () => {
    const s = taskStatus(task({ taskId: "a", state: "running", approval: { requestId: "r", risk: "edit", summary: "x" } }), 0);
    expect(s).toMatchObject({ label: "Needs approval", tone: "danger" });
  });
});

describe("taskTimeline / currentLine", () => {
  const events = [
    ev({ eventId: 1, taskId: "t1", text: "started", kind: "task.started", at: 1000 }),
    ev({ eventId: 2, taskId: "t2", text: "other task" }),
    ev({ eventId: 3, taskId: "t1", text: "running tests", at: 61_000 }),
  ];
  test("only this task's events, newest first, with ages", () => {
    const rows = taskTimeline(store([], events), "t1", 121_000);
    expect(rows.map((r) => r.text)).toEqual(["running tests", "started"]);
    expect(rows[0]?.when).toBe("1m ago");
  });
  test("limit keeps the newest", () => {
    expect(taskTimeline(store([], events), "t1", 0, 1).map((r) => r.text)).toEqual(["running tests"]);
  });
  test("activity wins; otherwise the newest event", () => {
    expect(currentLine(store([], events), task({ taskId: "t1", activity: "linting" }))).toBe("linting");
    expect(currentLine(store([], events), task({ taskId: "t1" }))).toBe("running tests");
    expect(currentLine(store([], events), task({ taskId: "zzz" }))).toBeUndefined();
  });
});

describe("goalLine / goal and question lines", () => {
  test("say wins", () => {
    expect(goalLine({ done: 1, total: 3, say: "The API is finished." })).toBe("The API is finished.");
  });
  test("milestones and verifier", () => {
    expect(goalLine({ done: 2, total: 3, verified: "pass" })).toBe("2 of 3 milestones · verifier passed");
    expect(goalLine({ done: 0, total: 1, verified: "none", active: "Write tests" })).toBe("0 of 1 milestone · Write tests");
  });
  test("success criteria are met together, never shown part-met", () => {
    expect(goalLine({ done: 0, total: 8, unit: "criteria" })).toBe("8 success criteria to meet");
    expect(goalLine({ done: 1, total: 1, unit: "criteria", verified: "pass" })).toBe("1 success criterion met · verifier passed");
  });
  test("no milestones never claims done", () => {
    expect(goalLine({ done: 0, total: 0 })).toBe("Setting up the goal");
    expect(goalLine({ done: 0, total: 0, needsYou: "add the API key" })).toBe("Setting up the goal · needs you: add the API key");
  });
  test("question beats goal beats activity", () => {
    const s = store([], []);
    const goal = { done: 1, total: 2 };
    expect(currentLine(s, task({ taskId: "t1", activity: "x", goal }))).toBe("1 of 2 milestones");
    expect(currentLine(s, task({ taskId: "t1", activity: "x", goal, question: { requestId: "q", text: "Which port?" } }))).toBe(
      "Waiting for your answer: Which port?",
    );
  });
});
