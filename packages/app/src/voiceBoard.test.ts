import { describe, expect, test } from "bun:test";
import {
  IDLE_BOARD,
  LANE_COUNT,
  PEW_TYPE_MAX_MS,
  boardFromInbox,
  boardView,
  busyLine,
  currentLine,
  DWELL_MS,
  callActions,
  captionView,
  foldBoard,
  lineKey,
  lineView,
  placeLanes,
  readBoardSessions,
  sessionsFromInbox,
  spotlightOf,
  typeDuration,
  voiceMood,
  pageChars,
  toolFloat,
  waitedFor,
  type BoardSession,
  type BoardState,
} from "./voiceBoard";
import { IDLE_CALL, stepCall, type CallState, type CompletedTool, type VoiceInboxItem } from "./voiceCall";
import { DEMO_DURATION_S, demoAt } from "./voiceDemo";

const T0 = 1_000_000;

const sess = (id: string, extra: Partial<BoardSession> = {}): BoardSession => ({
  sessionId: id,
  folder: id,
  agentName: "Agent",
  status: "working",
  since: T0,
  touchedAt: 0,
  lines: [],
  ...extra,
});

const frame = (sessions: BoardSession[]) => ({ t: "voice.board", sessions });

function fold(frames: BoardSession[][], start = IDLE_BOARD): BoardState {
  let state = start;
  frames.forEach((sessions, i) => (state = foldBoard(state, frame(sessions), T0 + i * 1000)));
  return state;
}

const noCall: Pick<CallState, "tools" | "inbox" | "focus"> = { tools: [], inbox: [] };

describe("reading boards", () => {
  test("drops malformed entries and duplicate ids, keeps the rest", () => {
    const read = readBoardSessions([
      { sessionId: "a", status: "working", since: 1, touchedAt: 2, lines: [{ kind: "tool", text: "x", at: 3 }, { kind: "weird", text: "y", at: 4 }] },
      { status: "working" },
      { sessionId: "a", status: "idle", since: 0, touchedAt: 0, lines: [] },
      { sessionId: "b", status: "mystery", lines: "nope" },
    ]);
    expect(read?.map((s) => s.sessionId)).toEqual(["a", "b"]);
    expect(read?.[0]?.lines).toEqual([{ kind: "tool", text: "x", at: 3 }]);
    expect(read?.[1]?.status).toBe("idle");
    expect(readBoardSessions("nope")).toBeUndefined();
  });

  test("ignores frames that are not voice frames", () => {
    expect(foldBoard(IDLE_BOARD, { t: "session.event" }, T0)).toBe(IDLE_BOARD);
    expect(foldBoard(IDLE_BOARD, null, T0)).toBe(IDLE_BOARD);
  });
});

