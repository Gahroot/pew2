import { expect, test } from "bun:test";
import {
  BACKLOG_TOOLS,
  DaveClient,
  daveChanges,
  daveCheckinEnabled,
  daveClient,
  daveDigest,
  daveConfig,
  daysUntil,
  FocusSchema,
  TriageUndoSchema,
} from "./dave.js";
import { Orchestrator, type VoiceHost } from "./dispatcher.js";
import { buildRegistry } from "./registry.js";
import { VoiceStore } from "./store.js";
import { callTools, TASK_INSTRUCTIONS, TASK_TOOLS, ToolExecutor } from "./taskTools.js";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const ORIGIN = "http://127.0.0.1:4317";

const objective = (
  id: string,
  projectId: string,
  projectName: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  projectId,
  projectName,
  objective: `Do ${id}`,
  whyNow: `Because ${id}`,
  humanOnly: false,
  dueDate: null,
  uncertain: null,
  provenance: [{ url: "https://secret.example/doc" }],
  ...extra,
});

function focusFixture() {
  return {
    top: objective("o1", "p-acme", "Acme Portal", { dueDate: "2026-10-18" }),
    queue: [
      objective("o1", "p-acme", "Acme Portal", { dueDate: "2026-10-18" }),
      objective("o2", "p-bill", "billing-api"),
      objective("o3", "p-acme", "Acme Portal", { humanOnly: true, objective: "Call the client" }),
      objective("o4", "p-bill", "billing-api"),
      objective("o5", "p-bill", "billing-api"),
      objective("o6", "p-bill", "billing-api"),
    ],
    projects: [
      {
        projectId: "p-acme",
        projectName: "Acme Portal",
        nextCommitment: { title: "Ship login", dueDate: "2026-10-20" },
      },
      { projectId: "p-bill", projectName: "billing-api", nextCommitment: null },
    ],
    decisions: [{ id: "d1" }, { id: "d2" }],
    external: {
      commitments: [
        {
          title: "Send invoice to bob@acme.com",
          projectName: "Acme Portal",
          dueDate: "2026-10-17",
          owner: "me",
        },
      ],
      blockers: [],
    },
    sources: [
      { source: "fathom", state: "ok" },
      { source: "github", state: "degraded" },
    ],
  };
}

const meetingsFixture = {
  promises: [
    {
      text: "Later promise",
      status: "open",
      dueDate: "2026-10-30",
      meetingTitle: "Sync",
      projectName: "Acme Portal",
      quote: "verbatim quote",
    },
    {
      text: "Overdue promise see https://x.example/a",
      status: "open",
      dueDate: "2026-10-14",
      meetingTitle: "Kickoff",
      projectName: "Acme Portal",
    },
    {
      text: "Undated promise",
      status: "open",
      dueDate: null,
      meetingTitle: null,
      projectName: null,
    },
    {
      text: "Done one",
      status: "looks_done",
      dueDate: "2026-10-10",
      meetingTitle: "Old",
      projectName: null,
    },
  ],
  asks: [{ id: "a1" }, { id: "a2" }, { id: "a3" }],
};

const intelFixture = {
  projectId: "p-acme",
  projectName: "Acme Portal",
  objective: objective("o1", "p-acme", "Acme Portal"),
  otherActions: [
    objective("o7", "p-acme", "Acme Portal"),
    objective("o8", "p-acme", "Acme Portal"),
  ],
  gaps: [{ text: "No tests for checkout", state: "needs_review" }],
};

interface Seen {
  url: string;
  origin: string | null;
  method: string;
  search: string;
  csrf: string | null;
  contentType: string | null;
  body: unknown;
}

