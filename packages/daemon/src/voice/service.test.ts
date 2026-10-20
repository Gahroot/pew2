import { expect, test } from "bun:test";
import { handleMessage } from "../handler.js";
import type { Daemon } from "../index.js";
import type { VoiceHost } from "./dispatcher.js";
import { DaveClient } from "./dave.js";
import { scratch } from "./scratch.js";
import { contextText, deskContext, VoiceService } from "./service.js";
import { TASK_INSTRUCTIONS } from "./taskTools.js";
import type { RunningSession } from "./types.js";
import { buildRegistry } from "./registry.js";

function host(): VoiceHost & { permissionAnswers: string[] } {
  const permissionAnswers: string[] = [];
  let sessions = 0;
  return {
    permissionAnswers,
    async startSession() {
      return `s${++sessions}`;
    },
    prompt: () => new Promise<void>(() => {}),
    async cancel() {},
    answerPermission: (_s, _r, o) => {
      permissionAnswers.push(o);
      return true;
    },
    answerAsk: () => true,
    hasSession: () => true,
    lastText: () => undefined,
  };
}

interface Note {
  callId: string;
  text: string;
  speak?: boolean;
  about?: string;
}

async function service(
  env: NodeJS.ProcessEnv = { CODEX_HOME: "/nonexistent-codex-home" },
  extra: {
    dave?: DaveClient;
    runningSessions?: () => RunningSession[];
    dataDir?: string;
    callInProgress?: (callId: string) => boolean;
  } = {},
) {
  const emitted: unknown[] = [];
  const notes: Note[] = [];
  const h = host();
  const svc = await VoiceService.create({
    dataDir: scratch(),
    // Never the real ~/.ezcoder: goal runs are read from an empty scratch dir.
    goalRunsBase: scratch(),
    env,
    host: h,
    emit: (m) => emitted.push(m),
    projectPaths: async () => ["/code/pew2"],
    usableProviders: () => ["echo"],
    note: (callId, note) => void notes.push({ callId, ...note }),
    tickMs: 0,
    ...extra,
  });
  return { svc, emitted, notes, h };
}

/** A task tool call as a call sends it: the arguments unparsed. */
const call = (svc: VoiceService, callId: string, toolCallId: string, name: string, args: Record<string, unknown> = {}) =>
  svc.tool({ callId, toolCallId, name, arguments: JSON.stringify(args) });

const toolNames = (briefing: { tools: readonly Record<string, unknown>[] }) =>
  briefing.tools.map((t) => (t as { name: string }).name);

test("a briefing adds the task guidance, the state now and the task tools, never the call's own", async () => {
  const { svc } = await service();
  const briefing = await svc.brief({ callId: "c" });
  expect(briefing.instructions.startsWith(TASK_INSTRUCTIONS)).toBe(true);
  expect(briefing.instructions).toContain("Tasks now:\nA call with Pew.");
  expect(briefing.instructions).toContain("pew2");
  const names = toolNames(briefing);
  for (const name of ["start_task", "follow_up", "task_status", "list_projects", "commit", "start_goal", "resolve_reference", "approve_safe"]) {
    expect(names).toContain(name);
  }
  // The call layer has its own: approvals, questions and hanging up.
  for (const name of ["pending_approvals", "answer_approval", "answer_question", "end_session", "request_screenshot"]) {
    expect(names).not.toContain(name);
  }
  expect(new Set(names).size).toBe(names.length);
  for (const name of names) expect(svc.handles(name)).toBe(true);
  expect(svc.handles("tell_agent")).toBe(false);
  svc.dispose();
});

test("a task tool answers as JSON text, and arguments that are not a JSON object are refused", async () => {
  const { svc } = await service();
  const started = JSON.parse((await call(svc, "c", "t1", "start_task", { project: "pew2", instruction: "go" })).output);
  expect(started.task).toMatchObject({ project: "pew2" });
  const bad = await svc.tool({ callId: "c", toolCallId: "t2", name: "list_tasks", arguments: "[1" });
  expect(JSON.parse(bad.output)).toEqual({ ok: false, error: "The arguments were not valid JSON." });
  const none = JSON.parse((await svc.tool({ callId: "c", toolCallId: "t3", name: "list_tasks", arguments: "" })).output);
  expect(none.tasks).toHaveLength(1);
  svc.dispose();
});

