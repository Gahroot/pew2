import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  canCompleteGoalRun,
  describeGoal,
  findRunForTask,
  goalHooks,
  goalProgress,
  goalRunsBase,
  goalRunsFile,
  GoalTracker,
  nextStep,
  parseGoalRuns,
  progressChanges,
  readGoalRuns,
} from "./goalRuns.js";
import { VoiceStore } from "./store.js";

const VERIFIED_AT = "2026-10-17T16:11:24.500Z";

/** Shaped like the real cliporous goals.json: absolute paths, long summaries, no tasks. */
function realRun(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "b85b5a71-3e93-4845-9a21-a4a4bbc66266",
    title: "Long-form storyboard: emotion, 3D variety, no dead holds",
    goal: "Make long-form storyboard edits feel professionally edited: stop the big two-word emphasis, end scenes shortly after their last beat.",
    status: "blocked",
    createdAt: "2026-10-17T15:29:16.389Z",
    updatedAt: "2026-10-17T16:11:24.505Z",
    projectPath: "/Users/groot/cliporous",
    successCriteria: ["F1: no statement scenes", "F2: scenes end after their last beat", "Full gate `npm run verify` passes"],
    prerequisites: [
      { id: "node", label: "Node >= 22 and node_modules installed", status: "met", evidence: "node v24.19.0" },
      {
        id: "live-gemini",
        label: "Permission to spend Gemini tokens on a live re-plan",
        status: "unknown",
        instructions: "Optional: confirm I may run one live re-plan with your saved key in /Users/groot/cliporous/.env",
      },
    ],
    harness: [{ id: "measure", label: "Offline measurement", command: "node ./node_modules/.cache-bc.mjs" }],
    evidencePlan: [],
    tasks: [],
    evidence: [
      { id: "e1", kind: "summary", label: "Goal decision: completion_audit", content: "kind=completion_audit; outputPath=/tmp/bc/verify2.log", createdAt: "2026-10-17T16:11:24.505Z" },
    ],
    verifier: {
      description: "Biome check + tsc",
      command: "npm run verify",
      lastResult: { status: "pass", summary: "npm run verify after all edits: clean", command: "npm run verify", exitCode: 0, outputPath: "/tmp/bc/verify2.log", checkedAt: VERIFIED_AT },
    },
    completionAudit: { status: "unknown", summary: "F1 statement rejected...", checkedAt: VERIFIED_AT, verifierCheckedAt: VERIFIED_AT, outputPath: "/tmp/bc/verify2.log" },
    blockers: [],
    ...over,
  };
}

/** A run ezcoder itself would let pass. */
function passingRun(over: Record<string, unknown> = {}) {
  return realRun({
    status: "verifying",
    prerequisites: [{ id: "node", label: "Node", status: "met", evidence: "v24" }],
    evidencePlan: [{ id: "ep", label: "Gate", mechanism: "command", description: "gate", status: "ready", evidence: "ran it" }],
    tasks: [
      { id: "a", title: "API changes", status: "done", attempts: 1 },
      { id: "b", title: "Database changes", status: "done", attempts: 1 },
    ],
    evidence: [],
    completionAudit: {
      status: "pass",
      summary: `FINAL_AUDIT_PASS verifier_checked_at=${VERIFIED_AT} output=/tmp/bc/verify2.log`,
      checkedAt: "2026-10-17T16:12:00.000Z",
      verifierCheckedAt: VERIFIED_AT,
      outputPath: "/tmp/bc/verify2.log",
    },
    ...over,
  });
}

async function base(): Promise<string> {
  return mkdtemp(join(tmpdir(), "goal-runs-"));
}

async function writeRuns(root: string, cwd: string, runs: unknown): Promise<string> {
  const file = goalRunsFile(root, cwd);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, typeof runs === "string" ? runs : JSON.stringify(runs));
  return file;
}

const parse = (raw: Record<string, unknown>) => {
  const run = parseGoalRuns(JSON.stringify([raw]))[0];
  if (!run) throw new Error("fixture did not parse");
  return run;
};

test("the file location matches ezcoder's hashPath and honours EZ_GOALS_BASE", () => {
  expect(goalRunsBase({}, "/home/u")).toBe("/home/u/.ezcoder/goals/projects");
  expect(goalRunsBase({ EZ_GOALS_BASE: "/x" }, "/home/u")).toBe("/x");
  const hash = createHash("sha256").update("/Users/groot/cliporous").digest("hex").slice(0, 16);
  expect(goalRunsFile("/b", "/Users/groot/cliporous/")).toBe(`/b/${hash}/goals.json`);
});

