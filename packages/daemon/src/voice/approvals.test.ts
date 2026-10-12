import { expect, test } from "bun:test";
import { Orchestrator, type VoiceHost } from "./dispatcher.js";
import { buildRegistry, resolveProject } from "./registry.js";
import { assessApproval } from "./safety.js";
import { VoiceStore } from "./store.js";
import { didYouMean, ToolExecutor, VOICE_INSTRUCTIONS, VOICE_TOOLS } from "./tools.js";

const cwd = "/code/pew2";

test("read-only work inside the project is safe and worded plainly", () => {
  const a = assessApproval({ kind: "read", title: "Read file", rawInput: { path: "/code/pew2/src/App.tsx" } }, cwd);
  expect(a).toMatchObject({ safe: true, risk: "read", speech: "Read App.tsx." });
  expect(assessApproval({ kind: "execute", title: "git status", rawInput: { command: "git status" } }, cwd).safe).toBe(true);
});

test("risky requests are never safe, and say why", () => {
  const risky = (input: Parameters<typeof assessApproval>[0]) => assessApproval(input, cwd);
  expect(risky({ kind: "read", rawInput: { path: "/etc/passwd" } }).concerns).toContain("touches files outside the project");
  expect(risky({ kind: "read", rawInput: { path: "../other/file" } }).safe).toBe(false);
  expect(risky({ kind: "read", rawInput: { path: "/code/pew2/.env" } }).safe).toBe(false);
  expect(risky({ kind: "fetch", title: "fetch" }).concerns).toContain("uses the network");
  expect(risky({ kind: "execute", rawInput: { command: "npm install left-pad" } }).concerns).toContain("installs packages");
  expect(risky({ kind: "execute", rawInput: { command: "git push origin main" } }).concerns).toContain("pushes to a remote");
  expect(risky({ kind: "delete", rawInput: { path: "/code/pew2/a.ts" } }).safe).toBe(false);
  expect(risky({ kind: "edit", rawInput: { path: "/code/pew2/a.ts" } }).safe).toBe(false);
  // Chained or redirected "read" commands are not trusted.
  expect(risky({ kind: "execute", rawInput: { command: "cat a.txt > b.txt" } }).safe).toBe(false);
  expect(risky({ kind: "execute", rawInput: { command: "ls && rm -rf x" } }).safe).toBe(false);
  expect(risky({ kind: "other", title: "mystery" }).safe).toBe(false);
});

test("speech never carries a path or a secret", () => {
  const a = assessApproval({ kind: "execute", rawInput: { command: "cat /Users/me/secret/dir/file.txt" } }, cwd);
  expect(a.speech).not.toContain("/Users");
  const b = assessApproval({ kind: "execute", rawInput: { command: "deploy --token sk-abcdefghijklmnopqrstuv" } }, cwd);
  expect(b.speech).not.toContain("sk-abcdef");
});

function setup() {
  const store = VoiceStore.memory();
  const answered: string[] = [];
  const host: VoiceHost = {
    async startSession() {
      return "s1";
    },
    prompt: () => new Promise<void>(() => {}),
    async cancel() {},
    answerPermission: (_s, _r, option) => {
      answered.push(option);
      return true;
    },
    hasSession: () => true,
    lastText: () => undefined,
  };
  const orchestrator = new Orchestrator(store, host);
  const projects = buildRegistry(["/code/pew2", "/code/billing-api", "/code/billing-web"], {});
  const executor = new ToolExecutor({
    store,
    orchestrator,
    projects: async () => projects,
    usableProviders: () => ["echo"],
    rememberAlias: async () => {},
  });
  let n = 0;
  const call = (name: string, args: Record<string, unknown> = {}) => executor.handle({ callId: `c${++n}`, name, args });
  const ask = (requestId: string, kind: string, command: string, path?: string) =>
    orchestrator.onSessionPayload("s1", {
      kind: "permission_request",
      requestId,
      params: {
        toolCall: { title: command, kind, rawInput: path ? { path } : { command } },
        options: [
          { optionId: "yes", kind: "allow_once" },
          { optionId: "no", kind: "reject_once" },
        ],
      },
    });
  return { store, orchestrator, call, ask, answered, executor };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("approve_safe approves read-only requests and leaves risky ones", async () => {
  const h = setup();
  await h.call("start_task", { project: "pew2", instruction: "go" });
  await tick();
  h.ask("p1", "read", "read", "/code/pew2/a.ts");
  const first = (await h.call("pending_approvals")).output as { approvals: Array<{ safe: boolean; say: string }> };
  expect(first.approvals[0]).toMatchObject({ safe: true, say: "Read a.ts." });
  const r = await h.call("approve_safe");
  expect(r.output).toMatchObject({ approved: 1, stillAsking: 0 });
  expect(h.answered).toEqual(["yes"]);
  h.ask("p2", "execute", "git push origin main");
  const r2 = await h.call("approve_safe");
  expect(r2.output).toMatchObject({ approved: 0, stillAsking: 1 });
  expect(h.answered).toEqual(["yes"]);
});

test("answer_approval works without ids when exactly one approval is pending", async () => {
  const h = setup();
  await h.call("start_task", { project: "pew2", instruction: "go" });
  await tick();
  expect((await h.call("answer_approval", { decision: "deny" })).ok).toBe(false);
  h.ask("p1", "read", "read", "/code/pew2/a.ts");
  const r = await h.call("answer_approval", { decision: "deny" });
  expect(r.ok).toBe(true);
  expect(h.answered).toEqual(["no"]);
});

test("auto-approve answers safe requests only when the hook allows, never risky ones", async () => {
  const h = setup();
  await h.call("start_task", { project: "pew2", instruction: "go" });
  await tick();
  h.orchestrator.autoApprove = () => true;
  h.ask("p1", "read", "read", "/code/pew2/a.ts");
  expect(h.answered).toEqual(["yes"]);
  expect(h.store.getTask("t_1")?.state).toBe("running");
  h.ask("p2", "execute", "rm -rf build");
  expect(h.answered).toEqual(["yes"]);
  expect(h.store.getTask("t_1")?.state).toBe("blocked");
});

test("set_approval_policy toggles and validates", async () => {
  const h = setup();
  expect(h.executor.getApprovalPolicy().autoApproveSafe).toBe(true);
  await h.call("set_approval_policy", { autoApproveSafe: false });
  expect(h.executor.getApprovalPolicy().autoApproveSafe).toBe(false);
  expect((await h.call("set_approval_policy", {})).ok).toBe(false);
});

test("ambiguous project names come back with a one-line question", async () => {
  const h = setup();
  const r = await h.call("resolve_project", { query: "billing" });
  const out = r.output as { ambiguous: boolean; question?: string };
  expect(out.ambiguous).toBe(true);
  expect(out.question).toContain("Did you mean");
  expect(didYouMean(["A", "B", "C", "D"])).toBe("Did you mean A, B or C?");
  expect(resolveProject("Pew Two", buildRegistry(["/code/pew2"], {})).best?.name).toBe("pew2");
});

test("instructions stay short-answer and the new tools are defined", () => {
  expect(VOICE_INSTRUCTIONS).toContain("one short sentence");
  const names = VOICE_TOOLS.map((t) => t.name);
  expect(names).toContain("approve_safe");
  expect(names).toContain("set_approval_policy");
});
