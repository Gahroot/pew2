/**
 * Project dashboard view-model, folded from the voice store (tasks + recent events).
 * Pure; no clocks.
 */
import type { VoiceEvent, VoiceTask } from "./types";
import type { VoiceStore } from "./voiceStore";

export type AgentState = "idle" | "working" | "waiting" | "blocked" | "done";

export interface ProjectRow {
  projectId: string;
  name: string;
  state: AgentState;
  stateLabel: string;
  queued: VoiceTask[];
  running: VoiceTask[];
  /** Live tool/progress line while working. */
  activity?: string;
  /** Summary of the most recent finished task or result event. */
  lastResult?: string;
  /** Pending approval summary, if any. */
  approval?: string;
  updatedAt: number;
}

export const STATE_LABEL: Record<AgentState, string> = {
  idle: "Idle",
  working: "Working",
  waiting: "Waiting for approval",
  blocked: "Blocked",
  done: "Done",
};

const FINISHED = new Set(["completed", "verified", "failed", "cancelled"]);
const RESULT_KINDS = new Set(["task.completed", "task.verified", "task.failed", "task.cancelled"]);
const LIVE_KINDS = new Set(["task.tool", "task.progress", "task.started", "task.resumed"]);

/**
 * Which row a task belongs on: its repository's when it ran on a worktree
 * branch, so a repo with a dozen ezcoder checkouts is one row, not a dozen.
 */
export function rowKeyOf(task: Pick<VoiceTask, "projectId" | "repo"> | Pick<VoiceEvent, "projectId" | "repo">): string {
  if (!task.repo) return task.projectId;
  return task.repo.projectId ?? `repo:${task.repo.name}`;
}

export function buildDashboard(store: VoiceStore): ProjectRow[] {
  const byProject = new Map<string, { name: string; tasks: VoiceTask[] }>();
  // Events name the directory a task ran in; this maps it to the task's row.
  const rowOfProject = new Map<string, string>();
  for (const task of Object.values(store.tasks)) {
    const key = rowKeyOf(task);
    rowOfProject.set(task.projectId, key);
    const entry = byProject.get(key) ?? { name: task.repo?.name ?? task.projectName, tasks: [] };
    entry.tasks.push(task);
    byProject.set(key, entry);
  }
  // Projects known only from events (their task left the snapshot) still get a
  // row — the repository's, when the event says it ran on one of its branches.
  const eventKey = (e: VoiceEvent) => rowOfProject.get(e.projectId) ?? rowKeyOf(e);
  for (const e of store.recent) {
    const key = eventKey(e);
    if (!byProject.has(key)) byProject.set(key, { name: e.repo?.name ?? e.projectName, tasks: [] });
  }
  const rows: ProjectRow[] = [];
  for (const [projectId, { name, tasks }] of byProject) {
    const events = store.recent.filter((e) => eventKey(e) === projectId);
    rows.push(rowFor(projectId, name, tasks, events));
  }
  const rank: Record<AgentState, number> = { waiting: 0, blocked: 1, working: 2, done: 3, idle: 4 };
  return rows.sort((a, b) => rank[a.state] - rank[b.state] || b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}

function newest<T extends { updatedAt: number; taskId: string }>(items: T[]): T | undefined {
  return [...items].sort((a, b) => b.updatedAt - a.updatedAt || a.taskId.localeCompare(b.taskId))[0];
}

function rowFor(projectId: string, name: string, tasks: VoiceTask[], events: VoiceEvent[]): ProjectRow {
  const queued = tasks.filter((t) => t.state === "queued");
  const running = tasks.filter((t) => t.state === "running");
  const waiting = tasks.filter((t) => t.approval !== undefined);
  const blocked = tasks.filter((t) => t.state === "blocked" && !t.approval);
  const finished = newest(tasks.filter((t) => FINISHED.has(t.state)));
  const lastResultEvent = [...events].reverse().find((e) => RESULT_KINDS.has(e.kind));
  const liveEvent = [...events].reverse().find((e) => LIVE_KINDS.has(e.kind));

  let state: AgentState = "idle";
  if (waiting.length > 0) state = "waiting";
  else if (blocked.length > 0) state = "blocked";
  else if (running.length > 0) state = "working";
  else if (finished && queued.length === 0) state = "done";

  const runningTask = newest(running);
  const activity =
    state === "working" ? (runningTask?.activity ?? (liveEvent && liveEvent.taskId === runningTask?.taskId ? liveEvent.text : undefined)) : undefined;
  const lastResult = lastResultEvent?.text ?? (finished ? `${finished.title} (${finished.state})` : undefined);
  const updatedAt = Math.max(0, ...tasks.map((t) => t.updatedAt), ...events.map((e) => e.at));
  return {
    projectId,
    name,
    state,
    stateLabel: STATE_LABEL[state],
    queued,
    running,
    activity,
    lastResult,
    approval: newest(waiting)?.approval?.summary,
    updatedAt,
  };
}
