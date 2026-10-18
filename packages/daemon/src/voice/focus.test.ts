import { describe, expect, test } from "bun:test";
import {
  type FocusGoal,
  type FocusTask,
  focusContext,
  noteEvent,
  noteToolCall,
  REFERENCE_TOOLS,
  type ResolveContext,
  resolveReference,
  runReferenceTool,
  salience,
} from "./focus.js";
import type { FocusRef } from "./store.js";
import type { VoiceEvent, VoiceProject } from "./types.js";

const HOUR = 3_600_000;
// 2026-10-18T15:00:00Z; with tz +120 local time is 17:00.
const NOW = Date.UTC(2026, 9, 18, 15, 0, 0);
const TZ = 120;

const projects: VoiceProject[] = [
  { projectId: "p_api", name: "billing-api", path: "/x/billing-api", aliases: [] },
  { projectId: "p_web", name: "storefront", path: "/x/storefront", aliases: [] },
  { projectId: "p_doc", name: "handbook", path: "/x/handbook", aliases: [] },
];

function task(over: Partial<FocusTask> & Pick<FocusTask, "taskId" | "projectId" | "title">): FocusTask {
  const project = projects.find((p) => p.projectId === over.projectId);
  return {
    projectName: project?.name ?? "x",
    state: "running",
    createdAt: NOW - HOUR,
    updatedAt: NOW - HOUR,
    ...over,
  };
}

function ctx(over: Partial<ResolveContext>): ResolveContext {
  return { refs: [], tasks: [], projects, goals: [], now: NOW, tzOffsetMinutes: TZ, ...over };
}

const ID = /\b(t_\w+|p_\w+|run_\w+|req_\w+)\b/;

describe("noteToolCall", () => {
  test("pulls task, project and run ids from args and output", () => {
    const tasks = [task({ taskId: "t_login", projectId: "p_api", title: "Fix the login bug", goal: { objective: "Ship login", requestedAt: 0, continues: 0, runId: "run_1" } })];
    const refs = noteToolCall([], { name: "task_status", args: { taskId: "t_login" }, output: { task: { taskId: "t_login" } }, ok: true }, { now: NOW, tasks, projects });
    expect(refs.map((r) => `${r.kind}:${r.id}`).sort()).toEqual(["goal:run_1", "project:p_api", "task:t_login"]);
    for (const r of refs) expect(r.label).not.toMatch(ID);
  });

  test("a failed call or unknown ids change nothing", () => {
    expect(noteToolCall([], { name: "x", args: { taskId: "t_login" }, output: null, ok: false }, { now: NOW, tasks: [], projects })).toEqual([]);
    expect(noteToolCall([], { name: "x", args: { projectId: "p_nope" }, output: null, ok: true }, { now: NOW, tasks: [], projects })).toEqual([]);
  });

  test("caps at 50", () => {
    let refs: FocusRef[] = [];
    const tasks = Array.from({ length: 60 }, (_, i) => task({ taskId: `t_${i}`, projectId: "p_api", title: `job ${i}` }));
    for (const t of tasks) refs = noteToolCall(refs, { name: "task_status", args: { taskId: t.taskId }, output: {}, ok: true }, { now: NOW, tasks, projects });
    expect(refs.length).toBe(50);
  });
});

