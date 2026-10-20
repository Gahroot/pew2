/**
 * The voice layer wired into a real Daemon and handler: inbox broadcasts,
 * tools running through the daemon's own methods, and the status reply.
 */
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { handleMessage } from "../handler.js";
import { Daemon } from "../index.js";
import { SessionLog } from "../session/log.js";
import { REASON_SIGN_IN } from "./credentials.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "pew2-voice-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PEW2_HOME: join(root, "pew2"),
    GG_AGENT_DIR: join(root, "gg"),
    CODEX_HOME: join(root, "codex"),
  };
  delete env.OPENAI_API_KEY;
  const daemon = new Daemon({ id: "t", name: "t" }, true, env);
  const sent: any[] = [];
  daemon.attach((message) => sent.push(message));
  const answered: [string, string][] = [];
  const session = {
    handle: {
      close: () => {},
      answerPermission: (requestId: string, optionId: string) => {
        answered.push([requestId, optionId]);
        return true;
      },
    },
    log: new SessionLog("s1"),
    providerId: "test",
    cwd: "/work/pew2",
    live: true,
    lastUsedAt: 0,
    ready: Promise.resolve(),
  } as any;
  (daemon as any).sessions.set("s1", session);
  const replies: any[] = [];
  const ctx = { daemon, reply: (m: unknown) => replies.push(m), broadcast: (m: unknown) => sent.push(m) };
  const ask = (title: string, requestId = "p1") => {
    (session.permissions ??= new Map()).set(requestId, {
      toolCall: { title },
      options: [
        { optionId: "always", kind: "allow_always" },
        { optionId: "once", kind: "allow_once" },
        { optionId: "no", kind: "reject_once" },
      ],
    });
    (daemon as any).record(session, { kind: "permission_request", requestId, params: {} });
  };
  return { daemon, sent, replies, ctx, ask, answered };
}

const inboxes = (sent: any[]) => sent.filter((m) => m.t === "voice.inbox");

test("a permission enters the inbox, an answer by voice takes it out", async () => {
  const { daemon, sent, replies, ctx, ask, answered } = setup();
  ask("npm test");
  expect(inboxes(sent).at(-1).items).toMatchObject([
    { id: "s1:approval:p1", sessionId: "s1", kind: "approval", requestId: "p1", folder: "pew2", title: "npm test" },
  ]);
  (daemon.voice as any).calls.add("c1");
  await handleMessage(
    JSON.stringify({
      t: "voice.tool",
      requestId: "r1",
      callId: "c1",
      toolCallId: "tc1",
      name: "answer_permission",
      arguments: JSON.stringify({ item_id: "s1:approval:p1", decision: "allow" }),
    }),
    ctx,
  );
  expect(answered).toEqual([["p1", "once"]]);
  expect(replies.at(-1)).toMatchObject({ t: "voice.tool", requestId: "r1", callId: "c1", toolCallId: "tc1" });
  expect(JSON.parse(replies.at(-1).output)).toEqual({ ok: true, say: "Approved." });
  expect(inboxes(sent).at(-1).items).toEqual([]);
  daemon.closeAll();
});

test("a destructive approval needs confirmed:true", async () => {
  const { daemon, replies, ctx, ask, answered } = setup();
  ask("git push --force origin main");
  (daemon.voice as any).calls.add("c1");
  let calls = 0;
  const call = (args: object) =>
    handleMessage(
      JSON.stringify({ t: "voice.tool", requestId: "r", callId: "c1", toolCallId: `t${++calls}`, name: "answer_permission", arguments: JSON.stringify(args) }),
      ctx,
    );
  await call({ item_id: "s1:approval:p1", decision: "allow" });
  expect(JSON.parse(replies.at(-1).output)).toMatchObject({ ok: false, needsConfirmation: true });
  expect(answered).toEqual([]);
  await call({ item_id: "s1:approval:p1", decision: "allow", confirmed: true });
  expect(answered).toEqual([["p1", "once"]]);
  daemon.closeAll();
});

test("a tool on an unknown call hangs up without acting", async () => {
  const { daemon, replies, ctx, ask, answered } = setup();
  ask("npm test");
  await handleMessage(
    JSON.stringify({ t: "voice.tool", requestId: "r", callId: "nope", toolCallId: "t", name: "answer_permission", arguments: "{\"item_id\":\"s1:approval:p1\",\"decision\":\"allow\"}" }),
    ctx,
  );
  expect(replies.at(-1).hangUp).toBe(true);
  expect(answered).toEqual([]);
  daemon.closeAll();
});

test("closing the session empties the inbox", () => {
  const { daemon, sent, ask } = setup();
  ask("npm test");
  daemon.closeAll();
  expect(inboxes(sent).at(-1).items).toEqual([]);
});

