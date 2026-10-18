import { expect, test } from "bun:test";
import type { AskAnswer } from "../acp/connect-types.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOAL_COMPLETED_TEXT, MAX_GOAL_CONTINUES, Orchestrator, type GoalHooks, type GoalTurnDecision, type VoiceHost } from "./dispatcher.js";
import { VoiceStore, type NewTask } from "./store.js";

interface Turn {
  text: string;
  resolve: () => void;
  reject: (e: Error) => void;
}

function fakeHost() {
  const turns: Turn[] = [];
  const answered: Array<[string, string, string]> = [];
  const asked: Array<[string, string, AskAnswer]> = [];
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
    answerAsk(id, req, result) {
      asked.push([id, req, result]);
      return true;
    },
    hasSession: (id) => live.has(id),
    lastText: () => lastText,
  };
  return {
    host,
    turns,
    answered,
    asked,
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

// ---- goals -----------------------------------------------------------------

/** Hooks that answer from a scripted list, recording each call. */
function scriptedGoals(decisions: GoalTurnDecision[]) {
  const calls: string[] = [];
  const hooks: GoalHooks = {
    async afterTurn(t) {
      calls.push(t.taskId);
      return decisions.shift() ?? { kind: "ordinary" };
    },
  };
  return { hooks, calls };
}

const goalTask = (over: Partial<NewTask> = {}) =>
  task({ providerId: "ezcoder", prompt: "/goal ship it", goal: { objective: "ship it", requestedAt: 0, continues: 0 }, ...over });

function goalSetup(decisions: GoalTurnDecision[]) {
  const store = VoiceStore.memory();
  const fake = fakeHost();
  const goals = scriptedGoals(decisions);
  const orchestrator = new Orchestrator(store, fake.host, { retryBackoffMs: 0, goals: goals.hooks });
  return { store, fake, orchestrator, goals };
}

const cont = (n = 0): GoalTurnDecision => ({
  kind: "continue",
  prompt: "Continue goal run r1",
  goal: { objective: "ship it", requestedAt: 0, runId: "r1", continues: n, lastRunUpdatedAt: `u${n}` },
});

async function endTurn(fake: ReturnType<typeof fakeHost>, index: number) {
  await tick();
  fake.turns[index]?.resolve();
  await tick();
  await tick();
}

test("goal: a continue decision sends the continue prompt, then completion is the agent's claim", async () => {
  const { store, fake, orchestrator } = goalSetup([cont(0), { kind: "complete" }]);
  const t = orchestrator.enqueue(goalTask());
  await endTurn(fake, 0);
  expect(fake.turns.map((x) => x.text)).toEqual(["/goal ship it", "Continue goal run r1"]);
  expect(store.getTask(t.taskId)?.goal?.continues).toBe(1);
  await endTurn(fake, 1);
  const done = store.getTask(t.taskId);
  expect(done?.state).toBe("completed");
  const last = store.eventsSince(0).at(-1);
  expect(last?.text).toBe(GOAL_COMPLETED_TEXT);
  expect(last?.goal?.change).toBe("passed");
  expect(fake.turns).toHaveLength(2);
});

test("goal: stalled blocks with a question to the user", async () => {
  const { store, fake, orchestrator } = goalSetup([{ kind: "stalled", say: "The goal run made no progress on the last turn." }]);
  const t = orchestrator.enqueue(goalTask());
  await endTurn(fake, 0);
  expect(store.getTask(t.taskId)?.state).toBe("blocked");
  const last = store.eventsSince(0).at(-1);
  expect(last).toMatchObject({ kind: "task.blocked", goal: { change: "stalled" } });
  expect(last?.text).toContain("Keep going");
  expect(fake.turns).toHaveLength(1);
});

test("goal: needs_you blocks with goal.change needs_you, and a follow_up picks it up again", async () => {
  const { store, fake, orchestrator } = goalSetup([{ kind: "needs_you", say: "an API key" }, { kind: "complete" }]);
  const t = orchestrator.enqueue(goalTask());
  await endTurn(fake, 0);
  expect(store.getTask(t.taskId)?.state).toBe("blocked");
  expect(store.eventsSince(0).at(-1)).toMatchObject({ kind: "task.blocked", class: "blocked", goal: { change: "needs_you" } });
  expect(orchestrator.followUp(t.taskId, "the key is in the keychain").ok).toBe(true);
  await tick();
  expect(fake.turns).toHaveLength(2);
  expect(fake.turns[1]?.text).toContain("the key is in the keychain");
});

test("goal: failed fails the task", async () => {
  const { store, fake, orchestrator } = goalSetup([{ kind: "failed", say: "The goal run failed." }]);
  const t = orchestrator.enqueue(goalTask());
  await endTurn(fake, 0);
  expect(store.getTask(t.taskId)?.state).toBe("failed");
  expect(store.eventsSince(0).at(-1)?.goal?.change).toBe("failed");
});

test("goal: the continue cap blocks with 'keep going?', and follow_up resets it", async () => {
  const decisions = Array.from({ length: MAX_GOAL_CONTINUES + 1 }, (_, i) => cont(i));
  const { store, fake, orchestrator } = goalSetup(decisions);
  const t = orchestrator.enqueue(goalTask());
  for (let i = 0; i <= MAX_GOAL_CONTINUES; i++) await endTurn(fake, i);
  expect(fake.turns).toHaveLength(MAX_GOAL_CONTINUES + 1);
  const blocked = store.getTask(t.taskId);
  expect(blocked?.state).toBe("blocked");
  expect(store.eventsSince(0).at(-1)?.text).toContain("Keep going?");
  orchestrator.followUp(t.taskId, "yes, keep going");
  expect(store.getTask(t.taskId)?.goal?.continues).toBe(0);
});

test("goal: pause during an in-flight continue turn sends nothing more and stays paused", async () => {
  const { store, fake, orchestrator } = goalSetup([cont(0), cont(1)]);
  const t = orchestrator.enqueue(goalTask());
  await endTurn(fake, 0);
  expect(fake.turns).toHaveLength(2); // the continue turn is in flight
  await orchestrator.pause(t.taskId);
  await endTurn(fake, 1);
  expect(fake.turns).toHaveLength(2);
  expect(store.getTask(t.taskId)?.state).toBe("paused");
});

test("goal: cancel during a continue turn sends nothing more and stays cancelled", async () => {
  const { store, fake, orchestrator } = goalSetup([cont(0), cont(1)]);
  const t = orchestrator.enqueue(goalTask());
  await endTurn(fake, 0);
  await orchestrator.cancel(t.taskId);
  await endTurn(fake, 1);
  expect(fake.turns).toHaveLength(2);
  expect(store.getTask(t.taskId)?.state).toBe("cancelled");
});

test("goal: a pause while the decision is being read wins over the continue", async () => {
  const store = VoiceStore.memory();
  const fake = fakeHost();
  let release: (d: GoalTurnDecision) => void = () => undefined;
  const hooks: GoalHooks = { afterTurn: () => new Promise((r) => (release = r)) };
  const orchestrator = new Orchestrator(store, fake.host, { goals: hooks });
  const t = orchestrator.enqueue(goalTask());
  await endTurn(fake, 0);
  await orchestrator.pause(t.taskId);
  release(cont(0));
  await tick();
  await tick();
  expect(fake.turns).toHaveLength(1);
  expect(store.getTask(t.taskId)?.state).toBe("paused");
});

test("goal: restart mid-run fails it as interrupted and nothing auto-continues", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "voice-goal-")), "voice.json");
  const before = await VoiceStore.open(path);
  const t = before.createTask(goalTask({ goal: { objective: "ship it", requestedAt: 0, runId: "r1", continues: 2 } }));
  before.transition(t.taskId, "running", "task.started", "Started", { sessionId: "s9" });
  await before.flush();

  const store = await VoiceStore.open(path);
  const fake = fakeHost();
  const goals = scriptedGoals([cont(2)]);
  let starts = 0;
  const host: VoiceHost = { ...fake.host, startSession: async (...a) => (starts++, fake.host.startSession(...a)) };
  const orchestrator = new Orchestrator(store, host, { goals: goals.hooks });
  orchestrator.reconcile();
  const after = store.getTask(t.taskId);
  expect(after?.state).toBe("failed");
  expect(after?.interrupted).toBe(true);
  orchestrator.pump();
  await tick();
  expect(starts).toBe(0);
  expect(fake.turns).toHaveLength(0);
  expect(goals.calls).toHaveLength(0);
});

