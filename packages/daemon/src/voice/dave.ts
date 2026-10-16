/**
 * DAVE, the user's portfolio assistant, as two voice tools.
 *
 * DAVE ("Portfolio Command Center", `~/dave`) runs its own loopback server and
 * knows what each project should do next, what was promised in meetings and
 * which decisions are waiting. Voice consults it **only when the model calls a
 * DAVE tool**, and the model is told to do that only when the user asks.
 * Nothing else here — not the opening context, not ticks, not pushes — ever
 * touches DAVE.
 *
 * Three rules:
 *  - GET only, loopback only. DAVE holds private client and meeting data, so a
 *    non-local `PEW2_DAVE_URL` fails closed rather than being followed.
 *  - The model sees summaries, never DAVE's raw JSON: quotes, emails, links and
 *    provenance stay behind, and every string passes `speakable()`.
 *  - Delegation always asks first (a single-use confirm token) and only ever
 *    starts EZ Coder. DAVE itself never launches anything.
 */
import { z } from "zod";
import type { Orchestrator } from "./dispatcher.js";
import { repoOf, resolveProject } from "./registry.js";
import { redactSecrets, speakable, type ConfirmationTokens } from "./safety.js";
import { TERMINAL, type VoiceStore } from "./store.js";
import { didYouMean, taskView, type ToolResult } from "./tools.js";
import type { VoiceProject } from "./types.js";

export const DAVE_DEFAULT_URL = "http://127.0.0.1:4317";
const TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 1_000_000;
const MAX_BRIEF_CHARS = 6_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const EZCODER = "ezcoder";

// ---- config ----------------------------------------------------------------

export type DaveConfig =
  { off: true } | { off: false; origin: string } | { off: false; refused: string };

/** `PEW2_DAVE=off` disables it; `PEW2_DAVE_URL` must be plain http on loopback. */
export function daveConfig(env: NodeJS.ProcessEnv): DaveConfig {
  const flag = env.PEW2_DAVE?.trim().toLowerCase();
  if (flag === "off" || flag === "0" || flag === "false") return { off: true };
  const raw = env.PEW2_DAVE_URL?.trim() || DAVE_DEFAULT_URL;
  const refused = { off: false, refused: "DAVE is set to a non-local address; refusing." } as const;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refused;
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password)
    return refused;
  return { off: false, origin: url.origin };
}

// ---- client ----------------------------------------------------------------

export type DaveGet<T> =
  { ok: true; value: T } | { ok: false; say: string; unavailable?: true; notFound?: true };

const UNAVAILABLE = "DAVE isn't running on the computer.";

/** Read-only, bounded GETs against DAVE's loopback API. */
export class DaveClient {
  constructor(
    private readonly config: Exclude<DaveConfig, { off: true }>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = TIMEOUT_MS,
  ) {}