/** A fake DAVE: routes by path, records every request. */
function fakeDave(routes: Record<string, (seen: Seen) => Response> = {}) {
  const seen: Seen[] = [];
  const json = (body: unknown) => () =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const table: Record<string, (seen: Seen) => Response> = {
    "/api/intel/focus": json(focusFixture()),
    "/api/meetings/items": json(meetingsFixture),
    "/api/intel/projects/p-acme": json(intelFixture),
    "/api/intel/projects/p-bill": json({
      ...intelFixture,
      projectId: "p-bill",
      projectName: "billing-api",
      objective: null,
      otherActions: [],
    }),
    "/api/intel/objectives/o1/brief": json({
      brief: "Implement o1 in Acme Portal. token sk-abcdefghijklmnopqrstuvwxyz123456",
    }),
    "/api/intel/objectives/o2/brief": json({ brief: "Implement o2." }),
    ...routes,
  };
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const entry: Seen = {
      url: url.pathname,
      origin: headers.get("origin"),
      method,
      search: url.search,
      csrf: headers.get("x-dave-csrf"),
      contentType: headers.get("content-type"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    seen.push(entry);
    const route = table[`${method} ${url.pathname}`] ?? table[url.pathname];
    return route ? route(entry) : new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, seen, client: new DaveClient({ off: false, origin: ORIGIN }, impl) };
}

function harness(
  opts: {
    routes?: Record<string, (seen: Seen) => Response>;
    providers?: string[];
    paths?: string[];
  } = {},
) {
  const dave = fakeDave(opts.routes);
  const store = VoiceStore.memory();
  const prompts: string[] = [];
  const host: VoiceHost = {
    async startSession() {
      return "s1";
    },
    prompt: (_id, text) => {
      prompts.push(text);
      return new Promise<void>(() => {});
    },
    async cancel() {},
    answerPermission: () => true,
    answerAsk: () => true,
    hasSession: () => true,
    lastText: () => undefined,
  };
  const orchestrator = new Orchestrator(store, host);
  const projects = buildRegistry(
    opts.paths ?? ["/code/acme-portal", "/code/billing-api", "/code/pew2"],
    {},
  );
  const executor = new ToolExecutor({
    store,
    orchestrator,
    projects: async () => projects,
    usableProviders: () => opts.providers ?? ["echo", "ezcoder"],
    rememberAlias: async () => {},
    dave: dave.client,
    now: () => NOW,
  });
  let n = 0;
  const call = (name: string, args: Record<string, unknown> = {}, callId = `c${++n}`) =>
    executor.handle({ callId, name, args });
  return { ...dave, store, call, prompts, orchestrator };
}

// ---- config -----------------------------------------------------------------

test("config: default loopback, off switch, and non-local URLs refused", () => {
  expect(daveConfig({})).toEqual({ off: false, origin: ORIGIN });
  expect(daveConfig({ PEW2_DAVE: "off" })).toEqual({ off: true });
  expect(daveConfig({ PEW2_DAVE_URL: "http://localhost:9000/x" })).toEqual({
    off: false,
    origin: "http://localhost:9000",
  });
  expect(daveConfig({ PEW2_DAVE_URL: "http://[::1]:4317" })).toEqual({
    off: false,
    origin: "http://[::1]:4317",
  });
  for (const bad of [
    "https://127.0.0.1:4317",
    "http://10.0.0.5:4317",
    "http://dave.example.com",
    "http://u:p@127.0.0.1",
    "nonsense",
  ]) {
    expect(daveConfig({ PEW2_DAVE_URL: bad })).toHaveProperty("refused");
  }
  expect(daveClient({ PEW2_DAVE: "off" })).toBeUndefined();
});

test("a refused URL never fetches and says why", async () => {
  let fetched = 0;
  const client = daveClient({ PEW2_DAVE_URL: "http://10.0.0.5:4317" }, (async () => {
    fetched++;
    return new Response("{}");
  }) as unknown as typeof fetch);
  const r = await client?.get("/api/intel/focus", FocusSchema);
  expect(r).toMatchObject({ ok: false, say: "DAVE is set to a non-local address; refusing." });
  expect(fetched).toBe(0);
});

// ---- client -----------------------------------------------------------------

test("GET sends DAVE's exact Origin and never anything but GET", async () => {
  const h = harness();
  await h.call("check_backlog", {});
  expect(h.seen.length).toBeGreaterThan(0);
  for (const s of h.seen) {
    expect(s.origin).toBe(ORIGIN);
    expect(s.method).toBe("GET");
  }
});

test("unreachable, refused, oversize and malformed answers become spoken messages", async () => {
  const down = new DaveClient({ off: false, origin: ORIGIN }, (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch);
  expect(await down.get("/api/intel/focus", FocusSchema)).toMatchObject({
    ok: false,
    unavailable: true,
    say: "DAVE isn't running on the computer.",
  });

  const forbidden = fakeDave({ "/api/intel/focus": () => new Response("no", { status: 403 }) });
  expect(await forbidden.client.get("/api/intel/focus", FocusSchema)).toMatchObject({
    ok: false,
    say: "DAVE refused the request.",
  });

  const huge = fakeDave({ "/api/intel/focus": () => new Response("x".repeat(1_100_000)) });
  expect(await huge.client.get("/api/intel/focus", FocusSchema)).toMatchObject({
    ok: false,
    say: "DAVE sent more than expected; ignoring it.",
  });

  const junk = fakeDave({
    "/api/intel/focus": () => new Response(JSON.stringify({ queue: "nope" })),
  });
  expect(await junk.client.get("/api/intel/focus", FocusSchema)).toMatchObject({
    ok: false,
    say: "DAVE sent something unexpected.",
  });
});

test("DAVE down is reported as unavailable, not as a failed command", async () => {
  const h = harness({ routes: { "/api/intel/focus": () => new Response("no", { status: 500 }) } });
  const r = await h.call("check_backlog", { about: "priorities" });
  expect(r).toMatchObject({ ok: true, output: { available: false } });
});

// ---- views ------------------------------------------------------------------

test("daysUntil counts whole UTC days", () => {
  expect(daysUntil("2026-10-16", NOW)).toBe(0);
  expect(daysUntil("2026-10-14", NOW)).toBe(-2);
  expect(daysUntil("2026-10-18T09:00:00Z", NOW)).toBe(2);
  expect(daysUntil(null, NOW)).toBeUndefined();
  expect(daysUntil("soon", NOW)).toBeUndefined();
});

test("overview: top three, commitments due soon overdue-first, decisions and degraded sources", async () => {
  const h = harness();
  const r = await h.call("check_backlog", {});
  const out = r.output as {
    available: boolean;
    top: { objectiveId: string; codingTask: boolean; when?: string }[];
    commitmentsDueSoon: { what: string; when?: string }[];
    pendingDecisions: number;
    degradedSources?: string[];
  };
  expect(out.available).toBe(true);
  expect(out.top.map((o) => o.objectiveId)).toEqual(["o1", "o2", "o3"]);
  expect(out.top[0]?.when).toBe("in 2 days");
  expect(out.top[2]?.codingTask).toBe(false);
  expect(out.commitmentsDueSoon.map((c) => c.when)).toEqual(["overdue by 2 days", "tomorrow"]);
  expect(out.pendingDecisions).toBe(2);
  expect(out.degradedSources).toEqual(["github is degraded"]);
  const text = JSON.stringify(out);
  for (const leak of ["bob@acme.com", "https://", "verbatim quote", "provenance", "secret.example"])
    expect(text).not.toContain(leak);
});

test("priorities: up to five, with a count of the rest", async () => {
  const h = harness();
  const out = (await h.call("check_backlog", { about: "priorities" })).output as {
    priorities: { objectiveId: string }[];
    more?: number;
  };
  expect(out.priorities.map((o) => o.objectiveId)).toEqual(["o1", "o2", "o3", "o4", "o5"]);
  expect(out.more).toBe(1);
});

test("commitments: open promises overdue first then soonest, undated last; asks counted", async () => {
  const h = harness();
  const out = (await h.call("check_backlog", { about: "commitments" })).output as {
    promises: { what: string }[];
    looksDone?: number;
    clientAsks?: number;
    projectCommitments?: { what: string; owner?: string }[];
  };
  expect(out.promises.map((p) => p.what)).toEqual([
    "Overdue promise see a link",
    "Later promise",
    "Undated promise",
  ]);
  expect(out.looksDone).toBe(1);
  expect(out.clientAsks).toBe(3);
  expect(out.projectCommitments?.[0]).toMatchObject({
    what: "Send invoice to someone",
    owner: "you",
  });
});

test("project: resolves against DAVE's own names and summarises one project", async () => {
  const h = harness();
  const out = (await h.call("check_backlog", { about: "project", project: "acme portal" }))
    .output as {
    project: string;
    objective: { objectiveId: string };
    otherActions: unknown[];
    gaps: { text: string; state?: string }[];
    nextCommitment?: { what: string; when?: string };
  };
  expect(out.project).toBe("Acme Portal");
  expect(out.objective.objectiveId).toBe("o1");
  expect(out.otherActions).toHaveLength(2);
  expect(out.gaps[0]).toEqual({ text: "No tests for checkout", state: "needs review" });
  expect(out.nextCommitment).toMatchObject({ what: "Ship login", when: "in 4 days" });

  const none = await h.call("check_backlog", { about: "project", project: "zzzqqq" });
  expect(none.output).toMatchObject({ needsClarification: true });
  expect(h.seen.some((s) => s.url.includes("zzzqqq"))).toBe(false);
});

// ---- delegation -------------------------------------------------------------

test("delegate: first call asks and starts nothing; a bad token starts nothing", async () => {
  const h = harness();
  const first = await h.call("delegate_backlog_item", { objectiveId: "o1" });
  expect(first.output).toMatchObject({
    needsConfirmation: true,
    question: "Send EZ Coder to acme-portal: Do o1?",
  });
  expect(h.store.tasks()).toHaveLength(0);

  const forged = await h.call("delegate_backlog_item", {
    objectiveId: "o1",
    confirmToken: "nope",
    userConfirmed: true,
  });
  expect(forged.output).toMatchObject({ needsConfirmation: true });
  const unconfirmed = await h.call("delegate_backlog_item", {
    objectiveId: "o1",
    confirmToken: (first.output as { confirmToken: string }).confirmToken,
  });
  expect(unconfirmed.output).toMatchObject({ needsConfirmation: true });
  expect(h.store.tasks()).toHaveLength(0);
});

test("delegate: a confirmed yes starts exactly one EZ Coder task with the redacted brief; a retry is a duplicate", async () => {
  const h = harness();
  const first = await h.call("delegate_backlog_item", {
    objectiveId: "o1",
    extra: "keep it small",
  });
  const confirmToken = (first.output as { confirmToken: string }).confirmToken;
  const yes = await h.call("delegate_backlog_item", {
    objectiveId: "o1",
    extra: "keep it small",
    confirmToken,
    userConfirmed: true,
  });
  expect(yes.output).toMatchObject({ delegated: true, task: { project: "acme-portal" } });
  const tasks = h.store.tasks();
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({
    providerId: "ezcoder",
    cwd: "/code/acme-portal",
    title: "Do o1",
  });
  expect(tasks[0]?.prompt).toContain("Implement o1 in Acme Portal.");
  expect(tasks[0]?.prompt).toEndWith("User's note: keep it small");
  expect(tasks[0]?.prompt).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");

  const again = await h.call("delegate_backlog_item", {
    objectiveId: "o1",
    extra: "keep it small",
    confirmToken,
    userConfirmed: true,
  });
  expect(again.output).toMatchObject({ delegated: false, duplicate: true });
  expect(h.store.tasks()).toHaveLength(1);
});

test("delegate: a human-only step is refused and never fetches a brief", async () => {
  const h = harness();
  const r = await h.call("delegate_backlog_item", { objectiveId: "o3" });
  expect(r.output).toMatchObject({
    delegated: false,
    humanStep: true,
    say: "That's a step for you: Call the client",
  });
  expect(h.seen.some((s) => s.url.includes("/brief"))).toBe(false);
  expect(h.store.tasks()).toHaveLength(0);
});

test("delegate: never falls back to another agent when EZ Coder is missing", async () => {
  const h = harness({ providers: ["echo", "claude"] });
  const r = await h.call("delegate_backlog_item", { objectiveId: "o1" });
  expect(r).toMatchObject({ ok: false, error: "EZ Coder isn't available on the computer." });
  expect(h.store.tasks()).toHaveLength(0);
});

test("delegate: a stale objective asks to check again; no matching project asks instead of guessing", async () => {
  const h = harness();
  expect((await h.call("delegate_backlog_item", { objectiveId: "gone" })).output).toMatchObject({
    stale: true,
  });

  const unmatched = harness({ paths: ["/code/pew2"] });
  const r = await unmatched.call("delegate_backlog_item", { objectiveId: "o1" });
  expect(r.output).toMatchObject({ delegated: false, needsClarification: true });
  expect(unmatched.store.tasks()).toHaveLength(0);
});

// ---- DAVE the assistant vs. the dave project ----------------------------------

test("'checking Dave' for the to-do list never starts a task in the dave project", async () => {
  const h = harness({ paths: ["/code/dave", "/code/pew2"] });
  const r = await h.call("start_task", {
    project: "dave",
    instruction: "Checking Dave, what are the next items on my to-do list?",
  });
  expect(r.output).toMatchObject({
    started: false,
    meantBacklog: true,
    next: "Call check_backlog with about 'priorities'.",
  });
  expect(h.store.tasks()).toHaveLength(0);
  // Resolving the phrase itself points at DAVE too, not at a project.
  expect((await h.call("resolve_project", { query: "checking Dave" })).output).toMatchObject({
    meantBacklog: true,
  });
  expect(h.seen).toHaveLength(0);
});

test("coding work in the dave project still starts there", async () => {
  const h = harness({ paths: ["/code/dave", "/code/pew2"] });
  const r = await h.call("start_task", {
    project: "dave",
    instruction: "fix the bug Dave reported in login",
  });
  expect(r.output).toMatchObject({ started: true, task: { project: "dave" } });
  expect(h.store.tasks()[0]?.cwd).toBe("/code/dave");
  // The project named outright wins even for a to-do question (the repo's own).
  const explicit = await h.call("start_task", {
    project: "the dave repo",
    instruction: "what are the next items on my to-do list",
  });
  expect(explicit.output).toMatchObject({ started: true });
});

test("a bare 'dave' with a to-do question asks which, and a projectId settles it", async () => {
  const h = harness({ paths: ["/code/dave", "/code/pew2"] });
  const first = await h.call("start_task", {
    project: "dave",
    instruction: "what's next on my to-do list",
  });
  const out = first.output as {
    needsClarification: boolean;
    question: string;
    candidates: { projectId: string }[];
  };
  expect(out).toMatchObject({
    started: false,
    needsClarification: true,
    question: "Do you want the backlog, or a task in the dave project?",
  });
  expect(h.store.tasks()).toHaveLength(0);
  const projectId = out.candidates[0]?.projectId;
  expect(projectId).toBeDefined();
  const second = await h.call("start_task", {
    project: projectId,
    instruction: "what's next on my to-do list",
  });
  expect(second.output).toMatchObject({ started: true });
});

test("'check the backlog' reads the backlog, and never starts or resolves the dave project", async () => {
  const h = harness({ paths: ["/code/dave", "/code/pew2"] });
  // The model filed it under the dave project; the word "backlog" settles it.
  const viaDave = await h.call("start_task", { project: "dave", instruction: "check the backlog" });
  expect(viaDave.output).toMatchObject({
    started: false,
    meantBacklog: true,
    next: "Call check_backlog with about 'priorities'.",
  });
  // The model passed the backlog itself as the project.
  for (const query of ["the backlog", "check the backlog", "what's next on the backlog"]) {
    const r = await h.call("resolve_project", { query });
    expect([query, r.output]).toMatchObject([query, { meantBacklog: true }]);
  }
  expect(h.store.tasks()).toHaveLength(0);
  expect(h.seen).toHaveLength(0);

  // And the lookup the model is sent to reads DAVE's ranked queue.
  const backlog = await h.call("check_backlog", { about: "priorities" });
  expect(backlog.ok).toBe(true);
  expect(h.seen.map((s) => s.url)).toEqual(["/api/intel/focus"]);
});

test("opening or working on the dave project goes to the project, not the backlog", async () => {
  const h = harness({ paths: ["/code/dave", "/code/pew2"] });
  const resolved = await h.call("resolve_project", { query: "open the dave project" });
  expect(resolved.output).toMatchObject({ ambiguous: false, name: "dave" });
  const work = await h.call("start_task", {
    project: "dave",
    instruction: "work on dave: look at the backlog screen and fix its layout",
  });
  expect(work.output).toMatchObject({ started: true, task: { project: "dave" } });
  expect(h.store.tasks()[0]?.cwd).toBe("/code/dave");
  expect(h.seen).toHaveLength(0);
});

test("'check the backlog' in another project is that project's work, untouched", async () => {
  const h = harness({ paths: ["/code/dave", "/code/pew2"] });
  const r = await h.call("start_task", { project: "pew2", instruction: "check the backlog" });
  expect(r.output).toMatchObject({ started: true, task: { project: "pew2" } });
});

test("the instructions and the backlog tool tell the model the backlog is not the dave project", () => {
  expect(TASK_INSTRUCTIONS).toContain("The backlog is not the project named dave");
  expect(TASK_INSTRUCTIONS).toContain("'check the backlog'");
  expect(TASK_INSTRUCTIONS).toContain("'open the dave project'");
  expect(BACKLOG_TOOLS[0].description).toContain("'check the backlog'");
  expect(BACKLOG_TOOLS[0].description).toContain("'checking Dave'");
});

// ---- wiring -----------------------------------------------------------------

test("DAVE tools are offered only when enabled, and the model is told to ask only on request", () => {
  expect(callTools().map((t) => t.name)).not.toContain("check_backlog");
  const on = callTools({ backlogTools: true });
  expect(on).toHaveLength(TASK_TOOLS.length + BACKLOG_TOOLS.length);
  expect(on.map((t) => t.name)).toContain("delegate_backlog_item");
  expect(TASK_INSTRUCTIONS).toContain("only when they ask");
});

test("the backlog tools are not named for dave, and their old names still answer", async () => {
  const offered = callTools({ backlogTools: true }).map((t) => t.name);
  expect(offered.filter((name) => /dave/i.test(name))).toEqual([]);
  expect(offered).toEqual(expect.arrayContaining(["check_backlog", "delegate_backlog_item"]));

  // A session minted before the rename still calls the old names; same answer.
  const h = harness();
  const today = await h.call("check_backlog", { about: "priorities" });
  const legacy = await h.call("check_with_dave", { about: "priorities" });
  expect(legacy).toEqual(today);
  const ask = await h.call("delegate_dave_task", { objectiveId: "o1" });
  expect(ask.output).toMatchObject({ needsConfirmation: true });
  expect(h.store.tasks()).toHaveLength(0);
});

test("a DAVE tool with DAVE turned off fails plainly", async () => {
  const store = VoiceStore.memory();
  const executor = new ToolExecutor({
    store,
    orchestrator: new Orchestrator(store, {} as VoiceHost),
    projects: async () => [],
    usableProviders: () => [],
    rememberAlias: async () => {},
  });
  const r = await executor.handle({ callId: "x", name: "check_backlog", args: {} });
  expect(r).toMatchObject({ ok: false, error: "DAVE is turned off." });
});

// ---- opening check-in ---------------------------------------------------------

test("daveDigest makes one GET with the short timeout and maps each project's top", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(focusFixture()), { status: 200 });
  }) as unknown as typeof fetch;
  const digest = await daveDigest(new DaveClient({ off: false, origin: ORIGIN }, fetchImpl), 1500);
  expect(calls.map((c) => [c.url, c.init?.method])).toEqual([[`${ORIGIN}/api/intel/focus`, "GET"]]);
  expect(digest).toEqual({
    "p-acme": { topObjectiveId: "o1", projectName: "Acme Portal" },
    "p-bill": { topObjectiveId: "o2", projectName: "billing-api" },
  });
});

