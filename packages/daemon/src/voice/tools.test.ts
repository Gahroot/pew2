import { expect, test } from "bun:test";
import { join } from "node:path";
import { Orchestrator, type VoiceHost } from "./dispatcher.js";
import { buildRegistry } from "./registry.js";
import { scratch } from "./scratch.js";
import { VoiceStore } from "./store.js";
import { realtimeSession, ToolExecutor, TOOL_NAMES, VOICE_INSTRUCTIONS, VOICE_TOOLS } from "./tools.js";

function harness(store = VoiceStore.memory()) {
  const prompts: string[] = [];
  const answered: string[] = [];
  const host: VoiceHost = {
    async startSession() {
      return "s1";
    },
    prompt: (_id, text) => {
      prompts.push(text);
      return new Promise<void>(() => {});
    },
    async cancel() {},
    answerPermission: (_s, _r, option) => {
      answered.push(option);
      return true;
    },
    hasSession: () => true,
    lastText: () => undefined,
  };
  const orchestrator = new Orchestrator(store, host);
  const projects = buildRegistry(["/code/pew2", "/code/billing-api", "/code/billing-web"], {});
  const aliases: string[] = [];
  const executor = new ToolExecutor({
    store,
    orchestrator,
    projects: async () => projects,
    usableProviders: () => ["echo"],
    rememberAlias: async (_path, alias) => void aliases.push(alias),
  });
  let n = 0;
  const call = async (name: string, args: Record<string, unknown> = {}, callId = `c${++n}`) => ({
    ...(await executor.handle({ callId, name, args })),
  });
  return { store, orchestrator, executor, call, prompts, answered, aliases };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("every tool has a definition and the session config carries them with server VAD", () => {
  expect(new Set(TOOL_NAMES).size).toBe(VOICE_TOOLS.length);
  for (const name of ["list_projects", "resolve_project", "start_task", "follow_up", "task_status", "list_tasks", "reprioritize_task", "pause_task", "resume_task", "cancel_task", "pending_approvals", "answer_approval", "recent_events", "get_details", "remember_decision", "end_session"]) {
    expect(TOOL_NAMES).toContain(name);
  }
  const session = realtimeSession({ voice: "marin" }) as {
    tools: unknown[];
    audio: { input: { turn_detection: { type: string; interrupt_response: boolean } } };
  };
  expect(session.tools).toHaveLength(VOICE_TOOLS.length);
  expect(session.audio.input.turn_detection).toMatchObject({ type: "server_vad", interrupt_response: true });
  expect(VOICE_INSTRUCTIONS).toContain("Never say work is done");
});

test("start_task resolves a spoken project, never takes a path, and returns small JSON", async () => {
  const h = harness();
  const r = await h.call("start_task", { project: "pew two", instruction: "add dark mode", cwd: "/etc" });
  expect(r.ok).toBe(true);
  const task = (r.output as { task: { project: string; state: string } }).task;
  expect(task).toMatchObject({ project: "pew2", state: "running" });
  expect(h.store.tasks()[0]?.cwd).toBe("/code/pew2");
  expect(JSON.stringify(r.output)).not.toContain("/code");
});

test("an ambiguous project asks instead of starting", async () => {
  const h = harness();
  const r = await h.call("start_task", { project: "billing", instruction: "fix it" });
  expect(r.output).toMatchObject({ started: false, needsClarification: true });
  expect(h.store.tasks()).toHaveLength(0);
  const none = await h.call("start_task", { project: "zzzqqq", instruction: "x" });
  expect(none.output).toMatchObject({ started: false, needsClarification: true });
});

test("a repeated call id returns the first answer without running again", async () => {
  const h = harness();
  const args = { project: "pew2", instruction: "do x" };
  const first = await h.call("start_task", args, "same");
  const second = await h.call("start_task", args, "same");
  expect(second).toEqual(first);
  expect(h.store.tasks()).toHaveLength(1);
  // Concurrent duplicates share one execution too.
  const [a, b] = await Promise.all([h.call("remember_decision", { text: "ship friday" }, "d1"), h.call("remember_decision", { text: "ship friday" }, "d1")]);
  expect(a).toEqual(b);
  expect(h.store.decisions()).toHaveLength(1);
});

test("the same instruction on the same project is not started twice under a new call id", async () => {
  const h = harness();
  await h.call("start_task", { project: "pew2", instruction: "do x" });
  const again = await h.call("start_task", { project: "pew2", instruction: "do x" });
  expect(again.output).toMatchObject({ started: false, duplicate: true });
  expect(h.store.tasks()).toHaveLength(1);
});

test("a call interrupted by a restart is not re-executed", async () => {
  const dir = scratch();
  const path = join(dir, "s.json");
  const first = await VoiceStore.open(path);
  first.journalBegin("crashed", "start_task");
  await first.flush();
  const h = harness(await VoiceStore.open(path));
  const r = await h.call("start_task", { project: "pew2", instruction: "x" }, "crashed");
  expect(r.ok).toBe(false);
  expect(r.error).toContain("unknown");
  expect(h.store.tasks()).toHaveLength(0);
});

test("follow_up, status, list and priority work on current state", async () => {
  const h = harness();
  await h.call("start_task", { project: "pew2", instruction: "a" });
  await tick();
  const second = await h.call("start_task", { project: "pew2", instruction: "b" });
  const secondId = (second.output as { task: { taskId: string } }).task.taskId;
  expect((await h.call("task_status", { taskId: secondId })).output).toMatchObject({
    task: { state: "queued", waiting: expect.stringContaining("t_1") },
  });
  // Two active tasks: status without an id asks which.
  expect((await h.call("task_status")).output).toMatchObject({ needsClarification: true });
  expect((await h.call("reprioritize_task", { taskId: secondId, priority: 9 })).ok).toBe(true);
  expect((await h.call("follow_up", { taskId: "t_1", instruction: "more" })).ok).toBe(true);
  expect(((await h.call("list_tasks", { limit: 1 })).output as { tasks: unknown[] }).tasks).toHaveLength(1);
  expect((await h.call("follow_up", { taskId: "t_99", instruction: "x" })).ok).toBe(false);
});

test("cancelling running work takes a confirmation round trip; a model cannot skip it", async () => {
  const h = harness();
  await h.call("start_task", { project: "pew2", instruction: "a" });
  await tick();
  const first = await h.call("cancel_task", { taskId: "t_1" });
  const token = (first.output as { confirmToken: string }).confirmToken;
  expect(first.output).toMatchObject({ needsConfirmation: true });
  expect(h.store.getTask("t_1")?.state).toBe("running");
  // Token without userConfirmed, and a made-up token, both fail.
  expect((await h.call("cancel_task", { taskId: "t_1", confirmToken: token })).output).toMatchObject({ needsConfirmation: true });
  expect((await h.call("cancel_task", { taskId: "t_1", confirmToken: "cf_made_up", userConfirmed: true })).output).toMatchObject({ needsConfirmation: true });
  const ok = await h.call("cancel_task", { taskId: "t_1", confirmToken: ((await h.call("cancel_task", { taskId: "t_1" })).output as { confirmToken: string }).confirmToken, userConfirmed: true });
  expect(ok.ok).toBe(true);
  expect(h.store.getTask("t_1")?.state).toBe("cancelled");
});

function block(h: ReturnType<typeof harness>, command: string, kind = "execute", requestId = "perm_1") {
  h.orchestrator.onSessionPayload("s1", {
    kind: "permission_request",
    requestId,
    params: {
      toolCall: { title: command, kind, rawInput: { command } },
      options: [
        { optionId: "yes", kind: "allow_once" },
        { optionId: "no", kind: "reject_once" },
      ],
    },
  });
}

test("approvals: shell needs an explicit yes, merge/deploy/destructive also need a token, stale ones are refused", async () => {
  const h = harness();
  await h.call("start_task", { project: "pew2", instruction: "a" });
  await tick();
  block(h, "npm test");
  const pending = (await h.call("pending_approvals")).output as { approvals: Array<{ requestId: string; risk: string }> };
  expect(pending.approvals[0]).toMatchObject({ requestId: "perm_1", risk: "shell" });

  // Shell: no explicit yes yet.
  expect((await h.call("answer_approval", { taskId: "t_1", requestId: "perm_1", decision: "approve" })).output).toMatchObject({ needsConfirmation: true });
  expect(h.answered).toEqual([]);
  // Stale request id is refused outright, no token issued.
  const stale = await h.call("answer_approval", { taskId: "t_1", requestId: "perm_0", decision: "approve", userConfirmed: true });
  expect(stale.ok).toBe(false);
  expect(stale.error).toContain("Stale");
  expect((await h.call("answer_approval", { taskId: "t_1", requestId: "perm_1", decision: "approve", userConfirmed: true })).ok).toBe(true);
  expect(h.answered).toEqual(["yes"]);

  // Deploy: token round trip.
  block(h, "wrangler deploy", "execute", "perm_2");
  const ask = await h.call("answer_approval", { taskId: "t_1", requestId: "perm_2", decision: "approve", userConfirmed: true });
  const token = (ask.output as { confirmToken: string }).confirmToken;
  expect(token).toBeTruthy();
  expect(h.answered).toHaveLength(1);
  const done = await h.call("answer_approval", { taskId: "t_1", requestId: "perm_2", decision: "approve", userConfirmed: true, confirmToken: token });
  expect(done.ok).toBe(true);
  expect(h.answered).toEqual(["yes", "yes"]);

  // Deny never needs confirmation, even for destructive.
  block(h, "rm -rf dist", "execute", "perm_3");
  expect((await h.call("answer_approval", { taskId: "t_1", requestId: "perm_3", decision: "deny" })).ok).toBe(true);
  expect(h.answered.at(-1)).toBe("no");
});

test("only the agent's report completes a task; verify is separate", async () => {
  const h = harness();
  await h.call("start_task", { project: "pew2", instruction: "a" });
  expect((await h.call("verify_task", { taskId: "t_1" })).ok).toBe(false);
  const status = (await h.call("task_status", { taskId: "t_1" })).output as { task: { state: string; note?: string } };
  expect(status.task.state).toBe("running");
  expect(status.task.note).toBeUndefined();
});

test("details are redacted and bounded; events are coalesced; alias and end_session work", async () => {
  const h = harness();
  await h.call("start_task", { project: "pew2", instruction: "a" });
  h.store.patch("t_1", { lastOutput: "ok" });
  const details = (await h.call("get_details", { taskId: "t_1" })).output as { history: unknown[] };
  expect(details.history.length).toBeGreaterThan(0);
  const events = (await h.call("recent_events", { taskId: "t_1" })).output as { events: unknown[] };
  expect(events.events.length).toBeGreaterThan(0);
  const projectId = buildRegistry(["/code/pew2"], {})[0]?.projectId;
  expect((await h.call("add_project_alias", { projectId, alias: "the app" })).ok).toBe(true);
  expect(h.aliases).toEqual(["the app"]);
  expect(await h.call("end_session")).toMatchObject({ ok: true, endSession: true });
  expect((await h.call("nope")).ok).toBe(false);
});
