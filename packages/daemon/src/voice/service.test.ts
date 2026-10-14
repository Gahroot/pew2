import { expect, test } from "bun:test";
import { handleMessage } from "../handler.js";
import type { Daemon } from "../index.js";
import { pushVoiceEvent, PushRegistry, voiceMessages } from "../push.js";
import type { VoiceHost } from "./dispatcher.js";
import { scratch } from "./scratch.js";
import { contextText, VoiceService } from "./service.js";
import type { VoiceEvent } from "./types.js";

function host(): VoiceHost & { permissionAnswers: string[] } {
  const permissionAnswers: string[] = [];
  return {
    permissionAnswers,
    async startSession() {
      return "s1";
    },
    prompt: () => new Promise<void>(() => {}),
    async cancel() {},
    answerPermission: (_s, _r, o) => {
      permissionAnswers.push(o);
      return true;
    },
    hasSession: () => true,
    lastText: () => undefined,
  };
}

const mintFetch = (async () =>
  new Response(JSON.stringify({ value: "ek_test", expires_at: 99 }))) as unknown as typeof fetch;

async function service(env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "sk-test", CODEX_HOME: "/nonexistent-codex-home" }) {
  const emitted: unknown[] = [];
  const pushed: VoiceEvent[] = [];
  const h = host();
  const svc = await VoiceService.create({
    dataDir: scratch(),
    env,
    host: h,
    emit: (m) => emitted.push(m),
    projectPaths: async () => ["/code/pew2"],
    usableProviders: () => ["echo"],
    push: (e) => void pushed.push(e),
    fetch: mintFetch,
    tickMs: 0,
  });
  return { svc, emitted, pushed, h };
}

test("open without a key is unavailable/no_api_key", async () => {
  const { svc } = await service({ CODEX_HOME: "/nonexistent-codex-home" });
  expect(await svc.open({ voiceSessionId: "v", source: "in_app" })).toMatchObject({
    t: "voice.unavailable",
    code: "no_api_key",
  });
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

test("events are broadcast, an answer elsewhere unblocks, and urgent ones push", async () => {
  const { svc, emitted, pushed } = await service();
  await svc.tool({ voiceSessionId: "v", callId: "c1", name: "start_task", args: { project: "pew2", instruction: "go" } });
  svc.orchestrator.onSessionPayload("s1", {
    kind: "permission_request",
    requestId: "perm_1",
    params: { toolCall: { title: "npm test", kind: "execute" }, options: [{ optionId: "y", kind: "allow_once" }] },
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
  await svc.tool({ voiceSessionId: "v", callId: "c1", name: "start_task", args: { project: "pew2", instruction: "go" } });
  expect((await svc.snapshot()).unheard.length).toBeGreaterThan(0);
  await svc.close({ voiceSessionId: "v", heardEventId: 2 });
  expect(svc.store.heardEventId).toBe(2);
  expect((await svc.snapshot()).unheard).toEqual([]);
  svc.dispose();
});

// ---- handler wiring with a fake daemon ---------------------------------------

test("handler: voice.open/tool(dedupe)/sync/close and hello -> voice.state", async () => {
  const { svc } = await service();
  const fake = { refreshProviders: async () => ({ errors: [] }), voice: async () => svc } as unknown as Daemon;
  const replies: Array<Record<string, unknown>> = [];
  const send = (m: Record<string, unknown>) => handleMessage(JSON.stringify(m), {
    daemon: fake,
    reply: (r) => replies.push(r as Record<string, unknown>),
    broadcast: () => {},
  });

  await send({ t: "hello", wire: 2, role: "app", deviceId: "d1" });
  expect(replies.at(-1)).toMatchObject({ t: "voice.state" });

  await send({ t: "voice.open", voiceSessionId: "v", source: "in_app" });
  expect(replies.at(-1)).toMatchObject({ t: "voice.ready", voiceSessionId: "v" });

  const call = { t: "voice.tool", voiceSessionId: "v", callId: "dup", name: "start_task", args: { project: "pew2", instruction: "x" } };
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
  expect(message?.data).toEqual({ type: "voice.callback", eventId: 7, taskId: "t_1", projectId: "proj_x", class: "approval" });
  const bodies: string[] = [];
  await pushVoiceEvent(registry, event, (async (_u: unknown, init?: RequestInit) => {
    bodies.push(init?.body as string);
    return new Response(JSON.stringify({ data: [{ status: "error", details: { error: "DeviceNotRegistered" } }] }));
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
    detectWorktree: async (path: string) => (path.includes("/worktrees/billing/") ? { repo: "billing", gone: true } : undefined),
  });
  const billing = (await second.projects()).find((p) => p.name === "billing");
  expect(second.store.getTask(task.taskId)?.repo).toEqual({ projectId: billing?.projectId, name: "billing", branch: "ez-mun7ig9t" });
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