describe("stable lanes", () => {
  test("the first board fills lanes in board order", () => {
    const state = fold([[sess("a"), sess("b"), sess("c")]]);
    expect(state.slots).toEqual(["a", "b", "c", undefined]);
    expect(state.slots).toHaveLength(LANE_COUNT);
  });

  test("reordering the board never moves a lane", () => {
    const state = fold([
      [sess("a"), sess("b"), sess("c"), sess("d")],
      [sess("d"), sess("c"), sess("b"), sess("a")],
    ]);
    expect(state.slots).toEqual(["a", "b", "c", "d"]);
  });

  test("a gone session frees its lane, and a newcomer takes that lane in place", () => {
    const state = fold([
      [sess("a"), sess("b"), sess("c"), sess("d")],
      [sess("a"), sess("c"), sess("d")],
      [sess("e"), sess("a"), sess("c"), sess("d")],
    ]);
    expect(state.slots).toEqual(["a", "e", "c", "d"]);
  });

  test("a fifth newcomer takes the least-recently-touched lane, and that lane folds", () => {
    const four = [
      sess("a", { touchedAt: T0 + 40 }),
      sess("b", { touchedAt: T0 + 10 }),
      sess("c", { touchedAt: T0 + 30 }),
      sess("d", { touchedAt: T0 + 20 }),
    ];
    const state = fold([four, [...four, sess("e", { status: "needs", since: T0 + 50 })]]);
    expect(state.slots).toEqual(["a", "e", "c", "d"]);
    expect(state.folded).toEqual(["b"]);
    const view = boardView(state, noCall, T0 + 5000);
    expect(view.fold).toEqual({ count: 1, folder: "b", status: { word: "Working", tone: "agent", pulse: true } });
  });

  test("an evicted lane does not swap straight back", () => {
    const four = [sess("a", { touchedAt: T0 + 40 }), sess("b", { touchedAt: T0 + 10 }), sess("c", { touchedAt: T0 + 30 }), sess("d", { touchedAt: T0 + 20 })];
    const e = sess("e", { status: "needs", since: T0 + 50 });
    const state = fold([four, [...four, e], [...four, e], [e, ...four]]);
    expect(state.slots).toEqual(["a", "e", "c", "d"]);
  });

  test("a folded session comes back once Pew touches it", () => {
    const four = [sess("a", { touchedAt: T0 + 40 }), sess("b", { touchedAt: T0 + 10 }), sess("c", { touchedAt: T0 + 30 }), sess("d", { touchedAt: T0 + 20 })];
    const e = sess("e", { status: "needs", since: T0 + 50 });
    const touched = four.map((s) => (s.sessionId === "b" ? { ...s, touchedAt: T0 + 90 } : s));
    const state = fold([four, [...four, e], [...touched, e]]);
    expect(state.slots).toEqual(["a", "e", "c", "b"]);
    expect(state.folded).toEqual(["d"]);
  });

  test("on the first board, sessions past four fold without evicting anything", () => {
    const state = fold([[sess("a"), sess("b"), sess("c"), sess("d"), sess("e"), sess("f")]]);
    expect(state.slots).toEqual(["a", "b", "c", "d"]);
    expect(state.folded).toEqual(["f", "e"]);
    expect(boardView(state, noCall, T0).fold?.folder).toBe("e");
    expect(boardView(state, noCall, T0).fold?.count).toBe(2);
  });

  test("an old quiet session never displaces a lane", () => {
    const { slots, evicted } = placeLanes(["a", "b", "c", "d"], ["a", "b", "c", "d", "e"].map((id) => sess(id)), () => false);
    expect(slots).toEqual(["a", "b", "c", "d"]);
    expect(evicted).toEqual([]);
  });
});

describe("type-out and fresh lines", () => {
  test("lines on the first board are history and never type out", () => {
    const state = fold([[sess("a", { lines: [{ kind: "pew", text: "hello there", at: 5 }] })]]);
    const lane = boardView(state, noCall, T0 + 1)?.lanes[0];
    expect(lane?.current?.typing).toBe(false);
    expect(lane?.current?.fresh).toBe(false);
  });

  test("a new pew line types at 30ms a char, capped at 2s, and flashes while fresh", () => {
    const text = "Keep v1 for a month.";
    const state = fold([[sess("a")], [sess("a", { lines: [{ kind: "pew", text, at: 9 }] })]]);
    const seen = T0 + 1000;
    const half = boardView(state, noCall, seen + (text.length * 30) / 2).lanes[0]?.current;
    expect(half?.typing).toBe(true);
    expect(half?.shown).toBe(text.slice(0, Math.ceil(text.length / 2)));
    expect(half?.fresh).toBe(true);
    const done = boardView(state, noCall, seen + text.length * 30).lanes[0]?.current;
    expect(done?.typing).toBe(false);
    expect(done?.shown).toBe(text);
    expect(typeDuration({ kind: "pew", text: "x".repeat(500) })).toBe(PEW_TYPE_MAX_MS);
  });

  test("the line clock survives later frames (seen time is kept, not restamped)", () => {
    const line = { kind: "tool" as const, text: "Run npm test", at: 9 };
    const state = fold([[sess("a")], [sess("a", { lines: [line] })], [sess("a", { lines: [line] })]]);
    expect(state.seen[lineKey("a", line)]).toBe(T0 + 1000);
  });

  test("lineView before its first char shows nothing and is typing", () => {
    const v = lineView("k", { kind: "pew", text: "abc", at: 0 }, 10, 10);
    expect(v).toMatchObject({ shown: "", typing: true, fresh: true });
  });
});

