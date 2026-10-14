import { describe, expect, test } from "bun:test";
import { buildDashboard } from "./dashboard";
import { appendLine, TRANSCRIPT_LIMIT } from "./transcript";
import { voiceMood, voiceStatus } from "./presentation";
import { emptyStore, type VoiceStore } from "./voiceStore";
import { initialState, type MachineState } from "./voiceMachine";
import type { VoiceEvent, VoiceTask } from "./types";

const task = (o: Partial<VoiceTask> & { taskId: string }): VoiceTask => ({
  projectId: "p1",
  projectName: "pew2",
  title: "Do it",
  state: "queued",
  priority: 0,
  createdAt: 1,
  updatedAt: 1,
  ...o,
});
const ev = (o: Partial<VoiceEvent> & { eventId: number }): VoiceEvent => ({
  taskId: "t1",
  projectId: "p1",
  projectName: "pew2",
  kind: "task.tool",
  class: "informational",
  text: "editing App.tsx",
  at: 1000,
  ...o,
});
const store = (tasks: VoiceTask[], recent: VoiceEvent[] = []): VoiceStore => ({
  ...emptyStore,
  tasks: Object.fromEntries(tasks.map((t) => [t.taskId, t])),
  recent,
});

describe("buildDashboard", () => {
  test("tasks on a repository's worktree branches share the repository's row", () => {
    const repo = (branch: string) => ({ projectId: "p_bmf", name: "black-mountain-fund", branch });
    const rows = buildDashboard(
      store(
        [
          task({ taskId: "t1", projectId: "p_wt1", projectName: "black-mountain-fund (fix/a)", repo: repo("fix/a"), state: "running" }),
          task({ taskId: "t2", projectId: "p_wt2", projectName: "black-mountain-fund (fix/b)", repo: repo("fix/b") }),
          task({ taskId: "t3", projectId: "p_bmf", projectName: "black-mountain-fund" }),
          task({ taskId: "t4", projectId: "p_pew2", projectName: "pew2" }),
        ],
        // An event names the worktree it ran in, and still lands on the repo's row.
        [ev({ eventId: 1, taskId: "t1", projectId: "p_wt1", projectName: "black-mountain-fund (fix/a)", kind: "task.tool", text: "editing a.ts" })],
      ),
    );
    expect(rows.map((r) => r.name).sort()).toEqual(["black-mountain-fund", "pew2"]);
    const bmf = rows.find((r) => r.name === "black-mountain-fund");
    expect(bmf?.projectId).toBe("p_bmf");
    expect(bmf?.running.map((t) => t.taskId)).toEqual(["t1"]);
    expect(bmf?.queued.map((t) => t.taskId).sort()).toEqual(["t2", "t3"]);
    expect(bmf?.activity).toBe("editing a.ts");
  });

  test("an event whose task has left the snapshot still lands on its repository's row", () => {
    const rows = buildDashboard(
      store(
        [task({ taskId: "t3", projectId: "p_bmf", projectName: "black-mountain-fund" })],
        [
          ev({
            eventId: 1,
            taskId: "t_old",
            projectId: "p_wt_gone",
            projectName: "black-mountain-fund (ez-old)",
            repo: { projectId: "p_bmf", name: "black-mountain-fund", branch: "ez-old" },
            kind: "task.completed",
            class: "completed",
            text: "Fixed the totals.",
          }),
        ],
      ),
    );
    expect(rows.map((r) => r.name)).toEqual(["black-mountain-fund"]);
    expect(rows[0]?.lastResult).toBe("Fixed the totals.");
  });

  test("working project shows activity and queue", () => {
    const rows = buildDashboard(
      store([task({ taskId: "t1", state: "running", activity: "running tests" }), task({ taskId: "t2" })]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("working");
    expect(rows[0]?.activity).toBe("running tests");
    expect(rows[0]?.queued).toHaveLength(1);
  });
  test("approval outranks everything and sorts first", () => {
    const rows = buildDashboard(
      store([
        task({ taskId: "a", projectId: "p2", projectName: "api", state: "running" }),
        task({ taskId: "b", state: "blocked", approval: { requestId: "r", risk: "shell", summary: "Run rm" } }),
      ]),
    );
    expect(rows.map((r) => r.state)).toEqual(["waiting", "working"]);
    expect(rows[0]?.approval).toBe("Run rm");
  });
  test("finished task gives done and last result from events", () => {
    const rows = buildDashboard(
      store([task({ taskId: "t1", state: "completed" })], [ev({ eventId: 1, kind: "task.completed", text: "Fixed the bug" })]),
    );
    expect(rows[0]?.state).toBe("done");
    expect(rows[0]?.lastResult).toBe("Fixed the bug");
  });
  test("event-only project is idle", () => {
    const rows = buildDashboard(store([], [ev({ eventId: 1, projectId: "p9", projectName: "docs" })]));
    expect(rows[0]).toMatchObject({ name: "docs", state: "idle" });
  });
});

describe("transcript", () => {
  test("ignores blanks, caps length, ids rise", () => {
    let lines = appendLine([], "user", "   ");
    expect(lines).toHaveLength(0);
    for (let i = 0; i < 10; i++) lines = appendLine(lines, "assistant", `line ${i}`);
    expect(lines).toHaveLength(TRANSCRIPT_LIMIT);
    expect(lines[lines.length - 1]?.id).toBe(10);
  });
});

describe("voiceStatus", () => {
  const m = (o: Partial<MachineState>): MachineState => ({ ...initialState, ...o });
  test("error is friendly and retryable", () => {
    const s = voiceStatus(m({ phase: "error", errorCode: "mic_denied" }), emptyStore, [], 0);
    expect(s.key).toBe("error");
    expect(s.detail).toContain("Microphone");
    expect(s.retry).toBe(true);
  });
  test("thinking after the user spoke, dispatching on fresh task event", () => {
    const lines = appendLine([], "user", "fix it");
    expect(voiceStatus(m({ phase: "listening" }), emptyStore, lines, 0).key).toBe("thinking");
    const s = store([], [ev({ eventId: 1, kind: "task.queued", at: 1000 })]);
    expect(voiceStatus(m({ phase: "listening" }), s, lines, 2000).key).toBe("dispatching");
    expect(voiceStatus(m({ phase: "listening" }), s, [], 60000).key).toBe("listening");
  });
  test("Pew waits idle when ready, talks while speaking, frowns on error", () => {
    expect(voiceMood(voiceStatus(m({ phase: "idle" }), emptyStore, [], 0).key)).toBe("idle");
    expect(voiceMood(voiceStatus(m({ phase: "speaking" }), emptyStore, [], 0).key)).toBe("talking");
    expect(voiceMood(voiceStatus(m({ phase: "error", errorCode: "offline" }), emptyStore, [], 0).key)).toBe("oops");
  });
});
