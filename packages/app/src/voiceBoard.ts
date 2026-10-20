/**
 * Pew's call screen ("Mission control"), as pure state.
 *
 * The daemon sends `voice.board` frames during a call: every session worth
 * showing, most relevant first, full list each time. This module folds them
 * into four *stable* lanes (a newcomer takes the slot of the lane Pew touched
 * least recently, in place, so nothing reshuffles), the "+N" fold chip for the
 * rest, the spotlight lane, the status overlay while Pew acts on a session,
 * the type-out clock for new feed lines, the end card's action list and the
 * caption's word clock. An older daemon sends no board: lanes are then built
 * from `voice.inbox`.
 *
 * Nothing here touches React, a timer or Expo: every function takes `now`.
 * See CLAUDE.md "Pure modules stay Expo-free".
 */
import { plainText, type wire } from "@pew2/protocol";
import { toolTarget, type CallCaption, type CallState, type CompletedTool, type VoiceInboxItem } from "./voiceCall";
import type { PewMood } from "./pew/engineBody";

export type BoardLine = wire.VoiceBoardLine;
export type BoardSession = wire.VoiceBoardSession;
export type BoardStatus = BoardSession["status"];

/** Lanes on screen at most. */
export const LANE_COUNT = 4;
/** Pew's own lines type out at this pace… */
export const PEW_TYPE_MS_PER_CHAR = 30;
/** …for at most this long. */
export const PEW_TYPE_MAX_MS = 2000;
/** Everything else an agent does types out quickly. */
export const LINE_TYPE_MS_PER_CHAR = 10;
export const LINE_TYPE_MAX_MS = 350;
/** A new line's background flash. */
export const FRESH_MS = 700;
/** A finished session's Pew smiles this long. */
export const DONE_HAPPY_MS = 1600;
/** Caption words light at about this pace (spoken English is ~150 wpm). */
/**
 * The least time a lane holds one activity before the next replaces it. An
 * agent can run a dozen tools a second; showing each would be a strobe. The
 * lane shows one thing, keeps it readable for this long, then jumps straight
 * to the newest (skipping what came between, which the step count still counts).
 */
export const DWELL_MS = 1100;
/** Pew's own messages stay a little longer than that once typed: they are what the user just said. */
export const PEW_DWELL_EXTRA_MS = 900;

export interface BoardState {
  /** True once a `voice.board` arrived; inbox frames are then ignored. */
  fromBoard: boolean;
  sessions: BoardSession[];
  /** Session id per lane; undefined is an empty lane. Always `LANE_COUNT` long. */
  slots: (string | undefined)[];
  /** Line key → when the phone first saw it (0: there before the screen was). */
  seen: Record<string, number>;
  /** Folded session ids, most recently folded last. */
  folded: string[];
  /** Tool steps each session started since the call opened (absent: none counted yet). */
  steps?: Record<string, number>;
}

export const IDLE_BOARD: BoardState = {
  fromBoard: false,
  sessions: [],
  slots: Array.from({ length: LANE_COUNT }, () => undefined),
  seen: {},
  folded: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const STATUSES: readonly BoardStatus[] = ["working", "asks", "needs", "done", "idle"];
const LINE_KINDS: readonly BoardLine["kind"][] = ["text", "tool", "result", "ask", "perm", "pew", "note"];

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Reads a board loosely: a newer peer may add fields, a bad entry is dropped, not fatal. */
export function readBoardSessions(value: unknown): BoardSession[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: BoardSession[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.sessionId !== "string" || ids.has(entry.sessionId)) continue;
    const status = STATUSES.find((s) => s === entry.status) ?? "idle";
    const lines: BoardLine[] = [];
    if (Array.isArray(entry.lines)) {
      for (const line of entry.lines) {
        if (!isRecord(line) || typeof line.text !== "string") continue;
        const kind = LINE_KINDS.find((k) => k === line.kind);
        // Plain text: an agent's markdown shows raw on a lane otherwise (an older daemon sends it as is).
        const text = plainText(line.text).replace(/\s+/g, " ").trim();
        if (kind && text) lines.push({ kind, text, at: int(line.at) });
      }
    }
    ids.add(entry.sessionId);
    out.push({
      sessionId: entry.sessionId,
      providerId: typeof entry.providerId === "string" ? entry.providerId : undefined,
      folder: typeof entry.folder === "string" ? entry.folder : undefined,
      agentName: typeof entry.agentName === "string" ? entry.agentName : undefined,
      status,
      since: int(entry.since),
      touchedAt: int(entry.touchedAt),
      lines: lines.slice(-12),
    });
  }
  return out;
}

