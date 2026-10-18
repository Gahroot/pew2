import { expect, test } from "bun:test";
import { Orchestrator, type VoiceHost } from "./dispatcher.js";
import { VoiceStore, type NewTask } from "./store.js";

interface Turn {
  text: string;
  resolve: () => void;
  reject: (e: Error) => void;
}

function fakeHost() {
  const turns: Turn[] = [];
  const answered: Array<[string, string, string]> = [];
  const cancelled: string[] = [];
  let sessions = 0;
  let failStart = 0;
  const live = new Set<string>();
  let lastText: string | undefined = "Added the button.";
  const host: VoiceHost = {
    async startSession() {
      if (failStart > 0) {
        failStart--;
        throw new Error("spawn ENOENT");
      }
      const id = `s${++sessions}`;
      live.add(id);
      return id;
    },
    prompt: (_id, text) =>
      new Promise<void>((resolve, reject) => {
        turns.push({ text, resolve, reject });
      }),
    async cancel(id) {
      cancelled.push(id);
    },
    answerPermission(id, req, option) {
      answered.push([id, req, option]);
      return true;
    },
    hasSession: (id) => live.has(id),
    lastText: () => lastText,
  };
  return {
    host,
    turns,
    answered,
    cancelled,
    live,
    failNextStarts: (n: number) => (failStart = n),
    setLastText: (t: string | undefined) => (lastText = t),
  };
}

const task = (over: Partial<NewTask> = {}): NewTask => ({
  projectId: "p1",
  projectName: "one",
  cwd: "/code/one",
  providerId: "echo",
  title: "t",
  prompt: "build it",
  ...over,
});

const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(options: { maxConcurrent?: number; now?: () => number; taskTimeoutMs?: number } = {}) {
  const store = VoiceStore.memory();
  const fake = fakeHost();
  const orchestrator = new Orchestrator(store, fake.host, { retryBackoffMs: 0, ...options });
  return { store, fake, orchestrator };
}

test("a task runs, and completion is reported as the agent's claim, not verified", async () => {
  const { store, fake, orchestrator } = setup();
  const t = orchestrator.enqueue(task());
  expect(store.getTask(t.taskId)?.state).toBe("running");
  await tick();
  expect(fake.turns[0]?.text).toBe("build it");
  fake.turns[0]?.resolve();
  await tick();
  const done = store.getTask(t.taskId);
  expect(done?.state).toBe("completed");
  const last = store.eventsSince(0).at(-1);
  expect(last?.kind).toBe("task.completed");
  expect(last?.text).toContain("says it finished");
  expect(store.getTask(t.taskId)?.sessionId).toBe("s1");
});

test("a second task in the same project queues until the first finishes", async () => {
  const { store, fake, orchestrator } = setup();
  const a = orchestrator.enqueue(task());
  const b = orchestrator.enqueue(task({ prompt: "other" }));
  expect(store.getTask(b.taskId)?.state).toBe("queued");
  await tick();
  fake.turns[0]?.resolve();
  await tick();
  expect(store.getTask(a.taskId)?.state).toBe("completed");
  expect(store.getTask(b.taskId)?.state).toBe("running");
});

test("different projects run concurrently up to the cap", async () => {
  const { store, orchestrator } = setup({ maxConcurrent: 2 });
  const ids = ["p1", "p2", "p3"].map((projectId) => orchestrator.enqueue(task({ projectId })).taskId);
  expect(ids.map((id) => store.getTask(id)?.state)).toEqual(["running", "running", "queued"]);
});

test("a dependent task waits, then starts; a failed dependency fails it", async () => {
  const { store, fake, orchestrator } = setup();
  const a = orchestrator.enqueue(task({ projectId: "p1" }));
  const b = orchestrator.enqueue(task({ projectId: "p2", dependsOn: [a.taskId] }));
  expect(store.getTask(b.taskId)?.state).toBe("queued");
  await tick();
  fake.turns[0]?.resolve();
  await tick();
  expect(store.getTask(b.taskId)?.state).toBe("running");

  const c = orchestrator.enqueue(task({ projectId: "p3" }));
  const d = orchestrator.enqueue(task({ projectId: "p4", dependsOn: [c.taskId] }));
  await tick();
  void orchestrator.cancel(c.taskId);
  await tick();
  expect(store.getTask(d.taskId)?.state).toBe("failed");
});