describe("status overlay and spotlight", () => {
  const four = [sess("a", { touchedAt: T0 + 3 }), sess("b", { touchedAt: T0 + 9 }), sess("c", { status: "asks" }), sess("d", { status: "done", since: 0 })];

  test("plain statuses are short words", () => {
    const view = boardView(fold([four]), noCall, T0 + 10_000);
    expect(view.lanes.map((l) => l.status.word)).toEqual(["Working", "Working", expect.stringMatching(/^Needs you/), "Done"]);
    expect(view.lanes.map((l) => l.mood)).toEqual(["working", "working", "thinking", "idle"]);
    expect(view.waiting).toBe(1);
  });

  test("Pew typing while a fresh pew line types out, then the real status", () => {
    const state = fold([four, [sess("a", { touchedAt: T0 + 3, lines: [{ kind: "pew", text: "Do the thing now", at: 1 }] }), ...four.slice(1)]]);
    expect(boardView(state, noCall, T0 + 1100).lanes[0]?.status.word).toBe("Pew typing");
    expect(boardView(state, noCall, T0 + 5000).lanes[0]?.status.word).toBe("Working");
  });

  test("With Pew while a tool targets the session (session_id, or item_id via the inbox)", () => {
    const state = fold([four]);
    const inbox: VoiceInboxItem[] = [{ id: "c:question:r1", sessionId: "c", kind: "question", requestId: "r1", title: "Keep v1?", since: 0 }];
    const call = { inbox, tools: [{ toolCallId: "t1", name: "answer_question", arguments: JSON.stringify({ item_id: "c:question:r1" }), requestId: "x" }] };
    const view = boardView(state, call, T0);
    expect(view.lanes.find((l) => l.sessionId === "c")?.status.word).toBe("With Pew");
    expect(view.spotlight).toBe("c");
    expect(view.sending).toBe("c");
    const tell = { inbox, tools: [{ toolCallId: "t2", name: "tell_agent", arguments: JSON.stringify({ session_id: "a", text: "hi" }), requestId: "y" }] };
    expect(spotlightOf(state, tell)).toBe("a");
  });

  test("without a tool, the newest touchedAt wins; untouched falls back to the focus item", () => {
    expect(spotlightOf(fold([four]), noCall)).toBe("b");
    const untouched = fold([four.map((s) => ({ ...s, touchedAt: 0 }))]);
    expect(spotlightOf(untouched, noCall)).toBeUndefined();
    expect(spotlightOf(untouched, { ...noCall, focus: "d:approval:r9" })).toBe("d");
  });

  test("a done session smiles briefly, then idles; an idle one sleeps", () => {
    const state = fold([[sess("a", { status: "done", since: T0 }), sess("b", { status: "idle" })]]);
    expect(boardView(state, noCall, T0 + 100).lanes.map((l) => l.mood)).toEqual(["happy", "sleepy"]);
    expect(boardView(state, noCall, T0 + 5000).lanes[0]?.mood).toBe("idle");
  });

  test("a lane opened on history shows its newest line", () => {
    const lines = Array.from({ length: 10 }, (_, i) => ({ kind: "tool" as const, text: `step ${i}`, at: i }));
    const view = boardView(fold([[sess("a", { touchedAt: 5, lines })]]), noCall, T0);
    expect(view.lanes[0]?.current?.text).toBe("step 9");
    expect(view.lanes[0]?.steps).toBe(0);
  });
});