describe("example phrases", () => {
  test('"Have it fix that." → the most salient active task', () => {
    const tasks = [
      task({ taskId: "t_old", projectId: "p_web", title: "Tidy CSS" }),
      task({ taskId: "t_new", projectId: "p_api", title: "Investigate checkout timeout" }),
    ];
    let refs = noteToolCall([], { name: "task_status", args: { taskId: "t_old" }, output: {}, ok: true }, { now: NOW - 30 * 60_000, tasks, projects });
    refs = noteToolCall(refs, { name: "task_status", args: { taskId: "t_new" }, output: {}, ok: true }, { now: NOW - 5 * 60_000, tasks, projects });
    const r = resolveReference("Have it fix that.", ctx({ refs, tasks }));
    expect(r.match?.taskId).toBe("t_new");
    expect(r.needsClarification).toBeUndefined();
  });

  test('"Actually, do the other project first." → the one other project, and corrects', () => {
    const tasks = [task({ taskId: "t_a", projectId: "p_api", title: "Add rate limits" }), task({ taskId: "t_b", projectId: "p_web", title: "New hero banner" })];
    let refs = noteToolCall([], { name: "start_task", args: {}, output: { taskId: "t_a" }, ok: true }, { now: NOW - 10 * 60_000, tasks, projects });
    refs = noteToolCall(refs, { name: "start_task", args: {}, output: { taskId: "t_b" }, ok: true }, { now: NOW - 60_000, tasks, projects });
    const r = resolveReference("Actually, do the other project first.", ctx({ refs, tasks }));
    expect(r.match?.projectId).toBe("p_api");
    expect(r.match?.label).toBe("billing-api");

    // The model reprioritises: the new project ref corrects the old focus.
    const after = noteToolCall(refs, { name: "reprioritize_task", args: { taskId: "t_a" }, output: {}, ok: true }, { now: NOW, tasks, projects });
    const proj = after.find((x) => x.kind === "project" && x.id === "p_api");
    expect(proj?.corrects).toBe("p_web");
    const web = after.find((x) => x.kind === "project" && x.id === "p_web");
    expect(web && salience(web, after, tasks, NOW)).toBe(0);
    expect(focusContext(after, tasks, NOW)).toContain("current project billing-api [p_api]");
  });

  test('"Did that issue from yesterday get resolved?" → yesterday\'s failure and the later fix', () => {
    // Local midnight today = 22:00Z yesterday (tz +120).
    const localMidnight = Date.UTC(2026, 9, 17, 22, 0, 0);
    const tasks = [
      task({ taskId: "t_fail", projectId: "p_api", title: "Fix webhook retries", state: "failed", createdAt: localMidnight - 5 * HOUR, updatedAt: localMidnight - 4 * HOUR }),
      task({ taskId: "t_ok", projectId: "p_web", title: "Copy edits", state: "completed", createdAt: localMidnight - 3 * HOUR, updatedAt: localMidnight - 2 * HOUR }),
      task({ taskId: "t_fix", projectId: "p_api", title: "Retry webhooks with backoff", state: "verified", createdAt: localMidnight + HOUR, updatedAt: localMidnight + 2 * HOUR }),
      // 23:30 local yesterday-evening by UTC date is still "today" locally: outside the window.
      task({ taskId: "t_late", projectId: "p_doc", title: "Typo", state: "failed", createdAt: localMidnight + 30 * 60_000, updatedAt: localMidnight + 30 * 60_000 }),
    ];
    const r = resolveReference("Did that issue from yesterday get resolved?", ctx({ tasks }));
    expect(r.match?.taskId).toBe("t_fail");
    expect(r.laterOutcome).toEqual({ taskId: "t_fix", label: "Retry webhooks with backoff", state: "verified" });

    // Same data, UTC timezone: t_late is now yesterday too → ambiguous → ask.
    const utc = resolveReference("Did that issue from yesterday get resolved?", ctx({ tasks, tzOffsetMinutes: 0, now: Date.UTC(2026, 9, 18, 15) }));
    expect(utc.needsClarification).toBe(true);
    expect(utc.question).toMatch(/^Did you mean .+ or .+\?$/);
  });

  test('"Tell the agent to try a different approach." → prefers the active task', () => {
    const tasks = [
      task({ taskId: "t_done", projectId: "p_web", title: "Image resize", state: "completed" }),
      task({ taskId: "t_run", projectId: "p_api", title: "Speed up invoices", state: "running" }),
    ];
    let refs = noteToolCall([], { name: "task_status", args: { taskId: "t_run" }, output: {}, ok: true }, { now: NOW - 20 * 60_000, tasks, projects });
    refs = noteEvent(refs, { eventId: 1, taskId: "t_done", projectId: "p_web", projectName: "storefront", kind: "task.completed", class: "informational", text: "done", at: NOW - 60_000 }, tasks[0]);
    const r = resolveReference("Tell the agent to try a different approach.", ctx({ refs, tasks }));
    expect(r.match?.taskId).toBe("t_run");
    // Without "the agent", "that" means the fresher result.
    expect(resolveReference("what happened with that", ctx({ refs, tasks })).match?.taskId).toBe("t_done");
  });
});

