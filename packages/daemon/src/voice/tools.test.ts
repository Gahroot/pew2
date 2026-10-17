import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Orchestrator, type VoiceHost } from "./dispatcher.js";
import { buildRegistry } from "./registry.js";
import { scratch } from "./scratch.js";
import { VoiceStore } from "./store.js";
import type { RunningSession, SessionPeek } from "./types.js";
import { realtimeSession, ToolExecutor, TOOL_NAMES, VOICE_INSTRUCTIONS, VOICE_TOOLS } from "./tools.js";

function harness(
  store = VoiceStore.memory(),
  projects = buildRegistry(["/code/pew2", "/code/billing-api", "/code/billing-web"], {}),
  running?: () => RunningSession[],
  peek?: (sessionId: string) => SessionPeek | undefined,
) {
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
  const aliases: string[] = [];
  const executor = new ToolExecutor({
    store,
    orchestrator,
    projects: async () => projects,
    usableProviders: () => ["echo"],
    runningSessions: running,
    peekSession: peek,
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
  for (const name of ["list_projects", "resolve_project", "start_task", "follow_up", "task_status", "list_tasks", "whats_running", "reprioritize_task", "pause_task", "resume_task", "cancel_task", "pending_approvals", "answer_approval", "recent_events", "get_details", "remember_decision", "end_session"]) {
    expect(TOOL_NAMES).toContain(name);
  }
  const session = realtimeSession({ voice: "marin" }) as {
    tools: unknown[];
    audio: { input: { turn_detection: { type: string; interrupt_response: boolean } } };
  };
  expect(session.tools).toHaveLength(VOICE_TOOLS.length);
  // No marker: an older app never answers itself, so the server must.
  expect(session.audio.input.turn_detection).toMatchObject({ type: "server_vad", interrupt_response: true, create_response: true });
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

test("a repository's tasks include its worktrees', and list_projects says which is which", async () => {
  const worktree = { repo: "billing", root: "/code/billing", branch: "fix/login" };
  const projects = buildRegistry(["/wt/billing/ez-abc123", "/code/pew2"], {}, undefined, (path) =>
    path === "/wt/billing/ez-abc123" ? worktree : undefined,
  );
  const h = harness(VoiceStore.memory(), projects);
  // "the login fix" names the worktree by branch; plain "billing" is the main checkout.
  // Reported as the repository's work, with the branch as a detail.
  const inWorktree = await h.call("start_task", { project: "fix login", instruction: "a" });
  expect(inWorktree.output).toMatchObject({ started: true, task: { project: "billing", branch: "fix/login" } });
  await h.call("start_task", { project: "pew2", instruction: "b" });

  const repo = projects.find((p) => p.name === "billing");
  const listed = (await h.call("list_tasks", { projectId: repo?.projectId })).output as { tasks: { project: string }[] };
  expect(listed.tasks.map((t) => t.project)).toEqual(["billing"]);

  // One entry per repository: the worktree is a branch under billing, not a project of its own.
  const { projects: spoken } = (await h.call("list_projects")).output as { projects: Record<string, unknown>[] };
  expect(spoken.map((p) => p.name)).toEqual(["billing", "pew2"]);
  const inBranch = projects.find((p) => p.worktree)?.projectId;
  expect(spoken[0]).toEqual({ projectId: repo?.projectId, name: "billing", branches: [{ projectId: inBranch, branch: "fix/login" }] });

  // The task knows its repository, so a client lists it under billing too.
  const view = h.store.tasks().find((t) => t.projectName === "billing (fix/login)");
  expect(view?.repo).toEqual({ projectId: repo?.projectId, name: "billing", branch: "fix/login" });
});

test("progress and completion on a branch are reported as the repository's", async () => {
  const projects = buildRegistry(["/wt/billing/ez-abc123"], {}, undefined, () => ({
    repo: "billing",
    root: "/code/billing",
    branch: "fix/login",
  }));
  const h = harness(VoiceStore.memory(), projects);
  const events: { repo?: unknown; projectName: string }[] = [];
  h.store.subscribe((e) => events.push(e));
  await h.call("start_task", { project: "fix login", instruction: "a" });
  const task = h.store.tasks()[0];
  if (!task) throw new Error("no task");
  h.store.transition(task.taskId, "completed", "task.completed", "The agent says it finished.");

  // Every event the task emits carries its repository, so each reader can say so.
  const repo = { projectId: projects.find((p) => p.path === "/code/billing")?.projectId, name: "billing", branch: "fix/login" };
  expect(events.length).toBeGreaterThan(1);
  for (const e of events) expect(e.repo).toEqual(repo);

  const { events: told } = (await h.call("recent_events", { sinceEventId: 0 })).output as { events: Record<string, unknown>[] };
  expect(told.at(-1)).toMatchObject({ project: "billing", branch: "fix/login", kind: "task.completed" });
});

test("a dozen ezcoder checkouts are one repository with branches, and deleted ones are not offered", async () => {
  const worktrees: Record<string, { repo: string; root?: string; branch?: string; gone?: boolean }> = {};
  const paths = ["/code/black-mountain-fund"];
  for (let i = 0; i < 9; i++) {
    const path = `/home/.ezcoder/worktrees/black-mountain-fund/ez-${i}`;
    paths.push(path);
    worktrees[path] = { repo: "black-mountain-fund", root: "/code/black-mountain-fund", branch: `feat/${i}` };
  }
  // Deleted: only the layout is left, so the checkout is found by name.
  worktrees["/home/.ezcoder/worktrees/black-mountain-fund/ez-old"] = { repo: "black-mountain-fund", gone: true };
  paths.push("/home/.ezcoder/worktrees/black-mountain-fund/ez-old", "/code/pew2");
  const projects = buildRegistry(paths, {}, undefined, (path) => worktrees[path]);
  expect(projects.some((p) => p.path.endsWith("ez-old"))).toBe(false);

  const h = harness(VoiceStore.memory(), projects);
  const { projects: spoken } = (await h.call("list_projects")).output as {
    projects: { name: string; branches?: unknown[]; moreBranches?: number }[];
  };
  expect(spoken.map((p) => p.name)).toEqual(["black-mountain-fund", "pew2"]);
  // Named up to a handful, then counted: still one short line to say.
  expect(spoken[0]?.branches).toHaveLength(6);
  expect(spoken[0]?.moreBranches).toBe(3);
});

test("whats_running lists desk-started conversations beside tasks and ranks blocked first", async () => {
  const live: RunningSession[] = [
    { sessionId: "d1", providerId: "claude", agentName: "Claude Code", cwd: "/code/pew2/packages/app", state: "working", idleMs: 1000 },
    { sessionId: "d2", providerId: "codex", cwd: "/code/billing-api", state: "needs_you", idleMs: 5000 },
    { sessionId: "d3", providerId: "codex", cwd: "/elsewhere/scratch", state: "idle", idleMs: 600_000 },
  ];
  const h = harness(VoiceStore.memory(), undefined, () => live);
  const r = await h.call("whats_running");
  const out = r.output as { tasks: unknown[]; otherSessions: { project: string; state: string; agent: string }[]; summary: string };
  expect(out.tasks).toHaveLength(0);
  expect(out.otherSessions.map((s) => [s.project, s.state])).toEqual([
    ["billing-api", "needs_you"],
    ["pew2", "working"],
    ["scratch", "idle"],
  ]);
  expect(out.otherSessions[0]?.agent).toBe("codex");
  expect(out.summary).toContain("2 other");
  expect(JSON.stringify(out)).not.toContain("/code");
});

test("whats_running labels a desk session with its ref, origin, title and tool", async () => {
  const live: RunningSession[] = [
    { sessionId: "desk:claude:abc", providerId: "claude", agentName: "Claude Code", cwd: "/code/pew2", state: "working", idleMs: 0, origin: "desktop", title: "Fix login", tool: "running tests" },
    { sessionId: "s9", providerId: "codex", cwd: "/code/billing-api", state: "idle", idleMs: 0, origin: "pew2" },
  ];
  const out = (await harness(VoiceStore.memory(), undefined, () => live).call("whats_running")).output as { otherSessions: Record<string, unknown>[] };
  expect(out.otherSessions[0]).toMatchObject({ sessionRef: "desk:claude:abc", startedAt: "computer", title: "Fix login", tool: "running tests", project: "pew2" });
  expect(out.otherSessions[1]).toMatchObject({ sessionRef: "s9", startedAt: "app" });
  expect(out.otherSessions[1]?.title).toBeUndefined();
});

describe("peek_session", () => {
  const live: RunningSession[] = [
    { sessionId: "desk:claude:abc", providerId: "claude", agentName: "Claude Code", cwd: "/code/pew2/packages/app", state: "working", idleMs: 0, origin: "desktop" },
    { sessionId: "s9", providerId: "codex", cwd: "/code/billing-api", state: "idle", idleMs: 0 },
  ];
  const peek = (id: string): SessionPeek | undefined =>
    id === "desk:claude:abc" ? { lastPrompt: "fix the login screen", latest: "Editing /code/pew2/app.tsx now", tool: "Edit" } : id === "s9" ? { latest: "done" } : undefined;

  test("with an explicit ref, reports without a path", async () => {
    const r = await harness(VoiceStore.memory(), undefined, () => live, peek).call("peek_session", { sessionRef: "s9" });
    expect(r.ok).toBe(true);
    expect(r.output).toMatchObject({ project: "billing-api", agent: "codex", state: "idle", startedAt: "app", latest: "done" });
  });

  test("defaults to the one working conversation", async () => {
    const r = await harness(VoiceStore.memory(), undefined, () => live, peek).call("peek_session");
    expect(r.output).toMatchObject({ project: "pew2", agent: "Claude Code", startedAt: "computer", lastPrompt: "fix the login screen", tool: "Edit" });
    expect(JSON.stringify(r.output)).not.toContain("/code");
  });

  test("an unknown ref fails", async () => {
    const r = await harness(VoiceStore.memory(), undefined, () => live, peek).call("peek_session", { sessionRef: "nope" });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.output)).toContain("whats_running");
  });

  test("several working asks which", async () => {
    const both = live.map((s) => ({ ...s, state: "working" as const }));
    const r = await harness(VoiceStore.memory(), undefined, () => both, peek).call("peek_session");
    const out = r.output as { needsClarification: boolean; sessions: { sessionRef: string }[] };
    expect(out.needsClarification).toBe(true);
    expect(out.sessions.map((s) => s.sessionRef)).toEqual(["desk:claude:abc", "s9"]);
    expect(JSON.stringify(out)).not.toContain("/code");
  });

  test("without the dep it fails plainly", async () => {
    const r = await harness(VoiceStore.memory(), undefined, () => live).call("peek_session");
    expect(r.ok).toBe(false);
  });
});

test("whats_running does not repeat a session a task already owns", async () => {
  const h = harness(VoiceStore.memory(), undefined, () => [{ sessionId: "s1", providerId: "echo", cwd: "/code/pew2", state: "working", idleMs: 0 }]);
  await h.call("start_task", { project: "pew2", instruction: "do it" });
  await tick();
  const out = (await h.call("whats_running")).output as { tasks: { session?: string }[]; otherSessions: unknown[] };
  expect(out.tasks).toHaveLength(1);
  expect(out.tasks[0]?.session).toBe("working");
  expect(out.otherSessions).toHaveLength(0);
});

test("whats_running on a host that cannot list sessions still answers with tasks and says so", async () => {
  const h = harness();
  await h.call("start_task", { project: "pew2", instruction: "do it" });
  await tick();
  const out = (await h.call("whats_running")).output as { tasks: unknown[]; otherSessions: unknown[]; note?: string };
  expect(out.tasks).toHaveLength(1);
  expect(out.otherSessions).toEqual([]);
  expect(out.note).toContain("cannot list");
});

test("session config: clientVad hands turn-taking to the app, its absence keeps the server answering", () => {
  type Input = {
    noise_reduction: unknown;
    transcription?: unknown;
    turn_detection: { threshold: number; silence_duration_ms: number; create_response: boolean; interrupt_response: boolean };
  };
  const input = (s: Record<string, unknown>) => (s.audio as { input: Input }).input;
  const old = input(realtimeSession());
  const next = input(realtimeSession({ clientVad: true }));
  expect(old.turn_detection).toMatchObject({ create_response: true, interrupt_response: true });
  expect(old.transcription).toBeUndefined();
  expect(next.turn_detection).toMatchObject({ create_response: false, interrupt_response: false });
  expect(next.transcription).toEqual({ model: "gpt-4o-mini-transcribe" });
  // Noise hardening is shared by both.
  for (const i of [old, next]) {
    expect(i.noise_reduction).toEqual({ type: "near_field" });
    expect(i.turn_detection.threshold).toBe(0.7);
    expect(i.turn_detection.silence_duration_ms).toBe(600);
  }
});