/** A DAVE that records every request, with Triten's top objective settable. */
function fakeDave() {
  const requests: { method: string; path: string }[] = [];
  let top = "o1";
  const daveFetch = (async (url: string, init?: RequestInit) => {
    requests.push({ method: init?.method ?? "GET", path: new URL(url).pathname });
    const objective = {
      id: top,
      projectId: "p-tri",
      projectName: "Triten",
      objective: "Call the client about the secret deal",
      humanOnly: false,
    };
    return new Response(
      JSON.stringify({ top: objective, queue: [objective], projects: [], decisions: [] }),
    );
  }) as unknown as typeof fetch;
  return {
    requests,
    setTop: (id: string) => void (top = id),
    client: new DaveClient({ off: false, origin: "http://127.0.0.1:4317" }, daveFetch),
  };
}

test("DAVE: a briefing makes exactly one read-only GET of its focus list; the tools exist only when enabled", async () => {
  const env = { CODEX_HOME: "/nonexistent-codex-home" };
  const dave = fakeDave();
  const { svc } = await service(env, { dave: dave.client });
  const briefing = await svc.brief({ callId: "c" });
  expect(toolNames(briefing)).toEqual(expect.arrayContaining(["check_backlog", "delegate_backlog_item"]));
  expect(dave.requests).toEqual([{ method: "GET", path: "/api/intel/focus" }]);

  await call(svc, "c", "d1", "check_backlog", { about: "priorities" });
  // Asking adds exactly the one read it needs; nothing else touched DAVE.
  expect(dave.requests).toEqual([
    { method: "GET", path: "/api/intel/focus" },
    { method: "GET", path: "/api/intel/focus" },
  ]);
  svc.dispose();

  // Opted out of the check-in: a briefing contacts DAVE not at all, and the tools stay.
  const quiet = fakeDave();
  const optedOut = await service({ ...env, PEW2_DAVE_CHECKIN: "off" }, { dave: quiet.client });
  const still = await optedOut.svc.brief({ callId: "c" });
  expect(quiet.requests).toEqual([]);
  expect(toolNames(still)).toContain("check_backlog");
  optedOut.svc.dispose();

  const off = await service(env);
  const plain = await off.svc.brief({ callId: "c" });
  expect(toolNames(plain)).not.toContain("check_backlog");
  expect(toolNames(plain)).not.toContain("delegate_backlog_item");
  expect(off.svc.handles("check_backlog")).toBe(true); // routed here either way; it answers that DAVE is off
  off.svc.dispose();
});

test("DAVE: a briefing never waits on a DAVE that does not answer", async () => {
  const hung = new DaveClient(
    { off: false, origin: "http://127.0.0.1:4317" },
    (() => new Promise<Response>(() => {})) as unknown as typeof fetch,
  );
  const { svc } = await service(undefined, { dave: hung });
  const started = Date.now();
  await svc.brief({ callId: "c" });
  expect(Date.now() - started).toBeLessThan(5_000);
  svc.dispose();
});