  async get<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<DaveGet<T>> {
    if ("refused" in this.config) return { ok: false, say: this.config.refused };
    const { origin } = this.config;
    let response: Response;
    try {
      response = await this.fetchImpl(`${origin}${path}`, {
        method: "GET",
        // DAVE's guard lets a non-browser read through only with its exact origin.
        headers: { Origin: origin, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return timedOut
        ? { ok: false, say: "DAVE didn't answer in time." }
        : { ok: false, say: UNAVAILABLE, unavailable: true };
    }
    if (response.status === 403) return { ok: false, say: "DAVE refused the request." };
    if (response.status === 404)
      return { ok: false, say: "DAVE doesn't know that one.", notFound: true };
    if (!response.ok) return { ok: false, say: "DAVE answered with an error." };
    const body = await readCapped(response, MAX_BODY_BYTES);
    if (body === undefined) return { ok: false, say: "DAVE sent more than expected; ignoring it." };
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return { ok: false, say: "DAVE sent something unexpected." };
    }
    const parsed = schema.safeParse(json);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, say: "DAVE sent something unexpected." };
  }
}

/** The client for this environment, or undefined when DAVE is turned off. */
export function daveClient(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): DaveClient | undefined {
  const config = daveConfig(env);
  return config.off ? undefined : new DaveClient(config, fetchImpl);
}

/** The body as text, or undefined once it passes `max` bytes. */
async function readCapped(response: Response, max: number): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// ---- schemas (the subset voice reads; everything else passes through) --------

const nstr = z.string().nullish();

const Objective = z
  .object({
    id: z.string(),
    projectId: z.string(),
    projectName: z.string(),
    objective: z.string(),
    whyNow: z.string().nullish(),
    humanOnly: z.boolean(),
    dueDate: nstr,
    uncertain: nstr,
  })
  .passthrough();
type Objective = z.output<typeof Objective>;

const Commitment = z
  .object({ title: z.string(), projectName: nstr, dueDate: nstr, owner: nstr })
  .passthrough();

export const FocusSchema = z
  .object({
    top: Objective.nullish(),
    queue: z.array(Objective).default([]),
    projects: z
      .array(
        z
          .object({
            projectId: z.string(),
            projectName: z.string(),
            nextCommitment: z.object({ title: z.string(), dueDate: nstr }).passthrough().nullish(),
          })
          .passthrough(),
      )
      .default([]),
    decisions: z.array(z.object({}).passthrough()).default([]),
    external: z
      .object({
        commitments: z.array(Commitment).default([]),
        blockers: z.array(z.object({}).passthrough()).default([]),
      })
      .passthrough()
      .default({}),
    sources: z.array(z.object({ source: z.string(), state: z.string() }).passthrough()).default([]),
  })
  .passthrough();
type Focus = z.output<typeof FocusSchema>;

export const ProjectIntelSchema = z
  .object({
    projectId: z.string(),
    projectName: z.string(),
    objective: Objective.nullish(),
    otherActions: z.array(Objective).default([]),
    gaps: z.array(z.object({ text: z.string(), state: nstr }).passthrough()).default([]),
  })
  .passthrough();

const Promise_ = z
  .object({
    text: z.string(),
    status: z.string(),
    dueDate: nstr,
    meetingTitle: nstr,
    projectName: nstr,
  })
  .passthrough();

export const MeetingItemsSchema = z
  .object({
    promises: z.array(Promise_).default([]),
    asks: z.array(z.object({}).passthrough()).default([]),
  })
  .passthrough();

export const BriefSchema = z.object({ brief: z.string() }).passthrough();

// ---- views -----------------------------------------------------------------

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL_TEXT = /\b(?:https?|ftp):\/\/\S+|\bwww\.\S+/gi;

/** Speakable, with emails and links dropped: DAVE's text comes from client meetings. */
function clean(text: string | null | undefined, max = 160): string {
  if (!text) return "";
  return speakable(text.replace(EMAIL, "someone").replace(URL_TEXT, "a link"), max);
}

const DAY_MS = 86_400_000;

/** Whole days from today to an ISO date (negative = overdue), in UTC. */
export function daysUntil(date: string | null | undefined, now: number): number | undefined {
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return undefined;
  const due = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(due)) return undefined;
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((due - today) / DAY_MS);
}

function dueFields(date: string | null | undefined, now: number) {
  const days = daysUntil(date, now);
  if (days === undefined || !date) return {};
  const when =
    days < 0
      ? `overdue by ${-days} day${days === -1 ? "" : "s"}`
      : days === 0
        ? "today"
        : days === 1
          ? "tomorrow"
          : `in ${days} days`;
  return { due: date.slice(0, 10), when };
}

function objectiveView(o: Objective, now: number) {
  return {
    objectiveId: o.id,
    project: clean(o.projectName, 60),
    objective: clean(o.objective),
    ...(o.whyNow ? { why: clean(o.whyNow) } : null),
    ...dueFields(o.dueDate, now),
    codingTask: !o.humanOnly,
    ...(o.uncertain ? { uncertain: clean(o.uncertain, 120) } : null),
  };
}

function queueOf(focus: Focus): Objective[] {
  const list = [...focus.queue];
  if (focus.top && !list.some((o) => o.id === focus.top?.id)) list.unshift(focus.top);
  return list;
}

function degraded(focus: Focus): string[] {
  return focus.sources
    .filter((s) => s.state === "degraded" || s.state === "unavailable")
    .map((s) => `${clean(s.source, 30)} is ${s.state}`);
}

interface Dated {
  dueDate?: string | null;
}

/** Overdue first, then soonest; undated last. Stable for equal dates. */
function byUrgency<T extends Dated>(items: readonly T[], now: number): T[] {
  const key = (x: T) => daysUntil(x.dueDate, now) ?? Number.POSITIVE_INFINITY;
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => key(a.item) - key(b.item) || a.i - b.i)
    .map((x) => x.item);
}

