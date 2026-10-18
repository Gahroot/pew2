import { expect, test } from "bun:test";
import { buildCheckin, type CheckinInput } from "./checkin.js";
import type { VoiceEvent } from "./types.js";

const NOW = Date.parse("2026-10-18T09:00:00Z");

function ev(eventId: number, taskId: string, kind: VoiceEvent["kind"], goal?: VoiceEvent["goal"]): VoiceEvent {
  return {
    eventId,
    taskId,
    projectId: "p",
    projectName: "pew2",
    kind,
    class: "informational",
    text: "x",
    at: NOW,
    ...(goal ? { goal } : null),
  };
}

const base = (extra: Partial<CheckinInput> = {}): CheckinInput => ({
  events: [],
  tasks: [],
  pendingApprovals: 0,
  openQuestions: 0,
  deskNeedsYou: 0,
  now: NOW,
  ...extra,
});

test("the user's example sentence, verbatim", () => {
  const c = buildCheckin(
    base({
      events: [ev(1, "a", "task.completed"), ev(2, "b", "task.completed"), ev(3, "a", "task.verified")],
      pendingApprovals: 1,
      dave: ["Triten"],
    }),
  );
  expect(c.say).toBe(
    "Two agents finished, one is blocked by an approval, and DAVE has a new recommendation for Triten. Want the details?",
  );
  expect(c).toMatchObject({ finished: 2, failed: 0, needsYou: 1, milestones: 0, dave: ["Triten"] });
});

test("nothing meaningful says nothing", () => {
  const c = buildCheckin(base());
  expect(c.say).toBeUndefined();
  expect(c).toEqual({ finished: 0, failed: 0, needsYou: 0, milestones: 0, dave: [] });
});

test("tool and progress chatter is ignored, goal milestones are not", () => {
  const chatter = buildCheckin(
    base({ events: [ev(1, "a", "task.tool"), ev(2, "a", "task.progress"), ev(3, "a", "task.started")] }),
  );
  expect(chatter.say).toBeUndefined();
  const goal = buildCheckin(
    base({
      events: [ev(1, "a", "task.progress", { change: "milestone_done" }), ev(2, "a", "task.tool")],
    }),
  );
  expect(goal.say).toBe("One goal milestone is done. Want the details?");
});

test("heard events are skipped", () => {
  const c = buildCheckin(
    base({ heardEventId: 2, events: [ev(1, "a", "task.completed"), ev(2, "b", "task.failed")] }),
  );
  expect(c.say).toBeUndefined();
  const later = buildCheckin(
    base({ heardEventId: 1, events: [ev(1, "a", "task.completed"), ev(2, "b", "task.failed")] }),
  );
  expect(later.say).toBe("One agent failed. Want the details?");
});

test("pluralisation and fixed order", () => {
  const c = buildCheckin(
    base({
      events: [
        ev(1, "a", "task.completed"),
        ev(2, "b", "task.failed"),
        ev(3, "c", "task.failed"),
        ev(4, "g", "task.progress", { change: "milestone_done" }),
        ev(5, "g", "task.progress", { change: "milestone_done" }),
        ev(6, "h", "task.completed", { change: "passed" }),
      ],
      tasks: [{ taskId: "g", state: "running", goal: { objective: "o", requestedAt: 0, continues: 0, progress: { done: 1, total: 3, needsYou: "Add a key" } } }],
      pendingApprovals: 2,
      openQuestions: 1,
      deskNeedsYou: 3,
      dave: ["Acme", "Triten"],
    }),
  );
  expect(c.say).toBe(
    "Two agents finished, two failed, two are blocked by approvals, one has a question for you, one goal needs you, three sessions at the computer need you, two goal milestones are done, one goal passed, and DAVE has new recommendations for Acme and Triten. Want the details?",
  );
  expect(c).toMatchObject({ finished: 2, failed: 2, needsYou: 7, milestones: 3 });
  expect(buildCheckin(base({ events: [ev(1, "a", "task.failed")], openQuestions: 2 })).say).toBe(
    "One agent failed and two have questions for you. Want the details?",
  );
});

test("a task that failed then finished counts once, as finished", () => {
  const c = buildCheckin(base({ events: [ev(1, "a", "task.failed"), ev(2, "a", "task.completed")] }));
  expect(c.say).toBe("One agent finished. Want the details?");
});
