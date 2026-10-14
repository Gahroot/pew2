import { describe, expect, test } from "bun:test";
import { arrivalNote, MAX_CARDS, readHeld, screenshotCards, sendTarget, sentNote } from "./screenshots";
import type { VoiceTask } from "./types";

const task = (o: Partial<VoiceTask> & { taskId: string }): VoiceTask => ({
  projectId: "p",
  projectName: "billing",
  title: "Fix the totals",
  state: "running",
  priority: 0,
  createdAt: 1,
  updatedAt: 1,
  ...o,
});
const byId = (...tasks: VoiceTask[]) => Object.fromEntries(tasks.map((t) => [t.taskId, t]));

describe("screenshotCards", () => {
  test("an upload keeps its card identity and thumbnail once the computer holds it", () => {
    const uploading = screenshotCards([{ requestId: "r1", name: "fix.png", localUri: "file:///fix.png", status: "uploading", at: 5 }], [], {}, {});
    expect(uploading).toEqual([{ key: "r1", name: "fix.png", localUri: "file:///fix.png", status: "uploading", sentTo: [] }]);

    const held = screenshotCards(
      [],
      [{ attachmentId: "a_1", name: "fix.png", mimeType: "image/png", size: 9, at: 5, sentTo: [] }],
      { a_1: { localUri: "file:///fix.png", key: "r1" } },
      {},
    );
    expect(held).toEqual([{ key: "r1", attachmentId: "a_1", name: "fix.png", localUri: "file:///fix.png", status: "held", sentTo: [] }]);
  });

  test("a sent screenshot names the task it went to; newest first, capped", () => {
    const cards = screenshotCards(
      [{ requestId: "r9", name: "bad.png", status: "failed", error: "Too big", at: 50 }],
      [
        { attachmentId: "a_1", name: "old.png", mimeType: "image/png", size: 1, at: 1, sentTo: ["t_1"] },
        ...Array.from({ length: 5 }, (_, i) => ({ attachmentId: `a_${i + 2}`, name: `s${i}.png`, mimeType: "image/png", size: 1, at: 10 + i, sentTo: [] })),
      ],
      {},
      byId(task({ taskId: "t_1", title: "Apply the fix" })),
    );
    expect(cards).toHaveLength(MAX_CARDS);
    expect(cards[0]).toMatchObject({ status: "failed", error: "Too big" });
    expect(cards.map((c) => c.name)).not.toContain("old.png");
    const sent = screenshotCards([], [{ attachmentId: "a_1", name: "old.png", mimeType: "image/png", size: 1, at: 1, sentTo: ["t_1"] }], {}, byId(task({ taskId: "t_1", title: "Apply the fix" })));
    expect(sent[0]).toMatchObject({ status: "sent", sentTo: [{ taskId: "t_1", title: "Apply the fix" }] });
  });

  test("malformed lists from the wire are ignored, not trusted", () => {
    expect(readHeld("nope")).toBeUndefined();
    expect(readHeld([{ attachmentId: 3 }, { attachmentId: "a_1", name: "x.png", sentTo: ["t_1", 4] }])).toEqual([
      { attachmentId: "a_1", name: "x.png", mimeType: "image/png", size: 0, at: 0, sentTo: ["t_1"] },
    ]);
  });
});

describe("sendTarget", () => {
  test("the one active task, else the latest finished one, never a guess between active ones", () => {
    expect(sendTarget(byId(task({ taskId: "t_1" }), task({ taskId: "t_2", state: "completed", updatedAt: 9 })))?.taskId).toBe("t_1");
    expect(sendTarget(byId(task({ taskId: "t_1" }), task({ taskId: "t_2", state: "queued" })))).toBeUndefined();
    expect(
      sendTarget(byId(task({ taskId: "t_1", state: "completed", updatedAt: 3 }), task({ taskId: "t_2", state: "cancelled", updatedAt: 9 })))?.taskId,
    ).toBe("t_1");
    expect(sendTarget({})).toBeUndefined();
  });
});

test("the model is told an id and a name, never shown the picture", () => {
  const note = arrivalNote({ attachmentId: "a_3", name: "partner-fix.png" });
  expect(note).toContain('"partner-fix.png" (attachmentId a_3)');
  expect(note).toContain("ask which project or task");
  expect(sentNote({ attachmentId: "a_3", name: "p.png" }, { taskId: "t_1", title: "Fix" })).toContain("do not send it again");
});