test("check-in: one sentence about what happened since, said once, naming DAVE's changed project only", async () => {
  const env = { CODEX_HOME: "/nonexistent-codex-home" };
  const dave = fakeDave();
  const { svc } = await service(env, { dave: dave.client });

  // First sight of DAVE records silently; nothing has happened yet.
  const first = await svc.brief({ callId: "c1" });
  expect(first.instructions).not.toContain("\n\nCheck-in:");
  await svc.callEnded("c1");

  // Two agents finish, one is waiting on an approval, and DAVE's top pick for Triten changes.
  const enqueue = (name: string) =>
    svc.orchestrator.enqueue({
      projectId: `p_${name}`,
      projectName: name,
      cwd: `/code/${name}`,
      providerId: "echo",
      title: name,
      prompt: name,
    });
  const [a, b, c] = [enqueue("alpha"), enqueue("beta"), enqueue("gamma")];
  await new Promise((r) => setTimeout(r, 0));
  for (const done of [a, b])
    svc.store.transition(done.taskId, "completed", "task.completed", "The agent says it finished.");
  const sessionId = svc.store.getTask(c.taskId)?.sessionId;
  if (!sessionId) throw new Error("expected gamma to have a session");
  svc.orchestrator.onSessionPayload(sessionId, {
    kind: "permission_request",
    requestId: "perm_1",
    params: {
      toolCall: { title: "npm test", kind: "execute" },
      options: [{ optionId: "y", kind: "allow_once" }],
    },
  });
  dave.setTop("o2");

  const second = await svc.brief({ callId: "c2" });
  const say =
    "Two agents finished, one is blocked by an approval, and DAVE has a new recommendation for Triten. Want the details?";
  expect(second.instructions).toContain(`\n\nCheck-in: ${say}`);
  // Project names only: DAVE's objective text never reaches the model.
  expect(second.instructions).not.toContain("secret deal");
  await svc.callEnded("c2");

  // Heard once: the next call repeats neither the results nor DAVE's news; the live approval still counts.
  const third = await svc.brief({ callId: "c3" });
  expect(third.instructions).toContain("\n\nCheck-in: One is blocked by an approval. Want the details?");
  svc.dispose();
});

test("focus survives a new call and a restart, as working-memory lines", async () => {
  const dataDir = scratch();
  const first = await service(undefined, { dataDir });
  await first.svc.brief({ callId: "c1" });
  await call(first.svc, "c1", "s", "start_task", { project: "pew2", instruction: "fix the login screen" });
  await first.svc.callEnded("c1");
  first.svc.dispose();

  const again = await service(undefined, { dataDir });
  const { instructions } = await again.svc.brief({ callId: "c2" });
  expect(instructions).toContain("Working memory: current project pew2");
  expect(instructions).toContain("Working memory: current task fix the login screen");
  again.svc.dispose();
});

test("contextText carries goal progress and an open question per task", () => {
  const text = contextText({
    eventId: 3,
    projects: [],
    unheard: [],
    tasks: [
      {
        taskId: "t_1",
        projectId: "p",
        projectName: "pew2",
        title: "Login goal",
        state: "running",
        priority: 0,
        createdAt: 1,
        updatedAt: 2,
        goal: {
          done: 2,
          total: 3,
          status: "running",
          verified: "pass",
          needsYou: "Grant the browser permission",
        },
        question: { requestId: "ask_1", text: "Use the staging database?", options: ["Yes", "No"] },
      },
    ],
  });
  expect(text).toContain(
    "  Goal: 2 of 3 milestones, run running, verifier passed, needs you: Grant the browser permission",
  );
  expect(text).toContain("  Question ask_1: Use the staging database? (options: Yes, No)");
});

test("events are broadcast, an answer elsewhere unblocks, and calls in progress hear the news once", async () => {
  let live = true;
  const { svc, emitted, notes } = await service(undefined, { callInProgress: () => live });
  await call(svc, "c0", "t1", "start_task", { project: "pew2", instruction: "go" });
  const approval = (requestId: string) =>
    svc.orchestrator.onSessionPayload("s1", {
      kind: "permission_request",
      requestId,
      params: {
        toolCall: { title: "npm test", kind: "execute" },
        options: [{ optionId: "y", kind: "allow_once" }],
      },
    });
  // No call open: nothing to tell (the task's own session sends the banner).
  approval("perm_1");
  expect(notes).toEqual([]);
  svc.orchestrator.onPermissionAnswered("s1", "perm_1");
  expect(svc.store.getTask("t_1")?.state).toBe("running");
  const kinds = emitted.map((m) => (m as { event: { kind: string } }).event.kind);
  expect(kinds).toEqual(["task.queued", "task.started", "task.approval", "task.progress"]);

  // A call in progress hears a new approval, spoken, once.
  await svc.brief({ callId: "c1" });
  approval("perm_2");
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ callId: "c1", speak: true, about: "pew2" });
  expect(notes[0]?.text).toStartWith("[Update] pew2 (taskId t_1): ");
  expect(notes[0]?.text).toContain("Call list_waiting");

  // A call whose end never arrived stops hearing news once it is no longer in progress.
  live = false;
  svc.orchestrator.onPermissionAnswered("s1", "perm_2");
  approval("perm_3");
  expect(notes).toHaveLength(1);
  svc.dispose();
});