/** Lanes for an older daemon: one per session with something waiting, from the inbox. */
export function sessionsFromInbox(items: readonly VoiceInboxItem[]): BoardSession[] {
  const bySession = new Map<string, BoardSession>();
  for (const item of items) {
    const line: BoardLine = { kind: item.kind === "approval" ? "perm" : "ask", text: item.title, at: item.since };
    const status: BoardStatus = item.kind === "approval" ? "needs" : "asks";
    const known = bySession.get(item.sessionId);
    if (known) {
      known.lines.push(line);
      known.since = Math.min(known.since, item.since);
      continue;
    }
    bySession.set(item.sessionId, {
      sessionId: item.sessionId,
      folder: item.folder,
      agentName: item.agentName,
      status,
      since: item.since,
      touchedAt: 0,
      lines: [line],
    });
  }
  return [...bySession.values()];
}

/** The key a line is remembered by: stable across frames, unique within a session. */
export function lineKey(sessionId: string, line: BoardLine): string {
  return `${sessionId}|${line.at}|${line.kind}|${line.text}`;
}

/** How recently Pew or the user had business with a session: touched, or started waiting. */
export function recency(session: BoardSession): number {
  const waiting = session.status === "asks" || session.status === "needs" ? session.since : 0;
  return Math.max(session.touchedAt, waiting);
}

/**
 * Place this frame's sessions into the lanes. Kept ones stay put; a gone one
 * frees its lane; free lanes fill in board order; then a session that is new
 * to the call, or more recent than the stalest lane, takes that stalest lane
 * in place. A lane only ever loses to something more recent than itself, so
 * two sessions can never trade one slot back and forth.
 */
export function placeLanes(
  slots: readonly (string | undefined)[],
  sessions: readonly BoardSession[],
  isNew: (id: string) => boolean,
): { slots: (string | undefined)[]; evicted: string[] } {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const next = Array.from({ length: LANE_COUNT }, (_, i) => {
    const id = slots[i];
    return id !== undefined && byId.has(id) ? id : undefined;
  });
  const evicted: string[] = [];
  const placed = new Set(next.filter((id): id is string => id !== undefined));
  for (const session of sessions) {
    if (placed.has(session.sessionId)) continue;
    const free = next.indexOf(undefined);
    if (free >= 0) {
      next[free] = session.sessionId;
      placed.add(session.sessionId);
      continue;
    }
    // Stalest lane: lowest recency, then the later lane, so ties are deterministic.
    let stale = -1;
    let staleAt = Number.POSITIVE_INFINITY;
    next.forEach((id, i) => {
      const lane = id === undefined ? undefined : byId.get(id);
      const at = lane ? recency(lane) : Number.NEGATIVE_INFINITY;
      if (at <= staleAt) {
        stale = i;
        staleAt = at;
      }
    });
    const mine = recency(session);
    if (stale < 0 || !(mine > staleAt || (isNew(session.sessionId) && mine >= staleAt))) continue;
    const out = next[stale];
    if (out !== undefined) {
      evicted.push(out);
      placed.delete(out);
    }
    next[stale] = session.sessionId;
    placed.add(session.sessionId);
  }
  return { slots: next, evicted };
}

