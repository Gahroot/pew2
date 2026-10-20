/**
 * Arming: only sessions the user armed may ring, arming expires and goes with
 * its session, and `ringUntil` switches On the go back off by itself.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { wire } from "@pew2/protocol";
import { ARM_MS, VoiceController } from "./controller.js";
import { ThreadStore } from "./threads.js";
import type { InboxSource } from "./inbox.js";
import type { VoiceRingPush } from "../push.js";

const M = 60_000;
const T0 = 1_800_000_000_000;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "pew2-voice-ctl-"));
  let now = T0;
  const sources: InboxSource[] = [];
  const rings: VoiceRingPush[] = [];
  const sent: any[] = [];
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const voice = new VoiceController(
    { inboxSources: () => sources, broadcast: (m) => sent.push(m), ring: (push) => rings.push(push) },
    {
      paths: {
        voicePrefs: join(root, "voice-prefs.json"),
        voiceAuth: join(root, "voice-auth.json"),
        ggAuth: join(root, "gg-auth.json"),
        codexAuth: join(root, "codex-auth.json"),
      },
      now: () => now,
      fetchImpl: (async () => new Response("{}", { status: 500 })) as any,
      setTimer: (fn, ms) => {
        const timer = { at: now + ms, fn, live: true };
        timers.push(timer);
        return { cancel: () => (timer.live = false) };
      },
    },
  );
  /** Move the clock, firing due timers in order. */
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.live = false;
      now = due.at;
      due.fn();
    }
    now = end;
  };
  const block = (sessionId: string, requestId = "p1") => {
    sources.push({
      sessionId,
      folder: sessionId,
      permissions: new Map([[requestId, { toolCall: { title: `run in ${sessionId}` }, options: [] }]]) as any,
    } as InboxSource);
    voice.inboxChanged();
  };
  const statuses = () => sent.filter((m) => m.t === "voice.status") as wire.VoiceStatus[];
  return { voice, rings, block, advance, statuses, now: () => now };
}

const QUIET_OFF = { on: false, from: 0, to: 0 };

test("with ringing narrowed to chosen chats, only an armed session rings", async () => {
  const { voice, rings, block, advance } = setup();
  await voice.setPrefs({ mode: "onthego", batchSeconds: 0, quietHours: QUIET_OFF, ringScope: "chosen" });
  block("docs");
  advance(M);
  expect(rings).toEqual([]);
  voice.arm("billing", true);
  block("billing");
  expect(rings).toHaveLength(1);
  expect(rings[0]?.focus).toBe("billing:approval:p1");
  // The ring talks about the armed session only.
  expect(rings[0]?.body).toContain("billing");
  expect(rings[0]?.body).not.toContain("docs");
});

test("Ring me rings for any chat that gets stuck by default, never about what was already waiting", async () => {
  const { voice, rings, block, advance } = setup();
  block("old");
  await voice.setPrefs({ mode: "onthego", batchSeconds: 0, quietHours: QUIET_OFF });
  advance(30 * M);
  expect(rings).toEqual([]);
  block("docs");
  expect(rings).toHaveLength(1);
  expect(rings[0]?.body).toContain("docs");
});

test("arming never rings about what was already waiting", async () => {
  const { voice, rings, block, advance } = setup();
  await voice.setPrefs({ mode: "onthego", batchSeconds: 0, quietHours: QUIET_OFF, ringScope: "chosen" });
  block("billing");
  voice.arm("billing", true);
  advance(30 * M);
  expect(rings).toEqual([]);
});

