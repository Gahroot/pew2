import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldRow, type DeskFileState } from "./parsers.js";
import {
  DesktopActivityWatcher,
  defaultDeskRoots,
  toWire,
  type DeskRoot,
  type DeskSession,
} from "./watcher.js";

const line = (row: unknown) => `${JSON.stringify(row)}\n`;

async function harness(format: DeskRoot["format"], providerId = "ezcoder") {
  const dir = await mkdtemp(join(tmpdir(), "desk-"));
  const project = format === "codex" ? join(dir, "2026", "10", "17") : join(dir, "-Users-me-app");
  await mkdir(project, { recursive: true });
  const owned = new Set<string>();
  const changes: DeskSession[][] = [];
  const watcher = new DesktopActivityWatcher({
    roots: [{ providerId, format, dir }],
    ownedAgentSessionIds: () => owned,
    onChange: (s) => changes.push(s),
  });
  return { dir, project, owned, changes, watcher };
}

const ggHead = {
  type: "session",
  version: 2,
  id: "gg-1",
  cwd: "/Users/me/app",
  preview: "fix the login bug",
};

test("gg: run_started is working, run_finished is idle, and appended lines are read", async () => {
  const h = await harness("gg");
  const file = join(h.project, "2026-10-17T10-00-00-000Z_gg1.jsonl");
  await writeFile(
    file,
    line(ggHead) +
      line({ type: "message", message: { role: "user", content: "fix the login bug" } }) +
      line({ type: "custom", kind: "run_started", data: { version: 1 } }) +
      line({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "tool_call", id: "t", name: "bash", args: {} }],
        },
      }),
  );
  await h.watcher.scan();
  const first = h.watcher.snapshot();
  expect(first.map(toWire)).toEqual([
    expect.objectContaining({
      providerId: "ezcoder",
      agentSessionId: "gg-1",
      cwd: "/Users/me/app",
      title: "fix the login bug",
      state: "working",
      tool: "bash",
    }),
  ]);
  expect(h.watcher.peek("gg-1")?.lastPrompt).toBe("fix the login bug");

  await appendFile(
    file,
    line({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Fixed it." }] },
    }) + line({ type: "custom", kind: "run_finished", data: { outcome: "completed" } }),
  );
  await h.watcher.tail();
  expect(h.watcher.snapshot()[0]?.state).toBe("idle");
  expect(h.watcher.snapshot()[0]?.tool).toBeUndefined();
  expect(h.watcher.peek("gg-1")?.lastText).toBe("Fixed it.");
  expect(h.changes.map((c) => c[0]?.state)).toEqual(["working", "idle"]);
});

test("gg: an autopilot run without run_started still reads from turn_metric", async () => {
  const h = await harness("gg");
  const file = join(h.project, "a.jsonl");
  await writeFile(
    file,
    line(ggHead) + line({ type: "custom", kind: "turn_metric", data: { stopReason: "tool_use" } }),
  );
  await h.watcher.scan();
  expect(h.watcher.snapshot()[0]?.state).toBe("working");
  await appendFile(
    file,
    line({ type: "custom", kind: "turn_metric", data: { stopReason: "end_turn" } }),
  );
  await h.watcher.tail();
  expect(h.watcher.snapshot()[0]?.state).toBe("idle");
});

test("a line written in two halves is folded once it is complete", async () => {
  const h = await harness("gg");
  const file = join(h.project, "a.jsonl");
  await writeFile(file, line(ggHead));
  await h.watcher.scan();
  const row = JSON.stringify({ type: "custom", kind: "run_started", data: {} });
  await appendFile(file, row.slice(0, 10));
  await h.watcher.tail();
  expect(h.watcher.snapshot()[0]?.state).toBe("idle");
  await appendFile(file, `${row.slice(10)}\n`);
  await h.watcher.tail();
  expect(h.watcher.snapshot()[0]?.state).toBe("working");
});

test("sessions the daemon holds are excluded", async () => {
  const h = await harness("gg");
  await writeFile(
    join(h.project, "a.jsonl"),
    line(ggHead) + line({ type: "custom", kind: "run_started" }),
  );
  h.owned.add("gg-1");
  await h.watcher.scan();
  expect(h.watcher.snapshot()).toEqual([]);
  expect(h.changes).toEqual([]);
});

test("a run left open by a crash goes idle once the file is stale, and old files are dropped", async () => {
  const h = await harness("gg");
  const stale = join(h.project, "stale.jsonl");
  const old = join(h.project, "old.jsonl");
  await writeFile(stale, line(ggHead) + line({ type: "custom", kind: "run_started" }));
  await writeFile(
    old,
    line({ ...ggHead, id: "gg-old" }) + line({ type: "custom", kind: "run_started" }),
  );
  const now = Date.now() / 1000;
  await utimes(stale, now - 20 * 60, now - 20 * 60);
  await utimes(old, now - 40 * 60, now - 40 * 60);
  await h.watcher.scan();
  expect(h.watcher.snapshot().map((s) => [s.agentSessionId, s.state])).toEqual([["gg-1", "idle"]]);
});

