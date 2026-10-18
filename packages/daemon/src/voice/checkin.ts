/**
 * The opening check-in: one fixed sentence about what happened since the user
 * last listened, or nothing at all. Pure and deterministic; `service.ts`
 * gathers the inputs from the store, the live daemon and DAVE.
 */
import { TERMINAL, type StoredTask } from "./store.js";
import type { VoiceEvent, VoiceGoalChange, VoiceSnapshot } from "./types.js";

export type Checkin = NonNullable<VoiceSnapshot["checkin"]>;

/** A goal change seen at open (e.g. from `GoalTracker`/`progressChanges`), not yet an event. */
export interface CheckinGoalChange {
  taskId: string;
  change: VoiceGoalChange;
}

export interface CheckinInput {
  /** Store events after the heard cursor (`store.eventsSince(heardEventId)` or similar). */
  events: readonly VoiceEvent[];
  /** Events at or below this id were already heard and are skipped. Default 0. */
  heardEventId?: number;
  /** `store.tasks()`: a non-terminal task whose goal progress has `needsYou` counts as needing the user. */
  tasks: readonly Pick<StoredTask, "taskId" | "state" | "goal">[];
  /** Approvals open right now (live state). */
  pendingApprovals: number;
  /** Agent questions open right now (live state). */
  openQuestions: number;
  /** Desk sessions currently in `needs_you` (from `RunningSession.state`). */
  deskNeedsYou: number;
  /** Goal changes noticed at open that have no event yet. */
  goalChanges?: readonly CheckinGoalChange[];
  /** DAVE projects with a new top recommendation (`daveChanges(...).projects`). */
  dave?: readonly string[];
  /** Unused today; kept so wording that depends on time stays injectable. */
  now: number;
}

const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];
const num = (n: number): string => WORDS[n] ?? String(n);
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

function list(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function daveClause(names: readonly string[]): string | undefined {
  if (names.length === 0) return undefined;
  if (names.length === 1) return `DAVE has a new recommendation for ${names[0]}`;
  if (names.length <= 3) {
    const joined =
      names.length === 2
        ? `${names[0]} and ${names[1]}`
        : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    return `DAVE has new recommendations for ${joined}`;
  }
  return `DAVE has new recommendations for ${num(names.length)} projects`;
}

/**
 * Counts and the opening sentence. Clause order: results (finished, failed),
 * then what needs the user (approvals, questions, goals, desk sessions), then
 * goal progress (milestones, passes), then DAVE — the order of the user's own
 * example sentence. `say` is undefined when nothing is worth saying.
 */
export function buildCheckin(input: CheckinInput): Checkin {
  const heard = input.heardEventId ?? 0;
  // Last outcome per task wins, so a task that failed then finished on a follow-up counts once.
  const outcome = new Map<string, "finished" | "failed">();
  let milestones = 0;
  const passed = new Set<string>();
  const goalsNeedYou = new Set<string>();
  const events = [...input.events]
    .filter((e) => e.eventId > heard)
    .sort((a, b) => a.eventId - b.eventId);
  for (const e of events) {
    if (e.kind === "task.completed" || e.kind === "task.verified")
      outcome.set(e.taskId, "finished");
    else if (e.kind === "task.failed") outcome.set(e.taskId, "failed");
    const change = e.goal?.change;
    if (change === "milestone_done") milestones++;
    else if (change === "passed") passed.add(e.taskId);
  }
  for (const c of input.goalChanges ?? []) {
    if (c.change === "milestone_done") milestones++;
    else if (c.change === "passed") passed.add(c.taskId);
    else if (c.change === "needs_you") goalsNeedYou.add(c.taskId);
  }
  const live = new Set(input.tasks.filter((t) => !TERMINAL.has(t.state)).map((t) => t.taskId));
  for (const t of input.tasks)
    if (live.has(t.taskId) && t.goal?.progress?.needsYou) goalsNeedYou.add(t.taskId);
  // A goal-change needs_you for a task that has since stopped is history, not a request.
  for (const id of [...goalsNeedYou]) if (!live.has(id)) goalsNeedYou.delete(id);

  let finished = 0;
  let failed = 0;
  for (const o of outcome.values()) {
    if (o === "finished") finished++;
    else failed++;
  }
  const approvals = Math.max(0, input.pendingApprovals);
  const questions = Math.max(0, input.openQuestions);
  const desk = Math.max(0, input.deskNeedsYou);
  const dave = [...(input.dave ?? [])];

  const parts: string[] = [];
  if (finished) parts.push(`${num(finished)} ${plural(finished, "agent", "agents")} finished`);
  if (failed)
    parts.push(
      finished
        ? `${num(failed)} failed`
        : `${num(failed)} ${plural(failed, "agent", "agents")} failed`,
    );
  if (approvals)
    parts.push(
      `${num(approvals)} ${plural(approvals, "is blocked by an approval", "are blocked by approvals")}`,
    );
  if (questions)
    parts.push(
      `${num(questions)} ${plural(questions, "has a question for you", "have questions for you")}`,
    );
  if (goalsNeedYou.size)
    parts.push(
      `${num(goalsNeedYou.size)} ${plural(goalsNeedYou.size, "goal needs you", "goals need you")}`,
    );
  if (desk)
    parts.push(
      `${num(desk)} ${plural(desk, "session at the computer needs you", "sessions at the computer need you")}`,
    );
  if (milestones)
    parts.push(
      `${num(milestones)} goal ${plural(milestones, "milestone is done", "milestones are done")}`,
    );
  if (passed.size)
    parts.push(`${num(passed.size)} ${plural(passed.size, "goal passed", "goals passed")}`);
  const daveText = daveClause(dave);
  if (daveText) parts.push(daveText);

  const sentence = list(parts);
  const say = sentence
    ? `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}. Want the details?`
    : undefined;
  return {
    ...(say ? { say } : null),
    finished,
    failed,
    needsYou: approvals + questions + goalsNeedYou.size + desk,
    milestones: milestones + passed.size,
    dave,
  };
}
