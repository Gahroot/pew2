import { expect, test } from "bun:test";
import { handleMessage } from "../handler.js";
import type { Daemon } from "../index.js";
import { pushVoiceEvent, PushRegistry, voiceMessages } from "../push.js";
import type { VoiceHost } from "./dispatcher.js";
import { DaveClient } from "./dave.js";
import { scratch } from "./scratch.js";
import { contextText, deskContext, VoiceService } from "./service.js";
import type { RunningSession, VoiceEvent } from "./types.js";
import { buildRegistry } from "./registry.js";
import { AccountAuth, type VoiceAccount } from "./accountAuth.js";

const connectedAccount = () =>
  AccountAuth.create({
    dataDir: "unused",
    storage: {
      read: async () => ({
        accessToken: "own-access",
        refreshToken: "own-refresh",
        expiresAt: Date.now() + 3600_000,
      }),
      replace: async () => {},
      delete: async () => {},
    },
    probe: async () => ({ ok: true }),
  });

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

const mintFetch = (async () =>
  new Response(JSON.stringify({ value: "ek_test", expires_at: 99 }))) as unknown as typeof fetch;

async function service(
  env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "sk-test", CODEX_HOME: "/nonexistent-codex-home" },
  extra: {
    dave?: DaveClient;
    runningSessions?: () => RunningSession[];
    dataDir?: string;
    account?: VoiceAccount;
    fetch?: typeof fetch;
  } = {},
) {
  const emitted: unknown[] = [];
  const pushed: VoiceEvent[] = [];
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
    push: (e) => void pushed.push(e),
    fetch: mintFetch,
    account: await connectedAccount(),
    tickMs: 0,
    ...extra,
  });
  return { svc, emitted, pushed, h };
}

test("voice never adopts CLI credentials or falls back to API billing", async () => {
  const dataDir = scratch();
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  await fsp.writeFile(
    path.join(dataDir, "auth.json"),
    JSON.stringify({ tokens: { access_token: "cli-access", refresh_token: "cli-refresh" } }),
  );
  await fsp.writeFile(
    path.join(dataDir, "voice-prefs.json"),
    JSON.stringify({ openaiApiKey: "prefs-key" }),
  );
  const account = await AccountAuth.create({ dataDir, probe: async () => ({ ok: true }) });
  let requests = 0;
  const { svc } = await service(
    { OPENAI_API_KEY: "env-key", CODEX_HOME: dataDir },
    {
      dataDir,
      account,
      fetch: (async () => {
        requests++;
        return new Response("{}");
      }) as unknown as typeof fetch,
    },
  );
  expect(await svc.open({ voiceSessionId: "v", source: "in_app" })).toMatchObject({
    t: "voice.unavailable",
    code: "account-required",
  });
  expect(requests).toBe(0);
  svc.dispose();
});

test("disconnect ends voice legs, preserves coding tasks and fences an in-flight mint", async () => {
  let finish: ((value: Response) => void) | undefined;
  const { svc, emitted } = await service();
  await svc.open({ voiceSessionId: "active", source: "in_app" });
  const task = svc.store.createTask({
    projectId: "p",
    projectName: "pew2",
    cwd: "/code/pew2",
    providerId: "echo",
    title: "Coding",
    prompt: "Work",
  });
  await svc.accountRequest({ t: "voice.account.disconnect", requestId: "d" }, "phone");
  expect(emitted).toContainEqual(
    expect.objectContaining({
      t: "voice.unavailable",
      voiceSessionId: "active",
      code: "account-required",
    }),
  );
  expect(svc.store.getTask(task.taskId)).toBeDefined();
  expect(await svc.open({ voiceSessionId: "again", source: "in_app" })).toMatchObject({
    t: "voice.unavailable",
    code: "account-required",
  });
  svc.dispose();
  const pending = await service(undefined, {
    fetch: (async () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      })) as unknown as typeof fetch,
  });
  const opening = pending.svc.open({ voiceSessionId: "late", source: "in_app" });
  for (let i = 0; i < 400 && !finish; i++)
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  expect(finish).toBeDefined();
  await pending.svc.accountRequest({ t: "voice.account.disconnect", requestId: "d" }, "phone");
  finish?.(new Response(JSON.stringify({ value: "late-secret", expires_at: 999 })));
  const result = await opening;
  expect(result.t).toBe("voice.unavailable");
  expect(JSON.stringify(result)).not.toContain("late-secret");
  pending.svc.dispose();
});