test("start failures retry a bounded number of times, then fail with a reason", async () => {
  const { store, fake, orchestrator } = setup();
  fake.failNextStarts(5);
  const t = orchestrator.enqueue(task());
  await tick();
  expect(store.getTask(t.taskId)?.state).toBe("queued"); // retry scheduled
  orchestrator.tick();
  await tick();
  const failed = store.getTask(t.taskId);
  expect(failed?.state).toBe("failed");
  expect(failed?.attempts).toBe(2);
  expect(store.eventsSince(0).at(-1)?.class).toBe("blocked");
});

test("a failed prompt is failed, never retried (it may have edited files)", async () => {
  const { store, fake, orchestrator } = setup();
  const t = orchestrator.enqueue(task());
  await tick();
  fake.turns[0]?.reject(new Error("agent crashed"));
  await tick();
  expect(store.getTask(t.taskId)?.state).toBe("failed");
  expect(fake.turns).toHaveLength(1);
});

test("follow-up to a running task goes after the current turn, in the same session", async () => {
  const { store, fake, orchestrator } = setup();
  const t = orchestrator.enqueue(task());
  await tick();
  expect(orchestrator.followUp(t.taskId, "also add tests").ok).toBe(true);
  expect(fake.turns).toHaveLength(1);
  fake.turns[0]?.resolve();
  await tick();
  expect(fake.turns[1]?.text).toBe("also add tests");
  expect(store.getTask(t.taskId)?.state).toBe("running");
  fake.turns[1]?.resolve();
  await tick();
  expect(store.getTask(t.taskId)?.state).toBe("completed");
});

test("follow-up to a finished task reopens its live session", async () => {
  const { store, fake, orchestrator } = setup();
  const t = orchestrator.enqueue(task());
  await tick();
  fake.turns[0]?.resolve();
  await tick();
  orchestrator.followUp(t.taskId, "one more thing");
  await tick();
  expect(fake.turns[1]?.text).toBe("one more thing");
  expect(store.getTask(t.taskId)?.sessionId).toBe("s1");
  expect(store.getTask(t.taskId)?.state).toBe("running");
});

test("pause stops the turn and frees the project; resume continues", async () => {
  const { store, fake, orchestrator } = setup();
  const a = orchestrator.enqueue(task());
  const b = orchestrator.enqueue(task({ prompt: "second" }));
  await tick();
  await orchestrator.pause(a.taskId);
  expect(fake.cancelled).toEqual(["s1"]);
  expect(store.getTask(a.taskId)?.state).toBe("paused");
  expect(store.getTask(b.taskId)?.state).toBe("running");
  fake.turns[0]?.resolve(); // the cancelled turn ends: must not flip paused to completed
  await tick();
  expect(store.getTask(a.taskId)?.state).toBe("paused");
  fake.turns[1]?.resolve();
  await tick();
  orchestrator.resume(a.taskId);
  await tick();
  expect(fake.turns[2]?.text).toContain("Continue");
  expect(store.getTask(a.taskId)?.state).toBe("running");
});

test("cancel is terminal and ignores the dying turn", async () => {
  const { store, fake, orchestrator } = setup();
  const t = orchestrator.enqueue(task());
  await tick();
  await orchestrator.cancel(t.taskId);
  fake.turns[0]?.reject(new Error("aborted"));
  await tick();
  expect(store.getTask(t.taskId)?.state).toBe("cancelled");
  expect((await orchestrator.cancel(t.taskId)).ok).toBe(false);
});

const request = (kind: string, command: string) => ({
  kind: "permission_request",
  requestId: "perm_1",
  params: {
    toolCall: { title: command, kind, rawInput: { command } },
    options: [
      { optionId: "yes", kind: "allow_once" },
      { optionId: "no", kind: "reject_once" },
    ],
  },
});

