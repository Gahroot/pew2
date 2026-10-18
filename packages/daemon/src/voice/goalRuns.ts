/**
 * EZ Coder goal runs, read from disk.
 *
 * A goal run (`/goal <objective>`, driven by the agent's own `goals` tool) is
 * durable state ezcoder writes to
 * `<EZ_GOALS_BASE or ~/.ezcoder/goals/projects>/<sha256(cwd)[0:16]>/goals.json`.
 * Voice never writes there. It reads the file to tell how a goal is going,
 * which is a different question from whether one agent turn ended, and ports
 * ezcoder's own completion and next-step rules read-only so it can say so.
 *
 * Everything that leaves this module as text has passed `speakable()`: the
 * file is full of absolute paths, commands and long summaries.
 */
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { GoalHooks, GoalTurnDecision } from "./dispatcher.js";
import { speakable } from "./safety.js";
import type { StoredGoal, StoredTask, VoiceStore } from "./store.js";
import type { VoiceGoalChange, VoiceGoalProgress } from "./types.js";

export const MAX_GOAL_FILE_BYTES = 2 * 1024 * 1024;
/** A run created this long before the task was asked for still counts as its run (clock skew, slow save). */
export const RUN_MATCH_SLACK_MS = 60_000;

// ---- location --------------------------------------------------------------

export function goalRunsBase(env: NodeJS.ProcessEnv, home: string): string {
  return env.EZ_GOALS_BASE ?? join(home, ".ezcoder", "goals", "projects");
}

/** Exactly ezcoder's `hashPath`: sha256 of the resolved path, first 16 hex chars. */
export function goalRunsFile(base: string, cwd: string): string {
  const hash = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
  return join(base, hash, "goals.json");
}

// ---- schema ----------------------------------------------------------------

const str = z.string().catch("");
const optStr = z
  .unknown()
  .transform((v) => (typeof v === "string" && v.length > 0 ? v : undefined));

/** An array where a malformed item is dropped, never fatal. */
function lenientArray<T extends z.ZodTypeAny>(item: T) {
  return z
    .unknown()
    .transform((value): z.output<T>[] => {
      if (!Array.isArray(value)) return [];
      const out: z.output<T>[] = [];
      for (const entry of value) {
        const parsed = item.safeParse(entry);
        if (parsed.success) out.push(parsed.data);
      }
      return out;
    });
}

const Verification = z
  .object({
    status: z.enum(["pass", "fail", "unknown"]).catch("unknown"),
    summary: str,
    command: optStr,
    outputPath: optStr,
    exitCode: z.number().optional().catch(undefined),
    checkedAt: str,
  })
  .passthrough();

const Prerequisite = z
  .object({
    id: str,
    label: z.string().catch("Prerequisite"),
    status: z.enum(["unknown", "met", "missing"]).catch("unknown"),
    instructions: optStr,
    evidence: optStr,
  })
  .passthrough();

const EvidencePlanItem = z
  .object({
    id: str,
    label: z.string().catch("Evidence path"),
    description: str,
    status: z.enum(["planned", "ready", "blocked"]).catch("planned"),
    command: optStr,
    path: optStr,
    instructions: optStr,
    evidence: optStr,
  })
  .passthrough();

const HarnessItem = z
  .object({ id: str, label: z.string().catch("Harness"), command: optStr, path: optStr })
  .passthrough();

const GoalTask = z
  .object({
    id: str,
    title: z.string().catch("Goal task"),
    status: z.enum(["pending", "running", "verifying", "done", "failed", "blocked"]).catch("pending"),
    attempts: z.number().nonnegative().catch(0),
    workerId: optStr,
  })
  .passthrough();

const Evidence = z
  .object({ label: z.string().catch("Evidence"), content: optStr, path: optStr, createdAt: str })
  .passthrough();

