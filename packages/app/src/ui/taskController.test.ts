import { expect, test } from "bun:test";
import { createTaskController, type TasksView } from "./taskController";

const snapshot = (eventId: number) => ({ eventId, projects: [], tasks: [], unheard: [] });

function setup(online = true) {
  const sent: Record<string, unknown>[] = [];
  let view: TasksView | undefined;
  let id = 0;
  const c = createTaskController({
    send: (m) => {
      sent.push(m);
      return online;
    },
    onChange: (v) => void (view = v),
    newId: () => String(++id),
    now: () => 1_000,
  });
  return { c, sent, view: () => view };
}

const task = { taskId: "t_1", projectId: "p", projectName: "pew2", title: "Fix", state: "running", priority: 0, createdAt: 1, updatedAt: 1 };

test("catch-up and events fold into the store; malformed frames are ignored", () => {
  const { c, view } = setup();
  c.handleMessage({ t: "voice.state", snapshot: snapshot(2), events: [], dismissed: [] });
  expect(view()?.store.cursor).toBe(2);
  expect(view()?.store.canDismiss).toBe(true);
  c.handleMessage({
    t: "voice.event",
    event: { eventId: 3, taskId: "t_1", projectId: "p", projectName: "pew2", kind: "task.started", class: "informational", text: "Started.", at: 1 },
    task,
  });
  expect(view()?.store.tasks.t_1?.title).toBe("Fix");
  expect(view()?.store.cursor).toBe(3);
  const before = view();
  c.handleMessage({ t: "voice.state", snapshot: { nope: true } });
  c.handleMessage({ t: "voice.event", event: "garbage" });
  expect(view()).toBe(before);
});

test("a screenshot sent to a task goes as voice.send, and a refusal becomes a card", () => {
  const { c, sent, view } = setup();
  c.handleMessage({ t: "voice.attachments", attachments: [{ attachmentId: "a_1", name: "fix.png", mimeType: "image/png", size: 3, at: 1, sentTo: [] }] });
  c.sendScreenshot("a_1", "t_1");
  expect(sent.at(-1)).toEqual({ t: "voice.send", requestId: "send-1", attachmentId: "a_1", taskId: "t_1" });
  // Answers for sends this phone did not make are not its business.
  c.handleMessage({ t: "voice.sent", requestId: "send-other", ok: false, error: "x" });
  expect(view()?.screenshots.some((s) => s.status === "failed")).toBe(false);
  c.handleMessage({ t: "voice.sent", requestId: "send-1", ok: false, error: "That task was cancelled." });
  expect(view()?.screenshots.find((s) => s.status === "failed")).toMatchObject({ name: "fix.png", error: "That task was cancelled." });
});

test("offline, a send fails at once and a dismissal waits for the next catch-up", () => {
  const { c, sent, view } = setup(false);
  c.handleMessage({ t: "voice.state", snapshot: snapshot(1), events: [], dismissed: [] });
  c.sendScreenshot("a_9", "t_1");
  expect(view()?.screenshots[0]).toMatchObject({ status: "failed", name: "Screenshot" });
  c.dismiss({ taskIds: ["t_2"] });
  const dismissals = () => sent.filter((m) => m.t === "voice.dismiss").length;
  expect(dismissals()).toBe(1);
  c.handleMessage({ t: "voice.state", snapshot: snapshot(1), events: [], dismissed: [] });
  // Retried with the catch-up (still offline here, so still waiting).
  expect(dismissals()).toBe(2);
});
