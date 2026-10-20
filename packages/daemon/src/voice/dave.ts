/**
 * DAVE, the user's portfolio assistant, as the two to-do list voice tools,
 * `check_backlog` and `delegate_backlog_item`.
 *
 * DAVE ("Portfolio Command Center", `~/dave`) runs its own loopback server and
 * knows what each project should do next, what was promised in meetings and
 * which decisions are waiting. Voice consults it **only when the model calls a
 * to-do tool**, and the model is told to do that only when the user asks.
 * Nothing else here — not the opening context, not ticks, not pushes — ever
 * touches DAVE.
 *
 * Three rules:
 *  - Loopback only. DAVE holds private client and meeting data, so a
 *    non-local `PEW2_DAVE_URL` fails closed rather than being followed. Reads
 *    are GETs; the only POSTs are an allow-list of DAVE's own records
 *    (clean-up, undo, its prepared next action), each behind a spoken yes.
 *  - The model sees summaries, never DAVE's raw JSON: quotes, emails, links and
 *    provenance stay behind, and every string passes `speakable()`.
 *  - Delegation always asks first (a single-use confirm token) and only ever
 *    starts EZ Coder. DAVE itself never launches anything.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Orchestrator } from "./dispatcher.js";
import { repoOf, resolveProject } from "./registry.js";
import { redactSecrets, speakable, type ConfirmationTokens } from "./safety.js";
import { TERMINAL, type VoiceStore } from "./store.js";
import { didYouMean, taskView, type ToolResult } from "./taskTools.js";
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
  | { ok: true; value: T }
  | { ok: false; say: string; unavailable?: true; notFound?: true; stale?: true };

const UNAVAILABLE = "DAVE isn't running on the computer.";

/**
 * The only paths voice may POST to: DAVE's own records (clean-up, its prepared
 * next action, a review suggestion). Nothing here can start work.
 */
const POST_PATHS = [
  /^\/api\/triage\/(?:preview|apply|undo)$/,
  /^\/api\/intel\/next\/[a-f0-9]{16}\/act$/,
  /^\/api\/intel\/recommendations\/suggestions\/apply$/,
];
export const davePostAllowed = (path: string): boolean => POST_PATHS.some((re) => re.test(path));
const CSRF_PATH = "/api/security/csrf";
const CSRF_HEADER = "x-dave-csrf";
const CsrfSchema = z.object({ token: z.string().min(1).max(512) }).passthrough();

type Schema<T> = z.ZodType<T, z.ZodTypeDef, unknown>;
type Sent = { ok: true; response: Response } | { ok: false; say: string; unavailable?: true };

/** Bounded GETs against DAVE's loopback API, and POSTs only to an allow-list of DAVE's own records. */
export class DaveClient {
  /** DAVE's CSRF token for this origin, fetched on the first POST. */
  private csrf: string | undefined;

  constructor(
    private readonly config: Exclude<DaveConfig, { off: true }>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = TIMEOUT_MS,
  ) {}

  async get<T>(
    path: string,
    schema: Schema<T>,
    options: { timeoutMs?: number } = {},
  ): Promise<DaveGet<T>> {
    if ("refused" in this.config) return { ok: false, say: this.config.refused };
    const sent = await this.send("GET", path, undefined, options.timeoutMs);
    return sent.ok ? this.parse(sent.response, schema) : sent;
  }