describe("inbox fallback (older daemon)", () => {
  const inbox: VoiceInboxItem[] = [
    { id: "s1:approval:r1", sessionId: "s1", kind: "approval", requestId: "r1", folder: "customer-portal-frontend", agentName: "Cursor Agent", title: "npm publish", since: 5 },
    { id: "s2:question:r2", sessionId: "s2", kind: "question", requestId: "r2", folder: "api", title: "Which db?", since: 7 },
    { id: "s1:plan:r3", sessionId: "s1", kind: "plan", requestId: "r3", title: "Plan ready for review", since: 9 },
  ];

  test("groups items into one lane per session", () => {
    const sessions = sessionsFromInbox(inbox);
    expect(sessions.map((s) => [s.sessionId, s.status, s.lines.length])).toEqual([
      ["s1", "needs", 2],
      ["s2", "asks", 1],
    ]);
  });

  test("inbox frames build lanes until a board arrives, then are ignored", () => {
    let state = foldBoard(IDLE_BOARD, { t: "voice.inbox", items: inbox }, T0);
    expect(state.slots.slice(0, 2)).toEqual(["s1", "s2"]);
    state = foldBoard(state, frame([sess("x")]), T0 + 1);
    expect(state.fromBoard).toBe(true);
    expect(state.slots).toEqual([undefined, undefined, undefined, undefined].map((_, i) => (i === 0 ? "x" : undefined)));
    const after = foldBoard(state, { t: "voice.inbox", items: inbox }, T0 + 2);
    expect(after).toBe(state);
  });

  test("boardFromInbox seeds a call with nothing typing", () => {
    const view = boardView(boardFromInbox(inbox), noCall, T0);
    expect(view.lanes[0]?.folder).toBe("customer-portal-frontend");
    expect(view.lanes.every((l) => !l.current?.typing)).toBe(true);
  });
});

describe("end card", () => {
  const tool = (name: string, args: Record<string, unknown>, extra: Partial<CompletedTool> = {}): CompletedTool => ({
    toolCallId: name,
    name,
    arguments: JSON.stringify(args),
    ok: true,
    ...extra,
  });

  test("lists answering tools and messages, skips failures and reads", () => {
    const actions = callActions(
      [
        tool("answer_permission", { item_id: "x", decision: "allow" }, { sessionId: "a", item: { kind: "approval", title: "prisma migrate deploy" } }),
        tool("answer_permission", { item_id: "y", decision: "deny" }, { ok: false }),
        tool("get_status", { session_id: "a" }, { sessionId: "a" }),
        tool("tell_agent", { session_id: "a", text: "Write the changelog" }, { sessionId: "a" }),
        tool("decide_plan", { item_id: "z", action: "feedback" }, { item: { kind: "plan", title: "Plan", folder: "api", agentName: "Codex" } }),
        tool("call_me_back", { minutes: 20 }),
      ],
      [sess("a", { folder: "customer-portal-frontend", agentName: "Cursor Agent" })],
    );
    expect(actions).toEqual([
      { text: "Approved prisma migrate deploy", detail: "customer-portal-frontend · Cursor Agent", later: false },
      { text: "Sent: “Write the changelog”", detail: "customer-portal-frontend · Cursor Agent", later: false },
      { text: "Sent feedback on the plan", detail: "api · Codex", later: false },
      { text: "Pew calls back in 20 min", detail: undefined, later: true },
    ]);
  });
});

describe("captions and moods", () => {
  test("a caption is what was said so far, keyed per line so each line streams on its own", () => {
    const first = { who: "pew" as const, text: " one two ", final: false, serial: 1 };
    expect(captionView(first)).toEqual({ who: "pew", text: "one two", key: "pew:1", streaming: true });
    // The same line growing keeps its key: the stream continues, it doesn't restart.
    expect(captionView({ ...first, text: "one two three" }).key).toBe("pew:1");
    // A new line (new serial) is a new stream.
    expect(captionView({ ...first, serial: 2 }).key).toBe("pew:2");
    expect(captionView(undefined).who).toBe("none");
    // A status shows whole, it isn't streamed.
    expect(captionView(first, "Typing to docs…")).toEqual({ who: "busy", text: "Typing to docs…", key: "busy:Typing to docs…", streaming: false });
  });

  test("mood: connecting thinks, a tool works, just-acted smiles, speaking talks", () => {
    const tool = (name: string) => ({ ...IDLE_CALL, phase: "live" as const, tools: [{ toolCallId: "t", name, arguments: "{}", requestId: "r" }] });
    expect(voiceMood({ ...IDLE_CALL, phase: "connecting" }, 0, 0)).toBe("dialing");
    expect(voiceMood(tool("tell_agent"), 0, 0)).toBe("typing");
    expect(voiceMood(tool("get_status"), 0, 0)).toBe("reading");
    expect(voiceMood(tool("answer_permission"), 0, 0)).toBe("working");
    expect(voiceMood({ ...IDLE_CALL, phase: "live", activity: "speaking" }, 1000, 500)).toBe("celebrate");
    expect(voiceMood({ ...IDLE_CALL, phase: "live", activity: "speaking" }, 5000, 500)).toBe("talking");
    expect(voiceMood({ ...IDLE_CALL, phase: "live", activity: "listening", userSpeaking: true }, 5000, 0)).toBe("listening");
    expect(voiceMood({ ...IDLE_CALL, phase: "live", activity: "listening", muted: true, userSpeaking: true }, 5000, 0)).toBe("muted");
    expect(voiceMood({ ...IDLE_CALL, phase: "live", activity: "listening" }, 5000, 0)).toBe("idle");
    expect(voiceMood({ ...IDLE_CALL, phase: "ended" }, 0, 0)).toBe("goodbye");
    expect(voiceMood({ ...IDLE_CALL, phase: "failed" }, 0, 0)).toBe("oops");
  });

  test("busy line names the session a tool is on, in the floats' words", () => {
    const call = { phase: "live" as const, inbox: [], tools: [{ toolCallId: "t", name: "tell_agent", arguments: JSON.stringify({ session_id: "a" }), requestId: "r" }] };
    expect(busyLine(call, [sess("a", { folder: "docs" })])).toBe("Passing docs a note…");
    expect(busyLine({ ...call, tools: [] }, [])).toBeUndefined();
    expect(busyLine({ ...call, phase: "connecting", tools: [] }, [])).toBe("Calling Pew…");
  });
});

