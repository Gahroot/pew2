/**
 * What the voice screen shows about tasks: grouping, a one-line status, a
 * per-task timeline and the headline counts. Pure; `now` is always injected.
 *
 * Two honesty rules carried over from the daemon: "completed" is only the
 * agent's claim (`verified` is the one that was checked), and a task that is
 * waiting on an approval is shown as needing the user, not as "running".
 */
import type { VoiceEvent, VoiceTask } from "./types";
import { orderedTasks, type VoiceStore } from "./voiceStore";

export type GroupKey = "attention" | "working" | "waiting" | "finished";
export type Tone = "accent" | "danger" | "success" | "dim";

export interface TaskGroup {
  key: GroupKey;
  title: string;
  tasks: VoiceTask[];
}

const GROUP_TITLE: Record<GroupKey, string> = {
  attention: "Needs you",
  working: "Working",
  waiting: "Up next",
  finished: "Finished",
};

const FINISHED = new Set<VoiceTask["state"]>(["completed", "verified", "failed", "cancelled"]);

export function groupOf(task: VoiceTask): GroupKey {
  if (task.approval || task.state === "blocked") return "attention";
  if (task.state === "running") return "working";
  if (FINISHED.has(task.state)) return "finished";
  return "waiting"; // queued, paused
}

/** Non-empty groups only, in the order the user should look at them. */
export function groupTasks(store: VoiceStore): TaskGroup[] {
  const buckets: Record<GroupKey, VoiceTask[]> = { attention: [], working: [], waiting: [], finished: [] };
  for (const task of orderedTasks(store)) buckets[groupOf(task)].push(task);
  const order: GroupKey[] = ["attention", "working", "waiting", "finished"];
  return order.flatMap((key) => (buckets[key].length > 0 ? [{ key, title: GROUP_TITLE[key], tasks: buckets[key] }] : []));
}

export interface Summary {
  attention: number;
  working: number;
  waiting: number;
  finished: number;
  failed: number;
}

export function summarize(store: VoiceStore): Summary {
  const out: Summary = { attention: 0, working: 0, waiting: 0, finished: 0, failed: 0 };
  for (const task of Object.values(store.tasks)) {
    out[groupOf(task)] += 1;
    if (task.state === "failed") out.failed += 1;
  }
  return out;
}

/** "just now", "45s", "3m", "2h", "5d". Negative skew between clocks reads as now. */
export function formatAge(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function ago(now: number, at: number): string {
  const age = formatAge(now - at);
  return age === "just now" ? age : `${age} ago`;
}

export interface TaskStatus {
  /** The state, in words. */
  label: string;
  tone: Tone;
  /** How long, or how long ago, in words. */
  timing: string;
}

export function taskStatus(task: VoiceTask, now: number): TaskStatus {
  if (task.approval) return { label: "Needs approval", tone: "danger", timing: `Asked ${ago(now, task.updatedAt)}` };
  switch (task.state) {
    case "blocked":
      return { label: "Blocked", tone: "danger", timing: `Stuck ${ago(now, task.updatedAt)}` };
    case "running":
      return { label: "Working", tone: "accent", timing: `Running for ${formatAge(now - task.createdAt)}` };
    case "queued":
      return { label: "Queued", tone: "dim", timing: `Waiting ${formatAge(now - task.createdAt)}` };
    case "paused":
      return { label: "Paused", tone: "dim", timing: `Paused ${ago(now, task.updatedAt)}` };
    case "completed":
      return { label: "Agent says done", tone: "success", timing: `Finished ${ago(now, task.updatedAt)}` };
    case "verified":
      return { label: "Verified", tone: "success", timing: `Checked ${ago(now, task.updatedAt)}` };
    case "failed":
      return { label: "Failed", tone: "danger", timing: `Failed ${ago(now, task.updatedAt)}` };
    case "cancelled":
      return { label: "Cancelled", tone: "dim", timing: `Cancelled ${ago(now, task.updatedAt)}` };
  }
}

export interface TimelineRow {
  eventId: number;
  text: string;
  tone: Tone;
  /** "2m ago". */
  when: string;
}

const EVENT_TONE: Record<VoiceEvent["kind"], Tone> = {
  "task.queued": "dim",
  "task.started": "accent",
  "task.progress": "accent",
  "task.tool": "accent",
  "task.approval": "danger",
  "task.blocked": "danger",
  "task.completed": "success",
  "task.failed": "danger",
  "task.cancelled": "dim",
  "task.verified": "success",
  "task.paused": "dim",
  "task.resumed": "accent",
};

export const TIMELINE_LIMIT = 6;

/** The task's own recent events, newest first. Only what the store still holds. */
export function taskTimeline(store: VoiceStore, taskId: string, now: number, limit = TIMELINE_LIMIT): TimelineRow[] {
  return store.recent
    .filter((e) => e.taskId === taskId)
    .slice(-limit)
    .reverse()
    .map((e) => ({ eventId: e.eventId, text: e.text, tone: EVENT_TONE[e.kind], when: ago(now, e.at) }));
}

/** The latest line saying what the task is doing: its `activity`, else its newest event. */
export function currentLine(store: VoiceStore, task: VoiceTask): string | undefined {
  if (task.activity) return task.activity;
  for (let i = store.recent.length - 1; i >= 0; i--) {
    const e = store.recent[i];
    if (e && e.taskId === task.taskId) return e.text;
  }
  return undefined;
}