  /**
   * A JSON POST to one of `POST_PATHS`, with DAVE's exact Origin and its CSRF
   * token (fetched once per client, fetched again once after a 403).
   */
  async post<T>(path: string, body: unknown, schema: Schema<T>): Promise<DaveGet<T>> {
    if ("refused" in this.config) return { ok: false, say: this.config.refused };
    if (!davePostAllowed(path)) return { ok: false, say: "Voice can't change that in DAVE." };
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.csrf) {
        const token = await this.get(CSRF_PATH, CsrfSchema);
        if (!token.ok) return token;
        this.csrf = token.value.token;
      }
      const sent = await this.send("POST", path, { body: JSON.stringify(body), csrf: this.csrf });
      if (!sent.ok) return sent;
      if (sent.response.status === 403 && attempt === 0) {
        await sent.response.body?.cancel().catch(() => undefined);
        this.csrf = undefined;
        continue;
      }
      if (sent.response.status === 409) {
        await sent.response.body?.cancel().catch(() => undefined);
        return {
          ok: false,
          stale: true,
          say: "That changed in DAVE since; check the backlog again.",
        };
      }
      if (sent.response.status === 400) {
        await sent.response.body?.cancel().catch(() => undefined);
        return { ok: false, say: "DAVE said that change isn't valid." };
      }
      return this.parse(sent.response, schema);
    }
    return { ok: false, say: "DAVE refused the request." };
  }

  private async send(
    method: "GET" | "POST",
    path: string,
    post?: { body: string; csrf: string },
    timeoutMs?: number,
  ): Promise<Sent> {
    if ("refused" in this.config) return { ok: false, say: this.config.refused };
    const { origin } = this.config;
    try {
      const response = await this.fetchImpl(`${origin}${path}`, {
        method,
        // DAVE's guard lets a non-browser client through only with its exact origin.
        headers: post
          ? {
              Origin: origin,
              Accept: "application/json",
              "content-type": "application/json",
              [CSRF_HEADER]: post.csrf,
            }
          : { Origin: origin, Accept: "application/json" },
        ...(post ? { body: post.body } : null),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
      });
      return { ok: true, response };
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return timedOut
        ? { ok: false, say: "DAVE didn't answer in time." }
        : { ok: false, say: UNAVAILABLE, unavailable: true };
    }
  }

  private async parse<T>(response: Response, schema: Schema<T>): Promise<DaveGet<T>> {
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
  briefing?: Briefing,
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
  const latest = briefing?.progress[0];
  return {
    available: true,
    ...(briefing?.next ? { next: actionView(briefing.next) } : null),
    ...(briefing
      ? {
          progress: latest
            ? `${progressWindow(briefing)}: ${clean(latest.headline)}${briefing.progress.length > 1 ? ` (and ${briefing.progress.length - 1} more)` : ""}`
            : `Nothing moved ${progressWindow(briefing)}.`,
        }
      : null),
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

// ---- prepared actions, progress and review (DAVE's closed loop) -------------

const OpSchema = z.object({ op: z.string() }).passthrough();

export const PreparedActionSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    projectName: z.string(),
    kind: z.string(),
    title: z.string(),
    whyNow: z.string().nullish(),
    effort: z.string().nullish(),
    primary: z.object({ label: z.string(), op: OpSchema }).passthrough(),
    secondary: z.array(z.object({ label: z.string(), op: OpSchema }).passthrough()).default([]),
    draft: z
      .object({ kind: z.string(), to: nstr, subject: nstr, text: z.string() })
      .passthrough()
      .nullish(),
    doneWhen: z.array(z.string()).default([]),
    missing: z.array(z.string()).default([]),
    objectiveId: nstr,
    uncertain: nstr,
  })
  .passthrough();
type PreparedAction = z.output<typeof PreparedActionSchema>;

export const NextStateSchema = z
  .object({
    action: PreparedActionSchema.nullish(),
    queue: z.array(PreparedActionSchema).default([]),
    skipped: z.number().default(0),
  })
  .passthrough();

const ProgressSchema = z
  .object({
    projectName: z.string(),
    at: z.string(),
    headline: z.string(),
    verdict: z.string(),
    advanced: z.array(z.object({ title: z.string() }).passthrough()).default([]),
    stillMissing: z.array(z.object({ title: z.string() }).passthrough()).default([]),
    finishLine: z.object({ percentDone: z.number() }).passthrough().nullish(),
  })
  .passthrough();

export const BriefingSchema = z
  .object({
    since: z.string(),
    sinceSource: z.enum(["explicit", "last_asked", "default_24h"]),
    next: PreparedActionSchema.nullish(),
    alsoReady: z.array(PreparedActionSchema).default([]),
    progress: z.array(ProgressSchema).default([]),
    decisionsWaiting: z.number().default(0),
    changedSince: z
      .object({ objectiveChanges: z.number(), workEvents: z.number() })
      .passthrough()
      .nullish(),
  })
  .passthrough();
type Briefing = z.output<typeof BriefingSchema>;

export const ReviewSchema = z
  .object({
    days: z.number(),
    totals: z.record(z.number()).default({}),
    agreementRate: z.number().nullish(),
    patterns: z.array(z.string()).default([]),
    suggestions: z.array(z.object({ id: z.string(), text: z.string() }).passthrough()).default([]),
  })
  .passthrough();