describe("live captions in voiceCall", () => {
  function live(): CallState {
    let s = stepCall(IDLE_CALL, { type: "start", requestId: "r" }).state;
    s = stepCall(s, { type: "daemon", message: { t: "voice.session", requestId: "r", ok: true, secret: "x", callId: "c" } }).state;
    return stepCall(s, { type: "open" }).state;
  }
  const server = (s: CallState, event: Record<string, unknown>) => stepCall(s, { type: "server", event }).state;

  test("deltas build Pew's caption word by word; done settles it", () => {
    let s = live();
    s = server(s, { type: "response.output_audio_transcript.delta", response_id: "r1", delta: "Hey" });
    s = server(s, { type: "response.output_audio_transcript.delta", response_id: "r1", delta: " there." });
    expect(s.caption).toMatchObject({ who: "pew", text: "Hey there.", final: false });
    s = server(s, { type: "response.output_audio_transcript.done", response_id: "r1", transcript: "Hey there." });
    expect(s.caption).toMatchObject({ who: "pew", text: "Hey there.", final: true });
    expect(s.transcript).toEqual([{ role: "assistant", text: "Hey there." }]);
    const serial = s.caption?.serial ?? 0;
    s = server(s, { type: "response.output_audio_transcript.delta", response_id: "r2", delta: "Next" });
    expect(s.caption).toMatchObject({ text: "Next", final: false, serial: serial + 1 });
  });

  test("the user's speech takes the caption; a late transcript never steals Pew's", () => {
    let s = live();
    s = server(s, { type: "input_audio_buffer.speech_started", item_id: "u1" });
    expect(s.caption).toMatchObject({ who: "you", text: "" });
    s = server(s, { type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "Keep it." });
    expect(s.caption).toMatchObject({ who: "you", text: "Keep it.", final: true });
    s = server(s, { type: "input_audio_buffer.speech_started", item_id: "u2" });
    s = server(s, { type: "response.output_audio_transcript.delta", response_id: "r3", delta: "Okay" });
    s = server(s, { type: "conversation.item.input_audio_transcription.completed", item_id: "u2", transcript: "Approve" });
    expect(s.caption).toMatchObject({ who: "pew", text: "Okay" });
    expect(s.transcript.at(-1)).toEqual({ role: "user", text: "Approve" });
  });

  test("a finished tool is recorded with its session for the end card", () => {
    let s = live();
    const item: VoiceInboxItem = { id: "a:approval:r", sessionId: "a", kind: "approval", requestId: "r", title: "npm publish", since: 0 };
    s = stepCall(s, { type: "daemon", message: { t: "voice.inbox", items: [item] } }).state;
    s = server(s, { type: "input_audio_buffer.committed", item_id: "u1" });
    // Read back first: the first approve is refused, the user's yes lets it through.
    s = server(s, { type: "response.function_call_arguments.done", call_id: "f0", name: "answer_permission", arguments: JSON.stringify({ item_id: item.id, decision: "allow" }) });
    s = server(s, { type: "input_audio_buffer.committed", item_id: "u2" });
    s = server(s, { type: "response.function_call_arguments.done", call_id: "f1", name: "answer_permission", arguments: JSON.stringify({ item_id: item.id, decision: "allow" }) });
    s = stepCall(s, { type: "daemon", message: { t: "voice.tool", requestId: "x", callId: "c", toolCallId: "f1", output: "{\"ok\":true}" } }).state;
    expect(s.completed).toEqual([
      { toolCallId: "f1", name: "answer_permission", arguments: JSON.stringify({ item_id: item.id, decision: "allow" }), sessionId: "a", item: { kind: "approval", title: "npm publish", folder: undefined, agentName: undefined }, ok: true },
    ]);
  });
});