test("voice.status with no login says sign in; voice.prefs persists and broadcasts", async () => {
  const { daemon, sent, replies, ctx } = setup();
  await handleMessage(JSON.stringify({ t: "voice.status", requestId: "q" }), ctx);
  expect(replies.at(-1)).toMatchObject({
    t: "voice.status",
    requestId: "q",
    available: false,
    canLogin: true,
    reason: REASON_SIGN_IN,
    prefs: { mode: "notify" },
  });
  await handleMessage(JSON.stringify({ t: "voice.prefs", prefs: { mode: "onthego" } }), ctx);
  expect(sent.filter((m) => m.t === "voice.status").at(-1).prefs.mode).toBe("onthego");
  const again = new Daemon({ id: "t", name: "t" }, true, (daemon as any).env);
  await again.voice.loaded;
  expect(again.voice.currentPrefs.mode).toBe("onthego");
  daemon.closeAll();
  again.closeAll();
});

test("a call opens a board; tell_agent puts Pew's line on the echo session's lane", async () => {
  const root = mkdtempSync(join(tmpdir(), "pew2-board-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PEW2_HOME: join(root, "pew2"),
    GG_AGENT_DIR: join(root, "gg"),
    CODEX_HOME: join(root, "codex"),
    OPENAI_API_KEY: "sk-test",
  };
  const daemon = new Daemon({ id: "t", name: "t" }, true, env);
  const sent: any[] = [];
  daemon.attach((message) => sent.push(message));
  (daemon.voice as any).fetchImpl = async () =>
    new Response(JSON.stringify({ value: "ek_test", expires_at: 9_999_999_999, session: { model: "m" } }));
  const replies: any[] = [];
  const ctx = { daemon, reply: (m: unknown) => replies.push(m), broadcast: (m: unknown) => sent.push(m) };
  try {
    await daemon.refreshProviders();
    const sessionId = await daemon.startSession("echo", process.cwd());
    daemon.markLive(sessionId);
    await handleMessage(JSON.stringify({ t: "voice.session", requestId: "v" }), ctx);
    const opened = replies.at(-1);
    expect(opened).toMatchObject({ t: "voice.session", ok: true });
    const boards = () => sent.filter((m) => m.t === "voice.board" && m.callId === opened.callId);
    expect(boards()).toHaveLength(1);
    await handleMessage(
      JSON.stringify({
        t: "voice.tool",
        requestId: "r",
        callId: opened.callId,
        toolCallId: "tc",
        name: "tell_agent",
        arguments: JSON.stringify({ session_id: sessionId, text: "run the tests" }),
      }),
      ctx,
    );
    expect(JSON.parse(replies.at(-1).output)).toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 600));
    const lane = boards()
      .at(-1)
      .sessions.find((s: any) => s.sessionId === sessionId);
    expect(lane.touchedAt).toBeGreaterThan(0);
    expect(lane.lines).toContainEqual(expect.objectContaining({ kind: "pew", text: "run the tests" }));
    const count = boards().length;
    await handleMessage(JSON.stringify({ t: "voice.end", callId: opened.callId }), ctx);
    await new Promise((r) => setTimeout(r, 300));
    expect(boards()).toHaveLength(count);
  } finally {
    daemon.closeAll();
  }
}, 60_000);

