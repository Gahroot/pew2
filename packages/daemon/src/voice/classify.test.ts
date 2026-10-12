import { expect, test } from "bun:test";
import { classifyKind, coalesce, EventBatcher, unheard } from "./classify.js";
import type { VoiceEvent } from "./types.js";

let id = 0;
function ev(taskId: string, kind: VoiceEvent["kind"]): VoiceEvent {
  return { eventId: ++id, taskId, projectId: "p", projectName: "P", kind, class: classifyKind(kind), text: kind, at: 0 };
}

test("kinds map to classes", () => {
  expect(classifyKind("task.approval")).toBe("approval");
  expect(classifyKind("task.blocked")).toBe("blocked");
  expect(classifyKind("task.failed")).toBe("blocked");
  expect(classifyKind("task.completed")).toBe("completed");
  expect(classifyKind("task.tool")).toBe("informational");
});

test("urgent events go out at once, informational waits and coalesces per task", () => {
  const batcher = new EventBatcher({ informationalMs: 100, completedMs: 20 });
  expect(batcher.add(ev("a", "task.tool"), 0)).toEqual([]);
  expect(batcher.add(ev("a", "task.tool"), 10)).toEqual([]);
  expect(batcher.add(ev("b", "task.tool"), 10)).toEqual([]);
  expect(batcher.pending).toBe(2);
  expect(batcher.due(50)).toEqual([]);
  const due = batcher.due(110);
  expect(due.map((e) => e.taskId)).toEqual(["a", "b"]);
  expect(due[0]?.eventId).toBeLessThan(due[1]!.eventId);
  expect(batcher.pending).toBe(0);
});

test("an approval is immediate and drops the task's held chatter", () => {
  const batcher = new EventBatcher({ informationalMs: 100, completedMs: 20 });
  batcher.add(ev("a", "task.tool"), 0);
  const urgent = ev("a", "task.approval");
  expect(batcher.add(urgent, 5)).toEqual([urgent]);
  expect(batcher.due(1000)).toEqual([]);
});

test("a completion is not replaced by later chatter and is due sooner", () => {
  const batcher = new EventBatcher({ informationalMs: 100, completedMs: 20 });
  const done = ev("a", "task.completed");
  batcher.add(done, 0);
  batcher.add(ev("a", "task.tool"), 5);
  expect(batcher.due(20)).toEqual([done]);
});

test("coalesce and unheard", () => {
  const list = [ev("a", "task.tool"), ev("a", "task.tool"), ev("b", "task.completed"), ev("a", "task.approval")];
  const out = coalesce(list);
  expect(out.map((e) => e.kind)).toEqual(["task.completed", "task.approval"]);
  expect(unheard(list, list[1]!.eventId)).toHaveLength(2);
});