function foldSessions(state: BoardState, sessions: BoardSession[], now: number, fromBoard: boolean): BoardState {
  // The first frame (or the first real board after inbox-built lanes) is history: nothing types out or evicts.
  const first = (fromBoard && !state.fromBoard) || (state.sessions.length === 0 && state.slots.every((id) => id === undefined));
  const known = new Set(state.sessions.map((s) => s.sessionId));
  const { slots, evicted } = placeLanes(state.slots, sessions, (id) => !first && !known.has(id));
  const seen: Record<string, number> = {};
  const steps: Record<string, number> = { ...state.steps };
  for (const session of sessions) {
    for (const line of session.lines) {
      const key = lineKey(session.sessionId, line);
      const known = state.seen[key];
      seen[key] = known ?? (first ? 0 : now);
      if (known === undefined && !first && line.kind === "tool") steps[session.sessionId] = (steps[session.sessionId] ?? 0) + 1;
    }
  }
  const present = new Set(sessions.map((s) => s.sessionId));
  const onScreen = new Set(slots);
  const folded = [...state.folded.filter((id) => !evicted.includes(id)), ...evicted].filter(
    (id) => present.has(id) && !onScreen.has(id),
  );
  // Anything off screen that never held a lane folds too, in board order, before the evicted.
  // Reverse board order, so the most relevant of them is the one the chip names.
  const never = sessions.filter((s) => !onScreen.has(s.sessionId) && !folded.includes(s.sessionId)).map((s) => s.sessionId);
  folded.unshift(...never.reverse());
  return { fromBoard, sessions, slots, seen, folded, steps };
}

/** Fold one daemon frame (`voice.board`, or `voice.inbox` until a board arrives). */
export function foldBoard(state: BoardState, message: unknown, now: number): BoardState {
  if (!isRecord(message)) return state;
  if (message.t === "voice.board") {
    const sessions = readBoardSessions(message.sessions);
    return sessions ? foldSessions(state, sessions, now, true) : state;
  }
  if (message.t === "voice.inbox" && !state.fromBoard && Array.isArray(message.items)) {
    const items = message.items.filter(
      (i): i is VoiceInboxItem =>
        isRecord(i) && typeof i.id === "string" && typeof i.sessionId === "string" && typeof i.title === "string" &&
        (i.kind === "approval" || i.kind === "question" || i.kind === "plan"),
    );
    return foldSessions(state, sessionsFromInbox(items), now, false);
  }
  return state;
}

/** A fresh board for a new call, seeded from the inbox in hand (all lines already "seen"). */
export function boardFromInbox(items: readonly VoiceInboxItem[]): BoardState {
  return foldSessions(IDLE_BOARD, sessionsFromInbox(items), 0, false);
}

// ── View ──────────────────────────────────────────────────

export type StatusTone = "agent" | "attention" | "success" | "pew" | "dim";
export interface StatusView {
  /** Short on purpose: an LED word that never wraps. */
  word: string;
  tone: StatusTone;
  pulse: boolean;
}

export type SessionMood = "idle" | "thinking" | "working" | "happy" | "sleepy";

export interface LineView {
  key: string;
  kind: BoardLine["kind"];
  text: string;
  /** The part typed so far. */
  shown: string;
  typing: boolean;
  fresh: boolean;
}

export interface LaneView {
  sessionId: string;
  slot: number;
  providerId?: string;
  folder: string;
  agentName: string;
  status: StatusView;
  mood: SessionMood;
  spotlight: boolean;
  /** The one thing this session is doing, held for `DWELL_MS` before the next replaces it. */
  current?: LineView;
  /** Tool steps since the call opened: proof of progress that never adds a row. */
  steps: number;
}

export interface FoldView {
  count: number;
  folder: string;
  status: StatusView;
}

export interface BoardView {
  lanes: LaneView[];
  spotlight?: string;
  fold?: FoldView;
  /** The session packets fly to: an in-flight tool's target, on screen. */
  sending?: string;
  /** Sessions waiting on the user (asks / needs), across the whole board. */
  waiting: number;
}