test("a permission request blocks the task with a tiered, urgent event", async () => {
  const { store, orchestrator } = setup();
  const t = orchestrator.enqueue(task());
  await tick();
  orchestrator.onSessionPayload("s1", request("execute", "git merge main"));
  const blocked = store.getTask(t.taskId);
  expect(blocked?.state).toBe("blocked");
  expect(blocked?.approval).toMatchObject({ requestId: "perm_1", risk: "merge" });
  const event = store.eventsSince(0).at(-1);
  expect(event).toMatchObject({ kind: "task.approval", class: "approval" });
  expect(orchestrator.pendingApprovals()).toHaveLength(1);
});

test("approvals are validated against the current request; stale ones are rejected", async () => {
  const { store, fake, orchestrator } = setup();
  const t = orchestrator.enqueue(task());
  await tick();
  expect(orchestrator.answerApproval(t.taskId, "perm_1", "approve").ok).toBe(false); // nothing pending
  orchestrator.onSessionPayload("s1", request("execute", "npm test"));
  const stale = orchestrator.answerApproval(t.taskId, "perm_0", "approve");
  expect(stale).toMatchObject({ ok: false });
  expect(fake.answered).toEqual([]);
  expect(orchestrator.answerApproval(t.taskId, "perm_1", "approve").ok).toBe(true);
  expect(fake.answered).toEqual([["s1", "perm_1", "yes"]]);
  expect(store.getTask(t.taskId)?.state).toBe("running");
  // A second answer to the same request is stale now.
  expect(orchestrator.answerApproval(t.taskId, "perm_1", "approve").ok).toBe(false);
  expect(fake.answered).toHaveLength(1);
});

test("deny sends the reject option", async () => {
  const { fake, orchestrator } = setup();
  const t = orchestrator.enqueue(task());
  await tick();
  orchestrator.onSessionPayload("s1", request("edit", "edit"));
  orchestrator.answerApproval(t.taskId, "perm_1", "deny");
  expect(fake.answered[0]?.[2]).toBe("no");
});

test("activity while blocked means it was answered elsewhere", async () => {
  const { store, orchestrator } = setup();
  const t = orchestrator.enqueue(task());
  await tick();
  orchestrator.onSessionPayload("s1", request("execute", "npm test"));
  // The app's own sheet answered; the daemon's pending map still holds it, so progress alone does not unblock.
  expect(store.getTask(t.taskId)?.state).toBe("blocked");
});

test("tool calls update activity with a speakable line, not raw input", async () => {
  const { store, orchestrator } = setup();
  const t = orchestrator.enqueue(task());
  await tick();
  orchestrator.onSessionPayload("s1", {
    update: { sessionUpdate: "tool_call", title: "Edit /home/me/proj/App.tsx", kind: "edit" },
  });
  expect(store.getTask(t.taskId)?.activity).toBe("Edit App.tsx");
});

test("reconcile marks tasks the dead process was running as interrupted, never completed", async () => {
  const { store, fake, orchestrator } = setup();
  const t = orchestrator.enqueue(task());
  const queued = orchestrator.enqueue(task({ prompt: "later" }));
  await tick();
  // New process, same store.
  const revived = new Orchestrator(store, fake.host, { retryBackoffMs: 0 });
  const touched = revived.reconcile();
  expect(touched.map((x) => x.taskId)).toEqual([t.taskId]);
  const after = store.getTask(t.taskId);
  expect(after).toMatchObject({ state: "failed", interrupted: true });
  expect(store.eventsSince(0).find((e) => e.kind === "task.failed")?.text).toContain("Nothing was confirmed");
  // The queued one is picked up now that the project is free.
  expect(store.getTask(queued.taskId)?.state).toBe("running");
});

test("a silent running task times out and is stopped", async () => {
  let now = 1_000;
  const { store, fake, orchestrator } = setup({ now: () => now, taskTimeoutMs: 60_000 });
  const t = orchestrator.enqueue(task());
  await tick();
  now += 59_000;
  orchestrator.tick();
  expect(store.getTask(t.taskId)?.state).toBe("running");
  now += 2_000;
  orchestrator.tick();
  expect(store.getTask(t.taskId)).toMatchObject({ state: "failed", error: "timeout" });
  await tick();
  expect(fake.cancelled).toEqual(["s1"]);
});