test("a call's end persists what it heard, and later events come back in the next snapshot", async () => {
  const { svc } = await service();
  await call(svc, "c0", "t1", "start_task", { project: "pew2", instruction: "go" });
  expect((await svc.snapshot()).unheard.length).toBeGreaterThan(0);
  await svc.brief({ callId: "c1" });
  const heard = svc.store.lastEventId;
  await svc.callEnded("c1");
  expect(svc.store.heardEventId).toBe(heard);
  expect((await svc.snapshot()).unheard).toEqual([]);
  // An unknown call (opened before a restart) changes nothing.
  await svc.callEnded("never-briefed");
  expect(svc.store.heardEventId).toBe(heard);
  svc.dispose();
});

test("hands-free auto-approval runs only while a briefed call is in progress", async () => {
  let live = true;
  const { svc } = await service(undefined, { callInProgress: () => live });
  await svc.brief({ callId: "c1" });
  await call(svc, "c1", "p1", "set_approval_policy", { autoApproveSafe: true });
  expect(svc.orchestrator.autoApprove?.()).toBe(true);
  live = false;
  expect(svc.orchestrator.autoApprove?.()).toBe(false);
  live = true;
  await svc.callEnded("c1");
  expect(svc.orchestrator.autoApprove?.()).toBe(false);
  svc.dispose();
});

// ---- handler wiring with a fake daemon ---------------------------------------

test("handler: hello and voice.sync answer voice.state; a call's task tools reach the service, once per id", async () => {
  const { svc } = await service();
  const ended: string[] = [];
  const fake = {
    refreshProviders: async () => ({ errors: [] }),
    voiceTasks: async () => svc,
    voiceStatuses: () => [],
    desktopActivity: () => ({ t: "desktop.activity", sessions: [] }),
    voice: {
      knowsCall: (callId: string) => callId === "call_1",
      runOnce: (() => {
        const answered = new Map<string, Promise<unknown>>();
        return (callId: string, toolCallId: string, run: () => Promise<unknown>) => {
          const key = `${callId}/${toolCallId}`;
          if (!answered.has(key)) answered.set(key, run());
          return answered.get(key);
        };
      })(),
      noteAction: () => {},
      endCall: (callId: string) => void ended.push(callId),
    },
  } as unknown as Daemon;
  const replies: Array<Record<string, unknown>> = [];
  const send = (m: Record<string, unknown>) =>
    handleMessage(JSON.stringify(m), {
      daemon: fake,
      reply: (r) => replies.push(r as Record<string, unknown>),
      broadcast: () => {},
    });

  await send({ t: "hello", wire: 2, role: "app", deviceId: "d1" });
  expect(replies.some((r) => r.t === "voice.state")).toBe(true);

  const tool = {
    t: "voice.tool",
    requestId: "r1",
    callId: "call_1",
    toolCallId: "fc_1",
    name: "start_task",
    arguments: JSON.stringify({ project: "pew2", instruction: "x" }),
  };
  await send(tool);
  await send({ ...tool, requestId: "r2" });
  const results = replies.filter((r) => r.t === "voice.tool");
  expect(results).toHaveLength(2);
  expect(results[0]).toMatchObject({ requestId: "r1", callId: "call_1", toolCallId: "fc_1" });
  expect(results[1]?.output).toBe(results[0]?.output);
  expect(JSON.parse(results[0]?.output as string).task).toMatchObject({ project: "pew2" });
  expect(svc.store.tasks()).toHaveLength(1);

  await send({ t: "voice.sync", since: 0 });
  const state = replies.at(-1) as { t: string; events: unknown[] };
  expect(state.t).toBe("voice.state");
  expect(state.events.length).toBeGreaterThan(0);

  // The call's end reaches both halves.
  await svc.brief({ callId: "call_1" });
  await send({ t: "voice.end", callId: "call_1", reason: "hangup" });
  await new Promise((r) => setTimeout(r, 10));
  expect(ended).toEqual(["call_1"]);
  expect(svc.store.heardEventId).toBe(svc.store.lastEventId);
  svc.dispose();
});