test("arming is listed, expires after 12 hours, and goes with its session", async () => {
  const { voice, statuses, advance } = setup();
  await voice.loaded;
  voice.arm("a", true);
  voice.arm("b", true);
  expect(voice.armedSessions.map((x) => x.sessionId)).toEqual(["a", "b"]);
  expect((await voice.status()).armed?.map((x) => x.sessionId)).toEqual(["a", "b"]);
  voice.sessionClosed("a");
  expect(voice.armedSessions.map((x) => x.sessionId)).toEqual(["b"]);
  advance(ARM_MS);
  expect(voice.armedSessions).toEqual([]);
  expect(voice.isArmed("b")).toBe(false);
  // The broadcast follows a credentials read: wait for it rather than one tick.
  for (let i = 0; i < 50 && statuses().length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  expect(statuses().length).toBeGreaterThan(0);
});

test("armNewSessions arms what the phone starts; off by default", async () => {
  const { voice } = setup();
  await voice.loaded;
  voice.sessionStarted("x");
  expect(voice.isArmed("x")).toBe(false);
  await voice.setPrefs({ armNewSessions: true });
  voice.sessionStarted("y");
  expect(voice.isArmed("y")).toBe(true);
});

test("ringUntil switches On the go back to notify by itself, and says so", async () => {
  const { voice, statuses, advance } = setup();
  await voice.setPrefs({ mode: "onthego", ringUntil: T0 + 60 * M });
  advance(60 * M);
  // setPrefs is async (it writes the file).
  for (let i = 0; i < 20 && voice.currentPrefs.mode !== "notify"; i++) await new Promise((r) => setTimeout(r, 5));
  expect(voice.currentPrefs.mode).toBe("notify");
  expect(voice.currentPrefs.ringUntil).toBe(0);
  expect(statuses().at(-1)?.prefs?.mode).toBe("notify");
});

test("a declined ring snoozes the next one", async () => {
  const { voice, rings, block, advance } = setup();
  await voice.setPrefs({ mode: "onthego", batchSeconds: 0, cooldownMinutes: 0, quietHours: QUIET_OFF });
  voice.arm("a", true);
  block("a");
  expect(rings).toHaveLength(1);
  voice.endCall("ring", "declined");
  block("a", "p2");
  advance(29 * M);
  expect(rings).toHaveLength(1);
  advance(2 * M);
  expect(rings).toHaveLength(2);
});

test("mid-call, a session Pew prompted finishing is told to Pew with its reply", async () => {
  const sent: any[] = [];
  const sources = [
    { sessionId: "s1", folder: "drjones", agentName: "Codex", working: true, events: [] as wire.SessionEvent[] },
    { sessionId: "s2", folder: "other", working: true, events: [] as wire.SessionEvent[] },
  ];
  const root = mkdtempSync(join(tmpdir(), "pew2-voice-note-"));
  writeFileSync(join(root, "g.json"), JSON.stringify({ openai: { accessToken: "tok", expiresAt: Date.now() + 3_600_000 } }));
  const voice = new VoiceController(
    { inboxSources: () => [], boardSources: () => sources, broadcast: (m) => sent.push(m), ring: () => {} },
    {
      paths: { voicePrefs: join(root, "p.json"), voiceAuth: join(root, "a.json"), ggAuth: join(root, "g.json"), codexAuth: join(root, "c.json") },
      fetchImpl: (async () => new Response(JSON.stringify({ value: "ek_1", expires_at: 9e9 }), { status: 200 })) as never,
      setTimer: () => ({ cancel: () => {} }),
    },
  );
  const opened = await voice.openSession("r1", undefined, [{ sessionId: "s1", folder: "drjones", working: true, lastLines: [] }], "s1");
  expect(opened.ok).toBe(true);
  sources[0]!.working = false;
  sources[0]!.events = [{ seq: 1, at: 1, payload: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "**Tests pass.**" } } } } as never];
  sources[1]!.working = false;
  voice.boardChanged();
  const notes = sent.filter((m) => m.t === "voice.note");
  // The chat they called from is watched; an untouched one is not.
  expect(notes).toHaveLength(1);
  expect(notes[0].text).toContain("drjones (Codex) finished its turn. Its reply: Tests pass.");
  expect(notes[0].speak).toBe(true);
});