test("daveDigest honours its timeout and is undefined on failure", async () => {
  const hang = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
  const started = Date.now();
  // Constructor timeout is 60s; the per-call one must win.
  const digest = await daveDigest(new DaveClient({ off: false, origin: ORIGIN }, hang, 60_000), 50);
  expect(digest).toBeUndefined();
  expect(Date.now() - started).toBeLessThan(2_000);
  const down = (async () => {
    throw new TypeError("connect ECONNREFUSED");
  }) as unknown as typeof fetch;
  expect(await daveDigest(new DaveClient({ off: false, origin: ORIGIN }, down))).toBeUndefined();
  expect(await daveDigest(new DaveClient({ off: false, refused: "no" }, down))).toBeUndefined();
});

test("daveChanges: first sight is silent, a changed top names the project only", () => {
  const digest = {
    "p-acme": { topObjectiveId: "o1", projectName: "Acme Portal" },
    "p-bill": { topObjectiveId: "o2", projectName: "billing-api" },
  };
  const first = daveChanges(undefined, digest);
  expect(first).toEqual({ projects: [], seen: { "p-acme": "o1", "p-bill": "o2" } });
  expect(daveChanges(first.seen, digest).projects).toEqual([]);
  const next = daveChanges(first.seen, {
    ...digest,
    "p-acme": { topObjectiveId: "o9", projectName: "Acme Portal" },
    "p-new": { topObjectiveId: "o7", projectName: "Triten" },
  });
  expect(next.projects).toEqual(["Acme Portal", "Triten"]);
  expect(next.seen).toEqual({ "p-acme": "o9", "p-bill": "o2", "p-new": "o7" });
  expect(JSON.stringify(next.projects)).not.toMatch(/Do o|o9|o7/);
  // No digest (DAVE down): nothing announced, the seen map is kept.
  expect(daveChanges(first.seen, undefined)).toEqual({ projects: [], seen: first.seen });
});

