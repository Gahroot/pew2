import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Orchestrator, type VoiceHost } from "./dispatcher.js";
import { goalRunsFile } from "./goalRuns.js";
import { goalSubject, runGoalTool, type GoalToolContext } from "./goalTools.js";
import { resolveProject } from "./registry.js";
import { ConfirmationTokens } from "./safety.js";
import { VoiceStore, type StoredTask } from "./store.js";
import type { ToolResult } from "./tools.js";
import type { VoiceProject } from "./types.js";

const NOW = Date.parse("2026-10-17T15:00:00.000Z");

function host(): VoiceHost & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    startSession: async () => "s1",
    prompt: (_id, text) => {
      prompts.push(text);
      return new Promise(() => undefined);
    },
    cancel: async () => undefined,
    answerPermission: () => true,
    answerAsk: () => true,
    hasSession: () => true,
    lastText: () => undefined,
  };
}

const PROJECTS: VoiceProject[] = [
  { projectId: "p_clip", name: "cliporous", path: "/Users/groot/cliporous", aliases: [] },
  { projectId: "p_billing", name: "billing api", path: "/code/billing-api", aliases: [] },
  { projectId: "p_billing2", name: "billing app", path: "/code/billing-app", aliases: [] },
];

async function context(over: Partial<GoalToolContext> = {}) {
  const base = await mkdtemp(join(tmpdir(), "goal-tools-"));
  const store = VoiceStore.memory(() => NOW);
  const h = host();
  const orchestrator = new Orchestrator(store, h, { now: () => NOW });
  const ctx: GoalToolContext = {
    store,
    orchestrator,
    projects: async () => PROJECTS,
    usableProviders: () => ["ezcoder", "claude"],
    confirm: new ConfirmationTokens(() => NOW),
    now: () => NOW,
    goalRunsBase: base,
    resolveProject: (q, p) => resolveProject(q, p),
    daveGuard: () => undefined,
    clarify: (r) => ({
      ok: true,
      output: { needsClarification: true, candidates: r.candidates.map((c) => c.project.name) },
    }),
    place: async (project) => ({ target: project }),
    taskView: (t: StoredTask) => ({ taskId: t.taskId, state: t.state, title: t.title }),
    ...over,
  };
  return { ctx, store, host: h, base };
}

const out = (r: ToolResult) => r.output as Record<string, unknown>;

async function writeRuns(base: string, cwd: string, runs: unknown[]) {
  const file = goalRunsFile(base, cwd);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(runs));
}