test("call me back: rings with nothing waiting and Ring me off, and the callback call remembers the last one", async () => {
  const root = mkdtempSync(join(tmpdir(), "pew2-voice-callback-"));
  writeFileSync(join(root, "g.json"), JSON.stringify({ openai: { accessToken: "tok", expiresAt: T0 + 24 * 3_600_000 } }));
  let now = T0;
  const rings: VoiceRingPush[] = [];
  const minted: string[] = [];
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const voice = new VoiceController(
    { inboxSources: () => [], broadcast: () => {}, ring: (push) => rings.push(push) },
    {
      paths: { voicePrefs: join(root, "p.json"), voiceAuth: join(root, "a.json"), ggAuth: join(root, "g.json"), codexAuth: join(root, "c.json") },
      now: () => now,
      threads: new ThreadStore(join(root, "threads.json"), () => now),
      fetchImpl: (async (_url: string, init: { body?: string }) => {
        minted.push(JSON.parse(init.body ?? "{}")?.session?.instructions ?? "");
        return new Response(JSON.stringify({ value: "ek_1", expires_at: 9e9 }), { status: 200 });
      }) as never,
      setTimer: (fn, ms) => {
        const timer = { at: now + ms, fn, live: true };
        timers.push(timer);
        return { cancel: () => (timer.live = false) };
      },
    },
  );
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.live = false;
      now = due.at;
      due.fn();
    }
    now = end;
  };
  // Ring me is off (the default): a callback still rings.
  const first = await voice.openSession("r1", undefined, []);
  expect(first.ok).toBe(true);
  voice.callMeBack(1, first.callId);
  voice.endCall(first.callId!, "hangup", [
    { role: "user", text: "Check the billing tests and call me back in a minute." },
    { role: "assistant", text: "Talk in 1 minute." },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  advance(59_000);
  expect(rings).toEqual([]);
  advance(2_000);
  expect(rings).toHaveLength(1);
  expect(rings[0]!.body).toBe("Calling you back, as you asked.");
  // They answer: the call knows it is the callback, and what was said.
  await voice.openSession("r2", undefined, []);
  const briefing = minted.at(-1)!;
  expect(briefing).toContain("THIS CALL: you rang them because");
  expect(briefing).toContain("- They: Check the billing tests and call me back in a minute.");
  expect(briefing).toContain("Your earlier calls with them from home");
});

test("call me back when it's done: rings once that session's turn ends, not before", async () => {
  let now = T0;
  const rings: VoiceRingPush[] = [];
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const source = { sessionId: "s1", providerId: "claude", folder: "billing-api", working: true, permissions: new Map(), events: [] } as never as { working: boolean };
  const root = mkdtempSync(join(tmpdir(), "pew2-voice-wait-"));
  const voice = new VoiceController(
    { inboxSources: () => [], boardSources: () => [source as never], broadcast: () => {}, ring: (push) => rings.push(push) },
    {
      paths: { voicePrefs: join(root, "p.json"), voiceAuth: join(root, "a.json"), ggAuth: join(root, "g.json"), codexAuth: join(root, "c.json") },
      now: () => now,
      setTimer: (fn, ms) => {
        const timer = { at: now + ms, fn, live: true };
        timers.push(timer);
        return { cancel: () => (timer.live = false) };
      },
    },
  );
  voice.callWhenDone("s1", "billing-api");
  now += 10 * M;
  voice.boardChanged();
  expect(rings).toEqual([]);
  source.working = false;
  voice.boardChanged();
  expect(rings).toHaveLength(1);
  expect(rings[0]!.body).toContain("Calling you back");
  // Once only.
  voice.boardChanged();
  expect(rings).toHaveLength(1);
});