test("daveCheckinEnabled is on unless PEW2_DAVE_CHECKIN=off", () => {
  expect(daveCheckinEnabled({})).toBe(true);
  expect(daveCheckinEnabled({ PEW2_DAVE_CHECKIN: "off" })).toBe(false);
  expect(daveCheckinEnabled({ PEW2_DAVE_CHECKIN: "on" })).toBe(true);
});

// ---- closed loop: next, progress, review and confirm-gated writes ----------

const reply =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const prepared = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectId: "p-acme",
  projectName: "Acme Portal",
  kind: "decide",
  title: `Accept the export plan ${id.slice(0, 2)}`,
  whyNow: "Mail bob@acme.com about https://secret.example/doc",
  effort: "one_tap",
  primary: { label: "Accept", op: { op: "accept_proposal", proposalId: "pr1" } },
  secondary: [],
  draft: null,
  doneWhen: ["Plan accepted"],
  evidence: [{ label: "Kickoff call", at: null, sourceKind: "meeting" }],
  missing: [],
  objectiveId: "0123456789abcdef",
  targetItemIds: [],
  score: 1,
  uncertain: null,
  fingerprint: "f",
  ...extra,
});
const A1 = "aaaaaaaaaaaaaaaa";
const A2 = "bbbbbbbbbbbbbbbb";
const A3 = "cccccccccccccccc";
const A4 = "dddddddddddddddd";
const HAND = "eeeeeeeeeeeeeeee";
const nextState = {
  generatedAt: "x",
  action: prepared(A1),
  queue: [
    prepared(A1),
    prepared(A2),
    prepared(A3),
    prepared(A4),
    prepared(HAND, {
      primary: { label: "Hand to EZ Coder", op: { op: "hand_to_ezcoder", objectiveId: "o1" } },
    }),
  ],
  skipped: 0,
};
const briefing = (sinceSource: string, since = "2026-10-14T08:00:00Z") => ({
  generatedAt: "x",
  since,
  sinceSource,
  next: prepared(A1),
  alsoReady: [prepared(A2)],
  progress: [
    {
      eventId: "e1",
      projectId: "p-acme",
      projectName: "Acme Portal",
      at: "2026-10-16T10:00:00Z",
      headline: "EZ Coder finished: export to CSV now looks implemented (not verified).",
      verdict: "partial",
      advanced: [{ itemId: "i1", title: "Export to CSV", from: {}, to: {} }],
      stillMissing: [{ itemId: "i2", title: "Import", state: "not_implemented", why: "open" }],
      finishLine: { verified: 1, observed: 1, total: 4, percentDone: 37.5 },
      nextBefore: null,
      nextAfter: null,
      source: "ezcoder",
      link: "explicit",
    },
  ],
  decisionsWaiting: 2,
  changedSince: { objectiveChanges: 1, workEvents: 1 },
});
const csrfRoute = (tokens: string[]) => {
  let n = 0;
  return () => new Response(JSON.stringify({ token: tokens[Math.min(n++, tokens.length - 1)] }));
};
const noLeak = (out: unknown) => {
  const text = JSON.stringify(out);
  for (const leak of ["bob@acme.com", "https://", "secret.example"])
    expect(text).not.toContain(leak);
};