const RUN_STATUSES = ["draft", "blocked", "ready", "running", "verifying", "passed", "failed", "paused"] as const;
export type GoalRunStatus = (typeof RUN_STATUSES)[number];

/** Lenient: every field defaulted the way ezcoder's `normalizeRun` does. Only a run without an id is unusable. */
export const GoalRunSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().catch("Untitled goal"),
    goal: str,
    status: z.enum(RUN_STATUSES).catch("draft"),
    createdAt: str,
    updatedAt: str,
    projectPath: optStr,
    successCriteria: lenientArray(z.string()),
    prerequisites: lenientArray(Prerequisite),
    harness: lenientArray(HarnessItem),
    evidencePlan: lenientArray(EvidencePlanItem),
    tasks: lenientArray(GoalTask),
    evidence: lenientArray(Evidence),
    verifier: z
      .object({ description: str, command: optStr, lastResult: Verification.optional().catch(undefined) })
      .passthrough()
      .optional()
      .catch(undefined),
    completionAudit: z
      .object({ status: z.enum(["pass", "fail", "unknown"]).catch("unknown"), summary: str, checkedAt: str, verifierCheckedAt: optStr, outputPath: optStr })
      .passthrough()
      .optional()
      .catch(undefined),
    blockers: lenientArray(z.string()),
    activeWorkerId: optStr,
    continueRequestedAt: optStr,
  })
  .passthrough()
  .transform((run) => ({
    ...run,
    goal: run.goal || run.title,
    updatedAt: run.updatedAt || run.createdAt,
    // ezcoder's deriveRunnableStatus: a blocking prerequisite blocks anything not finished or paused.
    status: (run.status !== "passed" && run.status !== "failed" && run.status !== "paused" && run.prerequisites.some(isBlockingPrerequisite)
      ? "blocked"
      : run.status) as GoalRunStatus,
  }));

export type GoalRun = z.output<typeof GoalRunSchema>;
type Prereq = GoalRun["prerequisites"][number];

function isBlockingPrerequisite(item: { status: string; evidence?: string }): boolean {
  return item.status !== "met" || !item.evidence?.trim();
}

/** Parse a goals.json body; malformed runs are dropped. Newest first by `updatedAt`, ties by id. */
export function parseGoalRuns(text: string): GoalRun[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(json)) return [];
  const runs: GoalRun[] = [];
  for (const item of json) {
    const parsed = GoalRunSchema.safeParse(item);
    if (parsed.success) runs.push(parsed.data);
  }
  return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

/** The project's runs, newest first. Missing, oversized or corrupt reads as none. */
export async function readGoalRuns(base: string, cwd: string, signal?: AbortSignal): Promise<GoalRun[]> {
  const file = goalRunsFile(base, cwd);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, "r");
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_GOAL_FILE_BYTES) return [];
    signal?.throwIfAborted();
    const text = await handle.readFile({ encoding: "utf8", ...(signal ? { signal } : null) });
    return parseGoalRuns(text);
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** goals.json's mtime in ms, undefined when there is none. */
export async function goalRunsMtime(base: string, cwd: string): Promise<number | undefined> {
  try {
    return (await stat(goalRunsFile(base, cwd))).mtimeMs;
  } catch {
    return undefined;
  }
}

/** The newest run created at or after the request (less a minute's slack). */
export function findRunForTask(runs: readonly GoalRun[], requestedAt: number): GoalRun | undefined {
  const floor = requestedAt - RUN_MATCH_SLACK_MS;
  return runs
    .map((run) => ({ run, created: Date.parse(run.createdAt) }))
    .filter((r) => Number.isFinite(r.created) && r.created >= floor)
    .sort((a, b) => b.created - a.created || a.run.id.localeCompare(b.run.id))[0]?.run;
}

// ---- ezcoder's completion rules, read-only ---------------------------------

const AUDIT_TASK = "Audit Goal completion evidence";

