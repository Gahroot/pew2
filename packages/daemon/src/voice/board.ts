/**
 * The live board behind the call screen ("Mission control"): one lane per
 * agent session, with a short feed of what the agent is doing and what Pew
 * typed into it. Pure: the controller supplies the sessions, the clock and the
 * per-call memory, and owns the throttle's timer.
 */
import { plainText, type wire } from "@pew2/protocol";

export type BoardLine = wire.VoiceBoardLine;
export type BoardSession = wire.VoiceBoardSession;
type Status = BoardSession["status"];

/** One live session, as the daemon hands it over. */
export interface BoardSource {
  sessionId: string;
  providerId?: string;
  folder?: string;
  agentName?: string;
  working: boolean;
  permissions?: ReadonlyMap<string, unknown>;
  asks?: ReadonlyMap<string, unknown>;
  plan?: wire.PlanState;
  events: readonly wire.SessionEvent[];
}

/** Per-call live state: Pew's marks and each lane's status clock. Never logged. */
export interface BoardMemory {
  callStartedAt: number;
  touched: Map<string, number>;
  marks: Map<string, BoardLine[]>;
  status: Map<string, { status: Status; since: number }>;
  wasWorking: Map<string, boolean>;
  finishedAt: Map<string, number>;
}

export const MAX_LINES = 12;
export const MAX_LINE_CHARS = 140;
export const MAX_SESSIONS = 8;
/** How far back from the end of a log the feed is read. */
export const SCAN_EVENTS = 400;
/** Lines from before the call kept so a lane is never empty. */
export const PRE_CALL_LINES = 3;
export const RECENT_DONE_MS = 10 * 60_000;
export const THROTTLE_MS = 250;

export function newMemory(callStartedAt: number): BoardMemory {
  return {
    callStartedAt,
    touched: new Map(),
    marks: new Map(),
    status: new Map(),
    wasWorking: new Map(),
    finishedAt: new Map(),
  };
}

/** Single line, whitespace collapsed, capped. */
export function clip(text: string): string {
  // Plain text: a lane shows an agent's words raw, and `**` read as noise.
  const flat = plainText(text).replace(/\s+/g, " ").trim();
  return flat.length > MAX_LINE_CHARS ? `${flat.slice(0, MAX_LINE_CHARS - 1)}…` : flat;
}

/** Record that Pew acted on a session, optionally with a line on its lane. */
export function mark(memory: BoardMemory, sessionId: string, now: number, line?: Omit<BoardLine, "at">): void {
  memory.touched.set(sessionId, now);
  if (!line) return;
  const text = clip(line.text);
  if (!text) return;
  const list = memory.marks.get(sessionId) ?? [];
  list.push({ kind: line.kind, text, at: now });
  memory.marks.set(sessionId, list.slice(-MAX_LINES));
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

function contentText(content: unknown): string {
  if (Array.isArray(content)) return content.map(contentText).join("");
  const block = record(content);
  return block?.type === "text" && typeof block.text === "string"
    ? block.text
    : typeof block?.text === "string" && block.type === undefined
      ? block.text
      : "";
}

const lastNonEmptyLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1) ?? "";

/**
 * The feed, newest last, read from the tail of a session log's ACP payloads.
 * Streamed agent text keeps one `text` line (its latest non-empty line) that
 * updates in place until something else happens.
 */
export function deriveLines(events: readonly wire.SessionEvent[]): BoardLine[] {
  const lines: BoardLine[] = [];
  const titles = new Map<string, string>();
  // Streamed text since the last other line; its line is `lines.at(-1)` once open.
  let prose = "";
  let proseOpen = false;
  const push = (kind: BoardLine["kind"], text: string, at: number) => {
    prose = "";
    proseOpen = false;
    const clipped = clip(text);
    if (clipped) lines.push({ kind, text: clipped, at });
  };
  for (const event of events.slice(-SCAN_EVENTS)) {
    const payload = record(event.payload);
    const update = record(payload?.update);
    const kind = update?.sessionUpdate ?? payload?.kind;
    switch (kind) {
      case "agent_message_chunk": {
        const piece = contentText(update?.content);
        if (!piece) break;
        prose = `${prose}${piece}`.slice(-4000);
        const latest = clip(lastNonEmptyLine(prose));
        if (!latest) break;
        const line = { kind: "text" as const, text: latest, at: event.at };
        if (proseOpen) lines[lines.length - 1] = line;
        else lines.push(line);
        proseOpen = true;
        break;
      }
      case "user_message":
      case "user_message_chunk": {
        prose = "";
        proseOpen = false;
        break;
      }
      case "tool_call": {
        const title = typeof update?.title === "string" ? update.title : "";
        if (typeof update?.toolCallId === "string" && title) titles.set(update.toolCallId, title);
        push("tool", title, event.at);
        break;
      }
      case "tool_call_update": {
        const id = typeof update?.toolCallId === "string" ? update.toolCallId : "";
        const title = (typeof update?.title === "string" && update.title) || titles.get(id) || "";
        if (title && id) titles.set(id, title);
        if (update?.status === "completed") push("result", title, event.at);
        else if (update?.status === "failed") push("result", title ? `Failed: ${title}` : "Failed", event.at);
        break;
      }
      case "permission_request": {
        const toolCall = record(record(payload?.params)?.toolCall);
        push("perm", typeof toolCall?.title === "string" ? toolCall.title : "Permission needed", event.at);
        break;
      }
      case "ask_user": {
        const first = record(Array.isArray(payload?.questions) ? payload.questions[0] : undefined);
        push("ask", typeof first?.question === "string" ? first.question : "Question", event.at);
        break;
      }
      default:
        break;
    }
  }
  return lines;
}