test("progress asks DAVE's briefing as pew and holds no timestamp between calls", async () => {
  const routes = { "/api/intel/briefing": reply(briefing("last_asked")) };
  const a = harness({ routes });
  const b = harness({ routes });
  const ra = await a.call("check_backlog", { about: "progress" });
  await a.call("check_backlog", { about: "progress" });
  const rb = await b.call("check_backlog", { about: "progress" });
  const reqs = [...a.seen, ...b.seen].map((s) => `${s.method} ${s.url}${s.search}`);
  expect(reqs).toEqual(Array(3).fill("GET /api/intel/briefing?caller=pew"));
  expect(ra.output).toEqual(rb.output);
  const out = ra.output as {
    window: string;
    moved: { moved: string[]; stillMissing: string[]; percentDone: number }[];
  };
  expect(out.window).toBe("since you last asked");
  expect(out.moved[0]).toMatchObject({
    moved: ["Export to CSV"],
    stillMissing: ["Import"],
    percentDone: 38,
  });
  noLeak(ra.output);
});

test("the spoken window follows sinceSource", async () => {
  const window = async (src: string) =>
    (
      (
        await harness({ routes: { "/api/intel/briefing": reply(briefing(src)) } }).call(
          "check_backlog",
          { about: "progress" },
        )
      ).output as { window: string }
    ).window;
  expect(await window("last_asked")).toBe("since you last asked");
  expect(await window("default_24h")).toBe("in the last day");
  expect(await window("explicit")).toBe("since October 14");
});