test("only a completed task can be verified", async () => {
  const { store, fake, orchestrator } = setup();
  const t = orchestrator.enqueue(task());
  await tick();
  expect(orchestrator.verify(t.taskId).ok).toBe(false);
  fake.turns[0]?.resolve();
  await tick();
  expect(orchestrator.verify(t.taskId, "tests green").ok).toBe(true);
  expect(store.getTask(t.taskId)?.state).toBe("verified");
});

test("a finished turn carries a debrief built from its tool calls, with one next step", async () => {
  const run = async (payloads: unknown[], lastText: string) => {
    const { store, fake, orchestrator } = setup();
    fake.setLastText(lastText);
    const t = orchestrator.enqueue(task());
    await tick();
    for (const p of payloads) orchestrator.onSessionPayload("s1", p);
    fake.turns[0]?.resolve();
    await tick();
    return store.getTask(t.taskId)?.debrief;
  };
  const call = (toolCallId: string, kind: string, title: string) => ({
    update: { sessionUpdate: "tool_call", toolCallId, kind, title, status: "in_progress" },
  });
  const done = (toolCallId: string, status: string) => ({ update: { sessionUpdate: "tool_call_update", toolCallId, status } });

  // Edited, never checked: offer the tests.
  const unchecked = await run([call("a", "edit", "Edit App.tsx"), done("a", "completed")], "Added the button.");
  expect(unchecked).toMatchObject({ outcome: "unchecked_edits", edits: 1, checks: "none", said: "Added the button." });
  expect(unchecked?.followUp).toContain("Run the project's tests");

  // The last check run failed, even though an earlier one passed.
  const failing = await run(
    [call("a", "edit", "Edit x"), call("b", "execute", "npm test"), done("b", "completed"), call("c", "execute", "bun test"), done("c", "failed")],
    "Done.",
  );
  expect(failing).toMatchObject({ outcome: "checks_failed", checks: "failed", commands: 2 });

  // Checked edits: ran, never "passed".
  const checked = await run([call("a", "edit", "Edit x"), call("b", "execute", "npm run typecheck"), done("b", "completed")], "Done.");
  expect(checked).toMatchObject({ outcome: "checked_edits", checks: "ran" });

  // The agent's own question outranks everything: no next step is invented.
  const asked = await run([call("a", "edit", "Edit x")], "I changed the colour. Should I also update the dark theme?");
  expect(asked?.outcome).toBe("question");
  expect(asked?.nextStep).toBeUndefined();

  // An answer with nothing touched has nothing to offer.
  expect(await run([call("a", "read", "Read App.tsx")], "It uses Expo Router.")).toMatchObject({ outcome: "no_changes", edits: 0 });
});

test("a debrief does not survive into the next run of the task", async () => {
  const { store, fake, orchestrator } = setup();
  const t = orchestrator.enqueue(task());
  await tick();
  fake.turns[0]?.resolve();
  await tick();
  expect(store.getTask(t.taskId)?.debrief).toBeDefined();
  orchestrator.followUp(t.taskId, "now the tests");
  await tick();
  expect(store.getTask(t.taskId)).toMatchObject({ state: "running" });
  expect(store.getTask(t.taskId)?.debrief).toBeUndefined();
});

test("a slash command is always its own turn, sent verbatim, never folded or wrapped", async () => {
  const { store, fake, orchestrator } = setup();
  // Queued behind another writer in the same checkout: not folded into its prompt.
  orchestrator.enqueue(task());
  const queued = orchestrator.enqueue(task({ prompt: "add dark mode" }));
  expect(orchestrator.followUp(queued.taskId, "/commit").ok).toBe(true);
  expect(store.getTask(queued.taskId)?.prompt).toBe("add dark mode");
  await tick();
  fake.turns[0]?.resolve();
  await tick();
  fake.turns[1]?.resolve();
  await tick();
  expect(fake.turns.map((t) => t.text)).toEqual(["build it", "add dark mode", "/commit"]);

  // Finished, its session gone: a fresh one gets "/commit" alone, not "Follow-up on…".
  fake.turns[2]?.resolve();
  await tick();
  expect(store.getTask(queued.taskId)?.state).toBe("completed");
  fake.live.clear();
  expect(orchestrator.followUp(queued.taskId, "/commit message: dark mode").ok).toBe(true);
  await tick();
  expect(fake.turns.at(-1)?.text).toBe("/commit message: dark mode");
});