function externalView(c: z.output<typeof Commitment>, now: number) {
  return {
    what: clean(c.title, 140),
    ...(c.projectName ? { project: clean(c.projectName, 60) } : null),
    ...(c.owner && c.owner !== "unknown"
      ? { owner: c.owner === "me" ? "you" : c.owner.replace("_", " ") }
      : null),
    ...dueFields(c.dueDate, now),
  };
}

function promiseView(p: z.output<typeof Promise_>, now: number) {
  return {
    what: clean(p.text, 140),
    ...(p.projectName ? { project: clean(p.projectName, 60) } : null),
    ...(p.meetingTitle ? { meeting: clean(p.meetingTitle, 60) } : null),
    ...dueFields(p.dueDate, now),
    ...(p.status === "looks_done" ? { looksDone: true } : null),
  };
}

const soon = (now: number) => (x: Dated) => {
  const days = daysUntil(x.dueDate, now);
  return days !== undefined && days <= 7;
};

export function overview(
  focus: Focus,
  meetings: z.output<typeof MeetingItemsSchema> | undefined,
  now: number,
) {
  const dueSoon = [
    ...(meetings?.promises.filter((p) => p.status === "open").filter(soon(now)) ?? []).map((p) => ({
      dueDate: p.dueDate,
      view: promiseView(p, now),
    })),
    ...focus.external.commitments
      .filter(soon(now))
      .map((c) => ({ dueDate: c.dueDate, view: externalView(c, now) })),
  ];
  const sources = degraded(focus);
  const queue = queueOf(focus);
  return {
    available: true,
    top: queue.slice(0, 3).map((o) => objectiveView(o, now)),
    ...(queue.length === 0 ? { note: "DAVE has no next actions yet." } : null),
    commitmentsDueSoon: byUrgency(dueSoon, now)
      .slice(0, 4)
      .map((x) => x.view),
    pendingDecisions: focus.decisions.length,
    ...(sources.length ? { degradedSources: sources } : null),
  };
}

export function priorities(focus: Focus, now: number) {
  const queue = queueOf(focus);
  return {
    available: true,
    priorities: queue.slice(0, 5).map((o) => objectiveView(o, now)),
    ...(queue.length > 5 ? { more: queue.length - 5 } : null),
    ...(queue.length === 0 ? { note: "DAVE has no next actions yet." } : null),
  };
}

export function commitments(
  focus: Focus | undefined,
  meetings: z.output<typeof MeetingItemsSchema> | undefined,
  now: number,
) {
  const open = byUrgency(meetings?.promises.filter((p) => p.status === "open") ?? [], now);
  const looksDone = meetings?.promises.filter((p) => p.status === "looks_done").length ?? 0;
  const external = byUrgency(focus?.external.commitments ?? [], now);
  return {
    available: true,
    promises: open.slice(0, 6).map((p) => promiseView(p, now)),
    ...(open.length > 6 ? { morePromises: open.length - 6 } : null),
    ...(looksDone ? { looksDone } : null),
    ...(external.length
      ? { projectCommitments: external.slice(0, 4).map((c) => externalView(c, now)) }
      : null),
    ...(meetings ? { clientAsks: meetings.asks.length } : null),
    ...(meetings ? null : { note: "DAVE's meeting list could not be read." }),
  };
}

export function projectView(intel: z.output<typeof ProjectIntelSchema>, focus: Focus, now: number) {
  const row = focus.projects.find((p) => p.projectId === intel.projectId);
  const next = row?.nextCommitment;
  return {
    available: true,
    project: clean(intel.projectName, 60),
    objective: intel.objective ? objectiveView(intel.objective, now) : null,
    otherActions: intel.otherActions.slice(0, 3).map((o) => objectiveView(o, now)),
    gaps: intel.gaps.slice(0, 3).map((g) => ({
      text: clean(g.text, 140),
      ...(g.state ? { state: g.state.replace(/_/g, " ") } : null),
    })),
    ...(next
      ? { nextCommitment: { what: clean(next.title, 140), ...dueFields(next.dueDate, now) } }
      : null),
  };
}

// ---- tools -----------------------------------------------------------------

export const DAVE_TOOL_NAMES = ["check_with_dave", "delegate_dave_task"] as const;