describe("decay, clarify, events", () => {
  test("half-lives: task halves at 2h, project at 4h, goal at 24h", () => {
    const mk = (kind: FocusRef["kind"]): FocusRef => ({ kind, id: kind, label: kind, at: NOW, via: "tool" });
    expect(salience(mk("task"), [], [], NOW + 2 * HOUR)).toBeCloseTo(0.5);
    expect(salience(mk("project"), [], [], NOW + 4 * HOUR)).toBeCloseTo(0.5);
    expect(salience(mk("goal"), [], [], NOW + 24 * HOUR)).toBeCloseTo(0.5);
    expect(salience(mk("result"), [], [], NOW + 6 * HOUR)).toBeCloseTo(0.5);
  });

  test("a faded reference asks instead of guessing", () => {
    const tasks = [task({ taskId: "t_a", projectId: "p_api", title: "Alpha", state: "completed" }), task({ taskId: "t_b", projectId: "p_web", title: "Beta", state: "completed" })];
    const refs = noteToolCall([], { name: "task_status", args: { taskId: "t_a" }, output: {}, ok: true }, { now: NOW - 10 * HOUR, tasks, projects });
    const r = resolveReference("fix that", ctx({ refs, tasks }));
    expect(r.needsClarification).toBe(true);
    expect(r.question).toBe("Did you mean Alpha in billing-api or Beta in storefront?");
    expect(r.question).not.toMatch(ID);
  });

  test('"the other project" with two candidates asks', () => {
    const tasks = [task({ taskId: "t_a", projectId: "p_api", title: "A" }), task({ taskId: "t_b", projectId: "p_web", title: "B" }), task({ taskId: "t_c", projectId: "p_doc", title: "C" })];
    let refs: FocusRef[] = [];
    for (const [i, id] of ["t_a", "t_b", "t_c"].entries()) refs = noteToolCall(refs, { name: "task_status", args: { taskId: id }, output: {}, ok: true }, { now: NOW - (3 - i) * 60_000, tasks, projects });
    const r = resolveReference("the other project", ctx({ refs, tasks }));
    expect(r.needsClarification).toBe(true);
    expect(r.question).toBe("Did you mean storefront or billing-api?");
  });

  test("named things match titles and goals; ties ask", () => {
    const goals: FocusGoal[] = [{ runId: "run_9", title: "Migrate payments to Stripe", projectId: "p_api", projectName: "billing-api" }];
    const tasks = [task({ taskId: "t_a", projectId: "p_web", title: "Dark mode toggle" }), task({ taskId: "t_b", projectId: "p_doc", title: "Dark mode docs" })];
    expect(resolveReference("how is the stripe migration", ctx({ goals, tasks })).match?.runId).toBe("run_9");
    expect(resolveReference("the dark mode one", ctx({ tasks })).needsClarification).toBe(true);
  });

  test("questions are refs while open; approvals are not", () => {
    const t = task({ taskId: "t_q", projectId: "p_api", title: "Schema change", state: "blocked", question: { requestId: "req_1", text: "Drop the column?" } });
    const ev = (kind: VoiceEvent["kind"], text: string): VoiceEvent => ({ eventId: 1, taskId: "t_q", projectId: "p_api", projectName: "billing-api", kind, class: "informational", text, at: NOW });
    expect(noteEvent([], ev("task.approval", "Approve?"), t)).toEqual([]);
    const refs = noteEvent([], ev("task.blocked", "Question: drop the column?"), t);
    expect(refs[0]?.kind).toBe("question");
    expect(salience(refs[0] as FocusRef, refs, [t], NOW + 100 * HOUR)).toBe(1);
    expect(salience(refs[0] as FocusRef, refs, [{ ...t, state: "running", question: undefined }], NOW)).toBe(0);
  });
});

describe("determinism and ids", () => {
  test("same inputs, same outputs; ids only in fields and brackets", () => {
    const tasks = [task({ taskId: "t_a", projectId: "p_api", title: "Fix invoice rounding", state: "failed" })];
    const refs = noteEvent(
      noteToolCall([], { name: "start_task", args: { projectId: "p_api" }, output: { taskId: "t_a" }, ok: true }, { now: NOW - HOUR, tasks, projects }),
      { eventId: 2, taskId: "t_a", projectId: "p_api", projectName: "billing-api", kind: "task.failed", class: "completed", text: "failed", at: NOW - 60_000 },
      tasks[0],
    );
    const a = resolveReference("have it retry that", ctx({ refs, tasks }));
    expect(resolveReference("have it retry that", ctx({ refs: [...refs], tasks: [...tasks] }))).toEqual(a);
    expect(a.match?.label).not.toMatch(ID);
    expect(a.match?.why).not.toMatch(ID);
    const lines = focusContext(refs, tasks, NOW).split("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(5);
    for (const line of lines) {
      expect(line.startsWith("Working memory")).toBe(true);
      expect(line.replace(/\[[^\]]*\]/g, "")).not.toMatch(ID);
    }
  });

  test("tool wiring", async () => {
    expect(REFERENCE_TOOLS.map((t) => t.name)).toEqual(["resolve_reference"]);
    const ok = await runReferenceTool("resolve_reference", { phrase: "that" }, ctx({}));
    expect(ok.ok).toBe(true);
    expect((ok.output as { needsClarification?: boolean }).needsClarification).toBe(true);
    expect((await runReferenceTool("resolve_reference", {}, ctx({}))).ok).toBe(false);
    expect((await runReferenceTool("nope", {}, ctx({}))).ok).toBe(false);
  });
});
