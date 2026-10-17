import { expect, test } from "bun:test";
import { join } from "node:path";
import { scratch } from "./scratch.js";
import { VoiceStore, type NewTask } from "./store.js";

const base: NewTask = {
  projectId: "proj_a",
  projectName: "a",
  cwd: "/code/a",
  providerId: "echo",
  title: "do a thing",
  prompt: "do a thing",
};

test("event ids are gapless and monotonic, and survive a restart", async () => {
  const path = join(scratch(), "state.json");
  const first = await VoiceStore.open(path);
  const t = first.createTask(base);
  first.transition(t.taskId, "running", "task.started", "go");
  first.transition(t.taskId, "completed", "task.completed", "done");
  await first.flush();
  expect(first.eventsSince(0).map((e) => e.eventId)).toEqual([1, 2, 3]);

  const second = await VoiceStore.open(path);
  expect(second.lastEventId).toBe(3);
  const next = second.createTask({ ...base, title: "next" });
  expect(next.taskId).not.toBe(t.taskId);
  expect(second.eventsSince(0).map((e) => e.eventId)).toEqual([1, 2, 3, 4]);
  expect(second.getTask(t.taskId)?.state).toBe("completed");
});

test("a corrupt state file starts empty rather than failing", async () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  await Bun.write(path, "{not json");
  const store = await VoiceStore.open(path);
  expect(store.tasks()).toEqual([]);
});

test("heard cursor is monotone and bounded by the last event", async () => {
  const store = VoiceStore.memory();
  store.createTask(base);
  expect(store.markHeard(99)).toBe(1);
  store.createTask(base);
  expect(store.markHeard(1)).toBe(1);
  expect(store.markHeard(2)).toBe(2);
});

test("one writer per project; read-only tasks do not hold the lock", () => {
  const store = VoiceStore.memory();
  const a = store.createTask(base);
  const b = store.createTask(base);
  const reader = store.createTask({ ...base, readOnly: true });
  store.transition(a.taskId, "running", "task.started", "go");
  expect(store.lockHolder("proj_a")?.taskId).toBe(a.taskId);
  expect(store.lockHolder("proj_a", a.taskId)).toBeUndefined();
  expect(store.waitingFor(b)).toContain(a.taskId);
  expect(store.waitingFor(reader)).toBeUndefined();
  store.transition(a.taskId, "completed", "task.completed", "done");
  expect(store.lockHolder("proj_a")).toBeUndefined();
});

test("queue order is priority then age; dependencies gate and break", () => {
  let now = 0;
  const store = VoiceStore.memory(() => ++now);
  const low = store.createTask(base);
  const high = store.createTask({ ...base, priority: 5 });
  const dependent = store.createTask({ ...base, dependsOn: [low.taskId] });
  expect(store.queue().map((t) => t.taskId)).toEqual([high.taskId, low.taskId, dependent.taskId]);
  expect(store.dependenciesMet(dependent)).toBe(false);
  store.transition(low.taskId, "completed", "task.completed", "ok");
  expect(store.dependenciesMet(dependent)).toBe(true);
  const other = store.createTask({ ...base, dependsOn: [high.taskId] });
  store.transition(high.taskId, "failed", "task.failed", "bad");
  expect(store.brokenDependency(other)?.taskId).toBe(high.taskId);
});

test("journal: new, then done returns the stored result, and pending survives a restart", async () => {
  const path = join(scratch(), "state.json");
  const store = await VoiceStore.open(path);
  expect(store.journalBegin("c1", "start_task")).toEqual({ status: "new" });
  expect(store.journalBegin("c1", "start_task")).toEqual({ status: "pending" });
  store.journalFinish("c1", { ok: true });
  expect(store.journalBegin("c1", "start_task")).toEqual({ status: "done", result: { ok: true } });
  store.journalBegin("c2", "cancel_task");
  await store.flush();

  const reopened = await VoiceStore.open(path);
  expect(reopened.journalBegin("c1", "start_task")).toEqual({ status: "done", result: { ok: true } });
  expect(reopened.journalBegin("c2", "cancel_task")).toEqual({ status: "pending" });
});

test("dismiss clears finished tasks only, survives a restart, and new news brings one back", async () => {
  const path = join(scratch(), "state.json");
  const store = await VoiceStore.open(path);
  const done = store.createTask(base);
  store.transition(done.taskId, "completed", "task.completed", "done");
  const live = store.createTask({ ...base, title: "live" });
  store.transition(live.taskId, "running", "task.started", "go");

  const dismissed = store.dismiss(() => true);
  expect(dismissed.map((t) => t.taskId)).toEqual([done.taskId]);
  expect(store.getTask(live.taskId)?.dismissedAt).toBeUndefined();
  expect(store.dismiss(() => true)).toEqual([]); // already dismissed
  await store.flush();

  const reopened = await VoiceStore.open(path);
  expect(reopened.getTask(done.taskId)?.dismissedAt).toBeNumber();
  expect(reopened.dismissedWithEvents()).toEqual([done.taskId]);

  reopened.transition(done.taskId, "verified", "task.verified", "checked");
  expect(reopened.getTask(done.taskId)?.dismissedAt).toBeUndefined();
});
