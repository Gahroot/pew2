/**
 * Project dashboard view-model, folded from the voice store (tasks + recent events).
 * Pure; no clocks.
 */
import { sessionMark } from "../sessionMark";
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
  /** Conversations open in the app or at the desk that are working or blocked, beside the tasks. */
  liveSessions: number;
}

/** An open conversation as the dashboard needs it: what the sidebar already knows. */
export interface SessionRef {
  /** The project it belongs to, as a person names it (repository, not checkout). */
  project: string;
  busy?: boolean;
  unread?: boolean;
  permission?: unknown;
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

export function buildDashboard(store: VoiceStore, sessions: readonly SessionRef[] = []): ProjectRow[] {
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
  foldSessions(rows, sessions);
  const rank: Record<AgentState, number> = { waiting: 0, blocked: 1, working: 2, done: 3, idle: 4 };
  return rows.sort((a, b) => rank[a.state] - rank[b.state] || b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}

/**
 * Lay open conversations over the task rows. A conversation nobody dispatched
 * from voice still makes its project busy: the sidebar animates it, so the
 * dashboard must not say "Idle" beside a spinning row. Tasks keep precedence
 * for their own text; this only raises idle/done rows and adds missing ones.
 */
function foldSessions(rows: ProjectRow[], sessions: readonly SessionRef[]): void {
  const live = new Map<string, { working: number; asking: number }>();
  for (const s of sessions) {
    const mark = sessionMark(s);
    if (mark !== "live" && mark !== "attention") continue;
    const entry = live.get(s.project) ?? { working: 0, asking: 0 };
    if (mark === "attention") entry.asking += 1;
    else entry.working += 1;
    live.set(s.project, entry);
  }
  for (const [name, n] of [...live].sort((a, b) => a[0].localeCompare(b[0]))) {
    const total = n.working + n.asking;
    const target: AgentState = n.asking > 0 ? "waiting" : "working";
    let row = rows.find((r) => r.name === name);
    if (!row) {
      row = { projectId: `session:${name}`, name, state: "idle", stateLabel: STATE_LABEL.idle, queued: [], running: [], updatedAt: 0, liveSessions: 0 };
      rows.push(row);
    }
    row.liveSessions = total;
    // Only ever raise: a task's own "blocked" or "waiting" is already louder.
    const rank: Record<AgentState, number> = { waiting: 0, blocked: 1, working: 2, done: 3, idle: 4 };
    if (rank[target] < rank[row.state]) {
      row.state = target;
      row.stateLabel = STATE_LABEL[target];
    }
    if (row.state === "waiting" && !row.approval && n.asking > 0) row.approval = "An agent is waiting on you";
  }
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
    liveSessions: 0,
  };
}
