import { describe, expect, test } from "bun:test";
import { cardApproval, needsConfirmation } from "./approvals";
import type { VoiceTask } from "./types";

const task = (risk: "edit" | "deploy", over: Partial<VoiceTask> = {}): VoiceTask => ({
  taskId: "t",
  projectId: "p",
  projectName: "pew2",
  sessionId: "s1",
  title: "x",
  state: "blocked",
  priority: 0,
  approval: { requestId: "r1", risk, summary: "do it" },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const held = [
  {
    sessionId: "s1",
    requestId: "r1",
    options: [
      { optionId: "allow_once", name: "Allow" },
      { optionId: "reject_once", name: "Reject" },
    ],
  },
];

describe("cardApproval", () => {
  test("no approval, no card", () => {
    expect(cardApproval(task("edit", { approval: undefined }), held)).toBeUndefined();
  });
  test("uses the held ACP options", () => {
    const card = cardApproval(task("edit"), held);
    expect(card).toMatchObject({ kind: "buttons", requestId: "r1", confirm: false });
    if (card?.kind === "buttons") {
      expect(card.approve.optionId).toBe("allow_once");
      expect(card.deny.optionId).toBe("reject_once");
    }
  });
  test("risky approvals require confirmation", () => {
    expect(cardApproval(task("deploy"), held)).toMatchObject({ confirm: true });
    expect(needsConfirmation("read")).toBe(false);
    expect(needsConfirmation("destructive")).toBe(true);
  });
  test("without the permission on the phone, it is voice-only (no guessed option ids)", () => {
    expect(cardApproval(task("edit"), [])).toMatchObject({ kind: "voice_only" });
    expect(cardApproval(task("edit", { sessionId: "other" }), held)).toMatchObject({ kind: "voice_only" });
  });
});