test("next gives DAVE's one recommendation plus two alternatives; overview leads with it", async () => {
  const h = harness({
    routes: {
      "/api/intel/next": reply(nextState),
      "/api/intel/briefing": reply(briefing("default_24h")),
    },
  });
  const next = (await h.call("check_backlog", { about: "next" })).output as {
    recommendation: { actionId: string };
    alternatives: { actionId: string }[];
  };
  expect(next.recommendation.actionId).toBe(A1);
  expect(next.alternatives.map((a) => a.actionId)).toEqual([A2, A3]);
  noLeak(next);
  const overview = (await h.call("check_backlog", {})).output as Record<string, unknown>;
  expect(Object.keys(overview).slice(0, 3)).toEqual(["available", "next", "progress"]);
  expect(overview.progress).toBe(
    "in the last day: EZ Coder finished: export to CSV now looks implemented (not verified).",
  );
  noLeak(overview);
});

test("review summarises agreement and patterns", async () => {
  const h = harness({
    routes: {
      "/api/intel/recommendations/review": reply({
        days: 30,
        totals: { followed: 3, overridden: 1 },
        agreementRate: 0.75,
        byKind: [],
        byProject: [],
        overrides: [],
        patterns: ["You often pick billing first"],
        suggestions: [{ id: "s1", text: "Raise billing-api", op: {} }],
      }),
    },
  });
  const out = (await h.call("check_backlog", { about: "review" })).output as Record<
    string,
    unknown
  >;
  expect(h.seen.at(-1)?.search).toBe("?days=30");
  expect(out).toMatchObject({
    agreement: "75 percent followed",
    suggestions: ["Raise billing-api"],
  });
});

test("POST: CSRF fetched with the exact Origin, cached, and refetched once on 403", async () => {
  let posts = 0;
  const dave = fakeDave({
    "/api/security/csrf": csrfRoute(["t1", "t2"]),
    "POST /api/triage/undo": (s) => {
      posts++;
      return s.csrf === "t2"
        ? reply({ restored: 1, skipped: 0 })()
        : new Response("no", { status: 403 });
    },
  });
  const r = await dave.client.post("/api/triage/undo", { batchId: "x" }, TriageUndoSchema);
  expect(r).toMatchObject({ ok: true, value: { restored: 1 } });
  expect(dave.seen.map((s) => `${s.method} ${s.url}`)).toEqual([
    "GET /api/security/csrf",
    "POST /api/triage/undo",
    "GET /api/security/csrf",
    "POST /api/triage/undo",
  ]);
  const post = dave.seen.at(-1);
  expect(post).toMatchObject({
    origin: ORIGIN,
    csrf: "t2",
    contentType: "application/json",
    body: { batchId: "x" },
  });
  await dave.client.post("/api/triage/undo", { batchId: "y" }, TriageUndoSchema);
  expect(dave.seen.filter((s) => s.url === "/api/security/csrf")).toHaveLength(2);
  expect(posts).toBe(3);

  const always = fakeDave({
    "/api/security/csrf": csrfRoute(["t1"]),
    "POST /api/triage/undo": () => new Response("no", { status: 403 }),
  });
  expect(await always.client.post("/api/triage/undo", {}, TriageUndoSchema)).toMatchObject({
    ok: false,
    say: "DAVE refused the request.",
  });
  expect(always.seen.filter((s) => s.method === "POST")).toHaveLength(2);
});