/** The lane's feed: the call's lines, a few from before it, and Pew's marks. */
export function laneLines(derived: readonly BoardLine[], marks: readonly BoardLine[], callStartedAt: number): BoardLine[] {
  const before = derived.filter((line) => line.at < callStartedAt).slice(-PRE_CALL_LINES);
  const during = derived.filter((line) => line.at >= callStartedAt);
  return [...before, ...during, ...marks]
    .map((line, index) => ({ line, index }))
    .sort((a, b) => a.line.at - b.line.at || a.index - b.index)
    .map(({ line }) => line)
    .slice(-MAX_LINES);
}

function statusOf(source: BoardSource, finishedAt: number | undefined, memory: BoardMemory, now: number): Status {
  if ((source.permissions?.size ?? 0) > 0) return "needs";
  if ((source.asks?.size ?? 0) > 0 || source.plan?.pending) return "asks";
  if (source.working) return "working";
  if (finishedAt !== undefined && (finishedAt >= memory.callStartedAt || now - finishedAt < RECENT_DONE_MS)) {
    return "done";
  }
  return "idle";
}

const TIER: Record<Status, number> = { needs: 1, asks: 1, working: 2, done: 3, idle: 4 };

/** Build the board, updating the memory's status clocks. */
export function buildBoard(sources: readonly BoardSource[], memory: BoardMemory, now: number): BoardSession[] {
  const sessions = sources.map((source): BoardSession => {
    const id = source.sessionId;
    const lastAt = source.events.at(-1)?.at;
    if (memory.wasWorking.get(id) === true && !source.working) memory.finishedAt.set(id, now);
    else if (!memory.wasWorking.has(id) && !source.working && lastAt !== undefined) memory.finishedAt.set(id, lastAt);
    memory.wasWorking.set(id, source.working);
    const status = statusOf(source, memory.finishedAt.get(id), memory, now);
    const previous = memory.status.get(id);
    const since =
      previous?.status === status
        ? previous.since
        : previous === undefined && (status === "done" || status === "idle")
          ? Math.min(now, memory.finishedAt.get(id) ?? lastAt ?? now)
          : now;
    memory.status.set(id, { status, since });
    return {
      sessionId: id,
      ...(source.providerId ? { providerId: source.providerId } : {}),
      ...(source.folder ? { folder: source.folder } : {}),
      ...(source.agentName ? { agentName: source.agentName } : {}),
      status,
      since,
      touchedAt: memory.touched.get(id) ?? 0,
      lines: laneLines(deriveLines(source.events), memory.marks.get(id) ?? [], memory.callStartedAt),
    };
  });
  return sessions
    .sort((a, b) => {
      if (a.touchedAt !== b.touchedAt) return b.touchedAt - a.touchedAt;
      if (TIER[a.status] !== TIER[b.status]) return TIER[a.status] - TIER[b.status];
      return b.since - a.since || a.sessionId.localeCompare(b.sessionId);
    })
    .slice(0, MAX_SESSIONS);
}

/** Changes whenever anything the app would draw changes. */
export function boardSignature(sessions: readonly BoardSession[]): string {
  return JSON.stringify(sessions);
}

export interface Timer {
  cancel(): void;
}

/**
 * At most one board per `THROTTLE_MS`, and only when its content changed.
 * `request()` coalesces; `flushNow()` sends at once (the call opening).
 */
export class BoardThrottle {
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private signature = "";
  private timer?: Timer;

  constructor(
    private readonly options: {
      now: () => number;
      setTimer: (fn: () => void, ms: number) => Timer;
      build: () => BoardSession[];
      send: (sessions: BoardSession[]) => void;
    },
  ) {}

  request(): void {
    if (this.timer) return;
    const wait = this.lastSentAt + THROTTLE_MS - this.options.now();
    if (wait <= 0) {
      this.flush();
      return;
    }
    this.timer = this.options.setTimer(() => {
      this.timer = undefined;
      this.flush();
    }, wait);
  }

  flushNow(): void {
    this.cancel();
    this.flush();
  }

  cancel(): void {
    this.timer?.cancel();
    this.timer = undefined;
  }

  private flush(): void {
    const sessions = this.options.build();
    const signature = boardSignature(sessions);
    if (signature === this.signature) return;
    this.signature = signature;
    this.lastSentAt = this.options.now();
    this.options.send(sessions);
  }
}