test("tasks saved before repositories were tracked are filed under theirs at startup", async () => {
  const dataDir = scratch();
  const deps = {
    dataDir,
    env: { CODEX_HOME: "/nonexistent-codex-home" },
    host: host(),
    emit: () => undefined,
    projectPaths: async () => ["/code/billing"],
    usableProviders: () => ["echo"],
    tickMs: 0,
  };
  // An older daemon's task in an ezcoder checkout that has since been deleted.
  const first = await VoiceService.create({ ...deps, detectWorktree: async () => undefined });
  const task = first.store.createTask({
    projectId: "proj_old",
    projectName: "ez-mun7ig9t",
    cwd: "/home/.ezcoder/worktrees/billing/ez-mun7ig9t",
    providerId: "echo",
    title: "Fix the login",
    prompt: "fix it",
  });
  first.store.transition(task.taskId, "completed", "task.completed", "Done.");
  await first.store.flush();
  first.dispose();

  const second = await VoiceService.create({
    ...deps,
    detectWorktree: async (path: string) =>
      path.includes("/worktrees/billing/") ? { repo: "billing", gone: true } : undefined,
  });
  const billing = (await second.projects()).find((p) => p.name === "billing");
  expect(second.store.getTask(task.taskId)?.repo).toEqual({
    projectId: billing?.projectId,
    name: "billing",
    branch: "ez-mun7ig9t",
  });
  // Idempotent: nothing left to fill on the next start.
  expect(await second.backfillRepos()).toBe(0);
  // And the model hears it as billing's work.
  const text = contextText(await second.snapshot());
  expect(text).toContain("billing, on the ez-mun7ig9t branch");
  expect(text).not.toMatch(/Task t_\d+ ez-mun7ig9t/);
  second.dispose();
});

test("voice.dismiss persists, broadcasts, and drops the task from every later picture", async () => {
  const { svc, emitted } = await service();
  const a = svc.store.createTask({
    projectId: "p1",
    projectName: "pew2",
    cwd: "/code/pew2",
    providerId: "echo",
    title: "a",
    prompt: "a",
  });
  svc.store.transition(a.taskId, "completed", "task.completed", "done");
  const b = svc.store.createTask({
    projectId: "p2",
    projectName: "other",
    cwd: "/code/other",
    providerId: "echo",
    title: "b",
    prompt: "b",
    repo: { projectId: "p3", name: "repo" },
  });
  svc.store.transition(b.taskId, "failed", "task.failed", "broke");
  const live = svc.store.createTask({
    projectId: "p1",
    projectName: "pew2",
    cwd: "/code/pew2",
    providerId: "echo",
    title: "live",
    prompt: "live",
  });
  emitted.length = 0;

  // Through the handler, as either transport delivers it; a live task id is ignored.
  await handleMessage(JSON.stringify({ t: "voice.dismiss", taskIds: [a.taskId, live.taskId] }), {
    daemon: { voiceTasks: async () => svc } as unknown as Daemon,
    reply: () => {},
    broadcast: () => {},
  });
  expect(emitted).toEqual([{ t: "voice.dismissed", taskIds: [a.taskId] }]);
  // A repository's row dismisses its worktree tasks too.
  expect(await svc.dismiss({ taskIds: [], projectIds: ["p3"] })).toEqual([b.taskId]);

  const state = await svc.state(0);
  expect(state.snapshot.tasks.map((t) => t.taskId)).toEqual([live.taskId]);
  expect(state.events.every((e) => e.taskId === live.taskId)).toBe(true);
  expect(state.dismissed).toEqual([a.taskId, b.taskId]);
  expect(svc.store.getTask(a.taskId)).toBeDefined(); // still on disk for the model to ask about
});