test("open_chat reopens a stored chat that wasn't open; start_chat starts one and sends the first message", async () => {
  const root = mkdtempSync(join(tmpdir(), "pew2-chats-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PEW2_HOME: join(root, "pew2"),
    GG_AGENT_DIR: join(root, "gg"),
    CODEX_HOME: join(root, "codex"),
    OPENAI_API_KEY: "sk-test",
  };
  const daemon = new Daemon({ id: "t", name: "t" }, true, env);
  const sent: any[] = [];
  daemon.attach((message) => sent.push(message));
  (daemon.voice as any).fetchImpl = async () =>
    new Response(JSON.stringify({ value: "ek_test", expires_at: 9_999_999_999, session: { model: "m" } }));
  const replies: any[] = [];
  const ctx = { daemon, reply: (m: unknown) => replies.push(m), broadcast: (m: unknown) => sent.push(m) };
  let toolCalls = 0;
  const tool = async (callId: string, name: string, args: object) => {
    await handleMessage(
      JSON.stringify({ t: "voice.tool", requestId: "r", callId, toolCallId: `${name}-${++toolCalls}`, name, arguments: JSON.stringify(args) }),
      ctx,
    );
    return JSON.parse(replies.at(-1).output);
  };
  try {
    await daemon.refreshProviders();
    await daemon.capabilitiesFor("echo");
    // The echo agent dates its stored chat in July: worked in today instead,
    // so it is inside Pew's two-week reach.
    const stored = daemon.voiceChats.bind(daemon);
    daemon.voiceChats = async () => (await stored()).map((c) => ({ ...c, updatedAt: new Date().toISOString() }));
    const project = basename(process.cwd());
    await handleMessage(JSON.stringify({ t: "voice.session", requestId: "v" }), ctx);
    const opened = replies.at(-1);
    expect(opened).toMatchObject({ t: "voice.session", ok: true });
    // Nothing is open, yet the briefing names the project and the tool reaches it.
    expect(daemon.voiceStatuses()).toEqual([]);
    expect((await daemon.voiceChats()).map((c) => c.agentSessionId)).toContain("echo_history_1");

    const reopened = await tool(opened.callId, "open_chat", { project });
    expect(reopened).toMatchObject({ ok: true, already_open: false, title: "Unopened echo session" });
    expect(daemon.voiceStatuses().map((s) => s.sessionId)).toEqual([reopened.session_id]);
    expect(sent).toContainEqual(expect.objectContaining({ t: "session.started", sessionId: reopened.session_id, resumed: true }));
    // Asked again: the same live session, not a second copy.
    expect(await tool(opened.callId, "open_chat", { project })).toMatchObject({ session_id: reopened.session_id, already_open: true });

    const started = await tool(opened.callId, "start_chat", { project, text: "hello there" });
    expect(started).toMatchObject({ ok: true, sent: true, agent: "Echo (test)" });
    expect(sent).toContainEqual(expect.objectContaining({ t: "session.started", sessionId: started.session_id }));
    await new Promise((r) => setTimeout(r, 600));
    const lines = daemon.voiceStatuses(started.session_id)[0]?.lastLines.join(" ") ?? "";
    expect(lines).toContain("hello there");
  } finally {
    daemon.closeAll();
  }
}, 60_000);

test("a call from a new, empty chat in a known project tells Pew where it came from", async () => {
  const root = mkdtempSync(join(tmpdir(), "pew2-place-"));
  const env: NodeJS.ProcessEnv = { ...process.env, PEW2_HOME: join(root, "pew2"), GG_AGENT_DIR: join(root, "gg"), CODEX_HOME: join(root, "codex"), OPENAI_API_KEY: "sk-test" };
  const daemon = new Daemon({ id: "t", name: "t" }, true, env);
  daemon.attach(() => {});
  let instructions = "";
  (daemon.voice as any).fetchImpl = async (_url: string, init: { body?: string }) => {
    instructions = JSON.parse(init.body ?? "{}")?.session?.instructions ?? "";
    return new Response(JSON.stringify({ value: "ek_test", expires_at: 9_999_999_999, session: { model: "m" } }));
  };
  const replies: any[] = [];
  const ctx = { daemon, reply: (m: unknown) => replies.push(m), broadcast: () => {} };
  try {
    await daemon.refreshProviders();
    await daemon.capabilitiesFor("echo");
    await handleMessage(JSON.stringify({ t: "voice.session", requestId: "v", cwd: process.cwd(), providerId: "echo" }), ctx);
    expect(replies.at(-1)).toMatchObject({ ok: true });
    expect(instructions).toContain(`They called from a new, empty ${basename(process.cwd())} (Echo (test)) chat`);
    // A path this daemon never published is not taken on the phone's word.
    await handleMessage(JSON.stringify({ t: "voice.session", requestId: "w", cwd: "/etc", providerId: "echo" }), ctx);
    expect(instructions).not.toContain("They called from");
  } finally {
    daemon.closeAll();
  }
}, 60_000);

test("voice.arm through the handler: listed on voice.status, dropped when the session closes", async () => {
  const { daemon, sent, ctx } = setup();
  await daemon.voice.loaded;
  await handleMessage(JSON.stringify({ t: "voice.arm", sessionId: "s1", on: true }), ctx);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const armed = sent.filter((m) => m.t === "voice.status").at(-1)?.armed;
  expect(armed?.map((entry: { sessionId: string }) => entry.sessionId)).toEqual(["s1"]);
  daemon.closeAll();
  expect(daemon.voice.armedSessions).toEqual([]);
});

test("a tool request sent twice (the phone resends after a drop) runs once", async () => {
  const { daemon, replies, ctx, ask, answered } = setup();
  ask("npm test");
  (daemon.voice as any).calls.add("c1");
  const send = () =>
    handleMessage(
      JSON.stringify({ t: "voice.tool", requestId: "r", callId: "c1", toolCallId: "same", name: "answer_permission", arguments: JSON.stringify({ item_id: "s1:approval:p1", decision: "allow" }) }),
      ctx,
    );
  await send();
  await send();
  expect(answered).toEqual([["p1", "once"]]);
  expect(replies.filter((r) => r.toolCallId === "same")).toHaveLength(2);
  expect(replies[0].output).toBe(replies[1].output);
});