test("shared handler requires transport identity for account operations", async () => {
  const { svc } = await service();
  const replies: unknown[] = [];
  const context = {
    daemon: { voice: async () => svc } as unknown as Daemon,
    reply: (m: unknown) => {
      replies.push(m);
    },
    broadcast: () => {},
  };
  await handleMessage(JSON.stringify({ t: "voice.account.disconnect", requestId: "r" }), context);
  expect(replies.at(-1)).toMatchObject({ t: "error", code: "unauthorized" });
  expect(await svc.account.accessToken()).toMatchObject({ ok: true });
  await handleMessage(JSON.stringify({ t: "voice.account.disconnect", requestId: "r" }), {
    ...context,
    deviceId: "verified-phone",
  });
  expect(replies.at(-1)).toMatchObject({
    t: "voice.account.state",
    requestId: "r",
    state: "not-connected",
  });
  svc.dispose();
});

test("open mints a secret and returns the session config plus a snapshot", async () => {
  const { svc } = await service();
  const ready = (await svc.open({ voiceSessionId: "v", source: "airpods" })) as {
    t: string;
    realtime: { secret: string; session: { type: string; tools: unknown[] } };
    snapshot: { opening: string; projects: unknown[] };
  };
  expect(ready.t).toBe("voice.ready");
  expect(ready.realtime.secret).toBe("ek_test");
  expect(ready.realtime.session.type).toBe("realtime");
  expect(ready.realtime.session.tools.length).toBeGreaterThan(5);
  expect(ready.snapshot.opening).toContain("AirPods");
  expect(ready.snapshot.projects).toHaveLength(1);
  svc.dispose();
});

const toolNames = (ready: unknown) =>
  (
    (ready as { realtime: { session: { tools: { name: string }[] } } }).realtime.session.tools ?? []
  ).map((t) => t.name);

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

const instructionsOf = (ready: unknown) =>
  (ready as { realtime: { session: { instructions: string } } }).realtime.session.instructions;

test("DAVE: open() makes exactly one read-only GET of its focus list; the tools exist only when enabled", async () => {
  const env = { OPENAI_API_KEY: "sk-test", CODEX_HOME: "/nonexistent-codex-home" };
  const dave = fakeDave();
  const { svc } = await service(env, { dave: dave.client });
  const ready = await svc.open({ voiceSessionId: "v", source: "in_app" });
  expect(toolNames(ready)).toEqual(
    expect.arrayContaining(["check_backlog", "delegate_backlog_item"]),
  );
  expect(dave.requests).toEqual([{ method: "GET", path: "/api/intel/focus" }]);

  await svc.tool({
    voiceSessionId: "v",
    callId: "d1",
    name: "check_backlog",
    args: { about: "priorities" },
  });
  // Asking adds exactly the one read it needs; nothing else touched DAVE.
  expect(dave.requests).toEqual([
    { method: "GET", path: "/api/intel/focus" },
    { method: "GET", path: "/api/intel/focus" },
  ]);
  svc.dispose();

  // Opted out of the check-in: open() contacts DAVE not at all, and the tools stay.
  const quiet = fakeDave();
  const optedOut = await service({ ...env, PEW2_DAVE_CHECKIN: "off" }, { dave: quiet.client });
  const still = await optedOut.svc.open({ voiceSessionId: "v", source: "in_app" });
  expect(quiet.requests).toEqual([]);
  expect(toolNames(still)).toContain("check_backlog");
  optedOut.svc.dispose();

  const off = await service(env);
  const plain = await off.svc.open({ voiceSessionId: "v", source: "in_app" });
  expect(toolNames(plain)).not.toContain("check_backlog");
  expect(toolNames(plain)).not.toContain("delegate_backlog_item");
  off.svc.dispose();
});