test("worktrees only git knows about are filed under their repository, deleted ones left out", async () => {
  const svc = await VoiceService.create({
    dataDir: scratch(),
    env: { CODEX_HOME: "/nonexistent-codex-home" },
    host: host(),
    emit: () => undefined,
    projectPaths: async () => ["/code/triten-os"],
    usableProviders: () => ["echo"],
    detectWorktree: async () => undefined,
    registeredWorktrees: async (root: string) =>
      root === "/code/triten-os"
        ? [
            { path: "/home/.ezcoder/worktrees/triten-os/ez-mv1", branch: "fix/boot", gone: false },
            { path: "/home/.ezcoder/worktrees/triten-os/ez-old", gone: true },
          ]
        : [],
    tickMs: 0,
  });
  const projects = await svc.projects();
  const root = projects.find((p) => p.name === "triten-os");
  expect(projects.map((p) => p.name)).toEqual(["triten-os", "triten-os (fix/boot)"]);
  expect(projects[1]?.worktree).toEqual({
    repo: "triten-os",
    repoId: root?.projectId,
    branch: "fix/boot",
  });
  svc.dispose();
});

const deskSessions: RunningSession[] = [
  {
    sessionId: "desk:codex:1",
    providerId: "codex",
    cwd: "/code/other",
    state: "idle",
    idleMs: 0,
    origin: "desktop",
  },
  {
    sessionId: "desk:claude:2",
    providerId: "claude",
    agentName: "Claude Code",
    cwd: "/code/pew2/src",
    state: "working",
    idleMs: 0,
    origin: "desktop",
    title: "Fix login",
  },
  {
    sessionId: "p1",
    providerId: "echo",
    cwd: "/code/pew2",
    state: "working",
    idleMs: 0,
    origin: "pew2",
  },
];

test("deskContext lists only desk sessions, working first, and is empty without any", () => {
  const projects = buildRegistry(["/code/pew2"], {});
  expect(deskContext(deskSessions, projects)).toBe(
    "Running on the computer now:\n- Claude Code in pew2 (working, started at the computer): Fix login\n- codex in other (idle, started at the computer)",
  );
  expect(deskContext(deskSessions.slice(2), projects)).toBe("");
  expect(deskContext([], projects)).toBe("");
});

test("a briefing tells the model what is running at the computer", async () => {
  const { svc } = await service(undefined, { runningSessions: () => deskSessions });
  const { instructions } = await svc.brief({ callId: "c" });
  expect(instructions).toContain("Running on the computer now:");
  svc.dispose();
});

test("voice.send hands a held screenshot to a task, and says why when it cannot", async () => {
  const { svc } = await service();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const attached = await svc.attach({ requestId: "r1", name: "fix.png", mimeType: "image/png", data: png });
  const attachmentId = attached.attachment?.attachmentId ?? "missing";
  await call(svc, "c", "t1", "start_task", { project: "pew2", instruction: "go" });

  const sent = await svc.send({ requestId: "s1", attachmentId, taskId: "t_1" });
  expect(sent).toEqual({ t: "voice.sent", requestId: "s1", ok: true });

  const refused = await svc.send({ requestId: "s2", attachmentId: "a_nope", taskId: "t_1" });
  expect(refused).toMatchObject({ t: "voice.sent", requestId: "s2", ok: false });
  expect(typeof refused.error).toBe("string");
  svc.dispose();
});