test("start_goal always asks first, then sends /goal to EZ Coder with the goal recorded", async () => {
  const { ctx, store, host: h } = await context();
  const args = { project: "cliporous", objective: "Make the storyboard feel edited" };
  const first = out(await runGoalTool("start_goal", args, ctx));
  expect(first.needsConfirmation).toBe(true);
  expect(first.question).toBe(
    "Start a goal in cliporous: Make the storyboard feel edited? It keeps working until it's verified.",
  );
  expect(store.tasks()).toHaveLength(0);
  // A yes without the token, or a token for another objective, does not start it.
  expect(out(await runGoalTool("start_goal", { ...args, userConfirmed: true }, ctx)).started).toBe(
    false,
  );
  const token = String(first.confirmToken);
  const wrong = out(
    await runGoalTool(
      "start_goal",
      { ...args, objective: "other", confirmToken: token, userConfirmed: true },
      ctx,
    ),
  );
  expect(wrong.started).toBe(false);

  const again = out(await runGoalTool("start_goal", args, ctx));
  const started = out(
    await runGoalTool(
      "start_goal",
      { ...args, confirmToken: again.confirmToken, userConfirmed: true },
      ctx,
    ),
  );
  expect(started.started).toBe(true);
  const [task] = store.tasks();
  expect(task?.providerId).toBe("ezcoder");
  expect(task?.prompt).toBe("/goal Make the storyboard feel edited");
  expect(task?.goal).toEqual({
    objective: "Make the storyboard feel edited",
    requestedAt: NOW,
    continues: 0,
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(h.prompts).toEqual(["/goal Make the storyboard feel edited"]);
  expect(goalSubject("p_clip", "x")).toMatch(/^goal:p_clip:[0-9a-f]{12}$/);
});

test("start_goal adds the worktree note after the objective", async () => {
  const { ctx, store } = await context({
    place: async (project) => ({
      target: { ...project, projectId: "p_wt", path: "/wt" },
      note: "(You are in a new git worktree.)",
      newWorktree: { project: "cliporous", branch: "edit" },
    }),
  });
  const args = { project: "cliporous", objective: "Ship it" };
  const first = out(await runGoalTool("start_goal", args, ctx));
  const r = out(
    await runGoalTool(
      "start_goal",
      { ...args, confirmToken: first.confirmToken, userConfirmed: true },
      ctx,
    ),
  );
  expect(r.newWorktree).toEqual({ project: "cliporous", branch: "edit" });
  expect(store.tasks()[0]?.prompt).toBe("/goal Ship it\n\n(You are in a new git worktree.)");
  expect(store.tasks()[0]?.cwd).toBe("/wt");
});

test("start_goal refuses a duplicate, a missing EZ Coder, and asks on an ambiguous project", async () => {
  const { ctx } = await context();
  const args = { project: "cliporous", objective: "Ship it" };
  const first = out(await runGoalTool("start_goal", args, ctx));
  await runGoalTool(
    "start_goal",
    { ...args, confirmToken: first.confirmToken, userConfirmed: true },
    ctx,
  );
  const dup = out(await runGoalTool("start_goal", args, ctx));
  expect(dup.duplicate).toBe(true);

  const { ctx: noEz } = await context({ usableProviders: () => ["claude"] });
  const missing = await runGoalTool("start_goal", args, noEz);
  expect(missing.ok).toBe(false);
  expect(missing.error).toContain("EZ Coder");

  const ambiguous = out(
    await runGoalTool("start_goal", { project: "billing", objective: "x" }, ctx),
  );
  expect(ambiguous.needsClarification).toBe(true);
  expect(ambiguous.confirmToken).toBeUndefined();
});

test("goal_status and list_goals read runs from registry projects only, speakably", async () => {
  const { ctx, base } = await context();
  await writeRuns(base, "/Users/groot/cliporous", [
    {
      id: "r1",
      title: "Storyboard polish",
      goal: "Make /Users/groot/cliporous/src/plan.ts edits feel edited",
      status: "running",
      createdAt: "2026-10-17T15:29:16.389Z",
      updatedAt: "2026-10-17T16:11:24.505Z",
      successCriteria: ["a"],
      prerequisites: [
        {
          id: "k",
          label: "Stripe account",
          status: "missing",
          instructions: "Sign in at the folder /Users/groot/cliporous/.env",
        },
      ],
      tasks: [],
    },
    {
      id: "r0",
      title: "Old work",
      goal: "old",
      status: "passed",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
  ]);
  const list = out(await runGoalTool("list_goals", {}, ctx));
  expect(list.goals).toEqual([
    {
      runId: "r1",
      title: "Storyboard polish",
      project: "cliporous",
      status: "blocked",
      done: 0,
      total: 1,
      unit: "criteria",
      needsYou: "Stripe account — Sign in at the folder .env",
    },
  ]);
  const status = out(await runGoalTool("goal_status", { goal: "storyboard" }, ctx));
  expect(status.runId).toBe("r1");
  expect(status.nothingNeedsYou).toBe(false);
  expect(String(status.say)).toContain("It needs you");
  expect(JSON.stringify(status)).not.toContain("/Users/groot");
});

test("answer_question falls back to the single open question", async () => {
  const { ctx, store } = await context();
  const t = ctx.orchestrator.enqueue({
    projectId: "p_clip",
    projectName: "cliporous",
    cwd: "/c",
    providerId: "ezcoder",
    title: "t",
    prompt: "go",
  });
  await new Promise((r) => setTimeout(r, 0));
  ctx.orchestrator.onSessionPayload("s1", {
    kind: "ask_user",
    requestId: "ask_1",
    questions: [{ id: "q", question: "Go?", kind: "confirm" }],
  });
  const r = out(await runGoalTool("answer_question", { answer: "yes" }, ctx));
  expect(r.answered).toBe(true);
  expect(store.getTask(t.taskId)?.state).toBe("running");
  expect((await runGoalTool("answer_question", { answer: "yes" }, ctx)).ok).toBe(false);
});