test("POST: non-loopback and non-allow-listed paths never fetch", async () => {
  let fetched = 0;
  const far = daveClient({ PEW2_DAVE_URL: "http://10.0.0.5:4317" }, (async () => {
    fetched++;
    return new Response("{}");
  }) as unknown as typeof fetch);
  expect(await far?.post("/api/triage/apply", {}, TriageUndoSchema)).toMatchObject({ ok: false });
  const dave = fakeDave({ "/api/security/csrf": csrfRoute(["t1"]) });
  for (const path of [
    "/api/agents/launch",
    "/api/intel/next/ABCDEF0123456789/act",
    "/api/intel/next/aaaaaaaaaaaaaaaa/act/x",
    "/api/triage/apply?x=1",
    "/api/intel/focus",
  ])
    expect(await dave.client.post(path, {}, TriageUndoSchema)).toMatchObject({ ok: false });
  expect(fetched).toBe(0);
  expect(dave.seen).toEqual([]);
});

test("act_on_backlog asks first, posts only after a yes, and never enqueues", async () => {
  const h = harness({
    routes: {
      "/api/intel/next": reply(nextState),
      "/api/security/csrf": csrfRoute(["t1"]),
      [`POST /api/intel/next/${A1}/act`]: reply({
        ok: true,
        actionId: A1,
        op: "accept_proposal",
        summary: "Accepted the export plan.",
      }),
    },
  });
  let enqueued = 0;
  h.orchestrator.enqueue = () => {
    enqueued++;
    throw new Error("never");
  };
  const first = (await h.call("act_on_backlog", { actionId: A1, choice: "primary" })).output as {
    needsConfirmation: boolean;
    confirmToken: string;
  };
  expect(first.needsConfirmation).toBe(true);
  expect(h.seen.some((s) => s.method === "POST")).toBe(false);
  // A token without a yes, or for another choice, changes nothing.
  await h.call("act_on_backlog", {
    actionId: A1,
    choice: "primary",
    confirmToken: first.confirmToken,
  });
  expect(h.seen.some((s) => s.method === "POST")).toBe(false);
  const again = (await h.call("act_on_backlog", { actionId: A1, choice: "primary" })).output as {
    confirmToken: string;
  };
  await h.call("act_on_backlog", {
    actionId: A1,
    choice: "skip",
    confirmToken: again.confirmToken,
    userConfirmed: true,
  });
  expect(h.seen.some((s) => s.method === "POST")).toBe(false);
  const t = (await h.call("act_on_backlog", { actionId: A1, choice: "primary" })).output as {
    confirmToken: string;
  };
  const done = await h.call("act_on_backlog", {
    actionId: A1,
    choice: "primary",
    confirmToken: t.confirmToken,
    userConfirmed: true,
  });
  expect(done.output).toMatchObject({ acted: true, say: "Accepted the export plan." });
  expect(h.seen.filter((s) => s.method === "POST").map((s) => s.body)).toEqual([
    { op: "accept_proposal" },
  ]);

  const hand = await h.call("act_on_backlog", { actionId: HAND, choice: "primary" });
  expect(hand.output).toMatchObject({ acted: false, handOff: true });
  expect(JSON.stringify(hand.output)).toContain("delegate_backlog_item");
  expect(enqueued).toBe(0);
  expect(h.store.tasks()).toEqual([]);
});

test("act_on_backlog reports a stale action, before and after the yes", async () => {
  const h = harness({
    routes: {
      "/api/intel/next": reply(nextState),
      "/api/security/csrf": csrfRoute(["t1"]),
      [`POST /api/intel/next/${A2}/act`]: reply({ error: "stale" }, 409),
    },
  });
  expect(
    (await h.call("act_on_backlog", { actionId: "ffffffffffffffff", choice: "skip" })).output,
  ).toMatchObject({ stale: true });
  const t = (await h.call("act_on_backlog", { actionId: A2, choice: "defer", until: "2026-10-20" }))
    .output as { confirmToken: string };
  const r = await h.call("act_on_backlog", {
    actionId: A2,
    choice: "defer",
    until: "2026-10-20",
    confirmToken: t.confirmToken,
    userConfirmed: true,
  });
  expect(r.output).toMatchObject({ acted: false, stale: true });
  expect(h.seen.filter((s) => s.method === "POST").map((s) => s.body)).toEqual([
    { op: "defer", date: "2026-10-20" },
  ]);
});

test("act_on_backlog never claims a copy: no question, no post, and it says the draft is in DAVE", async () => {
  const COPY = "ffffffffffff0000";
  const BARE = "ffffffffffff0001";
  const copyStep = { primary: { label: "Copy message", op: { op: "copy" } } };
  const h = harness({
    routes: {
      "/api/intel/next": reply({
        ...nextState,
        queue: [
          prepared(COPY, {
            ...copyStep,
            draft: {
              kind: "email",
              to: "bob@acme.com",
              subject: "Export",
              text: "Hi Bob, about the secret deal",
            },
          }),
          prepared(BARE, copyStep),
        ],
      }),
      "/api/security/csrf": csrfRoute(["t1"]),
    },
  });
  const r = await h.call("act_on_backlog", { actionId: COPY, choice: "primary" });
  expect(r.output).toEqual({
    acted: false,
    copyInDave: true,
    say: "The email is ready to copy in DAVE; nothing was copied.",
  });
  // A yes changes nothing either: there is still nothing for Pew to do.
  const yes = await h.call("act_on_backlog", {
    actionId: COPY,
    choice: "primary",
    confirmToken: "x",
    userConfirmed: true,
  });
  expect(yes.output).toMatchObject({ acted: false, copyInDave: true });
  expect(
    (await h.call("act_on_backlog", { actionId: BARE, choice: "primary" })).output,
  ).toMatchObject({
    say: "It's ready to copy in DAVE; nothing was copied.",
  });
  expect(h.seen.some((s) => s.method === "POST")).toBe(false);
  // check_backlog tells the model up front, and the draft's words never reach it.
  const next = await h.call("check_backlog", { about: "next" });
  expect(JSON.stringify(next.output)).toContain('"copyInDave":true');
  for (const out of [r.output, next.output]) {
    expect(JSON.stringify(out)).not.toContain("secret deal");
    expect(JSON.stringify(out)).not.toContain("bob@acme.com");
  }
});