test("check-in: one sentence about what happened since, said once, naming DAVE's changed project only", async () => {
  const env = { OPENAI_API_KEY: "sk-test", CODEX_HOME: "/nonexistent-codex-home" };
  const dave = fakeDave();
  const { svc } = await service(env, { dave: dave.client });

  // First sight of DAVE records silently; nothing has happened yet.
  const first = (await svc.open({ voiceSessionId: "v1", source: "in_app" })) as {
    snapshot: { checkin?: { say?: string } };
  };
  expect(first.snapshot.checkin).toMatchObject({ finished: 0, failed: 0, needsYou: 0, dave: [] });
  expect(first.snapshot.checkin?.say).toBeUndefined();
  expect(instructionsOf(first)).not.toContain("\n\nCheck-in:");
  await svc.close({ voiceSessionId: "v1" });

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

  const second = (await svc.open({ voiceSessionId: "v2", source: "in_app" })) as {
    snapshot: { checkin?: { say?: string; dave: string[] } };
  };
  const say =
    "Two agents finished, one is blocked by an approval, and DAVE has a new recommendation for Triten. Want the details?";
  expect(second.snapshot.checkin).toMatchObject({
    say,
    finished: 2,
    needsYou: 1,
    dave: ["Triten"],
  });
  expect(instructionsOf(second)).toContain(`\n\nCheck-in: ${say}`);
  // Project names only: DAVE's objective text never reaches the model.
  expect(instructionsOf(second)).not.toContain("secret deal");
  await svc.close({ voiceSessionId: "v2" });

  // Heard once: the next session repeats neither the results nor DAVE's news; the live approval still counts.
  const third = (await svc.open({ voiceSessionId: "v3", source: "in_app" })) as {
    snapshot: { checkin?: { say?: string } };
  };
  expect(third.snapshot.checkin?.say).toBe("One is blocked by an approval. Want the details?");
  svc.dispose();
});