function isAuditWorkerEvidence(run: GoalRun, label: string): boolean {
  const workerId = /^Worker\s+(\S+)\s+/.exec(label)?.[1];
  return !!workerId && run.tasks.some((t) => t.title === AUDIT_TASK && t.workerId === workerId);
}

function latestEvidence(run: GoalRun, predicate: (item: GoalRun["evidence"][number]) => boolean) {
  return run.evidence.filter(predicate).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function workerEvidenceAfterVerifier(run: GoalRun) {
  const at = run.verifier?.lastResult?.checkedAt;
  if (!at) return undefined;
  return latestEvidence(run, (e) => e.createdAt > at && e.label.startsWith("Worker ") && !isAuditWorkerEvidence(run, e.label));
}

/** Port of `hasFreshGoalCompletionAudit`. */
export function hasFreshCompletionAudit(run: GoalRun): boolean {
  const verifier = run.verifier?.lastResult;
  if (!verifier || verifier.status !== "pass") return false;
  if (workerEvidenceAfterVerifier(run)) return false;
  const audit = run.completionAudit;
  if (!audit || audit.status !== "pass") return false;
  if (!audit.summary.startsWith("FINAL_AUDIT_PASS")) return false;
  if (!audit.summary.includes(`verifier_checked_at=${verifier.checkedAt}`)) return false;
  if (!audit.outputPath && !/(?:output|artifact|log|path)=\S+/.test(audit.summary)) return false;
  if (audit.verifierCheckedAt !== verifier.checkedAt) return false;
  if (audit.checkedAt < verifier.checkedAt) return false;
  const newer = latestEvidence(run, (e) => {
    if (e.createdAt <= verifier.checkedAt) return false;
    if (isAuditWorkerEvidence(run, e.label) || e.label === "Goal decision: completion_audit") return false;
    if (e.label.startsWith("Verifier ")) return false;
    return e.label.startsWith("Worker ") || e.label.startsWith("Goal decision:");
  });
  return !(newer && newer.createdAt > audit.checkedAt);
}

function evidencePlanItemSatisfied(run: GoalRun, item: GoalRun["evidencePlan"][number]): boolean {
  if (item.evidence?.trim()) return true;
  const verifier = run.verifier?.lastResult;
  if (verifier?.status === "pass") {
    if (item.command && verifier.command === item.command) return true;
    if (item.path && verifier.outputPath === item.path) return true;
  }
  return run.evidence.some(
    (e) =>
      (item.path !== undefined && e.path === item.path) ||
      (item.command !== undefined && !!e.content?.includes(item.command)) ||
      (item.path !== undefined && !!e.content?.includes(item.path)),
  );
}

function unsatisfiedEvidence(run: GoalRun) {
  return run.evidencePlan.filter((item) => !evidencePlanItemSatisfied(run, item));
}

/** Port of `canCompleteGoalRun`: true only when ezcoder itself would let the run pass. */
export function canCompleteGoalRun(run: GoalRun): boolean {
  if (run.status === "draft" || run.successCriteria.length === 0 || run.evidencePlan.length === 0) return false;
  if (!run.verifier?.command) return false;
  if (run.prerequisites.some(isBlockingPrerequisite)) return false;
  if (run.tasks.some((t) => t.status !== "done")) return false;
  if (unsatisfiedEvidence(run).length > 0) return false;
  if (run.verifier.lastResult?.status !== "pass") return false;
  return hasFreshCompletionAudit(run);
}

// ---- progress --------------------------------------------------------------

/** What the user has to do, speakable. Prerequisites that carry instructions, blocked evidence, blockers. */
function needsYouOf(run: GoalRun): string | undefined {
  const lines: string[] = [];
  for (const p of run.prerequisites) {
    // Not "label: instructions": a label ending in "token" or "key" then reads as
    // a credential assignment, and redaction (rightly) swallows the instructions.
    if (isBlockingPrerequisite(p) && p.instructions) lines.push(`${p.label} — ${p.instructions}`);
  }
  for (const item of run.evidencePlan) {
    if (item.status === "blocked") lines.push(`${item.label} — ${item.instructions ?? "this proof needs you"}`);
  }
  if (run.status !== "passed") lines.push(...run.blockers);
  const said = [...new Set(lines.map((l) => speakable(l, 160)).filter(Boolean))];
  return said.length ? speakable(said.slice(0, 3).join("; "), 240) : undefined;
}

export type NextStepKind =
  | "complete"
  | "needs_you"
  | "terminal"
  | "wait"
  | "milestone"
  | "pause"
  | "evidence"
  | "harness"
  | "fix_verifier"
  | "verify"
  | "audit"
  | "setup";

export interface NextStep {
  kind: NextStepKind;
  say: string;
}

/**
 * What ezcoder's controller would do next, as one phrase. A read-only port of
 * `decideGoalNextAction`'s priority order: it names the step, never takes it.
 */
export function nextStep(run: GoalRun): NextStep {
  const step = (kind: NextStepKind, say: string): NextStep => ({ kind, say: speakable(say, 160) });
  if (canCompleteGoalRun(run)) return step("complete", "it can be marked passed");
  const blocking = run.prerequisites.filter(isBlockingPrerequisite);
  if (blocking.length) {
    const first = blocking[0] as Prereq;
    return first.instructions || first.status === "missing"
      ? step("needs_you", `it needs you for ${first.label}`)
      : step("setup", `checking ${first.label}`);
  }
  const verifierPass = run.verifier?.lastResult?.status === "pass";
  if (
    (run.status === "blocked" && !verifierPass) ||
    run.status === "failed" ||
    (run.status === "passed" && !verifierPass) ||
    (run.status === "paused" && !run.continueRequestedAt)
  ) {
    return step("terminal", `the run is ${run.status}`);
  }
  const active = run.tasks.find((t) => t.status === "running" || t.status === "verifying");
  if (active) return step("wait", `working on ${active.title}`);
  if (run.activeWorkerId) return step("wait", "a worker is already on it");
  const pending = run.tasks.find((t) => t.status === "pending" || t.status === "failed");
  if (pending) {
    return pending.attempts + 1 > 5 ? step("pause", `${pending.title} has run out of attempts`) : step("milestone", `next is ${pending.title}`);
  }
  const blockedEvidence = run.evidencePlan.find((item) => item.status === "blocked");
  if (blockedEvidence) return step("needs_you", `it needs you for ${blockedEvidence.label}`);
  if (unsatisfiedEvidence(run).some((item) => item.status === "planned")) {
    return step("evidence", verifierPass ? "reconciling the evidence after the verifier passed" : "building a way to prove it works");
  }
  if (run.harness.some((h) => !h.command && !h.path)) return step("harness", "building the test harness");
  if (run.verifier?.lastResult?.status === "fail") return step("fix_verifier", "fixing what the verifier caught");
  if (verifierPass) {
    if (workerEvidenceAfterVerifier(run) && run.verifier?.command) return step("verify", "re-running the verifier");
    return step("audit", "the final completion audit");
  }
  if (run.verifier?.command) return step("verify", "running the verifier");
  return step("setup", "defining how to verify it");
}

/** Where a goal run stands, for the ear. */
export function goalProgress(run: GoalRun): VoiceGoalProgress {
  const complete = canCompleteGoalRun(run);
  const verifierStatus = run.verifier?.lastResult?.status;
  const verified: VoiceGoalProgress["verified"] =
    verifierStatus === "pass" && hasFreshCompletionAudit(run) ? "pass" : verifierStatus === "fail" ? "fail" : "none";
  let done: number;
  let total: number;
  if (run.tasks.length > 0) {
    total = run.tasks.length;
    done = run.tasks.filter((t) => t.status === "done").length;
  } else {
    // No milestones: success criteria stand in, met all together or not yet.
    total = run.successCriteria.length;
    done = complete || run.status === "passed" ? total : 0;
  }
  const active = run.tasks.find((t) => t.status === "running" || t.status === "verifying");
  const needsYou = needsYouOf(run);
  const next = nextStep(run);
  const progress: VoiceGoalProgress = {
    runId: run.id,
    title: speakable(run.title, 80),
    status: run.status,
    done,
    total,
    ...(run.tasks.length === 0 && total > 0 ? { unit: "criteria" as const } : null),
    ...(active ? { active: speakable(active.title, 80) } : null),
    verified,
    ...(needsYou ? { needsYou } : null),
    ...(next.say ? { next: next.say } : null),
  };
  const evidence = run.tasks.length === 0 && run.evidence.length > 0 ? run.evidence.length : 0;
  progress.say = describeGoal(progress, undefined, evidence);
  return progress;
}

export interface GoalLive {
  working: boolean;
  agentName: string;
  approvals: number;
  question?: string;
}

const capital = (s: string) => (s ? s[0]?.toUpperCase() + s.slice(1) : s);

/**
 * A fragment as the end of a spoken sentence. A cut (`speakable`'s "…") can
 * leave a bracket open, which reads as an unfinished aside, so it is dropped
 * from there; then exactly one full stop.
 */
function sentenceEnd(text: string): string {
  let out = text.trim();
  const open = out.lastIndexOf("(");
  if (open > 0 && open > out.lastIndexOf(")")) out = out.slice(0, open).replace(/[\s:;,—-]+$/, "");
  return /[.!?…]$/.test(out) ? out : `${out}.`;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How far along, in words. Criteria are met together, so they are never counted part-way. */
function countSentence({ done, total, unit }: VoiceGoalProgress): string {
  if (unit === "criteria") {
    const noun = total === 1 ? "success criterion" : "success criteria";
    if (done >= total) return total === 1 ? "Its success criterion is met." : `All ${total} ${noun} are met.`;
    return total === 1 ? "It has one success criterion to meet." : `It has ${total} ${noun} to meet.`;
  }
  if (total === 1) return done >= 1 ? "Its one milestone is done." : "Its one milestone is not done yet.";
  if (done >= total) return `All ${plural(total, "milestone")} are done.`;
  return `${done} of ${plural(total, "milestone")} ${done === 1 ? "is" : "are"} done.`;
}

/**
 * The spoken summary: where it stands, what is happening, and whether the
 * user is needed. Deterministic and speakable.
 */
export function describeGoal(progress: VoiceGoalProgress, live?: GoalLive, evidenceCount = 0): string {
  const parts: string[] = [];
  if (progress.status === "passed" || (progress.verified === "pass" && progress.done >= progress.total && progress.total > 0)) {
    parts.push("The goal reports passed, with the verifier and final audit recorded.");
  } else if (progress.status === "failed") {
    parts.push("The goal run failed.");
  } else if (progress.total === 0) {
    parts.push("The goal is still being set up.");
  } else {
    parts.push(countSentence(progress));
  }
  if (evidenceCount > 0) parts.push(`${plural(evidenceCount, "piece")} of evidence recorded.`);
  if (progress.verified === "fail") parts.push("The verifier last failed.");
  if (progress.active) parts.push(`Now on: ${progress.active}.`);
  // With something waiting on the user, the next step *is* that thing: say it once, below.
  else if (progress.next && progress.status !== "passed" && !progress.needsYou) parts.push(sentenceEnd(capital(progress.next)));
  if (live?.question) parts.push(`${live.agentName} is asking: ${live.question}`);
  else if (live && live.approvals > 0) parts.push(`${live.agentName} is waiting for an approval.`);
  else if (live?.working) parts.push(`${live.agentName} is working on that now.`);
  const needsSomething = !!progress.needsYou || !!live?.question || (live?.approvals ?? 0) > 0;
  if (progress.needsYou) parts.push(`It needs you: ${sentenceEnd(progress.needsYou)}`);
  else if (!needsSomething) parts.push("Nothing needs you.");
  return speakable(parts.join(" ").replace(/\.\./g, "."), 400);
}

/** What changed between two readings of one run, in a fixed order. */
export function progressChanges(prev: VoiceGoalProgress | undefined, next: VoiceGoalProgress): VoiceGoalChange[] {
  const changes: VoiceGoalChange[] = [];
  if (!prev?.runId && next.runId) changes.push("setup");
  if (prev && next.done > prev.done && next.total > 0) changes.push("milestone_done");
  if (next.verified === "pass" && prev?.verified !== "pass") changes.push("verifier_pass");
  if (next.verified === "fail" && prev?.verified !== "fail") changes.push("verifier_fail");
  if (next.needsYou && next.needsYou !== prev?.needsYou) changes.push("needs_you");
  if (next.status === "passed" && prev?.status !== "passed") changes.push("passed");
  if (next.status === "failed" && prev?.status !== "failed") changes.push("failed");
  return changes;
}

const CHANGE_TEXT: Record<VoiceGoalChange, (p: VoiceGoalProgress) => string> = {
  setup: (p) => `Goal set up: ${p.title ?? "the goal"}${p.total ? `, ${plural(p.total, "milestone")}` : ""}.`,
  milestone_done: (p) => `Goal milestone done: ${p.done} of ${p.total}.`,
  milestone_failed: () => "A goal milestone failed.",
  verifier_pass: () => "The goal's verifier passed and the final audit is recorded.",
  verifier_fail: () => "The goal's verifier failed; the agent is meant to fix it.",
  needs_you: (p) => `The goal needs you: ${p.needsYou ?? "check it"}.`,
  passed: () => "The agent reports the goal passed.",
  failed: () => "The goal run failed.",
  stalled: () => "The goal made no progress.",
};

/** The text for a goal change; exported for the dispatcher and tests. */
export function changeText(change: VoiceGoalChange, progress: VoiceGoalProgress): string {
  return speakable(CHANGE_TEXT[change](progress), 240);
}

/** The turn that keeps a run going: ezcoder's own `resume` action names the next step. */
export function continuePrompt(runId: string, title: string): string {
  return `Continue goal run ${runId} ("${title}"): call the goals tool with action resume for this run, then do the next step it names; keep durable state current; never mark it complete unless the verifier and final audit pass.`;
}

/** The run a goal task belongs to: by id once known, otherwise the newest made after it was asked for. */
export function runOf(goal: StoredGoal, runs: readonly GoalRun[]): GoalRun | undefined {
  return goal.runId ? runs.find((r) => r.id === goal.runId) : findRunForTask(runs, goal.requestedAt);
}

// ---- tracker ---------------------------------------------------------------

const TRACKED: ReadonlySet<string> = new Set(["running", "blocked"]);

/**
 * Watches goals.json for live goal tasks and turns what changed into events.
 * Stats only, until a file actually moved; never overlaps itself.
 */
export class GoalTracker {
  private readonly seen = new Map<string, number>();
  private inFlight: Promise<number> | undefined;

  /** Resolves with the number of events emitted. A poll during a poll joins it. */
  poll(store: VoiceStore, base: string, signal?: AbortSignal): Promise<number> {
    if (this.inFlight) return this.inFlight;
    const run = this.pollOnce(store, base, signal).finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = run;
    return run;
  }

  private async pollOnce(store: VoiceStore, base: string, signal?: AbortSignal): Promise<number> {
    let emitted = 0;
    const live = store
      .tasks()
      .filter((t) => t.goal && TRACKED.has(t.state))
      .sort((a, b) => a.taskId.localeCompare(b.taskId, "en", { numeric: true }));
    const liveIds = new Set(live.map((t) => t.taskId));
    for (const id of [...this.seen.keys()]) if (!liveIds.has(id)) this.seen.delete(id);
    for (const task of live) {
      if (signal?.aborted) break;
      const mtime = await goalRunsMtime(base, task.cwd);
      if (mtime === undefined || this.seen.get(task.taskId) === mtime) continue;
      this.seen.set(task.taskId, mtime);
      const runs = await readGoalRuns(base, task.cwd, signal);
      // The task may have moved on while the file was read.
      const current = store.getTask(task.taskId);
      if (!current?.goal || !TRACKED.has(current.state)) continue;
      const found = runOf(current.goal, runs);
      if (!found) continue;
      emitted += applyRun(store, current, found);
    }
    return emitted;
  }
}

/** Record a fresh reading of a task's run and announce each change. Returns the events emitted. */
export function applyRun(store: VoiceStore, task: StoredTask, run: GoalRun): number {
  const goal = task.goal;
  if (!goal) return 0;
  const progress = goalProgress(run);
  const changes = progressChanges(goal.progress, progress);
  const updated: StoredGoal = { ...goal, runId: run.id, progress };
  if (changes.length === 0) {
    store.patch(task.taskId, { goal: updated });
    return 0;
  }
  for (const change of changes) {
    // Always progress: the task's state has not changed, so an event kind
    // claiming "failed" or "completed" would contradict it, and the urgent
    // announcement belongs to the transition `goalHooks.afterTurn` makes when
    // the turn ends. Announcing here too would ring the phone twice.
    store.transition(task.taskId, task.state, "task.progress", changeText(change, progress), { goal: updated }, { goal: { runId: run.id, change } });
  }
  return changes.length;
}

// ---- orchestrator hooks ----------------------------------------------------

export interface GoalHookOptions {
  base: string;
  now?: () => number;
  /** Override the reader, for tests. */
  read?: (base: string, cwd: string) => Promise<GoalRun[]>;
}

/**
 * Decide what a goal task does after a turn ends, from the run as ezcoder
 * left it on disk. ezcoder stays the authority: "complete" only when its own
 * completion rule holds, and "continue" sends a turn that asks *its* resume
 * action for the next step.
 */
export function goalHooks(options: GoalHookOptions): GoalHooks {
  const read = options.read ?? ((base: string, cwd: string) => readGoalRuns(base, cwd));
  return {
    async afterTurn(task: StoredTask): Promise<GoalTurnDecision> {
      const goal = task.goal;
      if (!goal) return { kind: "ordinary" };
      const run = runOf(goal, await read(options.base, task.cwd));
      if (!run) return { kind: "ordinary" };
      const progress = goalProgress(run);
      const updated: StoredGoal = { ...goal, runId: run.id, progress, lastRunUpdatedAt: run.updatedAt };
      const step = nextStep(run);
      // Only ezcoder marking the run passed is "complete" (its `complete`
      // action refuses unless the verifier and final audit pass). A run that
      // merely *could* be completed gets one more continue: its `resume` then
      // names `complete` as the next action, and the agent records it.
      if (run.status === "passed") return { kind: "complete", goal: updated };
      if (step.kind === "needs_you" || progress.needsYou) {
        return { kind: "needs_you", say: progress.needsYou ?? step.say, goal: updated };
      }
      if (step.kind === "terminal" || step.kind === "pause") {
        if (run.status === "failed") return { kind: "failed", say: speakable(`The goal run failed: ${step.say}`, 200), goal: updated };
        return { kind: "needs_you", say: step.say, goal: updated };
      }
      if (goal.continues > 0 && goal.lastRunUpdatedAt !== undefined && goal.lastRunUpdatedAt === run.updatedAt) {
        return { kind: "stalled", say: "The goal run made no progress on the last turn.", goal: updated };
      }
      return { kind: "continue", prompt: continuePrompt(run.id, speakable(run.title, 80)), goal: updated };
    },
  };
}