describe("scripted demo", () => {
  test("runs end to end: five sessions, the fifth folds one, actions on the end card", () => {
    const start = demoAt(0);
    expect(start.call.phase).toBe("connecting");
    expect(boardView(start.board, start.call, start.now).lanes).toHaveLength(4);

    const typing = demoAt(14.2);
    const typingView = boardView(typing.board, typing.call, typing.now);
    expect(typingView.lanes.find((l) => l.sessionId === "bill")?.status.word).toBe("Pew typing");
    expect(typingView.spotlight).toBe("bill");
    expect(typingView.sending).toBe("bill");

    const fifth = demoAt(40.6);
    const fifthView = boardView(fifth.board, fifth.call, fifth.now);
    expect(fifthView.lanes.map((l) => l.sessionId)).toContain("land");
    expect(fifthView.fold?.count).toBe(1);
    expect(fifth.board.slots.filter(Boolean)).toHaveLength(4);

    const end = demoAt(DEMO_DURATION_S);
    expect(end.call.phase).toBe("ended");
    const actions = callActions(end.call.completed, end.board.sessions);
    expect(actions.map((a) => a.text)).toContain("Approved prisma migrate deploy");
    expect(actions.some((a) => a.later)).toBe(true);
  });

  test("lanes never move once placed during the demo", () => {
    const positions = new Map<string, number>();
    for (let t = 0; t <= DEMO_DURATION_S; t += 0.5) {
      const { board } = demoAt(t);
      board.slots.forEach((id, slot) => {
        if (!id) return;
        const was = positions.get(id);
        if (was !== undefined) expect(slot).toBe(was);
        positions.set(id, slot);
      });
    }
  });
});