test("focus survives a new voice session and a restart, as working-memory lines", async () => {
  const dataDir = scratch();
  const first = await service(undefined, { dataDir });
  await first.svc.open({ voiceSessionId: "v1", source: "in_app" });
  await first.svc.tool({
    voiceSessionId: "v1",
    callId: "s",
    name: "start_task",
    args: { project: "pew2", instruction: "fix the login screen" },
  });
  await first.svc.close({ voiceSessionId: "v1" });
  first.svc.dispose();

  const again = await service(undefined, { dataDir });
  const ready = await again.svc.open({ voiceSessionId: "v2", source: "in_app" });
  const text = instructionsOf(ready);
  expect(text).toContain("Working memory: current project pew2");
  expect(text).toContain("Working memory: current task fix the login screen");
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

test("events are broadcast, an answer elsewhere unblocks, and urgent ones push", async () => {
  const { svc, emitted, pushed } = await service();
  await svc.tool({
    voiceSessionId: "v",
    callId: "c1",
    name: "start_task",
    args: { project: "pew2", instruction: "go" },
  });
  svc.orchestrator.onSessionPayload("s1", {
    kind: "permission_request",
    requestId: "perm_1",
    params: {
      toolCall: { title: "npm test", kind: "execute" },
      options: [{ optionId: "y", kind: "allow_once" }],
    },
  });
  expect(pushed.map((e) => e.kind)).toEqual(["task.approval"]);
  svc.orchestrator.onPermissionAnswered("s1", "perm_1");
  expect(svc.store.getTask("t_1")?.state).toBe("running");
  const kinds = emitted.map((m) => (m as { event: VoiceEvent }).event.kind);
  expect(kinds).toEqual(["task.queued", "task.started", "task.approval", "task.progress"]);
  // Nothing is pushed while a voice session is open.
  await svc.open({ voiceSessionId: "v", source: "in_app" });
  svc.orchestrator.onSessionPayload("s1", {
    kind: "permission_request",
    requestId: "perm_2",
    params: { toolCall: { title: "npm test", kind: "execute" }, options: [] },
  });
  expect(pushed).toHaveLength(1);
  svc.dispose();
});

test("close persists the heard cursor and unheard events come back in the snapshot", async () => {
  const { svc } = await service();
  await svc.tool({
    voiceSessionId: "v",
    callId: "c1",
    name: "start_task",
    args: { project: "pew2", instruction: "go" },
  });
  expect((await svc.snapshot()).unheard.length).toBeGreaterThan(0);
  await svc.close({ voiceSessionId: "v", heardEventId: 2 });
  expect(svc.store.heardEventId).toBe(2);
  expect((await svc.snapshot()).unheard).toEqual([]);
  svc.dispose();
});

// ---- handler wiring with a fake daemon ---------------------------------------

test("handler: voice.open/tool(dedupe)/sync/close and hello -> voice.state", async () => {
  const { svc } = await service();
  const fake = {
    refreshProviders: async () => ({ errors: [] }),
    voice: async () => svc,
  } as unknown as Daemon;
  const replies: Array<Record<string, unknown>> = [];
  const send = (m: Record<string, unknown>) =>
    handleMessage(JSON.stringify(m), {
      daemon: fake,
      reply: (r) => replies.push(r as Record<string, unknown>),
      broadcast: () => {},
    });

  await send({ t: "hello", wire: 2, role: "app", deviceId: "d1" });
  expect(replies.at(-1)).toMatchObject({ t: "voice.state" });

  await send({ t: "voice.open", voiceSessionId: "v", source: "in_app" });
  expect(replies.at(-1)).toMatchObject({ t: "voice.ready", voiceSessionId: "v" });

  const call = {
    t: "voice.tool",
    voiceSessionId: "v",
    callId: "dup",
    name: "start_task",
    args: { project: "pew2", instruction: "x" },
  };
  await send(call);
  await send(call);
  const results = replies.filter((r) => r.t === "voice.tool.result");
  expect(results).toHaveLength(2);
  expect(results[1]).toEqual(results[0]!);
  expect(svc.store.tasks()).toHaveLength(1);

  await send({ t: "voice.sync", since: 0 });
  const state = replies.at(-1) as { t: string; events: unknown[] };
  expect(state.t).toBe("voice.state");
  expect(state.events.length).toBeGreaterThan(0);

  const before = replies.length;
  await send({ t: "voice.close", voiceSessionId: "v", reason: "user", heardEventId: 1 });
  expect(replies).toHaveLength(before);
  expect(svc.store.heardEventId).toBe(1);
  svc.dispose();
});

// ---- push --------------------------------------------------------------------

const event: VoiceEvent = {
  eventId: 7,
  taskId: "t_1",
  projectId: "proj_x",
  projectName: "pew2",
  kind: "task.approval",
  class: "approval",
  text: "Needs approval (shell): npm test",
  at: 1,
};

test("voice push data is exactly VoiceCallbackPush, sent to registered tokens", async () => {
  const registry = new PushRegistry();
  registry.register("d", "ExponentPushToken[abc]", "ios");
  const [message] = voiceMessages(registry, event);
  expect(message?.data).toEqual({
    type: "voice.callback",
    eventId: 7,
    taskId: "t_1",
    projectId: "proj_x",
    class: "approval",
  });
  const bodies: string[] = [];
  await pushVoiceEvent(registry, event, (async (_u: unknown, init?: RequestInit) => {
    bodies.push(init?.body as string);
    return new Response(
      JSON.stringify({ data: [{ status: "error", details: { error: "DeviceNotRegistered" } }] }),
    );
  }) as unknown as typeof fetch);
  expect(bodies).toHaveLength(1);
  expect(registry.size).toBe(0); // dead token dropped
  await pushVoiceEvent(registry, event, (async () => {
    throw new Error("must not be called with no targets");
  }) as unknown as typeof fetch);
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

test("a push about a branch is titled by its repository", () => {
  const registry = new PushRegistry();
  registry.register("d", "ExponentPushToken[abc]", "ios");
  const [message] = voiceMessages(registry, {
    ...event,
    class: "completed",
    kind: "task.completed",
    projectName: "billing (fix/login)",
    repo: { name: "billing", branch: "fix/login" },
  });
  expect(message?.title).toBe("billing · fix/login: finished");
});

test("voice.open: clientVad selects the manual-turn config; no marker keeps the server answering", async () => {
  const { svc } = await service();
  const turn = (r: Record<string, unknown>) =>
    (
      r as {
        realtime: { session: { audio: { input: { turn_detection: Record<string, unknown> } } } };
      }
    ).realtime.session.audio.input.turn_detection;
  const old = await svc.open({ voiceSessionId: "old", source: "in_app" });
  const next = await svc.open({ voiceSessionId: "new", source: "in_app", clientVad: true });
  expect(old.t).toBe("voice.ready");
  expect(turn(old)).toMatchObject({ create_response: true, interrupt_response: true });
  expect(turn(next)).toMatchObject({ create_response: false, interrupt_response: false });
  svc.dispose();
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
    daemon: { voice: async () => svc } as unknown as Daemon,
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

test("open() tells the model what is running at the computer", async () => {
  const { svc } = await service(undefined, { runningSessions: () => deskSessions });
  const ready = (await svc.open({ voiceSessionId: "v", source: "in_app" })) as {
    realtime: { session: { instructions: string } };
  };
  expect(ready.realtime.session.instructions).toContain("Running on the computer now:");
  svc.dispose();
});