test("the real schema parses; unknown prerequisite with instructions is what needs the user, spoken without paths", () => {
  const run = parse(realRun());
  expect(run.status).toBe("blocked");
  const p = goalProgress(run);
  expect(p.total).toBe(3); // no tasks: success criteria stand in
  expect(p.done).toBe(0);
  expect(p.needsYou).toContain("Gemini");
  expect(p.needsYou).not.toContain("/Users/groot");
  // A stale (unknown) audit is not a pass, even though the verifier passed.
  expect(p.verified).toBe("none");
  expect(canCompleteGoalRun(run)).toBe(false);
  expect(JSON.stringify(p)).not.toMatch(/\/Users|\/tmp\//);
});

test("what needs the user is said once, and a cut instruction ends as a sentence", () => {
  const instructions =
    "Optional: confirm I may run one live long-form re-plan with your saved Gemini key (costs a few cents per run, and it only touches the scratch copy of the project, never the original files you are editing)";
  const run = parse(realRun({ prerequisites: [{ id: "g", label: "Permission to spend Gemini tokens", status: "unknown", instructions }] }));
  const say = goalProgress(run).say ?? "";
  expect(say.match(/Permission to spend Gemini tokens/g)).toHaveLength(1);
  expect(say).not.toContain("needs you for");
  expect(say).not.toMatch(/\(|…\.|\.\.$/);
  expect(say).not.toContain("[redacted]");
  expect(say).toMatch(/^It has 3 success criteria to meet\. /);
  expect(say).toMatch(/It needs you: Permission to spend Gemini tokens — .*Gemini key\.$/);
});

test("counts read as English, and a run without milestones never claims criteria part-met", () => {
  expect(describeGoal({ done: 0, total: 1 })).toStartWith("Its one milestone is not done yet.");
  expect(describeGoal({ done: 1, total: 3 })).toStartWith("1 of 3 milestones is done.");
  expect(describeGoal({ done: 0, total: 1, unit: "criteria" })).toStartWith("It has one success criterion to meet.");
  expect(describeGoal({ done: 4, total: 4, unit: "criteria" })).toStartWith("All 4 success criteria are met.");
  expect(goalProgress(parse(realRun())).unit).toBe("criteria");
  expect(goalProgress(parse(passingRun())).unit).toBeUndefined();
});

test("an unknown prerequisite without instructions is the agent's to check, not the user's", () => {
  const run = parse(realRun({ prerequisites: [{ id: "x", label: "Docker running", status: "unknown" }] }));
  expect(goalProgress(run).needsYou).toBeUndefined();
  expect(nextStep(run).kind).toBe("setup");
});

test("a fresh audit after a passing verifier completes; later worker evidence makes it stale", () => {
  const run = parse(passingRun());
  expect(canCompleteGoalRun(run)).toBe(true);
  expect(nextStep(run).kind).toBe("complete");
  const p = goalProgress(run);
  expect(p).toMatchObject({ done: 2, total: 2, verified: "pass" });
  const stale = parse(passingRun({ evidence: [{ label: "Worker w1 finished", createdAt: "2026-10-17T16:20:00.000Z" }] }));
  expect(canCompleteGoalRun(stale)).toBe(false);
  expect(nextStep(stale).kind).toBe("verify");
});

test("next step follows the controller's order", () => {
  const tasks = [
    { id: "a", title: "API changes", status: "done" },
    { id: "b", title: "Browser flow testing", status: "running" },
    { id: "c", title: "Docs", status: "pending" },
  ];
  const base = { status: "running", prerequisites: [], tasks };
  expect(nextStep(parse(realRun(base)))).toEqual({ kind: "wait", say: "working on Browser flow testing" });
  expect(nextStep(parse(realRun({ ...base, tasks: [tasks[0], tasks[2]] }))).kind).toBe("milestone");
  expect(nextStep(parse(realRun({ ...base, status: "failed" }))).kind).toBe("terminal");
  expect(nextStep(parse(realRun({ ...base, tasks: [], verifier: { description: "v", command: "x", lastResult: { status: "fail", summary: "", checkedAt: VERIFIED_AT } } }))).kind).toBe("fix_verifier");
  expect(nextStep(parse(realRun({ ...base, tasks: [], harness: [], verifier: undefined }))).kind).toBe("setup");
});

test("describeGoal reads like a person", () => {
  const p = goalProgress(parse(realRun({ status: "running", prerequisites: [], tasks: [
    { id: "a", title: "API changes", status: "done" },
    { id: "b", title: "Database changes", status: "done" },
    { id: "c", title: "Browser flow testing", status: "running" },
  ] })));
  expect(describeGoal(p, { working: true, agentName: "EZ Coder", approvals: 0 })).toBe(
    "2 of 3 milestones are done. Now on: Browser flow testing. EZ Coder is working on that now. Nothing needs you.",
  );
});

test("malformed runs are dropped, corrupt and missing files read as none", async () => {
  const root = await base();
  expect(await readGoalRuns(root, "/nowhere")).toEqual([]);
  await writeRuns(root, "/p/corrupt", "{not json");
  expect(await readGoalRuns(root, "/p/corrupt")).toEqual([]);
  await writeRuns(root, "/p/mixed", [null, 7, { title: "no id" }, realRun({ tasks: [null, { title: "t" }], successCriteria: "nope" })]);
  const runs = await readGoalRuns(root, "/p/mixed");
  expect(runs).toHaveLength(1);
  expect(runs[0]?.tasks.map((t) => t.status)).toEqual(["pending"]);
  expect(runs[0]?.successCriteria).toEqual([]);
});

test("findRunForTask takes the newest run made after the request, with a minute's slack", () => {
  const runs = parseGoalRuns(JSON.stringify([
    realRun({ id: "old", createdAt: "2026-10-17T10:00:00.000Z" }),
    realRun({ id: "new", createdAt: "2026-10-17T12:00:30.000Z" }),
  ]));
  expect(findRunForTask(runs, Date.parse("2026-10-17T12:01:00.000Z"))?.id).toBe("new");
  expect(findRunForTask(runs, Date.parse("2026-10-17T13:00:00.000Z"))).toBeUndefined();
});

test("progressChanges names each change once", () => {
  const prev = { runId: "r", done: 1, total: 3, verified: "none" as const };
  expect(progressChanges(undefined, { runId: "r", done: 0, total: 3 })).toEqual(["setup"]);
  expect(progressChanges(prev, { ...prev, done: 2, verified: "fail" })).toEqual(["milestone_done", "verifier_fail"]);
  expect(progressChanges(prev, { ...prev, done: 3, verified: "pass", status: "passed" })).toEqual(["milestone_done", "verifier_pass", "passed"]);
  expect(progressChanges(prev, { ...prev, needsYou: "a key" })).toEqual(["needs_you"]);
  expect(progressChanges(prev, prev)).toEqual([]);
});

test("the tracker reads only when the file moved, and reports needs_you as progress without changing state", async () => {
  const root = await base();
  const cwd = "/code/goal";
  const requestedAt = Date.parse("2026-10-17T15:29:00.000Z");
  const store = VoiceStore.memory(() => requestedAt);
  const task = store.createTask({ projectId: "p", projectName: "goal", cwd, providerId: "ezcoder", title: "g", prompt: "/goal x", goal: { objective: "x", requestedAt, continues: 0 } });
  store.transition(task.taskId, "running", "task.started", "Started");
  const file = await writeRuns(root, cwd, [realRun({ status: "running", prerequisites: [] })]);
  const tracker = new GoalTracker();
  expect(await tracker.poll(store, root)).toBe(1); // setup
  expect(await tracker.poll(store, root)).toBe(0); // unchanged mtime: not re-read
  await writeFile(file, JSON.stringify([realRun()]));
  await utimes(file, new Date(), new Date(Date.now() + 5000));
  const [first, second] = [tracker.poll(store, root), tracker.poll(store, root)];
  expect(first).toBe(second); // never overlaps
  expect(await first).toBe(1);
  const last = store.eventsSince(0).at(-1);
  expect(last).toMatchObject({ kind: "task.progress", class: "informational", goal: { change: "needs_you", runId: "b85b5a71-3e93-4845-9a21-a4a4bbc66266" } });
  // The urgent "blocked" is the turn-end transition's to make, once.
  expect(store.eventsSince(0).some((e) => e.kind === "task.blocked" || e.kind === "task.failed" || e.kind === "task.completed")).toBe(false);
  expect(store.getTask(task.taskId)?.goal?.progress?.needsYou).toContain("Gemini");
  expect(store.getTask(task.taskId)?.state).toBe("running");
});

test("goalHooks: continue, then stalled when the run did not move, complete only once ezcoder recorded passed", async () => {
  let runs = parseGoalRuns(JSON.stringify([realRun({ status: "running", prerequisites: [] })]));
  const hooks = goalHooks({ base: "/unused", read: async () => runs });
  const requestedAt = Date.parse("2026-10-17T15:29:00.000Z");
  const store = VoiceStore.memory(() => requestedAt);
  const t = store.createTask({ projectId: "p", projectName: "goal", cwd: "/c", providerId: "ezcoder", title: "g", prompt: "/goal x", goal: { objective: "x", requestedAt, continues: 0 } });
  const first = await hooks.afterTurn(t);
  expect(first.kind).toBe("continue");
  if (first.kind !== "continue" || !first.goal) throw new Error("expected continue");
  expect(first.prompt).toContain("action resume");
  const again = await hooks.afterTurn({ ...t, goal: { ...first.goal, continues: 1 } });
  expect(again.kind).toBe("stalled");
  // Completable but not yet marked: one more turn, so the agent records it.
  runs = parseGoalRuns(JSON.stringify([passingRun()]));
  expect((await hooks.afterTurn(t)).kind).toBe("continue");
  runs = parseGoalRuns(JSON.stringify([passingRun({ status: "passed" })]));
  expect((await hooks.afterTurn(t)).kind).toBe("complete");
  runs = [];
  expect((await hooks.afterTurn(t)).kind).toBe("ordinary");
});