/** How long a new line takes to type out. */
export function typeDuration(line: Pick<BoardLine, "kind" | "text">): number {
  return line.kind === "pew"
    ? Math.min(line.text.length * PEW_TYPE_MS_PER_CHAR, PEW_TYPE_MAX_MS)
    : Math.min(line.text.length * LINE_TYPE_MS_PER_CHAR, LINE_TYPE_MAX_MS);
}

/** A line as it looks `now`, given when the phone first saw it. */
export function lineView(key: string, line: BoardLine, seenAt: number, now: number): LineView {
  const age = seenAt === 0 ? Number.POSITIVE_INFINITY : now - seenAt;
  const dur = typeDuration(line);
  const k = dur <= 0 ? 1 : Math.max(0, Math.min(1, age / dur));
  const typing = k < 1;
  return {
    key,
    kind: line.kind,
    text: line.text,
    shown: typing ? line.text.slice(0, Math.ceil(line.text.length * k)) : line.text,
    typing,
    fresh: age < FRESH_MS,
  };
}

/** How long a line holds the lane once it is showing. */
function dwellOf(line: BoardLine): number {
  return line.kind === "pew" ? Math.max(DWELL_MS, typeDuration(line) + PEW_DWELL_EXTRA_MS) : DWELL_MS;
}

/**
 * The one line a lane shows `now`, and when it took the lane.
 *
 * Replays the lane's arrivals: a line takes over when it has arrived and the
 * line before it has had its dwell (Pew's own message cuts in at once), and
 * then it is always the *newest* arrival that takes over, so a burst collapses
 * to its last step instead of queueing.
 * Lines already there when the screen opened (seen at 0) count as arrived long
 * ago. A session waiting on the user pins the line that says why, until Pew answers it.
 */
export function currentLine(
  session: Pick<BoardSession, "sessionId" | "status" | "lines">,
  seen: Readonly<Record<string, number>>,
  now: number,
): { line: BoardLine; at: number } | undefined {
  const lines = session.lines;
  if (lines.length === 0) return undefined;
  if (session.status === "asks" || session.status === "needs") {
    // Pinned until Pew answers it: a Pew line after the question is the answer going in.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (line.kind === "pew" || line.kind === "note") break;
      if (line.kind === "ask" || line.kind === "perm") return { line, at: seen[lineKey(session.sessionId, line)] ?? 0 };
    }
  }
  const arrival = lines.map((line) => {
    const at = seen[lineKey(session.sessionId, line)] ?? 0;
    return at === 0 ? Number.NEGATIVE_INFINITY : at;
  });
  let cur = -1;
  let curAt = Number.NEGATIVE_INFINITY;
  let i = 0;
  while (i < lines.length) {
    // The earliest moment anything still to come can take over: Pew's own
    // message cuts in at once (it is what the user just said); anything else
    // waits out the current line's dwell.
    let ready = Number.POSITIVE_INFINITY;
    for (let k = i; k < lines.length; k++) {
      const at = cur < 0 || lines[k]!.kind === "pew" ? arrival[k]! : Math.max(arrival[k]!, curAt + dwellOf(lines[cur]!));
      if (at < ready) ready = at;
    }
    if (ready > now) break;
    let j = i;
    while (j + 1 < lines.length && arrival[j + 1]! <= ready) j++;
    cur = j;
    curAt = ready;
    i = j + 1;
  }
  if (cur < 0) return undefined;
  return { line: lines[cur]!, at: Number.isFinite(curAt) ? curAt : 0 };
}

const BASE_STATUS: Record<BoardStatus, StatusView> = {
  working: { word: "Working", tone: "agent", pulse: true },
  // One word for waiting on the user, as home's cards say it; the lane's
  // line says what it is (the question, or the command to approve).
  asks: { word: "Needs you", tone: "attention", pulse: false },
  needs: { word: "Needs you", tone: "attention", pulse: false },
  done: { word: "Done", tone: "success", pulse: false },
  idle: { word: "Idle", tone: "dim", pulse: false },
};

