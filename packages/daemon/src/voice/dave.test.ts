import { expect, test } from "bun:test";
import {
  BACKLOG_TOOLS,
  DaveClient,
  daveClient,
  daveConfig,
  daysUntil,
  FocusSchema,
} from "./dave.js";
import { Orchestrator, type VoiceHost } from "./dispatcher.js";
import { buildRegistry } from "./registry.js";
import { VoiceStore } from "./store.js";
import { realtimeSession, ToolExecutor, VOICE_INSTRUCTIONS, VOICE_TOOLS } from "./tools.js";

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
}

/** A fake DAVE: routes by path, records every request. */
function fakeDave(routes: Record<string, () => Response> = {}) {
  const seen: Seen[] = [];
  const json = (body: unknown) => () =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const table: Record<string, () => Response> = {
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
    seen.push({ url: url.pathname, origin: headers.get("origin"), method: init?.method ?? "GET" });
    const route = table[url.pathname];
    return route ? route() : new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, seen, client: new DaveClient({ off: false, origin: ORIGIN }, impl) };
}

function harness(
  opts: { routes?: Record<string, () => Response>; providers?: string[]; paths?: string[] } = {},
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
  return { ...dave, store, call, prompts };
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
  expect(VOICE_INSTRUCTIONS).toContain("The backlog is not the project named dave");
  expect(VOICE_INSTRUCTIONS).toContain("'check the backlog'");
  expect(VOICE_INSTRUCTIONS).toContain("'open the dave project'");
  expect(BACKLOG_TOOLS[0].description).toContain("'check the backlog'");
  expect(BACKLOG_TOOLS[0].description).toContain("'checking Dave'");
});

// ---- wiring -----------------------------------------------------------------

test("DAVE tools are offered only when enabled, and the model is told to ask only on request", () => {
  const off = realtimeSession({ voice: "marin" }) as { tools: { name: string }[] };
  expect(off.tools.map((t) => t.name)).not.toContain("check_backlog");
  const on = realtimeSession({ voice: "marin", backlogTools: true }) as {
    tools: { name: string }[];
  };
  expect(on.tools).toHaveLength(VOICE_TOOLS.length + BACKLOG_TOOLS.length);
  expect(on.tools.map((t) => t.name)).toContain("delegate_backlog_item");
  expect(VOICE_INSTRUCTIONS).toContain("only when the user asks");
});

test("the backlog tools are not named for dave, and their old names still answer", async () => {
  const on = realtimeSession({ backlogTools: true }) as { tools: { name: string }[] };
  const offered = on.tools.map((t) => t.name);
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