describe("one thing at a time", () => {
  const tool = (text: string, at: number) => ({ kind: "tool" as const, text, at });
  type Line = { kind: "tool" | "pew"; text: string; at: number };
  const seenAt = (id: string, stamps: [Line, number][]) => Object.fromEntries(stamps.map(([line, at]) => [lineKey(id, line), at]));

  test("a burst of tools holds each shown line for the dwell, then jumps to the newest", () => {
    const a = tool("Read a.ts", 1);
    const b = tool("Read b.ts", 2);
    const c = tool("Read c.ts", 3);
    const d = tool("Edit d.ts", 4);
    const session = { sessionId: "s", status: "working" as const, lines: [a, b, c, d] };
    // a at T0, then b, c, d 100ms apart: far faster than anyone reads.
    const seen = seenAt("s", [[a, T0], [b, T0 + 100], [c, T0 + 200], [d, T0 + 300]]);
    expect(currentLine(session, seen, T0 + 50)?.line).toBe(a);
    expect(currentLine(session, seen, T0 + DWELL_MS - 1)?.line).toBe(a);
    // When a's dwell ends, everything has arrived: skip b and c, show d.
    const next = currentLine(session, seen, T0 + DWELL_MS);
    expect(next?.line).toBe(d);
    expect(next?.at).toBe(T0 + DWELL_MS);
  });

  test("Pew's own message cuts in at once, then holds while it types", () => {
    const a = tool("Run npm test", 1);
    const pew = { kind: "pew" as const, text: "Keep v1 for a month.", at: 2 };
    const after = tool("Edit routes.ts", 3);
    const session = { sessionId: "s", status: "working" as const, lines: [a, pew, after] };
    const seen = seenAt("s", [[a, T0], [pew, T0 + 200], [after, T0 + 300]]);
    expect(currentLine(session, seen, T0 + 250)?.line).toBe(pew);
    // Still Pew's line well past a plain dwell: typing plus a beat to read it.
    expect(currentLine(session, seen, T0 + 200 + DWELL_MS + 100)?.line).toBe(pew);
    expect(currentLine(session, seen, T0 + 200 + 5000)?.line).toBe(after);
  });

  test("a waiting session pins the line that says why, whatever came after", () => {
    const perm = { kind: "perm" as const, text: "prisma migrate deploy", at: 1 };
    const later = { kind: "text" as const, text: "Waiting for approval…", at: 2 };
    const session = { sessionId: "s", status: "needs" as const, lines: [perm, later] };
    expect(currentLine(session, {}, T0)?.line).toBe(perm);
  });

  test("steps count tools that arrive during the call, not history", () => {
    const history = [tool("old 1", 1), tool("old 2", 2)];
    const live = [...history, tool("new 1", 3), { kind: "text" as const, text: "thinking", at: 4 }, tool("new 2", 5)];
    const state = fold([[sess("a", { lines: history })], [sess("a", { lines: live })]]);
    expect(boardView(state, noCall, T0 + 1500).lanes[0]?.steps).toBe(2);
  });

  test("a new line types out from when it takes the lane, not when it arrived", () => {
    const first = tool("Read a.ts", 1);
    const second = tool("Edit a really long file name that takes a moment to type.ts", 2);
    const state = fold([[sess("a")], [sess("a", { lines: [first] })], [sess("a", { lines: [first, second] })]]);
    // first arrives at T0+1000, second at T0+2000 (after first's dwell would end at T0+2100).
    const takeover = T0 + 1000 + DWELL_MS;
    const lane = boardView(state, noCall, takeover + 1).lanes[0];
    expect(lane?.current?.text).toBe(second.text);
    expect(lane?.current?.typing).toBe(true);
    expect(lane?.current?.fresh).toBe(true);
  });
});

describe("when the board shows", () => {
  test("Pew alone until it touches a session, something waits, or a tool reaches into sessions", async () => {
    const { boardEngaged } = await import("./voiceBoard");
    const quiet = fold([[sess("a")]]);
    expect(boardEngaged(quiet, noCall)).toBe(false);
    expect(boardEngaged(fold([[sess("a", { touchedAt: 5 })]]), noCall)).toBe(true);
    const waiting = { ...noCall, inbox: [{ id: "a:question:r", sessionId: "a", kind: "question" as const, requestId: "r", title: "?", since: 1 }] };
    expect(boardEngaged(quiet, waiting)).toBe(true);
    const telling = { ...noCall, tools: [{ toolCallId: "t", name: "tell_agent", arguments: JSON.stringify({ session_id: "a", text: "hi" }), requestId: "q" }] };
    expect(boardEngaged(quiet, telling)).toBe(true);
    const surveying = { ...noCall, tools: [{ toolCallId: "t", name: "get_status", arguments: "{}", requestId: "q" }] };
    expect(boardEngaged(quiet, surveying)).toBe(true);
    // Surveying an empty machine has nothing to show.
    expect(boardEngaged(fold([]), surveying)).toBe(false);
  });
});