export const TriagePreviewSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            key: z.string(),
            bucket: z.string(),
            title: z.string(),
            projectName: nstr,
            meetingTitle: nstr,
          })
          .passthrough(),
      )
      .default([]),
    total: z.number(),
  })
  .passthrough();
export const TriageResultSchema = z
  .object({ batchId: z.string().nullable(), changed: z.number(), summary: z.string() })
  .passthrough();
export const TriageUndoSchema = z
  .object({ restored: z.number(), skipped: z.number() })
  .passthrough();
const BatchesSchema = z
  .object({
    batches: z
      .array(
        z
          .object({ id: z.string(), summary: z.string(), undoneAt: z.string().nullable() })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** How Pew names the window DAVE chose: the cursor lives in DAVE, never here. */
export function progressWindow(b: Pick<Briefing, "since" | "sinceSource">): string {
  if (b.sinceSource === "last_asked") return "since you last asked";
  if (b.sinceSource === "default_24h") return "in the last day";
  const t = Date.parse(b.since);
  if (Number.isNaN(t)) return "recently";
  const d = new Date(t);
  return `since ${MONTHS[d.getUTCMonth()] ?? ""} ${d.getUTCDate()}`;
}

export function actionView(a: PreparedAction) {
  const handOff = a.primary.op.op === "hand_to_ezcoder";
  return {
    actionId: a.id,
    project: clean(a.projectName, 60),
    action: clean(a.title),
    ...(a.whyNow ? { why: clean(a.whyNow) } : null),
    yes: clean(a.primary.label, 80),
    ...(handOff
      ? { handOff: true, ...(a.objectiveId ? { objectiveId: a.objectiveId } : null) }
      : null),
    // The yes step is a copy the user makes on DAVE's screen; voice cannot do it.
    ...(a.primary.op.op === "copy" ? { copyInDave: true } : null),
    ...(a.draft ? { draftReady: clean(a.draft.kind, 20) } : null),
    ...(a.doneWhen.length ? { doneWhen: a.doneWhen.slice(0, 3).map((d) => clean(d, 120)) } : null),
    ...(a.missing.length
      ? { notConfirmed: a.missing.slice(0, 2).map((d) => clean(d, 120)) }
      : null),
    ...(a.uncertain ? { uncertain: clean(a.uncertain, 120) } : null),
  };
}

function progressItem(r: z.output<typeof ProgressSchema>) {
  return {
    project: clean(r.projectName, 60),
    what: clean(r.headline),
    ...(r.advanced.length
      ? { moved: r.advanced.slice(0, 3).map((x) => clean(x.title, 100)) }
      : null),
    ...(r.stillMissing.length
      ? { stillMissing: r.stillMissing.slice(0, 3).map((x) => clean(x.title, 100)) }
      : null),
    ...(r.finishLine ? { percentDone: Math.round(r.finishLine.percentDone) } : null),
  };
}

export function nextView(state: z.output<typeof NextStateSchema>) {
  const first = state.action ?? state.queue[0];
  if (!first) return { available: true, note: "DAVE has nothing prepared right now." };
  const others = state.queue.filter((a) => a.id !== first.id).slice(0, 2);
  return {
    available: true,
    recommendation: actionView(first),
    ...(others.length ? { alternatives: others.map(actionView) } : null),
    ...(state.skipped ? { skipped: state.skipped } : null),
    note: "DAVE's recommendation. Ask one yes or no; act_on_backlog makes the change.",
  };
}

export function progressView(b: Briefing) {
  const window = progressWindow(b);
  return {
    available: true,
    window,
    ...(b.progress.length
      ? { moved: b.progress.slice(0, 5).map(progressItem) }
      : { note: `Nothing moved ${window}.` }),
    ...(b.progress.length > 5 ? { more: b.progress.length - 5 } : null),
    ...(b.next ? { next: actionView(b.next) } : null),
    decisionsWaiting: b.decisionsWaiting,
  };
}

export function reviewView(r: z.output<typeof ReviewSchema>) {
  return {
    available: true,
    days: r.days,
    agreement:
      r.agreementRate === null || r.agreementRate === undefined
        ? "not enough yet"
        : `${Math.round(r.agreementRate * 100)} percent followed`,
    totals: Object.fromEntries(
      Object.keys(r.totals)
        .sort()
        .map((k) => [k, r.totals[k] ?? 0]),
    ),
    patterns: r.patterns.slice(0, 3).map((p) => clean(p)),
    suggestions: r.suggestions.slice(0, 3).map((x) => clean(x.text)),
  };
}

// ---- tools -----------------------------------------------------------------
//
// Named for what they do, the user's to-do list, never "dave": `~/dave` is
// also a project in the registry, and a tool called check_with_dave sat right
// beside start_task's "dave" for the model to confuse.

/** DAVE's clean-up buckets (src/triage/types.ts). */
const TRIAGE_BUCKETS = [
  "overdue_promises",
  "stale_promises",
  "looks_done",
  "old_asks",
  "meeting_decisions",
  "ideas",
] as const;

export const BACKLOG_TOOL_NAMES = [
  "check_backlog",
  "delegate_backlog_item",
  "act_on_backlog",
  "clean_up_backlog",
  "undo_backlog_clean_up",
] as const;

/**
 * The names these tools had before, mapped to today's. A Realtime session
 * minted by an older daemon still calls them until it reconnects; they are
 * accepted, never offered.
 */
export const LEGACY_BACKLOG_TOOL_NAMES: Readonly<
  Record<string, (typeof BACKLOG_TOOL_NAMES)[number]>
> = {
  check_with_dave: "check_backlog",
  delegate_dave_task: "delegate_backlog_item",
};

/** Today's name for a to-do tool, under either name; undefined for any other tool. */
export function backlogToolName(name: string): (typeof BACKLOG_TOOL_NAMES)[number] | undefined {
  const known = BACKLOG_TOOL_NAMES.find((n) => n === name);
  return (
    known ??
    (Object.hasOwn(LEGACY_BACKLOG_TOOL_NAMES, name) ? LEGACY_BACKLOG_TOOL_NAMES[name] : undefined)
  );
}

export const BACKLOG_TOOLS = [
  {
    type: "function",
    name: "check_backlog",
    description:
      "Check the backlog: the user's to-do list (what to do next, priorities and promises), as ranked by DAVE, their portfolio and priorities assistant. Only when the user asks (e.g. 'check the backlog', 'what's next on the backlog', 'checking Dave', 'what does Dave think I should do', 'what's next on my to-do list', 'what did I promise Acme'), never on your own. The backlog is not the code project named dave: opening or working on that project ('open the dave project', 'work on dave') is start_task.",
    parameters: {
      type: "object",
      properties: {
        about: {
          type: "string",
          enum: ["overview", "next", "progress", "priorities", "commitments", "project", "review"],
          description:
            "overview (default), next (DAVE's one prepared next action plus two alternatives; use for 'what should I do next'), progress (what moved and what's still missing since the user last asked), ranked priorities (the to-do list), meeting commitments, one project, or review (how often DAVE's recommendations were followed).",
        },
        project: { type: "string", description: "Spoken project name, for about=project." },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "delegate_backlog_item",
    description:
      "Hand one coding item from the backlog (an objective from check_backlog) to EZ Coder. Always needs a yes: call once to get a confirmToken and question, ask it, and call again with confirmToken and userConfirmed true only after the user says yes.",
    parameters: {
      type: "object",
      properties: {
        objectiveId: { type: "string", description: "objectiveId from check_backlog." },
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
  {
    type: "function",
    name: "act_on_backlog",
    description:
      "Change DAVE's own records for one prepared action from check_backlog (next): do its yes step, skip it, or defer it. Never starts coding work: a hand-off to EZ Coder is delegate_backlog_item. A copy step (copyInDave) is done on DAVE's own screen: this says where the draft is and changes nothing, so never say it was copied. Every other change needs a yes: call once to get a confirmToken and question, ask it, and call again with confirmToken and userConfirmed true only after the user says yes.",
    parameters: {
      type: "object",
      properties: {
        actionId: { type: "string", description: "actionId from check_backlog." },
        choice: { type: "string", enum: ["primary", "skip", "defer"] },
        reason: { type: "string", description: "Why, for skip or defer, in the user's words." },
        until: { type: "string", description: "YYYY-MM-DD, required for defer." },
        confirmToken: { type: "string", description: "Token from the first call." },
        userConfirmed: {
          type: "boolean",
          description: "True only if the user just said yes out loud.",
        },
      },
      required: ["actionId", "choice"],
    },
  },
  {
    type: "function",
    name: "clean_up_backlog",
    description:
      "Clear (or mark done) noise in DAVE: overdue or stale meeting promises, items that look done, old client asks, drafted decisions and ideas that never became promises. Only when the user asks. First call previews and returns keys, a confirmToken and a question; ask it, then call again with the same keys, confirmToken and userConfirmed true only after a yes. Exactly the previewed items change; it can be undone.",
    parameters: {
      type: "object",
      properties: {
        buckets: {
          type: "array",
          items: { type: "string", enum: [...TRIAGE_BUCKETS] },
          description: "Kinds of noise; all when omitted.",
        },
        project: { type: "string", description: "Spoken project name." },
        meeting: { type: "string", description: "Words from the meeting's title." },
        olderThanDays: { type: "integer", minimum: 0, maximum: 3650 },
        text: { type: "string", description: "Only items containing these words." },
        action: { type: "string", enum: ["clear", "done"] },
        keys: {
          type: "array",
          items: { type: "string" },
          description: "Second call only: the keys from the preview, unchanged.",
        },
        confirmToken: { type: "string", description: "Token from the first call." },
        userConfirmed: {
          type: "boolean",
          description: "True only if the user just said yes out loud.",
        },
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "undo_backlog_clean_up",
    description:
      "Undo a clean-up in DAVE (the latest when no batchId). Needs a yes: call once for a confirmToken and question, then again with userConfirmed true after the user says yes.",
    parameters: {
      type: "object",
      properties: {
        batchId: { type: "string", description: "batchId from clean_up_backlog." },
        confirmToken: { type: "string", description: "Token from the first call." },
        userConfirmed: {
          type: "boolean",
          description: "True only if the user just said yes out loud.",
        },
      },
      required: [],
    },
  },
] as const;

export interface BacklogToolContext {
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
const ACTION_ID = /^[a-f0-9]{16}$/;
const BATCH_ID = /^tb-[0-9a-f]{24}$/;
const TRIAGE_KEY = /^(?:m:[A-Za-z0-9_-]{8,128}|p:[A-Za-z0-9_-]{8,128})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** DAVE keeps "when Pew last asked" itself, so Pew holds no timestamp. */
const BRIEFING_PATH = "/api/intel/briefing?caller=pew";

async function check(args: Record<string, unknown>, ctx: BacklogToolContext): Promise<ToolResult> {
  const about = arg(args, "about", 20) ?? "overview";
  const now = ctx.now();
  switch (about) {
    case "overview": {
      const [focus, meetings, briefing] = await Promise.all([
        ctx.client.get("/api/intel/focus", FocusSchema),
        ctx.client.get("/api/meetings/items", MeetingItemsSchema),
        ctx.client.get(BRIEFING_PATH, BriefingSchema),
      ]);
      if (!focus.ok) return unavailable(focus.say);
      return good(
        overview(
          focus.value,
          meetings.ok ? meetings.value : undefined,
          now,
          briefing.ok ? briefing.value : undefined,
        ),
      );
    }
    case "next": {
      const next = await ctx.client.get("/api/intel/next", NextStateSchema);
      return next.ok ? good(nextView(next.value)) : unavailable(next.say);
    }
    case "progress": {
      const briefing = await ctx.client.get(BRIEFING_PATH, BriefingSchema);
      return briefing.ok ? good(progressView(briefing.value)) : unavailable(briefing.say);
    }
    case "review": {
      const review = await ctx.client.get(
        "/api/intel/recommendations/review?days=30",
        ReviewSchema,
      );
      return review.ok ? good(reviewView(review.value)) : unavailable(review.say);
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
      return fail(
        "about must be overview, next, progress, priorities, commitments, project or review.",
      );
  }
}

/** The objective by id: DAVE's ranked queue first, then each project's other actions. */
async function findObjective(
  ctx: BacklogToolContext,
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

async function delegate(
  args: Record<string, unknown>,
  ctx: BacklogToolContext,
): Promise<ToolResult> {
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

/** Ask first; true only for a redeemed token on a spoken yes. */
function confirmed(
  args: Record<string, unknown>,
  ctx: BacklogToolContext,
  subject: string,
): boolean {
  return args.userConfirmed === true && ctx.confirm.redeem(arg(args, "confirmToken", 40), subject);
}

/** Pew asks, DAVE records. Never enqueues anything: a hand-off is delegate_backlog_item. */
async function act(args: Record<string, unknown>, ctx: BacklogToolContext): Promise<ToolResult> {
  const actionId = arg(args, "actionId", 20);
  if (!actionId || !ACTION_ID.test(actionId))
    return fail("That is not one of DAVE's prepared actions. Check the backlog again.");
  const choice = arg(args, "choice", 10);
  if (choice !== "primary" && choice !== "skip" && choice !== "defer")
    return fail("choice must be primary, skip or defer.");
  const until = arg(args, "until", 10);
  if (choice === "defer" && (!until || !DATE_ONLY.test(until) || Number.isNaN(Date.parse(until))))
    return fail("Defer needs a date (YYYY-MM-DD).");
  const reason = arg(args, "reason", 300);
  const next = await ctx.client.get("/api/intel/next", NextStateSchema);
  if (!next.ok) return unavailable(next.say);
  const all = [...(next.value.action ? [next.value.action] : []), ...next.value.queue];
  const action = all.find((a) => a.id === actionId);
  if (!action)
    return good({
      acted: false,
      stale: true,
      say: "DAVE's recommendation changed; check the backlog again.",
    });
  const title = clean(action.title);
  if (choice === "primary" && action.primary.op.op === "hand_to_ezcoder")
    return good({
      acted: false,
      handOff: true,
      ...(action.objectiveId ? { objectiveId: action.objectiveId } : null),
      say: "That one is coding work for EZ Coder; offer delegate_backlog_item instead.",
    });
  // A copy happens on DAVE's own screen and DAVE records nothing for it, so there
  // is no yes to ask for and nothing to post. Saying where the draft is keeps the
  // model from telling the user it was copied. Its text never comes through here.
  if (choice === "primary" && action.primary.op.op === "copy")
    return good({
      acted: false,
      copyInDave: true,
      say: action.draft
        ? `The ${clean(action.draft.kind, 20)} is ready to copy in DAVE; nothing was copied.`
        : "It's ready to copy in DAVE; nothing was copied.",
    });
  const subject = `dave-act:${actionId}:${choice}`;
  if (!confirmed(args, ctx, subject)) {
    const question =
      choice === "primary"
        ? `${clean(action.primary.label, 80)} for ${clean(action.projectName, 60)}: ${title}?`
        : choice === "skip"
          ? `Skip DAVE's recommendation for now: ${title}?`
          : `Put off until ${until}: ${title}?`;
    return good({ needsConfirmation: true, confirmToken: ctx.confirm.issue(subject), question });
  }
  const body =
    choice === "primary"
      ? { op: action.primary.op.op }
      : choice === "skip"
        ? { op: "skip", ...(reason ? { note: reason } : null) }
        : { op: "defer", date: until, ...(reason ? { note: reason } : null) };
  const r = await ctx.client.post(
    `/api/intel/next/${actionId}/act`,
    body,
    z.object({ summary: z.string().default("") }).passthrough(),
  );
  if (!r.ok)
    return r.stale
      ? good({
          acted: false,
          stale: true,
          say: "That's out of date in DAVE; check the backlog again.",
        })
      : unavailable(r.say);
  return good({ acted: true, say: clean(r.value.summary) || `Done: ${title}.` });
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of [...values].sort()) out[v] = (out[v] ?? 0) + 1;
  return out;
}

const cleanSubject = (keys: readonly string[], action: string) =>
  `dave-clean:${createHash("sha256")
    .update([...keys].sort().join("\n"))
    .digest("hex")}:${action}`;

async function cleanUp(
  args: Record<string, unknown>,
  ctx: BacklogToolContext,
): Promise<ToolResult> {
  const action = arg(args, "action", 10) ?? "clear";
  if (action !== "clear" && action !== "done") return fail("action must be clear or done.");

  // Step 2: exactly the keys the user heard about, bound to the token by their hash.
  if (args.confirmToken !== undefined) {
    const raw = args.keys;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 1000)
      return fail("Send back the keys from the preview.");
    const keys = raw.filter((k): k is string => typeof k === "string" && TRIAGE_KEY.test(k));
    if (keys.length !== raw.length) return fail("Those keys are not from DAVE's preview.");
    if (!confirmed(args, ctx, cleanSubject(keys, action)))
      return good({ cleaned: false, say: "That needs a fresh yes; preview it again." });
    const r = await ctx.client.post("/api/triage/apply", { keys, action }, TriageResultSchema);
    if (!r.ok)
      return r.stale ? good({ cleaned: false, stale: true, say: r.say }) : unavailable(r.say);
    return good({
      cleaned: r.value.changed > 0,
      ...(r.value.batchId ? { batchId: r.value.batchId } : null),
      say: `${clean(r.value.summary)}${r.value.batchId ? " It can be undone." : ""}`,
    });
  }

  const filter: Record<string, unknown> = {};
  if (args.buckets !== undefined) {
    const list = Array.isArray(args.buckets) ? args.buckets : [];
    const buckets = TRIAGE_BUCKETS.filter((b) => list.includes(b));
    if (buckets.length !== list.length || !buckets.length) return fail("Unknown kind of noise.");
    filter.buckets = buckets;
  }
  if (args.olderThanDays !== undefined) {
    const d = args.olderThanDays;
    if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 3650)
      return fail("olderThanDays should be a whole number of days.");
    filter.olderThanDays = d;
  }
  const words = arg(args, "text", 200);
  if (words) filter.text = words;
  const projectQuery = arg(args, "project", 100);
  if (projectQuery) {
    const focus = await ctx.client.get("/api/intel/focus", FocusSchema);
    if (!focus.ok) return unavailable(focus.say);
    const r = resolveProject(projectQuery, daveProjects(focus.value));
    if (!r.best)
      return good({
        needsClarification: true,
        reason: r.candidates.length
          ? "Several of DAVE's projects match."
          : "DAVE has no project by that name.",
        ...(r.candidates.length
          ? { question: didYouMean(r.candidates.map((c) => c.project.name)) }
          : null),
      });
    filter.projectId = r.best.projectId;
  }
  const preview = await ctx.client.post("/api/triage/preview", { filter }, TriagePreviewSchema);
  if (!preview.ok) return unavailable(preview.say);
  let entries = preview.value.entries;
  const meeting = arg(args, "meeting", 100)?.toLowerCase();
  if (meeting) {
    entries = entries.filter((e) => e.meetingTitle?.toLowerCase().includes(meeting));
    const titles = [...new Set(entries.map((e) => clean(e.meetingTitle, 60)))].sort();
    if (titles.length > 1)
      return good({
        needsClarification: true,
        reason: "Several meetings match.",
        question: didYouMean(titles),
      });
  }
  entries = entries.filter((e) => TRIAGE_KEY.test(e.key)).slice(0, 1000);
  if (!entries.length)
    return good({ cleaned: false, say: "Nothing matches that, so there is nothing to clean up." });
  const keys = entries.map((e) => e.key);
  const n = keys.length;
  const examples = entries.slice(0, 3).map((e) => clean(e.title, 100));
  return good({
    needsConfirmation: true,
    confirmToken: ctx.confirm.issue(cleanSubject(keys, action)),
    question: `${action === "clear" ? "Clear" : "Mark done"} ${n} item${n === 1 ? "" : "s"} in DAVE, for example ${examples.slice(0, 2).join(" and ")}? It can be undone.`,
    total: n,
    byBucket: countBy(entries.map((e) => e.bucket)),
    byProject: countBy(entries.map((e) => clean(e.projectName, 60) || "no project")),
    examples,
    keys,
    action,
  });
}

async function undoCleanUp(
  args: Record<string, unknown>,
  ctx: BacklogToolContext,
): Promise<ToolResult> {
  let batchId = arg(args, "batchId", 40);
  let summary: string | undefined;
  if (batchId && !BATCH_ID.test(batchId)) return fail("That is not one of DAVE's clean-ups.");
  if (!batchId) {
    const list = await ctx.client.get("/api/triage/batches", BatchesSchema);
    if (!list.ok) return unavailable(list.say);
    const latest = list.value.batches.find((b) => b.undoneAt === null && BATCH_ID.test(b.id));
    if (!latest) return good({ undone: false, say: "There is no clean-up to undo." });
    batchId = latest.id;
    summary = clean(latest.summary);
  }
  const subject = `dave-undo:${batchId}`;
  if (!confirmed(args, ctx, subject))
    return good({
      needsConfirmation: true,
      confirmToken: ctx.confirm.issue(subject),
      batchId,
      question: summary ? `Undo the clean-up: ${summary}?` : "Undo that clean-up in DAVE?",
    });
  const r = await ctx.client.post("/api/triage/undo", { batchId }, TriageUndoSchema);
  if (!r.ok)
    return r.notFound
      ? good({ undone: false, say: "DAVE has no such clean-up." })
      : unavailable(r.say);
  return good({
    undone: true,
    say: `Restored ${r.value.restored} item${r.value.restored === 1 ? "" : "s"}.${r.value.skipped ? ` ${r.value.skipped} had changed since, so DAVE left them.` : ""}`,
  });
}

/** Run one backlog tool, under its current or legacy name. Errors become results, like every other voice tool. */
export function runBacklogTool(
  name: string,
  args: Record<string, unknown>,
  ctx: BacklogToolContext,
): Promise<ToolResult> {
  const tool = backlogToolName(name);
  if (tool === "check_backlog") return check(args, ctx);
  if (tool === "delegate_backlog_item") return delegate(args, ctx);
  if (tool === "act_on_backlog") return act(args, ctx);
  if (tool === "clean_up_backlog") return cleanUp(args, ctx);
  if (tool === "undo_backlog_clean_up") return undoCleanUp(args, ctx);
  return Promise.resolve(fail(`Unknown tool '${name}'.`));
}

// ---- opening check-in --------------------------------------------------------
//
// The one unprompted contact with DAVE: a single read-only GET of the focus
// list when a voice session opens, so the check-in can say "DAVE has a new
// recommendation for X". Project names only; objective text never leaves here.

/** `PEW2_DAVE_CHECKIN=off` keeps DAVE out of the opening check-in; `PEW2_DAVE=off` still removes everything. */
export function daveCheckinEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = env.PEW2_DAVE_CHECKIN?.trim().toLowerCase();
  return !(flag === "off" || flag === "0" || flag === "false");
}

/** Per DAVE projectId, its current top objective and the project's display name. */
export type DaveDigest = Record<string, { topObjectiveId: string; projectName: string }>;

/**
 * Exactly one GET to `/api/intel/focus` with a short timeout. A project's top
 * objective is the first of its objectives in DAVE's ranked queue (`top` first).
 * Undefined on any failure: the check-in just says nothing about DAVE.
 */
export async function daveDigest(
  client: DaveClient,
  timeoutMs = 1_500,
): Promise<DaveDigest | undefined> {
  try {
    const focus = await client.get("/api/intel/focus", FocusSchema, { timeoutMs });
    if (!focus.ok) return undefined;
    const digest: DaveDigest = {};
    for (const o of queueOf(focus.value)) {
      if (Object.hasOwn(digest, o.projectId)) continue;
      digest[o.projectId] = { topObjectiveId: o.id, projectName: o.projectName };
    }
    return digest;
  } catch {
    return undefined;
  }
}

/**
 * Which DAVE projects have a new top recommendation since `prevSeen`
 * (projectId → objectiveId, as stored in `CheckinState.daveSeen`), and the map
 * to store next. First sight (no `prevSeen`) records silently. A project new
 * to DAVE, or whose top changed, is named; names are cleaned and sorted.
 * Without a digest the previous map is kept as it was.
 */
export function daveChanges(
  prevSeen: Readonly<Record<string, string>> | undefined,
  digest: DaveDigest | undefined,
): { projects: string[]; seen: Record<string, string> | undefined } {
  if (!digest) return { projects: [], seen: prevSeen ? { ...prevSeen } : undefined };
  const seen: Record<string, string> = {};
  const names = new Set<string>();
  for (const id of Object.keys(digest).sort()) {
    const entry = digest[id];
    if (!entry) continue;
    seen[id] = entry.topObjectiveId;
    if (!prevSeen) continue;
    const before = Object.hasOwn(prevSeen, id) ? prevSeen[id] : undefined;
    if (before === entry.topObjectiveId) continue;
    const name = clean(entry.projectName, 60);
    if (name) names.add(name);
  }
  return { projects: [...names].sort((a, b) => a.localeCompare(b)), seen };
}