/** In-flight tools of this call, with the session each targets. */
export function toolTargets(call: Pick<CallState, "tools" | "inbox">): string[] {
  const out: string[] = [];
  for (const tool of call.tools) {
    const id = toolTarget(tool.name, tool.arguments, call.inbox);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Whether the lane is showing Pew's message mid-type: the status says so in the same breath. */
function pewTyping(state: BoardState, session: BoardSession, now: number): boolean {
  const shown = currentLine(session, state.seen, now);
  if (shown?.line.kind !== "pew") return false;
  return lineView(lineKey(session.sessionId, shown.line), shown.line, shown.at, now).typing;
}

/** The status word, with Pew's overlay: typing into it, or a tool on it. */
export function statusOf(state: BoardState, session: BoardSession, targets: readonly string[], now: number): StatusView {
  if (pewTyping(state, session, now)) return { word: "Pew typing", tone: "pew", pulse: true };
  if (targets.includes(session.sessionId)) return { word: "With Pew", tone: "pew", pulse: true };
  const base = BASE_STATUS[session.status];
  if (session.status !== "asks" && session.status !== "needs") return base;
  const waited = waitedFor(now - session.since);
  return waited ? { ...base, word: `${base.word} · ${waited}` } : base;
}

/** How long something has waited, as a lane says it: nothing under a minute, then "12m", "2h". */
export function waitedFor(ms: number): string | undefined {
  if (!(ms >= 60_000)) return undefined;
  const minutes = Math.floor(ms / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

function moodOf(session: BoardSession, status: StatusView, now: number): SessionMood {
  if (status.tone === "pew") return "thinking";
  switch (session.status) {
    case "working":
      return "working";
    case "asks":
    case "needs":
      return "thinking";
    case "done":
      return now - session.since < DONE_HAPPY_MS ? "happy" : "idle";
    default:
      return "sleepy";
  }
}

/** The session a focus item belongs to: the inbox knows; the id's own prefix is the fallback. */
function focusSession(call: Pick<CallState, "focus" | "inbox">): string | undefined {
  if (!call.focus) return undefined;
  return call.inbox?.find((item) => item.id === call.focus)?.sessionId ?? call.focus.split(":")[0];
}

/**
 * Which lane is open: the session of an in-flight voice tool, else the one
 * Pew touched most recently, else the session of the call's focus item.
 */
export function spotlightOf(state: BoardState, call: Pick<CallState, "tools" | "inbox" | "focus">): string | undefined {
  const lanes = new Set(state.slots.filter((id): id is string => id !== undefined));
  const tool = toolTargets(call).find((id) => lanes.has(id));
  if (tool) return tool;
  let best: BoardSession | undefined;
  for (const s of state.sessions) {
    if (!lanes.has(s.sessionId) || s.touchedAt <= 0) continue;
    if (!best || s.touchedAt > best.touchedAt) best = s;
  }
  if (best) return best.sessionId;
  const focus = focusSession(call);
  return focus && lanes.has(focus) ? focus : undefined;
}

/** Everything the screen draws from the board, `now`. */
export function boardView(
  state: BoardState,
  call: Pick<CallState, "tools" | "inbox" | "focus">,
  now: number,
): BoardView {
  const targets = toolTargets(call);
  const spotlight = spotlightOf(state, call);
  const byId = new Map(state.sessions.map((s) => [s.sessionId, s]));
  const lanes: LaneView[] = [];
  state.slots.forEach((id, slot) => {
    const session = id === undefined ? undefined : byId.get(id);
    if (!session) return;
    const status = statusOf(state, session, targets, now);
    const shown = currentLine(session, state.seen, now);
    lanes.push({
      sessionId: session.sessionId,
      slot,
      providerId: session.providerId,
      folder: session.folder || "Session",
      agentName: session.agentName || "Agent",
      status,
      mood: moodOf(session, status, now),
      spotlight: session.sessionId === spotlight,
      // Typing and the fresh flash start when the line takes the lane, not when it arrived.
      current: shown ? lineView(lineKey(session.sessionId, shown.line), shown.line, shown.at, now) : undefined,
      steps: state.steps?.[session.sessionId] ?? 0,
    });
  });
  const foldedId = state.folded[state.folded.length - 1];
  const foldedSession = foldedId === undefined ? undefined : byId.get(foldedId);
  const fold: FoldView | undefined =
    foldedSession && state.folded.length > 0
      ? { count: state.folded.length, folder: foldedSession.folder || "Session", status: statusOf(state, foldedSession, targets, now) }
      : undefined;
  const sending = targets.find((id) => state.slots.includes(id));
  const waiting = state.sessions.filter((s) => s.status === "asks" || s.status === "needs").length;
  return { lanes, spotlight, fold, sending, waiting };
}

// ── End card ──────────────────────────────────────────────

export interface CallAction {
  text: string;
  /** "folder · agent", when known. */
  detail?: string;
  /** Parked for later, not done. */
  later: boolean;
}

function args(tool: Pick<CompletedTool, "arguments">): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(tool.arguments);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function clip(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** What this call did, from its finished tools, for the end card. Failed ones are left out. */
export function callActions(completed: readonly CompletedTool[], sessions: readonly BoardSession[]): CallAction[] {
  const out: CallAction[] = [];
  for (const tool of completed) {
    if (!tool.ok) continue;
    const a = args(tool);
    const title = tool.item?.title ? clip(tool.item.title) : undefined;
    let text: string | undefined;
    let later = false;
    switch (tool.name) {
      case "answer_permission":
        text = a.decision === "deny" ? `Denied ${title ?? "a request"}` : `Approved ${title ?? "a request"}`;
        break;
      case "answer_question":
        text = a.cancel === true ? "Cancelled a question" : `Answered: ${title ?? "a question"}`;
        break;
      case "decide_plan":
        text = a.action === "reject" ? "Rejected the plan" : a.action === "feedback" ? "Sent feedback on the plan" : "Accepted the plan";
        break;
      case "tell_agent":
        text = typeof a.text === "string" && a.text.trim() ? `Sent: “${clip(a.text, 48)}”` : "Sent a message";
        break;
      case "call_me_back":
        text = typeof a.minutes === "number" ? `Pew calls back in ${a.minutes} min` : "Pew calls back later";
        later = true;
        break;
      case "open_chat":
        text = typeof a.project === "string" && a.project.trim() ? `Opened ${clip(a.project, 32)}` : "Opened a chat";
        break;
      case "start_chat":
        text = typeof a.project === "string" && a.project.trim() ? `Started ${clip(a.project, 32)}` : "Started a chat";
        break;
      default:
        break;
    }
    if (!text) continue;
    const session = tool.sessionId ? sessions.find((s) => s.sessionId === tool.sessionId) : undefined;
    const folder = session?.folder ?? tool.item?.folder;
    const agent = session?.agentName ?? tool.item?.agentName;
    const detail = [folder, agent].filter(Boolean).join(" · ") || undefined;
    out.push({ text, detail, later });
  }
  return out;
}

// ── Caption and mood ──────────────────────────────────────

export interface CaptionView {
  who: "pew" | "you" | "busy" | "none";
  /** Everything said so far: the screen streams it in, it is never shown ahead. */
  text: string;
  /** One per spoken line: a new key starts a new stream instead of typing over the last. */
  key: string;
  /** Still arriving: stream it. Finished or a status line: show it whole. */
  streaming: boolean;
}

/**
 * What the caption shows: who is speaking and what they have said so far. A
 * status ("Typing to docs…") takes over while Pew is busy and can't talk.
 */
export function captionView(caption: CallCaption | undefined, busy?: string): CaptionView {
  if (busy) return { who: "busy", text: busy, key: `busy:${busy}`, streaming: false };
  if (!caption) return { who: "none", text: "", key: "none", streaming: false };
  return { who: caption.who, text: caption.text.trim(), key: `${caption.who}:${caption.serial}`, streaming: true };
}

export type VoiceMood = PewMood;

/** How long Pew celebrates after doing something. */
export const HAPPY_MS = 1400;

/** Tools that read sessions rather than change them. */
const READING_TOOLS = new Set(["get_status", "list_waiting"]);

/**
 * Pew's face on the call, from what is happening right now. In order: how
 * the call stands (ringing, failed, over), what Pew is doing to a session
 * (typing to it, reading it, answering it), a moment of celebration after
 * it did something, then the conversation (muted, hearing you, talking).
 */
export function voiceMood(
  call: Pick<CallState, "phase" | "activity" | "tools"> & Partial<Pick<CallState, "muted" | "userSpeaking">>,
  now: number,
  lastActionAt: number,
): VoiceMood {
  if (call.phase === "failed") return "oops";
  if (call.phase === "ended") return "goodbye";
  if (call.phase === "connecting" || call.phase === "idle") return "dialing";
  const tool = call.tools[0];
  if (tool) {
    if (tool.name === "tell_agent") return "typing";
    if (READING_TOOLS.has(tool.name)) return "reading";
    if (tool.name === "end_call" || tool.name === "call_me_back") return "goodbye";
    return "working";
  }
  if (lastActionAt > 0 && now - lastActionAt < HAPPY_MS) return "celebrate";
  if (call.phase === "ending") return "goodbye";
  if (call.activity === "speaking") return "talking";
  if (call.muted) return "muted";
  if (call.userSpeaking) return "listening";
  return "idle";
}

/** "Calling Pew…", "Looking at storefront…": the caption while Pew can't talk. */
export function busyLine(call: Pick<CallState, "phase" | "tools" | "inbox">, sessions: readonly BoardSession[]): string | undefined {
  if (call.phase === "connecting") return "Calling Pew…";
  const tool = call.tools[0];
  if (!tool) return undefined;
  // The same words as the floats above Pew (`toolFloat`): one voice for
  // what Pew is doing, wherever it shows.
  return `${toolFloat(tool.name, tool.arguments, sessions, call.inbox)}…`;
}

/**
 * What Pew is up to, as a little word that floats off its head while a tool
 * runs (`ToolFloats`): in Pew's own voice, never a status like "Checking
 * agent". Short enough for one line; a project name is clipped.
 */
export function toolFloat(
  name: string,
  rawArgs: string,
  sessions: readonly Pick<BoardSession, "sessionId" | "folder">[],
  inbox: readonly VoiceInboxItem[] | undefined,
): string {
  const a = args({ arguments: rawArgs });
  const id = toolTarget(name, rawArgs, inbox);
  const named = (value: unknown) => (typeof value === "string" && value.trim() ? clip(value.trim(), 18) : undefined);
  const folder = named((id && sessions.find((s) => s.sessionId === id)?.folder) || undefined) ?? named(a.project);
  switch (name) {
    case "tell_agent":
      return folder ? `Passing ${folder} a note` : "Passing a note";
    case "get_status":
      return id || folder ? `Peeking at ${folder ?? "it"}` : "Peeking at the crew";
    case "list_waiting":
      return "Sniffing the inbox";
    case "answer_permission":
      return a.decision === "deny" ? "Waving it off" : "Stamping it";
    case "answer_question":
      return "Whispering back";
    case "decide_plan":
      return "Weighing the plan";
    case "call_me_back":
      return "Setting an alarm";
    case "set_ring":
      return a.on === false ? "Hushing the bell" : "Tuning the bell";
    case "open_chat":
      return folder ? `Knocking on ${folder}` : "Knocking";
    case "start_chat":
      return folder ? `Waking ${folder}` : "Waking an agent";
    case "end_call":
      return "Waving bye";
    default:
      return "Rummaging";
  }
}

/** Tools that look across sessions: running one is working with them, whichever. */
const SURVEY_TOOLS = new Set(["get_status", "list_waiting"]);

/**
 * Whether Pew is working with sessions yet: the call screen opens on Pew alone,
 * big and centred, and moves to the board the first time this is true.
 *
 * True once Pew has touched a session this call (the daemon stamps `touchedAt`,
 * including the focus item's session at the start), when something is waiting
 * on the user (Pew leads with it), or while a tool is reaching into sessions.
 * The screen keeps it once true: a board that came and went with each tool
 * would flicker the whole layout.
 */
export function boardEngaged(board: Pick<BoardState, "sessions">, call: Pick<CallState, "tools" | "inbox">): boolean {
  if (board.sessions.some((s) => s.touchedAt > 0)) return true;
  if ((call.inbox ?? []).length > 0) return true;
  if (toolTargets(call).length > 0) return true;
  return call.tools.some((tool) => SURVEY_TOOLS.has(tool.name)) && board.sessions.length > 0;
}

/**
 * Where each caption page starts in a spoken line: sentences packed from the
 * front, a page at most `maxChars`, a sentence too long for one page split at
 * words. Built from the front, so pages already made never move as the line
 * grows: the last page fills, then a new one begins.
 */
export function captionPageStarts(text: string, maxChars: number): number[] {
  const sentences: number[] = [0];
  const end = /[.!?]["')\]]?\s+/g;
  for (let m = end.exec(text); m; m = end.exec(text)) sentences.push(m.index + m[0].length);
  sentences.push(text.length);
  const starts = [0];
  let pageStart = 0;
  for (let i = 1; i < sentences.length; i++) {
    const sentenceEnd = sentences[i]!;
    if (sentenceEnd - pageStart <= maxChars) continue;
    // This sentence would overflow: start the page at its beginning, unless
    // it is the page's first, which then splits at words.
    const sentenceStart = sentences[i - 1]!;
    if (sentenceStart > pageStart) {
      pageStart = sentenceStart;
      starts.push(pageStart);
    }
    while (sentenceEnd - pageStart > maxChars) {
      const cut = text.lastIndexOf(" ", pageStart + maxChars);
      pageStart = cut > pageStart ? cut + 1 : pageStart + maxChars;
      starts.push(pageStart);
    }
  }
  return starts;
}

/**
 * The caption page that holds position `upTo` of the line: subtitles turning
 * a page at a sentence end, never scrolling or shrinking what is on screen.
 * `text` is the whole page (the screen lays the unrevealed part out unseen,
 * so wraps never move); `start` is where it begins in the line.
 */
export function captionPageAt(text: string, maxChars: number, upTo: number): { text: string; start: number } {
  const starts = captionPageStarts(text, maxChars);
  let index = 0;
  for (let i = 0; i < starts.length; i++) if (starts[i]! < Math.max(1, upTo)) index = i;
  const start = starts[index]!;
  const next = starts[index + 1] ?? text.length;
  return { text: text.slice(start, next).trimEnd(), start };
}

/** Pew's words never take more than two lines: a long line turns pages instead. */
export const CAPTION_LINES = 2;

/**
 * How many characters a page of `CAPTION_LINES` lines holds at this width:
 * the system font averages about half its size per character, and a page is
 * cut short by a sixth so word wrapping never needs a third line.
 */
export function pageChars(width: number, fontSize: number): number {
  const perLine = Math.max(12, Math.floor(width / (fontSize * 0.5)));
  return Math.floor(perLine * CAPTION_LINES * 0.85);
}

/** How fast Pew speaks before a call has taught us, in characters a second. */
export const SPEECH_CPS = 16;

/** How much of Pew's line has been said, `elapsed` ms into its audio. */
export function spokenLength(text: string, elapsedMs: number, cps: number): number {
  return Math.max(0, Math.min(text.length, Math.floor((Math.max(0, elapsedMs) / 1000) * cps)));
}

/**
 * Learn Pew's pace from a line it just finished: its length over how long it
 * played. Half new, half old, within a human range; a line too short to time
 * teaches nothing.
 */
export function learnSpeechRate(previous: number, chars: number, ms: number): number {
  if (ms < 700 || chars < 12) return previous;
  const observed = Math.min(26, Math.max(9, chars / (ms / 1000)));
  return previous * 0.5 + observed * 0.5;
}