describe("caption pages", () => {
  test("pages are packed from the front at sentence ends, and never move as the line grows", async () => {
    const { captionPageStarts } = await import("./voiceBoard");
    const line = "First sentence is here. Second one follows it. Third one ends now.";
    const starts = captionPageStarts(line, 30);
    expect(starts[0]).toBe(0);
    for (const at of starts.slice(1)) expect(line[at - 1]).toBe(" ");
    // Growing the line only appends pages.
    let previous: number[] = [];
    for (let n = 1; n <= line.length; n++) {
      const now = captionPageStarts(line.slice(0, n), 30);
      expect(now.slice(0, previous.length)).toEqual(previous.slice(0, Math.min(previous.length, now.length)));
      previous = now;
    }
  });

  test("the page shown is the one holding what has been said so far", async () => {
    const { captionPageAt } = await import("./voiceBoard");
    const line = "First sentence is here. Second one follows it. Third one ends now.";
    expect(captionPageAt(line, 30, 5).text).toBe("First sentence is here.");
    expect(captionPageAt(line, 30, 30).text).toBe("Second one follows it.");
    expect(captionPageAt(line, 30, line.length).text).toBe("Third one ends now.");
    expect(captionPageAt("Sent.", 30, 5)).toEqual({ text: "Sent.", start: 0 });
  });

  test("a sentence longer than a page splits at words", async () => {
    const { captionPageStarts } = await import("./voiceBoard");
    const long = "one two three four five six seven eight nine ten eleven twelve thirteen";
    const starts = captionPageStarts(long, 20);
    expect(starts.length).toBeGreaterThan(2);
    for (let i = 0; i < starts.length; i++) {
      const end = starts[i + 1] ?? long.length;
      expect(long.slice(starts[i], end).trimEnd().length).toBeLessThanOrEqual(20);
    }
  });
});

describe("in time with Pew's voice", () => {
  test("words are revealed at Pew's pace from when its audio starts", async () => {
    const { spokenLength, SPEECH_CPS } = await import("./voiceBoard");
    const line = "Hey, it's Pew. Your agents are busy.";
    expect(spokenLength(line, 0, SPEECH_CPS)).toBe(0);
    expect(spokenLength(line, 1000, SPEECH_CPS)).toBe(SPEECH_CPS);
    expect(spokenLength(line, 60_000, SPEECH_CPS)).toBe(line.length);
  });

  test("the pace is learned from finished lines, within a human range", async () => {
    const { learnSpeechRate, SPEECH_CPS } = await import("./voiceBoard");
    // 40 chars in 2 s = 20 cps: halfway there.
    expect(learnSpeechRate(SPEECH_CPS, 40, 2000)).toBe((SPEECH_CPS + 20) / 2);
    // A one-word line teaches nothing.
    expect(learnSpeechRate(SPEECH_CPS, 5, 400)).toBe(SPEECH_CPS);
    // An absurd reading is clamped.
    expect(learnSpeechRate(SPEECH_CPS, 400, 1000)).toBe((SPEECH_CPS + 26) / 2);
  });
});

describe("tool floats: what Pew is up to, in its own words", () => {
  const sessions = [{ sessionId: "s1", folder: "storefront" }];
  test("names the project a tool targets, and never reads like a status", () => {
    expect(toolFloat("tell_agent", JSON.stringify({ session_id: "s1", text: "x" }), sessions, [])).toBe("Passing storefront a note");
    expect(toolFloat("get_status", JSON.stringify({ session_id: "s1" }), sessions, [])).toBe("Peeking at storefront");
    expect(toolFloat("get_status", "{}", sessions, [])).toBe("Peeking at the crew");
    expect(toolFloat("open_chat", JSON.stringify({ project: "billing-api" }), sessions, [])).toBe("Knocking on billing-api");
    expect(toolFloat("answer_permission", JSON.stringify({ decision: "deny" }), sessions, [])).toBe("Waving it off");
    expect(toolFloat("something_new", "not json", sessions, [])).toBe("Rummaging");
  });
  test("a long project name is clipped so the word stays one line", () => {
    const text = toolFloat("start_chat", JSON.stringify({ project: "a-really-very-long-project-name" }), sessions, []);
    expect(text.length).toBeLessThanOrEqual(26);
  });
});

describe("caption pages fit two lines", () => {
  test("narrower screens and bigger type hold fewer characters", () => {
    expect(pageChars(360, 20)).toBe(61);
    expect(pageChars(274, 17)).toBe(54);
    expect(pageChars(300, 20)).toBeLessThan(pageChars(360, 20));
  });
});

describe("waiting on you reads the same everywhere, with how long", () => {
  test("nothing under a minute, then minutes, then hours", () => {
    expect(waitedFor(30_000)).toBeUndefined();
    expect(waitedFor(12 * 60_000 + 5_000)).toBe("12m");
    expect(waitedFor(125 * 60_000)).toBe("2h");
  });
});