test("each chat has its own voice thread: a call from it carries on, a new chat starts fresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "pew2-voice-threads-"));
  writeFileSync(join(root, "g.json"), JSON.stringify({ openai: { accessToken: "tok", expiresAt: T0 + 24 * 3_600_000 } }));
  const minted: string[] = [];
  const conversations: Record<string, string | undefined> = { live1: "conv-billing", live2: "conv-docs", live3: undefined };
  const make = () =>
    new VoiceController(
      {
        inboxSources: () => [],
        broadcast: () => {},
        ring: () => {},
        threadFor: (id) => (conversations[id] ? { key: `claude:${conversations[id]}`, label: id === "live1" ? "billing-api" : "docs" } : undefined),
      },
      {
        paths: { voicePrefs: join(root, "p.json"), voiceAuth: join(root, "a.json"), ggAuth: join(root, "g.json"), codexAuth: join(root, "c.json") },
        now: () => T0,
        threads: new ThreadStore(join(root, "threads.json"), () => T0),
        setTimer: () => ({ cancel: () => {} }),
        fetchImpl: (async (_url: string, init: { body?: string }) => {
          minted.push(JSON.parse(init.body ?? "{}")?.session?.instructions ?? "");
          return new Response(JSON.stringify({ value: "ek", expires_at: 9e9 }), { status: 200 });
        }) as never,
      },
    );
  const status = (sessionId: string) => [{ sessionId, folder: "x", working: false, lastLines: [] }];
  let voice = make();
  const a = await voice.openSession("r1", undefined, status("live1"), "live1");
  voice.endCall(a.callId!, "hangup", [{ role: "user", text: "Make billing retry twice." }, { role: "assistant", text: "Sent." }]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // A different chat: its own (empty) thread, nothing about billing.
  await voice.openSession("r2", undefined, status("live2"), "live2");
  expect(minted.at(-1)).not.toContain("Make billing retry twice.");
  // After a restart (a new controller, same file), billing's call carries on.
  voice = make();
  await voice.openSession("r3", undefined, status("live1"), "live1");
  expect(minted.at(-1)).toContain("Your earlier calls about the billing-api chat");
  expect(minted.at(-1)).toContain("- They: Make billing retry twice.");
  // A new chat with nothing sent: a fresh call; when Pew starts the chat, its lines land there.
  const fresh = await voice.openSession("r4", undefined, [], undefined, [], { folder: "docs" });
  expect(minted.at(-1)).not.toContain("Your earlier calls");
  voice.bindCall(fresh.callId!, "live2");
  voice.endCall(fresh.callId!, "hangup", [{ role: "user", text: "Start docs and fix the links." }]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await voice.openSession("r5", undefined, status("live2"), "live2");
  expect(minted.at(-1)).toContain("- They: Start docs and fix the links.");
  await voice.forgetThreads();
  await voice.openSession("r6", undefined, status("live1"), "live1");
  expect(minted.at(-1)).not.toContain("Your earlier calls");
});


test("a call from one chat that acts on another leaves a note in the other's thread", async () => {
  const root = mkdtempSync(join(tmpdir(), "pew2-voice-cross-"));
  writeFileSync(join(root, "g.json"), JSON.stringify({ openai: { accessToken: "tok", expiresAt: T0 + 24 * 3_600_000 } }));
  const minted: string[] = [];
  const keys: Record<string, string> = { a: "conv-billing", b: "conv-docs" };
  const voice = new VoiceController(
    { inboxSources: () => [], broadcast: () => {}, ring: () => {}, threadFor: (id) => (keys[id] ? { key: `claude:${keys[id]}`, label: id === "a" ? "billing-api" : "docs" } : undefined) },
    {
      paths: { voicePrefs: join(root, "p.json"), voiceAuth: join(root, "a.json"), ggAuth: join(root, "g.json"), codexAuth: join(root, "c.json") },
      now: () => T0,
      threads: new ThreadStore(join(root, "threads.json"), () => T0),
      setTimer: () => ({ cancel: () => {} }),
      fetchImpl: (async (_url: string, init: { body?: string }) => {
        minted.push(JSON.parse(init.body ?? "{}")?.session?.instructions ?? "");
        return new Response(JSON.stringify({ value: "ek", expires_at: 9e9 }), { status: 200 });
      }) as never,
    },
  );
  const status = (sessionId: string) => [{ sessionId, folder: "x", working: false, lastLines: [] }];
  const call = await voice.openSession("r1", undefined, status("a"), "a");
  voice.noteAction(call.callId!, 'Sent docs: "fix the links"', "b");
  voice.endCall(call.callId!, "hangup", [{ role: "user", text: "Also tell docs to fix the links." }]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await voice.openSession("r2", undefined, status("b"), "b");
  const docs = minted.at(-1)!;
  expect(docs).toContain('- (you did: Sent docs: "fix the links")');
  // Only the action: billing's words stay in billing's thread.
  expect(docs).not.toContain("Also tell docs to fix the links.");
});

test("a call carries the voice tasks' instructions and tools, and only the call in progress hears their notes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pew2-voice-tasks-"));
  writeFileSync(join(root, "g.json"), JSON.stringify({ openai: { accessToken: "tok", expiresAt: T0 + 24 * 3_600_000 } }));
  let now = T0;
  const sent: any[] = [];
  const minted: { instructions: string; tools: { name: string }[] }[] = [];
  const voice = new VoiceController(
    { inboxSources: () => [], boardSources: () => [], broadcast: (m) => sent.push(m), ring: () => {} },
    {
      paths: { voicePrefs: join(root, "p.json"), voiceAuth: join(root, "a.json"), ggAuth: join(root, "g.json"), codexAuth: join(root, "c.json") },
      now: () => now,
      setTimer: () => ({ cancel: () => {} }),
      fetchImpl: (async (_url: string, init: { body?: string }) => {
        minted.push(JSON.parse(init.body ?? "{}")?.session);
        return new Response(JSON.stringify({ value: "ek", expires_at: 9e9 }), { status: 200 });
      }) as never,
    },
  );
  const briefed: string[] = [];
  const tasks = async (callId: string) => {
    briefed.push(callId);
    return { instructions: "Tasks:\n- use start_task", tools: [{ type: "function", name: "start_task" }] };
  };
  const opened = await voice.openSession("r1", undefined, [], undefined, undefined, undefined, tasks);
  const callId = opened.callId;
  if (!opened.ok || !callId) throw new Error("expected the call to open");
  // Briefed with the id the call is minted under, and both halves are offered.
  expect(briefed).toEqual([callId]);
  const names = minted[0]?.tools.map((t) => t.name) ?? [];
  expect(names).toContain("start_task");
  expect(names).toContain("tell_agent");
  expect(minted[0]?.instructions).toContain("Tasks:\n- use start_task");
  expect(minted[0]?.instructions).toContain("New work they ask for goes to start_task");
  expect(minted[0]?.instructions).not.toContain("If they ask for new work in a project with no chat, call start_chat");

  expect(voice.callInProgress(callId)).toBe(true);
  voice.noteCall(callId, { text: "[Update] pew2: done", speak: true });
  voice.noteCall("call_other", { text: "not this call" });
  expect(sent.filter((m) => m.t === "voice.note")).toEqual([
    { t: "voice.note", callId: callId, text: "[Update] pew2: done", speak: true },
  ]);

  // A call whose end never arrived goes stale; an ended one is over at once.
  now += 61 * M;
  expect(voice.callInProgress(callId)).toBe(false);
  now = T0;
  voice.endCall(callId, "hangup");
  expect(voice.callInProgress(callId)).toBe(false);

  // A task side that fails leaves the call as it always was.
  const plain = await voice.openSession("r2", undefined, [], undefined, undefined, undefined, async () => {
    throw new Error("disk");
  });
  expect(plain.ok).toBe(true);
  expect(minted[1]?.tools.map((t) => t.name)).not.toContain("start_task");
  expect(minted[1]?.instructions).toContain("If they ask for new work in a project with no chat, call start_chat");
});
