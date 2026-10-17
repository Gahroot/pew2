import { describe, expect, test } from "bun:test";
import {
  RECENT_LIMIT,
  decodeCursor,
  emptyStore,
  encodeCursor,
  orderedTasks,
  pendingApprovals,
  reduce,
  tasksFromOutput,
} from "./voiceStore";
import type { VoiceEvent, VoiceSnapshot, VoiceTask } from "./types";

const task = (id: string, over: Partial<VoiceTask> = {}): VoiceTask => ({
  taskId: id,
  projectId: "p1",
  projectName: "pew2",
  title: `task ${id}`,
  state: "running",
  priority: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const event = (eventId: number, over: Partial<VoiceEvent> = {}): VoiceEvent => ({
  eventId,
  taskId: "t1",
  projectId: "p1",
  projectName: "pew2",
  kind: "task.progress",
  class: "informational",
  text: `e${eventId}`,
  at: eventId,
  ...over,
});
const snapshot = (eventId: number, tasks: VoiceTask[] = [], unheard: VoiceEvent[] = []): VoiceSnapshot => ({
  eventId,
  projects: [],
  tasks,
  unheard,
});

describe("events", () => {
  test("folds in order and advances the cursor", () => {
    let s = reduce(emptyStore, { type: "event", event: event(1), task: task("t1") });
    s = reduce(s, { type: "event", event: event(2), task: task("t1", { activity: "running tests", updatedAt: 2 }) });
    expect(s.cursor).toBe(2);
    expect(s.tasks.t1?.activity).toBe("running tests");
    expect(s.needsSync).toBe(false);
  });
  test("a duplicate or replayed event changes nothing", () => {
    const s = reduce(emptyStore, { type: "event", event: event(5) });
    expect(reduce(s, { type: "event", event: event(5) })).toBe(s);
    expect(reduce(s, { type: "event", event: event(3) })).toBe(s);
  });
  test("a gap asks for a sync", () => {
    let s = reduce(emptyStore, { type: "event", event: event(1) });
    s = reduce(s, { type: "event", event: event(4) });
    expect(s.needsSync).toBe(true);
  });
  test("the first event after a cold start is not a gap", () => {
    expect(reduce(emptyStore, { type: "event", event: event(40) }).needsSync).toBe(false);
  });
  test("an older task never overwrites a newer one", () => {
    let s = reduce(emptyStore, { type: "event", event: event(1), task: task("t1", { updatedAt: 9, title: "new" }) });
    s = reduce(s, { type: "event", event: event(2), task: task("t1", { updatedAt: 3, title: "old" }) });
    expect(s.tasks.t1?.title).toBe("new");
  });
  test("recent is bounded and ordered", () => {
    let s = emptyStore;
    for (let i = 1; i <= RECENT_LIMIT + 5; i++) s = reduce(s, { type: "event", event: event(i) });
    expect(s.recent.length).toBe(RECENT_LIMIT);
    expect(s.recent.at(-1)?.eventId).toBe(RECENT_LIMIT + 5);
  });
});

describe("state", () => {
  test("a snapshot replaces tasks and clears needsSync", () => {
    let s = reduce(emptyStore, { type: "event", event: event(1), task: task("old") });
    s = reduce(s, { type: "event", event: event(9) });
    expect(s.needsSync).toBe(true);
    s = reduce(s, { type: "state", snapshot: snapshot(12, [task("new")]), events: [event(10), event(12)] });
    expect(Object.keys(s.tasks)).toEqual(["new"]);
    expect(s.cursor).toBe(12);
    expect(s.needsSync).toBe(false);
  });
  test("events replayed after the snapshot are then deduped", () => {
    const s = reduce(emptyStore, { type: "state", snapshot: snapshot(5), events: [event(5)] });
    expect(reduce(s, { type: "event", event: event(5) })).toBe(s);
  });
  test("a reset daemon history moves the cursor down", () => {
    let s = reduce(emptyStore, { type: "restore", cursor: 100, heardEventId: 90 });
    s = reduce(s, { type: "state", snapshot: snapshot(3), events: [] });
    expect(s.cursor).toBe(3);
    expect(s.heardEventId).toBe(3);
  });
});

describe("tool results", () => {
  test("shows tasks an output happens to carry, ignores the rest", () => {
    expect(tasksFromOutput({ ok: true })).toEqual([]);
    expect(tasksFromOutput("text")).toEqual([]);
    expect(tasksFromOutput({ task: task("a"), tasks: [task("b"), { nonsense: 1 }] }).map((t) => t.taskId)).toEqual(["a", "b"]);
    const s = reduce(emptyStore, { type: "toolResult", output: { task: task("a") } });
    expect(s.tasks.a).toBeDefined();
    expect(reduce(s, { type: "toolResult", output: { ok: 1 } })).toBe(s);
  });
});

describe("views and persistence", () => {
  test("approvals sort first", () => {
    let s = reduce(emptyStore, { type: "state", snapshot: snapshot(1, [
      task("done", { state: "completed", updatedAt: 9 }),
      task("run", { state: "running" }),
      task("ask", { state: "blocked", approval: { requestId: "r", risk: "shell", summary: "rm" } }),
    ]), events: [] });
    expect(orderedTasks(s).map((t) => t.taskId)).toEqual(["ask", "run", "done"]);
    expect(pendingApprovals(s).map((t) => t.taskId)).toEqual(["ask"]);
    s = reduce(s, { type: "heard", eventId: 4 });
    expect(s.heardEventId).toBe(4);
  });
  test("cursor round-trips and tolerates junk", () => {
    const s = reduce(emptyStore, { type: "restore", cursor: 7, heardEventId: 5 });
    expect(decodeCursor(encodeCursor(s))).toEqual({ cursor: 7, heardEventId: 5 });
    expect(decodeCursor("nope")).toEqual({ cursor: 0, heardEventId: 0 });
    expect(decodeCursor(null)).toEqual({ cursor: 0, heardEventId: 0 });
    expect(decodeCursor('{"cursor":-2,"heardEventId":1.5}')).toEqual({ cursor: 0, heardEventId: 0 });
  });
});

describe("dismissed", () => {
  test("drops finished tasks and their events, never a live one", () => {
    let s = reduce(emptyStore, { type: "event", event: event(1, { taskId: "t1" }), task: task("t1", { state: "completed" }) });
    s = reduce(s, { type: "event", event: event(2, { taskId: "t2" }), task: task("t2") });
    s = reduce(s, { type: "dismissed", taskIds: ["t1", "t2"] });
    expect(Object.keys(s.tasks)).toEqual(["t2"]);
    expect(s.recent.map((e) => e.taskId)).toEqual(["t2"]);
  });
  test("a state names what was dismissed while away, and says the daemon can dismiss", () => {
    let s = reduce(emptyStore, { type: "event", event: event(1, { taskId: "t1" }), task: task("t1", { state: "completed" }) });
    s = reduce(s, { type: "state", snapshot: snapshot(1), events: [] });
    expect(s.canDismiss).toBe(false); // an older daemon says nothing
    expect(s.recent).toHaveLength(1);
    s = reduce(s, { type: "state", snapshot: snapshot(1), events: [], dismissed: ["t1"] });
    expect(s.canDismiss).toBe(true);
    expect(s.recent).toEqual([]);
  });
});