test("a file without a cwd is not reported", async () => {
  const h = await harness("gg");
  await writeFile(join(h.project, "a.jsonl"), line({ type: "custom", kind: "run_started" }));
  await h.watcher.scan();
  expect(h.watcher.snapshot()).toEqual([]);
});

test("a file that shrinks is read again from the start", async () => {
  const h = await harness("gg");
  const file = join(h.project, "a.jsonl");
  await writeFile(
    file,
    line(ggHead) +
      line({ type: "custom", kind: "run_started" }) +
      line({ type: "custom", kind: "turn_metric", data: { stopReason: "tool_use" } }),
  );
  await h.watcher.scan();
  expect(h.watcher.snapshot()[0]?.state).toBe("working");
  await writeFile(file, line({ ...ggHead, id: "gg-2" }));
  await h.watcher.tail();
  expect(h.watcher.snapshot().map((s) => [s.agentSessionId, s.state])).toEqual([["gg-2", "idle"]]);
});

test("claude: a typed prompt opens the turn, end_turn closes it, tool results and meta rows do not", async () => {
  const h = await harness("claude", "claude-code");
  const file = join(h.project, "c1.jsonl");
  const base = { sessionId: "c-1", cwd: "/Users/me/app" };
  await writeFile(
    file,
    line({
      ...base,
      type: "user",
      isMeta: true,
      message: { role: "user", content: "<local-command-caveat>x" },
    }) +
      line({ ...base, type: "user", message: { role: "user", content: "add a dark mode" } }) +
      line({
        ...base,
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: "tool_use",
          content: [{ type: "tool_use", name: "Edit", input: {} }],
        },
      }) +
      line({
        ...base,
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
      }),
  );
  await h.watcher.scan();
  expect(toWire(h.watcher.snapshot()[0] as DeskSession)).toEqual(
    expect.objectContaining({
      providerId: "claude-code",
      agentSessionId: "c-1",
      title: "add a dark mode",
      state: "working",
      tool: "Edit",
    }),
  );
  await appendFile(
    file,
    line({
      ...base,
      type: "assistant",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Done." }],
      },
    }),
  );
  await h.watcher.tail();
  expect(h.watcher.snapshot()[0]?.state).toBe("idle");
  // A sidechain (subagent) prompt is not the user starting a turn.
  await appendFile(
    file,
    line({
      ...base,
      type: "user",
      isSidechain: true,
      message: { role: "user", content: "subtask" },
    }),
  );
  await h.watcher.tail();
  expect(h.watcher.snapshot()[0]?.state).toBe("idle");
  await appendFile(
    file,
    line({ ...base, type: "user", message: { role: "user", content: "and tests" } }),
  );
  await h.watcher.tail();
  expect(h.watcher.snapshot()[0]?.state).toBe("working");
  await appendFile(
    file,
    line({ ...base, type: "system", subtype: "turn_duration", durationMs: 10 }),
  );
  await h.watcher.tail();
  expect(h.watcher.snapshot()[0]?.state).toBe("idle");
});

test("codex: session_meta names it, task_started and task_complete drive the state", async () => {
  const h = await harness("codex", "codex");
  const file = join(h.project, "rollout-1.jsonl");
  await writeFile(
    file,
    line({ type: "session_meta", payload: { id: "x-1", cwd: "/Users/me/app" } }) +
      line({ type: "event_msg", payload: { type: "task_started" } }) +
      line({ type: "event_msg", payload: { type: "user_message", message: "rename the module" } }),
  );
  await h.watcher.scan();
  expect(toWire(h.watcher.snapshot()[0] as DeskSession)).toEqual(
    expect.objectContaining({
      providerId: "codex",
      agentSessionId: "x-1",
      title: "rename the module",
      state: "working",
    }),
  );
  await appendFile(
    file,
    line({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "Renamed." } }),
  );
  await h.watcher.tail();
  expect(h.watcher.snapshot()[0]?.state).toBe("idle");
  expect(h.watcher.peek("x-1")?.lastText).toBe("Renamed.");
});

test("malformed rows are skipped, never thrown", () => {
  const state: DeskFileState = { working: false };
  for (const row of [
    null,
    3,
    "x",
    [],
    { type: "message", message: "nope" },
    { type: "custom", kind: "run_started", data: 5 },
  ]) {
    foldRow("gg", state, row);
    foldRow("claude", state, row);
    foldRow("codex", state, row);
  }
  expect(state.working).toBe(true);
});

test("toWire leaves prompts and reply text on this machine", () => {
  const out = toWire({
    providerId: "p",
    agentSessionId: "a",
    cwd: "/c",
    state: "idle",
    updatedAt: 1,
    lastPrompt: "secret",
    lastText: "secret",
  });
  expect(JSON.stringify(out)).not.toContain("secret");
});

test("default roots honour each agent's own override", () => {
  const roots = defaultDeskRoots(
    { CLAUDE_CONFIG_DIR: "/c", GG_AGENT_DIR: "/g", CODEX_HOME: "/x" },
    "/h",
  );
  expect(roots.map((r) => [r.providerId, r.dir])).toEqual([
    ["claude-code", join("/c", "projects")],
    ["ggcoder", join("/g", "sessions")],
    ["ezcoder", join("/h", ".ezcoder", "sessions")],
    ["codex", join("/x", "sessions")],
  ]);
});