test("clean_up_backlog previews, then applies exactly the frozen keys after a yes; undo asks too", async () => {
  const key = (n: number) => `m:mi-${String(n).padStart(24, "0")}`;
  const entry = (
    n: number,
    bucket: string,
    projectName: string,
    meetingTitle = "Acme kickoff",
  ) => ({
    key: key(n),
    kind: "promise",
    bucket,
    title: `Idea ${n} for bob@acme.com`,
    projectId: "p-acme",
    projectName,
    dueDate: null,
    meetingAt: null,
    meetingTitle,
    reasons: [],
    confirmed: false,
  });
  let entries = [
    entry(1, "ideas", "Acme Portal"),
    entry(2, "ideas", "Acme Portal"),
    entry(3, "old_asks", "billing-api"),
    entry(4, "ideas", "billing-api", "Weekly"),
  ];
  const h = harness({
    routes: {
      "/api/security/csrf": csrfRoute(["t1"]),
      "POST /api/triage/preview": () =>
        reply({
          generatedAt: "x",
          entries,
          counts: {},
          total: entries.length,
          confirmedHidden: 0,
        })(),
      "POST /api/triage/apply": (s) =>
        reply({
          batchId: "tb-000000000000000000000001",
          changed: (s.body as { keys: string[] }).keys.length,
          skipped: [],
          kept: [],
          summary: "Cleared 3 items.",
        })(),
      "/api/triage/batches": reply({
        batches: [
          {
            id: "tb-000000000000000000000001",
            createdAt: "x",
            source: "ui",
            action: "clear",
            summary: "Cleared 3 items.",
            count: 3,
            undoneAt: null,
          },
        ],
      }),
      "POST /api/triage/undo": reply({ restored: 3, skipped: 0 }),
    },
  });
  const p = (
    await h.call("clean_up_backlog", {
      buckets: ["ideas", "old_asks"],
      project: "acme",
      meeting: "kickoff",
      olderThanDays: 7,
      action: "clear",
    })
  ).output as {
    needsConfirmation: boolean;
    confirmToken: string;
    keys: string[];
    byBucket: Record<string, number>;
    byProject: Record<string, number>;
    examples: string[];
  };
  expect(h.seen.find((s) => s.url === "/api/triage/preview")?.body).toEqual({
    filter: { buckets: ["old_asks", "ideas"], olderThanDays: 7, projectId: "p-acme" },
  });
  expect(p.keys).toEqual([key(1), key(2), key(3)]);
  expect(p.byBucket).toEqual({ ideas: 2, old_asks: 1 });
  expect(p.byProject).toEqual({ "Acme Portal": 2, "billing-api": 1 });
  expect(p.examples).toHaveLength(3);
  noLeak(p);
  expect(h.seen.some((s) => s.url === "/api/triage/apply")).toBe(false);

  // New noise arrives before the yes; a widened key list does not redeem the token.
  entries = [...entries, entry(5, "ideas", "Acme Portal")];
  const widened = await h.call("clean_up_backlog", {
    action: "clear",
    keys: [...p.keys, key(5)],
    confirmToken: p.confirmToken,
    userConfirmed: true,
  });
  expect(widened.output).toMatchObject({ cleaned: false });
  const p2 = (
    await h.call("clean_up_backlog", {
      buckets: ["ideas", "old_asks"],
      project: "acme",
      meeting: "kickoff",
      action: "clear",
    })
  ).output as { confirmToken: string; keys: string[] };
  entries = [...entries, entry(6, "ideas", "Acme Portal")];
  const yes = await h.call("clean_up_backlog", {
    action: "clear",
    keys: [...p2.keys].reverse(),
    confirmToken: p2.confirmToken,
    userConfirmed: true,
  });
  expect(yes.output).toMatchObject({ cleaned: true, batchId: "tb-000000000000000000000001" });
  expect(h.seen.filter((s) => s.url === "/api/triage/apply").map((s) => s.body)).toEqual([
    { keys: [...p2.keys].reverse(), action: "clear" },
  ]);
  expect(p2.keys).not.toContain(key(6));

  const u = (await h.call("undo_backlog_clean_up", {})).output as {
    needsConfirmation: boolean;
    confirmToken: string;
    batchId: string;
  };
  expect(u.needsConfirmation).toBe(true);
  expect(h.seen.some((s) => s.url === "/api/triage/undo")).toBe(false);
  const undone = await h.call("undo_backlog_clean_up", {
    batchId: u.batchId,
    confirmToken: u.confirmToken,
    userConfirmed: true,
  });
  expect(undone.output).toMatchObject({ undone: true });
  expect(h.seen.find((s) => s.url === "/api/triage/undo")?.body).toEqual({
    batchId: "tb-000000000000000000000001",
  });
});