export const DAVE_TOOLS = [
  {
    type: "function",
    name: "check_with_dave",
    description:
      "Ask DAVE, the user's portfolio and priorities assistant, what matters now. Only when the user asks (e.g. 'check in with Dave', 'what does Dave think I should do', 'what did I promise Acme'), never on your own.",
    parameters: {
      type: "object",
      properties: {
        about: {
          type: "string",
          enum: ["overview", "priorities", "commitments", "project"],
          description:
            "overview (default), ranked priorities, meeting commitments, or one project.",
        },
        project: { type: "string", description: "Spoken project name, for about=project." },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "delegate_dave_task",
    description:
      "Hand one of DAVE's coding objectives to EZ Coder. Always needs a yes: call once to get a confirmToken and question, ask it, and call again with confirmToken and userConfirmed true only after the user says yes.",
    parameters: {
      type: "object",
      properties: {
        objectiveId: { type: "string", description: "objectiveId from check_with_dave." },
        project: {
          type: "string",
          description: "Spoken project name, only if DAVE's project name did not match one.",
        },
        extra: { type: "string", description: "Anything the user added for the agent." },
        confirmToken: { type: "string", description: "Token from the first call." },
        userConfirmed: {
          type: "boolean",
          description: "True only if the user just said yes out loud.",
        },
      },
      required: ["objectiveId"],
    },
  },
] as const;

export interface DaveToolContext {
  client: DaveClient;
  projects: () => Promise<VoiceProject[]>;
  usableProviders: () => string[];
  store: VoiceStore;
  orchestrator: Orchestrator;
  confirm: ConfirmationTokens;
  now: () => number;
}

const good = (output: unknown): ToolResult => ({ ok: true, output });
const fail = (error: string): ToolResult => ({ ok: false, output: { error }, error });
/** DAVE being down is news to report, not a failed command. */
const unavailable = (say: string): ToolResult => good({ available: false, say });

function arg(args: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

/** DAVE's projects as registry entries, so spoken names resolve the same way pew2's do. */
function daveProjects(focus: Focus): VoiceProject[] {
  return focus.projects.map((p) => ({
    projectId: p.projectId,
    name: p.projectName,
    path: `dave:${p.projectId}`,
    aliases: [],
  }));
}

/** Pinned by DAVE's routes: only these ids are ever put in a path. */
const PROJECT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const OBJECTIVE_ID = /^[A-Za-z0-9_-]{1,64}$/;

async function check(args: Record<string, unknown>, ctx: DaveToolContext): Promise<ToolResult> {
  const about = arg(args, "about", 20) ?? "overview";
  const now = ctx.now();
  switch (about) {
    case "overview": {
      const [focus, meetings] = await Promise.all([
        ctx.client.get("/api/intel/focus", FocusSchema),
        ctx.client.get("/api/meetings/items", MeetingItemsSchema),
      ]);
      if (!focus.ok) return unavailable(focus.say);
      return good(overview(focus.value, meetings.ok ? meetings.value : undefined, now));
    }
    case "priorities": {
      const focus = await ctx.client.get("/api/intel/focus", FocusSchema);
      return focus.ok ? good(priorities(focus.value, now)) : unavailable(focus.say);
    }
    case "commitments": {
      const [focus, meetings] = await Promise.all([
        ctx.client.get("/api/intel/focus", FocusSchema),
        ctx.client.get("/api/meetings/items", MeetingItemsSchema),
      ]);
      if (!focus.ok && !meetings.ok) return unavailable(meetings.say);
      return good(
        commitments(
          focus.ok ? focus.value : undefined,
          meetings.ok ? meetings.value : undefined,
          now,
        ),
      );
    }
    case "project": {
      const query = arg(args, "project", 100);
      if (!query) return fail("project is required for about=project.");
      const focus = await ctx.client.get("/api/intel/focus", FocusSchema);
      if (!focus.ok) return unavailable(focus.say);
      const r = resolveProject(query, daveProjects(focus.value));
      if (!r.best) {
        return good({
          available: true,
          needsClarification: true,
          reason: r.candidates.length
            ? "Several of DAVE's projects match."
            : "DAVE has no project by that name.",
          ...(r.candidates.length
            ? { question: didYouMean(r.candidates.map((c) => c.project.name)) }
            : null),
        });
      }
      if (!PROJECT_ID.test(r.best.projectId)) return fail("DAVE sent something unexpected.");
      const intel = await ctx.client.get(
        `/api/intel/projects/${encodeURIComponent(r.best.projectId)}`,
        ProjectIntelSchema,
      );
      return intel.ok ? good(projectView(intel.value, focus.value, now)) : unavailable(intel.say);
    }
    default:
      return fail("about must be overview, priorities, commitments or project.");
  }
}

/** The objective by id: DAVE's ranked queue first, then each project's other actions. */
async function findObjective(
  ctx: DaveToolContext,
  focus: Focus,
  id: string,
): Promise<Objective | undefined> {
  const queued = queueOf(focus).find((o) => o.id === id);
  if (queued) return queued;
  for (const p of focus.projects.slice(0, 20)) {
    if (!PROJECT_ID.test(p.projectId)) continue;
    const intel = await ctx.client.get(
      `/api/intel/projects/${encodeURIComponent(p.projectId)}`,
      ProjectIntelSchema,
    );
    if (!intel.ok) continue;
    const found = [intel.value.objective, ...intel.value.otherActions].find((o) => o?.id === id);
    if (found) return found;
  }
  return undefined;
}

async function delegate(args: Record<string, unknown>, ctx: DaveToolContext): Promise<ToolResult> {
  const objectiveId = arg(args, "objectiveId", 64);
  if (!objectiveId) return fail("objectiveId is required.");
  if (!OBJECTIVE_ID.test(objectiveId))
    return fail("That is not one of DAVE's objectives. Check with DAVE again.");
  const focus = await ctx.client.get("/api/intel/focus", FocusSchema);
  if (!focus.ok) return unavailable(focus.say);
  const objective = await findObjective(ctx, focus.value, objectiveId);
  if (!objective)
    return good({
      delegated: false,
      stale: true,
      say: "DAVE's priorities changed; check with DAVE again.",
    });
  const spoken = clean(objective.objective);
  if (objective.humanOnly)
    return good({ delegated: false, humanStep: true, say: `That's a step for you: ${spoken}` });

  if (!ctx.usableProviders().includes(EZCODER))
    return fail("EZ Coder isn't available on the computer.");

  const brief = await ctx.client.get(
    `/api/intel/objectives/${encodeURIComponent(objective.id)}/brief`,
    BriefSchema,
  );
  if (!brief.ok) {
    if (brief.notFound)
      return good({
        delegated: false,
        humanStep: true,
        say: `DAVE has no coding brief for that; it's a step for you: ${spoken}`,
      });
    return unavailable(brief.say);
  }

  const query = arg(args, "project", 100) ?? objective.projectName;
  const r = resolveProject(query, await ctx.projects());
  if (!r.best) {
    return good({
      delegated: false,
      needsClarification: true,
      reason: r.candidates.length
        ? "Several projects on the computer match."
        : `No project on the computer matches DAVE's ${clean(objective.projectName, 60)}.`,
      ...(r.candidates.length
        ? { question: didYouMean(r.candidates.map((c) => c.project.name)) }
        : null),
      candidates: r.candidates.map((c) => ({
        projectId: c.project.projectId,
        name: c.project.name,
      })),
    });
  }
  const project = r.best;
  const extra = arg(args, "extra", 1000);
  const prompt = `${redactSecrets(brief.value.brief).slice(0, MAX_BRIEF_CHARS)}${extra ? `\n\nUser's note: ${extra}` : ""}`;

  // Before the token: a retry after the task already started finds it here.
  const duplicate = ctx.store
    .tasks()
    .find(
      (t) => t.projectId === project.projectId && !TERMINAL.has(t.state) && t.prompt === prompt,
    );
  if (duplicate)
    return good({ delegated: false, duplicate: true, task: taskView(ctx.store, duplicate) });

  const subject = `dave:${objective.id}:${project.projectId}`;
  const confirmed =
    args.userConfirmed === true && ctx.confirm.redeem(arg(args, "confirmToken", 40), subject);
  if (!confirmed) {
    return good({
      needsConfirmation: true,
      confirmToken: ctx.confirm.issue(subject),
      question: `Send EZ Coder to ${project.name}: ${spoken}?`,
    });
  }
  const repo = repoOf(project);
  const task = ctx.orchestrator.enqueue({
    projectId: project.projectId,
    projectName: project.name,
    ...(repo ? { repo } : null),
    cwd: project.path,
    providerId: EZCODER,
    title: clean(objective.objective, 60),
    prompt,
  });
  return good({ delegated: true, task: taskView(ctx.store, task) });
}

/** Run one DAVE tool. Errors become results, like every other voice tool. */
export function runDaveTool(
  name: string,
  args: Record<string, unknown>,
  ctx: DaveToolContext,
): Promise<ToolResult> {
  if (name === "check_with_dave") return check(args, ctx);
  if (name === "delegate_dave_task") return delegate(args, ctx);
  return Promise.resolve(fail(`Unknown tool '${name}'.`));
}