// ---- questions -------------------------------------------------------------

test("ask_user blocks with the question; an answer goes to the agent and the task runs again; a stale one is refused", async () => {
  const { store, fake, orchestrator } = setup();
  const t = orchestrator.enqueue(task());
  await tick();
  orchestrator.onSessionPayload("s1", {
    kind: "ask_user",
    requestId: "ask_1",
    questions: [{ id: "q1", question: "Which database, in /Users/me/app/db?", kind: "choice", options: [{ label: "Postgres", value: "pg" }, { label: "SQLite" }] }],
  });
  const blocked = store.getTask(t.taskId);
  expect(blocked?.state).toBe("blocked");
  expect(blocked?.question).toEqual({ requestId: "ask_1", text: "Which database, in db?", options: ["Postgres", "SQLite"] });
  expect(store.eventsSince(0).at(-1)).toMatchObject({ kind: "task.blocked", text: "Question: Which database, in db?" });
  // A tool update while the question is open does not unblock it.
  orchestrator.onSessionPayload("s1", { update: { sessionUpdate: "tool_call", title: "Read" } });
  expect(store.getTask(t.taskId)?.state).toBe("blocked");

  expect(orchestrator.answerQuestion(t.taskId, "ask_0", "Postgres").ok).toBe(false);
  expect(fake.asked).toHaveLength(0);
  const r = orchestrator.answerQuestion(t.taskId, "ask_1", "postgres");
  expect(r.ok).toBe(true);
  expect(fake.asked).toEqual([["s1", "ask_1", { action: "answer", answers: { q1: "pg" } }]]);
  expect(store.getTask(t.taskId)?.state).toBe("running");
  expect(store.getTask(t.taskId)?.question).toBeUndefined();
  expect(orchestrator.answerQuestion(t.taskId, "ask_1", "again").ok).toBe(false);
});

test("ask_user_closed clears the question and returns the task to running", async () => {
  const { store, orchestrator } = setup();
  const t = orchestrator.enqueue(task());
  await tick();
  orchestrator.onSessionPayload("s1", { kind: "ask_user", requestId: "ask_2", questions: [{ id: "q", question: "Go?", kind: "confirm" }] });
  expect(store.getTask(t.taskId)?.state).toBe("blocked");
  orchestrator.onSessionPayload("s1", { kind: "ask_user_closed", requestId: "ask_2" });
  expect(store.getTask(t.taskId)?.state).toBe("running");
  expect(store.getTask(t.taskId)?.question).toBeUndefined();
});
