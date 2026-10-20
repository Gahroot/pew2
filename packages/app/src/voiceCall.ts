/**
 * A voice call with Pew, as a pure state machine.
 *
 * The daemon mints an ephemeral OpenAI secret (`voice.session`), the phone
 * opens WebRTC straight to OpenAI, and every tool the model calls is run by the
 * daemon (`voice.tool`). This module decides everything about that exchange —
 * the call's phase, what Pew is doing, which function calls are in flight,
 * what to tell the model when the inbox changes mid-call, when to hang up —
 * and returns it as effects for `ui/useVoiceCall.ts` to carry out. Nothing
 * here touches the network, a timer or React, so the whole call is testable
 * under `bun test`. Expo-free: see CLAUDE.md "Pure modules stay Expo-free".
 */
import type { wire } from "@pew2/protocol";
import { optionValue, questionOptions, readAskRequest } from "./askUser";

export type VoiceInboxItem = wire.VoiceInboxItem;
export type VoiceStatus = wire.VoiceStatus;
export type VoiceEndReason = NonNullable<wire.VoiceEnd["reason"]>;

export type CallPhase = "idle" | "connecting" | "live" | "ending" | "ended" | "failed";
/** What Pew is doing, for the orb. */
export type CallActivity = "connecting" | "listening" | "speaking" | "working";

/** One row on the call screen. `done` once it has left the inbox. */
export interface CallItem {
  id: string;
  kind: VoiceInboxItem["kind"];
  title: string;
  folder?: string;
  done: boolean;
}

interface PendingTool {
  toolCallId: string;
  name: string;
  arguments: string;
  requestId: string;
}

/** A tool this call finished, kept for the end card. */
export interface CompletedTool {
  toolCallId: string;
  name: string;
  arguments: string;
  /** The session it acted on, resolved when it finished (the item may leave the inbox after). */
  sessionId?: string;
  /** The inbox item it answered, as it was when the tool finished. */
  item?: Pick<VoiceInboxItem, "kind" | "title" | "folder" | "agentName">;
  /** The daemon's output carried no `error`. */
  ok: boolean;
}

/** Who is talking on the call, word by word. `final` once the whole line is known. */
export interface CallCaption {
  who: "pew" | "you";
  text: string;
  final: boolean;
  /** The realtime response or item id the text belongs to. */
  ref?: string;
  /** Bumped per new caption, so the screen can restart its word clock. */
  serial: number;
}

export interface TranscriptLine {
  role: "user" | "assistant";
  text: string;
}

/** Where on the phone a call was placed from, when no conversation exists yet: the project and agent on screen. */
export interface CallPlace {
  cwd?: string;
  providerId?: string;
}

export interface CallState {
  phase: CallPhase;
  activity: CallActivity;
  /** The `voice.session` request this call was opened with. */
  requestId?: string;
  focus?: string;
  callId?: string;
  /** User-facing, set when `phase` is "failed". */
  error?: string;
  items: CallItem[];
  /** The newest `voice.inbox`, whatever the phase (undefined: none heard). */
  inbox?: VoiceInboxItem[];
  /** Ids the model currently believes are waiting. */
  told: string[];
  /** Items a tool of this call acted on: their leaving is not "handled elsewhere". */
  answeredHere: string[];
  tools: PendingTool[];
  /** Every function call id already dispatched (both events can carry one). */
  seenToolCalls: string[];
  toolCounter: number;
  /** A response is in progress on the server; a second `response.create` would be refused. */
  responding: boolean;
  createQueued: boolean;
  /** The daemon said hang up; waiting for the goodbye to finish playing. */
  hangUpPending: boolean;
  muted: boolean;
  /** Pew's audio is playing. */
  pewAudio: boolean;
  /**
   * The echo guard: the mic is closed while Pew's audio plays (and
   * `ECHO_TAIL_MS` after). Only where nothing cancels echo (the simulator,
   * whose Mac speakers feed Pew's voice straight back, and the server's turn
   * detection then interrupted Pew with itself); there, tapping Pew
   * (`interrupt`) cuts it off. A real iPhone's call audio cancels echo, so the
   * mic stays open and the user talks over Pew to interrupt it.
   */
  echoGuard: boolean;
  /**
   * The call is on the loudspeaker. Pew's voice then comes back into the mic
   * louder than echo cancelling can always remove, and it once answered
   * itself (it heard its own "calling you back" and booked another
   * callback). So on the speaker the mic closes while Pew talks, as with
   * `echoGuard`; a tap still interrupts.
   */
  speaker: boolean;
  /** Within the tail after Pew's audio stopped: still closed. */
  echoTail: boolean;
  /**
   * The first moments of each reply Pew speaks, with the mic open for
   * talking over it (no echo guard): still closed. The phone's echo
   * cancelling adapts to each new stretch of Pew's voice, and until it has,
   * the start of a reply leaked into the mic and read as the user talking:
   * Pew cut itself off a few words in, then started again.
   */
  leadIn: boolean;
  /** The server hears the user speaking right now (its turn detection). */
  userSpeaking: boolean;
  transcript: TranscriptLine[];
  endReason?: VoiceEndReason;
  /** Live captions; undefined before anyone has spoken. */
  caption?: CallCaption;
  /** Tools this call finished, oldest first. */
  completed: CompletedTool[];
  /** What Pew has been told but not yet said: see `pace`. */
  held: HeldNews;
  /**
   * The user has said something this call (or answered a card). Until then
   * Pew may look but not act: it once opened a call by starting a chat and
   * answering the agent's question before a word was spoken.
   */
  heardUser: boolean;
  /**
   * The reply in progress was started by Pew, not by the user: its greeting,
   * or news at a pause. Such a reply has nothing of the user's to act on, so
   * it is sent with no tools (`UNPROMPTED`). With them, the model took the
   * briefing or an agent's question as the request: measured against the
   * real model, it answered an agent's question by itself in 4 of 8 runs and
   * started a chat by itself in 1 of 8 openings (probe-opening.ts).
   */
  unprompted: boolean;
  /** Turns the user has spoken this call (each committed stretch of their audio). */
  userTurns: number;
  /**
   * Approvals Pew has been told to read back, by inbox item id, with the
   * user's turn count at that moment. A voice "yes" is only taken in a later
   * turn: Pew must say exactly what it is about to approve, and hear yes.
   */
  readBack: Record<string, number>;
}

/**
 * News waiting for a pause in the conversation. Something that needs the user
 * is said at the first pause; sessions that merely finished are gathered for
 * `GATHER_MS` and then said together, so three finishing in a minute is one
 * sentence, not three interruptions. A name Pew says meanwhile (the user
 * asked) is dropped, so nothing is told twice.
 */
export interface HeldNews {
  /** New items waiting on the user, named by folder (or title). */
  urgent: { id: string; name: string }[];
  /** Finished sessions, by name ("" when an older daemon sent none). */
  finished: string[];
  /** The gather window for `finished` has run out. */
  gathered: boolean;
  /** The gather timer is armed. */
  gathering: boolean;
  /** The pause timer is armed. */
  pauseArmed: boolean;
}

const NO_NEWS: HeldNews = { urgent: [], finished: [], gathered: false, gathering: false, pauseArmed: false };

export const IDLE_CALL: CallState = {
  phase: "idle",
  activity: "connecting",
  items: [],
  told: [],
  answeredHere: [],
  tools: [],
  seenToolCalls: [],
  toolCounter: 0,
  responding: false,
  createQueued: false,
  hangUpPending: false,
  muted: false,
  pewAudio: false,
  echoGuard: true,
  speaker: false,
  echoTail: false,
  leadIn: false,
  userSpeaking: false,
  transcript: [],
  completed: [],
  held: NO_NEWS,
  heardUser: false,
  unprompted: false,
  userTurns: 0,
  readBack: {},
};

/**
 * Whether the mic should be live: not muted, not within a tail (the connect
 * chime, or Pew just finished behind the echo guard), and, behind the echo
 * guard only, Pew not speaking.
 */
export function micOpen(
  state: Pick<CallState, "muted" | "pewAudio" | "echoTail"> & { echoGuard?: boolean; leadIn?: boolean; speaker?: boolean },
): boolean {
  return !state.muted && !state.echoTail && state.leadIn !== true && (!guarded(state) || !state.pewAudio);
}

/** The mic closes while Pew talks: no echo cancelling here, or the loudspeaker is on. */
function guarded(state: { echoGuard?: boolean; speaker?: boolean }): boolean {
  return state.echoGuard !== false || state.speaker === true;
}

/** Apply the mic rule after a change, emitting the track switch when it flips. */
function gateMic(before: CallState, after: CallState, effects: CallEffect[]): CallState {
  if (micOpen(before) !== micOpen(after)) effects.push({ kind: "mute", muted: !micOpen(after) });
  return after;
}

/** How long the daemon has to answer `voice.session` before the call gives up. */
export const SESSION_TIMEOUT_MS = 15_000;
/** How long a tool may run on the daemon before the model is told it failed. */
export const TOOL_TIMEOUT_MS = 30_000;
/** After a goodbye's response is done, hang up even if no audio-stopped event comes. */
export const HANGUP_GRACE_MS = 8_000;
/**
 * How long the mic stays closed after Pew's audio stops. Playback trails the
 * server's "stopped" by the jitter buffer, and the room rings on a beat after
 * that; a mic opened at once hears Pew's last words and the model takes them
 * as the user's (cut off mid-sentence, then answering itself).
 */
export const ECHO_TAIL_MS = 700;
/** How long the mic stays closed at the start of each reply Pew speaks (see `leadIn`). */
export const LEAD_IN_MS = 1000;
/** Lines kept for `voice.end`; the daemon caps it again. */
export const TRANSCRIPT_MAX_LINES = 60;
const TRANSCRIPT_MAX_CHARS = 500;
/** How long finished sessions are gathered before Pew says them, together. */
export const GATHER_MS = 8_000;
/** Quiet needed (nobody speaking, nothing running) before held news is said. */
export const PAUSE_MS = 900;
/**
 * The inbox item a tool call would approve by voice (allowing an approval,
 * accepting a plan), or undefined. Denying, rejecting or answering a
 * question needs no read-back.
 */
export function approvalNeedingReadBack(name: string, rawArgs: string): string | undefined {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(rawArgs || "{}");
    if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  // A message that asks an agent to do something destructive is read back
  // the same way, whoever thought of it: the one place a planted instruction
  // (in a page an agent read, or an earlier call) could turn into damage.
  // Keyed by the text, so the confirmed message is the one that goes.
  if ((name === "tell_agent" || name === "start_chat") && typeof args.text === "string" && RISKY.test(args.text)) {
    return `send:${args.text.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200)}`;
  }
  const item = typeof args.item_id === "string" && args.item_id ? args.item_id : undefined;
  if (!item) return undefined;
  if (name === "answer_permission" && args.decision === "allow") return item;
  if (name === "decide_plan" && args.action === "accept") return item;
  return undefined;
}

/**
 * Work that can't be taken back: deleting, force-pushing, deploying, wiping.
 * A message asking an agent for it needs their yes after hearing it.
 */
const RISKY =
  /\b(force[\s-]?push|push\s+(--force|-f)|--force|reset\s+--hard|rm\s+-rf|delete|drop\s+(table|database|db)|truncate|destroy|wipe|deploy|publish|release|rollback|revoke|rotate\s+(the\s+)?(key|secret|token)s?)\b/i;

/** What Pew is told when it would send a risky message unheard: say it, then wait for yes. */
export function readBackSendOutput(text: string): string {
  return JSON.stringify({
    ok: false,
    error: "read_back_first",
    say: `Not sent. This can't be undone, so read it back word for word first ("${text.slice(0, 160)}") and ask them to confirm. Send it only after they say yes, and only if they asked for it in this call.`,
  });
}

/** What Pew is told when it approves without a read-back: say it, then wait for yes. */
export function readBackOutput(item: Pick<VoiceInboxItem, "folder" | "title" | "kind"> | undefined): string {
  const what = item ? `${item.folder ? `${item.folder}: ` : ""}${item.kind === "plan" ? "its plan" : item.title}` : "this";
  return JSON.stringify({
    ok: false,
    error: "read_back_first",
    say: `Before approving, read it back in one short line (${what}) and ask them to confirm. Approve only after they say yes.`,
  });
}

/** Tools that only look: allowed before the user has said anything. */
const LOOKING_TOOLS = new Set(["list_waiting", "get_status"]);

/** What Pew is told when it tries to act before the user asked for anything. */
export const NOT_ASKED_OUTPUT = JSON.stringify({
  ok: false,
  error: "not_asked",
  say: "They haven't asked for anything yet. Don't act on any session until they do. Greet them and wait.",
});

/** Tools whose `item_id` names an inbox item this call is answering. */
const ANSWERING_TOOLS = new Set(["answer_permission", "answer_question", "decide_plan"]);

/** Every user-facing failure string, in one place. */
export const CALL_ERRORS = {
  offline: "Your computer isn't connected. Try again when it's back.",
  noAnswer: "Your computer didn't answer. Try again in a moment.",
  oldDaemon: "pew2 on your computer is too old for calls. Update it and try again.",
  microphone: "pew2 needs the microphone for calls. Allow it in Settings → pew2.",
  expired: "The call took too long to connect. Try again.",
  dropped: "The call dropped.",
  busy: "A call is already in progress.",
  generic: "The call couldn't connect. Try again.",
} as const;

/** The user-facing line for a failed `POST /v1/realtime/calls`. */
export function offerErrorMessage(status: number): string {
  if (status === 401 || status === 403) return "OpenAI refused the call's key. Try again.";
  if (status === 429) return "OpenAI is busy or out of quota for calls. Try again in a minute.";
  if (status >= 500) return "OpenAI's voice service is having trouble. Try again shortly.";
  return `Couldn't start the call with OpenAI (${status}).`;
}

export type CallInput =
  | {
      type: "start";
      requestId: string;
      focus?: string;
      sessionId?: string;
      place?: CallPlace;
      /** False where the audio cancels echo, so the user can talk over Pew. Default true. */
      echoGuard?: boolean;
    }
  /** Any daemon frame; the machine picks out the voice ones it is waiting for. */
  | { type: "daemon"; message: unknown }
  /** The `oai-events` data channel opened: the call is live. */
  | { type: "open" }
  /** One realtime server event from the data channel, already JSON-parsed. */
  | { type: "server"; event: unknown }
  /** The transport failed; `error` is user-facing. */
  | { type: "failed"; error: string }
  | { type: "hangup"; reason?: VoiceEndReason }
  | { type: "mute"; muted: boolean }
  /** The user tapped Pew while it was speaking: stop it and listen. */
  | { type: "interrupt" }
  /** The echo tail after Pew's audio ran out: the mic may open. */
  | { type: "echoTail" }
  | { type: "leadIn" }
  | { type: "route"; speaker: boolean }
  /** The link to the computer is back: anything sent while it was down may be lost. */
  | { type: "reconnected" }
  | { type: "timeout"; what: "session" }
  | { type: "timeout"; what: "tool"; toolCallId: string }
  | { type: "timeout"; what: "goodbye" }
  | { type: "timeout"; what: "gather" }
  | { type: "timeout"; what: "pause" }
  /** Back to idle once the ended/failed screen is dismissed. */
  | { type: "reset" }
  /**
   * The user answered an item on the call screen's card instead of by voice.
   * `message` is the ordinary answer frame for the daemon (`session.ask` /
   * `session.permission`); `tell` is the line Pew hears so it moves on.
   */
  | {
      type: "answeredOnScreen";
      itemId: string;
      message: Record<string, unknown> & { t: string };
      tell: string;
      tool: "answer_question" | "answer_permission";
      arguments: Record<string, unknown>;
    };

export type RealtimeEvent = Record<string, unknown> & { type: string };

export type CallEffect =
  | { kind: "daemon"; message: Record<string, unknown> & { t: string } }
  | { kind: "connect"; secret: string; expiresAt?: number }
  | { kind: "realtime"; event: RealtimeEvent }
  | { kind: "timer"; key: string; ms: number; input: CallInput }
  | { kind: "cancelTimer"; key: string }
  | { kind: "mute"; muted: boolean }
  /** Tear down the peer connection and the microphone. */
  | { kind: "close" };

export interface CallStep {
  state: CallState;
  effects: CallEffect[];
}

/** The inbox item id the daemon builds: `${sessionId}:${kind}:${requestId}`. */
export function inboxItemId(sessionId: string, kind: VoiceInboxItem["kind"], requestId: string): string {
  return `${sessionId}:${kind}:${requestId}`;
}

/** Whether a call occupies the phone (a second one must not start). */
export function callActive(state: CallState): boolean {
  return state.phase === "connecting" || state.phase === "live" || state.phase === "ending";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Validates a wire inbox item loosely: older or newer peers may differ in extras. */
export function readInboxItems(value: unknown): VoiceInboxItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: VoiceInboxItem[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { id, sessionId, kind, requestId, title, since } = entry;
    if (typeof id !== "string" || typeof sessionId !== "string" || typeof requestId !== "string") continue;
    if (kind !== "approval" && kind !== "question" && kind !== "plan") continue;
    if (typeof title !== "string") continue;
    items.push({
      id,
      sessionId,
      kind,
      requestId,
      title,
      since: typeof since === "number" ? since : 0,
      folder: str(entry.folder),
      agentName: str(entry.agentName),
      ...cardFields(entry),
    });
  }
  return items;
}

/** The card's data, when a newer daemon sent it and it reads cleanly; otherwise nothing (voice-only). */
function cardFields(entry: Record<string, unknown>): Pick<VoiceInboxItem, "questions" | "options" | "detail"> {
  const out: Pick<VoiceInboxItem, "questions" | "options" | "detail"> = {};
  // The chat's own reader, so the call's card accepts exactly what the chat's sheet does.
  const questions = readAskRequest({ requestId: "card", questions: entry.questions })?.questions;
  if (questions) out.questions = questions;
  if (Array.isArray(entry.options)) {
    const options = entry.options.flatMap((option) => {
      if (!isRecord(option) || typeof option.optionId !== "string" || typeof option.name !== "string") return [];
      return [{ optionId: option.optionId, name: option.name, ...(typeof option.kind === "string" ? { kind: option.kind } : {}) }];
    });
    if (options.length > 0) out.options = options;
  }
  const detail = str(entry.detail);
  if (detail) out.detail = detail;
  return out;
}

function toCallItem(item: VoiceInboxItem): CallItem {
  return { id: item.id, kind: item.kind, title: item.title, folder: item.folder, done: false };
}

function label(item: { folder?: string; title: string }): string {
  return item.folder ? `${item.folder} · ${item.title}` : item.title;
}

function systemText(text: string): RealtimeEvent {
  return {
    type: "conversation.item.create",
    item: { type: "message", role: "system", content: [{ type: "input_text", text }] },
  };
}

/** The line injected when an item starts waiting mid-call. */
export function newItemText(item: VoiceInboxItem): string {
  const choices = itemChoices(item);
  if (!choices) return `New: ${label(item)} (item_id ${item.id}). Bring it up at the next natural pause: read it out and wait for their answer.`;
  return `New question: ${label(item)}. ${choices} Read it out at the next natural pause and wait for their answer. Only once they choose, call answer_question with item_id "${item.id}" and answers keyed by question id.`;
}

/**
 * A question's questions and options, so Pew can read them out in a reply
 * that has no tools (`UNPROMPTED`) instead of fetching them with one.
 */
export function itemChoices(item: VoiceInboxItem): string {
  if (item.kind !== "question" || !item.questions?.length) return "";
  return item.questions
    .slice(0, 3)
    .map((question) => {
      const options = questionOptions(question)
        .slice(0, 6)
        .map((option) => `"${optionValue(option)}" (${option.label})`);
      return `Question id "${question.id}": ${question.question}${options.length > 0 ? ` Option values: ${options.join(", ")}.` : ""}`;
    })
    .join(" ");
}

/** The line injected when an item was answered somewhere other than this call. */
export function handledElsewhereText(item: { id: string; folder?: string; title: string }): string {
  return `${label(item)} (item_id ${item.id}) was handled elsewhere. Skip it.`;
}

/**
 * What changed between what the model was told and the inbox now.
 * Pure diff, exported for tests: added in inbox order, removed in told order.
 */
export function diffInbox(told: readonly string[], inbox: readonly VoiceInboxItem[]): { added: VoiceInboxItem[]; removed: string[] } {
  const now = new Set(inbox.map((item) => item.id));
  const known = new Set(told);
  return {
    added: inbox.filter((item) => !known.has(item.id)),
    removed: told.filter((id) => !now.has(id)),
  };
}

/** Bring the call's item list and the model's knowledge up to date with `state.inbox`. */
function reconcile(state: CallState, effects: CallEffect[]): CallState {
  const inbox = state.inbox;
  if (!inbox) return state;
  const { added, removed } = diffInbox(state.told, inbox);
  if (added.length === 0 && removed.length === 0) return state;
  const live = state.phase === "live";
  let items = state.items;
  let urgent = state.held.urgent;
  for (const item of added) {
    if (live) {
      effects.push({ kind: "realtime", event: systemText(newItemText(item)) });
      urgent = [...urgent, { id: item.id, name: item.folder ?? item.title }];
    }
    if (!items.some((row) => row.id === item.id)) items = [...items, toCallItem(item)];
    else items = items.map((row) => (row.id === item.id ? { ...row, done: false } : row));
  }
  const gone = new Set(removed);
  for (const id of removed) {
    const row = items.find((entry) => entry.id === id);
    if (live && row && !state.answeredHere.includes(id)) {
      effects.push({ kind: "realtime", event: systemText(handledElsewhereText(row)) });
    }
  }
  items = items.map((row) => (gone.has(row.id) ? { ...row, done: true } : row));
  urgent = urgent.filter((entry) => !gone.has(entry.id));
  return { ...state, items, told: inbox.map((item) => item.id), held: { ...state.held, urgent } };
}

/** Nothing is being said or done: the moment held news may be spoken. */
function quiet(state: CallState): boolean {
  return (
    state.phase === "live" &&
    !state.responding &&
    !state.pewAudio &&
    !state.userSpeaking &&
    !state.hangUpPending &&
    state.tools.length === 0
  );
}

function newsReady(held: HeldNews): boolean {
  return held.urgent.length > 0 || (held.gathered && held.finished.length > 0);
}

/** Forget held news Pew has just said (the user asked, or it came up). */
function dropSaid(held: HeldNews, said: string): HeldNews {
  const text = said.toLowerCase();
  const unsaid = (name: string) => name === "" || !text.includes(name.toLowerCase());
  const finished = held.finished.filter(unsaid);
  return {
    ...held,
    urgent: held.urgent.filter((entry) => unsaid(entry.name)),
    finished,
    gathered: held.gathered && finished.length > 0,
  };
}

/** The one line that turns held news into speech. Exported for tests. */
export function newsText(held: Pick<HeldNews, "urgent" | "finished">): string {
  const named = (names: string[]) => [...new Set(names.filter(Boolean))].join(", ");
  const parts: string[] = [];
  if (held.urgent.length > 0) {
    const who = named(held.urgent.map((entry) => entry.name));
    parts.push(`Bring up what is now waiting on them${who ? ` (${who})` : ""} first.`);
  }
  if (held.finished.length > 0) {
    const who = named(held.finished);
    parts.push(
      `${who ? `Finished: ${who}.` : "Sessions finished."} Tell them the outcomes together, in a sentence or two, not one by one.`,
    );
  }
  return `There's a pause: speak now. ${parts.join(" ")} Skip anything you already told them.`;
}

/**
 * The pacing rule, run after every step: once held news is ready and the call
 * is quiet, wait `PAUSE_MS` of quiet and then say it all in one response. Any
 * sound or work in between disarms the wait, so Pew never talks over the user,
 * itself or a running tool.
 */
function pace(state: CallState, effects: CallEffect[], pauseOver = false): CallState {
  const held = state.held;
  if (!newsReady(held) || !quiet(state)) {
    if (!held.pauseArmed) return state;
    effects.push({ kind: "cancelTimer", key: "pause" });
    return { ...state, held: { ...held, pauseArmed: false } };
  }
  if (!pauseOver) {
    if (held.pauseArmed) return state;
    effects.push({ kind: "timer", key: "pause", ms: PAUSE_MS, input: { type: "timeout", what: "pause" } });
    return { ...state, held: { ...held, pauseArmed: true } };
  }
  effects.push({ kind: "realtime", event: systemText(newsText(held)) });
  return speakUnprompted({ ...state, held: NO_NEWS }, effects);
}

/** A reply Pew starts on its own may talk, never act. */
const UNPROMPTED: RealtimeEvent = { type: "response.create", response: { tool_choice: "none" } };

/**
 * Ask for a response, or hold it until the one in progress finishes. While
 * the user hasn't asked for anything since Pew last spoke on its own
 * (`unprompted`), the reply gets no tools.
 */
function requestResponse(state: CallState, effects: CallEffect[]): CallState {
  if (state.responding) return { ...state, createQueued: true };
  effects.push({ kind: "realtime", event: state.unprompted ? UNPROMPTED : { type: "response.create" } });
  return { ...state, responding: true, createQueued: false };
}

/** Pew speaks on its own (its greeting, news at a pause): a reply with no tools. */
function speakUnprompted(state: CallState, effects: CallEffect[]): CallState {
  return requestResponse({ ...state, unprompted: true }, effects);
}

function finish(state: CallState, effects: CallEffect[], reason: VoiceEndReason, error?: string): CallState {
  effects.push({ kind: "close" });
  for (const tool of state.tools) effects.push({ kind: "cancelTimer", key: `tool:${tool.toolCallId}` });
  effects.push({ kind: "cancelTimer", key: "session" }, { kind: "cancelTimer", key: "goodbye" });
  effects.push({ kind: "cancelTimer", key: "gather" }, { kind: "cancelTimer", key: "pause" });
  if (state.callId) {
    const message: Record<string, unknown> & { t: string } = { t: "voice.end", callId: state.callId, reason };
    if (state.transcript.length > 0) message.transcript = state.transcript;
    effects.push({ kind: "daemon", message });
  }
  return {
    ...state,
    phase: error ? "failed" : "ended",
    activity: "listening",
    error,
    endReason: reason,
    tools: [],
    responding: false,
    createQueued: false,
    hangUpPending: false,
  };
}

function addTranscript(state: CallState, role: TranscriptLine["role"], raw: unknown): CallState {
  const text = typeof raw === "string" ? raw.trim().slice(0, TRANSCRIPT_MAX_CHARS) : "";
  if (!text) return state;
  const transcript = [...state.transcript, { role, text }].slice(-TRANSCRIPT_MAX_LINES);
  return { ...state, transcript };
}

/** Start one function call on the daemon, once per `call_id`. */
function dispatchTool(state: CallState, effects: CallEffect[], callIdRaw: unknown, nameRaw: unknown, argsRaw: unknown): CallState {
  const toolCallId = str(callIdRaw);
  const name = str(nameRaw);
  if (!toolCallId || !name || state.seenToolCalls.includes(toolCallId)) return state;
  const args = typeof argsRaw === "string" ? argsRaw : "{}";
  if ((!state.heardUser || state.unprompted) && !LOOKING_TOOLS.has(name)) {
    // Refused here, never sent: nothing reaches a session the user hasn't asked about.
    effects.push({
      kind: "realtime",
      event: { type: "conversation.item.create", item: { type: "function_call_output", call_id: toolCallId, output: NOT_ASKED_OUTPUT } },
    });
    const refused: CallState = { ...state, seenToolCalls: [...state.seenToolCalls, toolCallId].slice(-200) };
    return state.responding ? { ...refused, createQueued: true } : requestResponse(refused, effects);
  }
  const approving = approvalNeedingReadBack(name, args);
  if (approving) {
    const asked = state.readBack[approving];
    if (asked === undefined || state.userTurns <= asked) {
      // Refused here: Pew says what it would approve, and the user's yes in
      // a later turn is what lets the same call through.
      const item = state.inbox?.find((entry) => entry.id === approving) ?? state.items.find((entry) => entry.id === approving);
      const sending = approving.startsWith("send:");
      const text = sending ? (JSON.parse(args || "{}") as { text?: unknown }).text : undefined;
      const said = sending ? readBackSendOutput(typeof text === "string" ? text : "") : readBackOutput(item);
      effects.push({
        kind: "realtime",
        event: { type: "conversation.item.create", item: { type: "function_call_output", call_id: toolCallId, output: said } },
      });
      const refused: CallState = {
        ...state,
        readBack: { ...state.readBack, [approving]: state.userTurns },
        seenToolCalls: [...state.seenToolCalls, toolCallId].slice(-200),
      };
      return state.responding ? { ...refused, createQueued: true } : requestResponse(refused, effects);
    }
  }
  const requestId = `${state.requestId ?? "voice"}:tool:${state.toolCounter + 1}`;
  effects.push(
    {
      kind: "daemon",
      message: { t: "voice.tool", requestId, callId: state.callId ?? state.requestId ?? "", toolCallId, name, arguments: args },
    },
    { kind: "timer", key: `tool:${toolCallId}`, ms: TOOL_TIMEOUT_MS, input: { type: "timeout", what: "tool", toolCallId } },
  );
  return {
    ...state,
    activity: "working",
    toolCounter: state.toolCounter + 1,
    seenToolCalls: [...state.seenToolCalls, toolCallId].slice(-200),
    tools: [...state.tools, { toolCallId, name, arguments: args, requestId }],
  };
}

/** Hand a tool's output to the model and, once nothing else is running, ask it to speak. */
function completeTool(state: CallState, effects: CallEffect[], toolCallId: string, output: string, hangUp: boolean): CallState {
  const tool = state.tools.find((entry) => entry.toolCallId === toolCallId);
  if (!tool) return state;
  effects.push(
    { kind: "cancelTimer", key: `tool:${toolCallId}` },
    { kind: "realtime", event: { type: "conversation.item.create", item: { type: "function_call_output", call_id: toolCallId, output } } },
  );
  const sessionId = toolTarget(tool.name, tool.arguments, state.inbox);
  const itemId = ANSWERING_TOOLS.has(tool.name) ? answeredItem(tool.arguments) : undefined;
  const found = itemId ? state.inbox?.find((entry) => entry.id === itemId) : undefined;
  const record: CompletedTool = {
    toolCallId,
    name: tool.name,
    arguments: tool.arguments,
    sessionId,
    item: found ? { kind: found.kind, title: found.title, folder: found.folder, agentName: found.agentName } : undefined,
    ok: outputOk(output),
  };
  let next: CallState = {
    ...state,
    tools: state.tools.filter((entry) => entry !== tool),
    completed: [...state.completed, record].slice(-50),
  };
  if (ANSWERING_TOOLS.has(tool.name)) {
    const itemId = answeredItem(tool.arguments);
    if (itemId && !next.answeredHere.includes(itemId)) next = { ...next, answeredHere: [...next.answeredHere, itemId] };
  }
  if (hangUp) next = { ...next, hangUpPending: true, phase: "ending" };
  if (next.tools.length === 0) {
    next = { ...next, activity: "listening" };
    next = requestResponse(next, effects);
  }
  return next;
}

function parseArgs(args: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(args);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function answeredItem(args: string): string | undefined {
  return str(parseArgs(args)?.item_id);
}

/** Tools that name a session directly. */
const SESSION_TOOLS = new Set(["tell_agent", "get_status"]);

/**
 * The session a voice tool acts on: `session_id` for tell_agent / get_status,
 * `item_id` looked up in the inbox for the answering tools. Undefined when the
 * tool names none, or its item is no longer known.
 */
export function toolTarget(name: string, args: string, inbox: readonly VoiceInboxItem[] | undefined): string | undefined {
  const parsed = parseArgs(args);
  if (!parsed) return undefined;
  if (SESSION_TOOLS.has(name)) return str(parsed.session_id) || undefined;
  if (ANSWERING_TOOLS.has(name)) {
    const id = str(parsed.item_id);
    return id ? inbox?.find((item) => item.id === id)?.sessionId : undefined;
  }
  return undefined;
}

function outputOk(output: string): boolean {
  const parsed = parseArgs(output);
  return !parsed || parsed.error === undefined;
}

function setCaption(state: CallState, who: CallCaption["who"], text: string, final: boolean, ref: string | undefined): CallState {
  const serial = (state.caption?.serial ?? 0) + 1;
  return { ...state, caption: { who, text, final, ref, serial } };
}

/** A transcript delta: extends the open caption it belongs to, or starts a new one. */
function captionDelta(state: CallState, who: CallCaption["who"], delta: unknown, ref: string | undefined): CallState {
  if (typeof delta !== "string" || delta === "") return state;
  const open = state.caption;
  if (open && open.who === who && !open.final && open.ref === ref) {
    return { ...state, caption: { ...open, text: open.text + delta } };
  }
  return setCaption(state, who, delta.trimStart(), false, ref);
}

/** The whole line arrived: settle the caption it belongs to (never steals one from the other speaker). */
function captionDone(state: CallState, who: CallCaption["who"], transcript: unknown, ref: string | undefined): CallState {
  const text = typeof transcript === "string" ? transcript.trim() : "";
  const open = state.caption;
  if (open && open.who === who && open.ref === ref) {
    return { ...state, caption: { ...open, text: text || open.text, final: true } };
  }
  if (!text) return state;
  // A late user transcript must not replace Pew's answer already on screen.
  if (who === "you" && open?.who === "pew" && !open.final) return state;
  return setCaption(state, who, text, true, ref);
}

function onDaemon(state: CallState, message: unknown, effects: CallEffect[]): CallState {
  if (!isRecord(message)) return state;
  if (message.t === "voice.inbox") {
    const inbox = readInboxItems(message.items);
    if (!inbox) return state;
    const next = { ...state, inbox };
    return state.phase === "live" || state.phase === "ending" ? reconcile(next, effects) : next;
  }
  if (message.t === "error" && message.code === "unknown_message" && state.phase === "connecting" && !state.callId) {
    return finish(state, effects, "failed", CALL_ERRORS.oldDaemon);
  }
  if (message.t === "voice.session" && message.requestId === state.requestId && state.phase === "connecting" && !state.callId) {
    effects.push({ kind: "cancelTimer", key: "session" });
    const secret = str(message.secret);
    if (message.ok !== true || !secret) {
      return finish(state, effects, "failed", str(message.error) ?? CALL_ERRORS.generic);
    }
    const callId = str(message.callId) ?? state.requestId;
    const briefed = readInboxItems(message.items) ?? state.inbox ?? [];
    const expiresAt = typeof message.expiresAt === "number" ? message.expiresAt : undefined;
    effects.push({ kind: "connect", secret, expiresAt });
    return { ...state, callId, items: briefed.map(toCallItem), told: briefed.map((item) => item.id) };
  }
  // A session Pew is working with started or finished a turn: tell the model,
  // and let it speak at the next pause (never on top of the user or itself).
  if (message.t === "voice.note" && message.callId === state.callId && state.phase === "live") {
    const text = str(message.text);
    if (!text) return state;
    effects.push({ kind: "realtime", event: systemText(text) });
    if (message.speak !== true) return state;
    const held = { ...state.held, finished: [...state.held.finished, str(message.about) ?? ""] };
    if (!held.gathering && !held.gathered) {
      effects.push({ kind: "timer", key: "gather", ms: GATHER_MS, input: { type: "timeout", what: "gather" } });
      held.gathering = true;
    }
    return { ...state, held };
  }
  if (message.t === "voice.tool" && message.callId === state.callId && typeof message.toolCallId === "string") {
    if (state.phase !== "live" && state.phase !== "ending") return state;
    const output = typeof message.output === "string" ? message.output : "{}";
    return completeTool(state, effects, message.toolCallId, output, message.hangUp === true);
  }
  return state;
}

function onServer(state: CallState, raw: unknown, effects: CallEffect[]): CallState {
  if (!isRecord(raw) || typeof raw.type !== "string") return state;
  if (state.phase !== "live" && state.phase !== "ending") return state;
  const event = raw;
  switch (event.type) {
    case "response.created":
      return { ...state, responding: true };
    case "response.function_call_arguments.done":
      return dispatchTool(state, effects, event.call_id, event.name, event.arguments);
    case "response.done": {
      let next: CallState = { ...state, responding: false };
      const response = isRecord(event.response) ? event.response : undefined;
      const output = Array.isArray(response?.output) ? response.output : [];
      for (const item of output) {
        if (isRecord(item) && item.type === "function_call") {
          next = dispatchTool(next, effects, item.call_id, item.name, item.arguments);
        }
      }
      if (next.createQueued && next.tools.length === 0) next = requestResponse(next, effects);
      if (next.hangUpPending && next.tools.length === 0 && !next.responding) {
        effects.push({ kind: "timer", key: "goodbye", ms: HANGUP_GRACE_MS, input: { type: "timeout", what: "goodbye" } });
      }
      return next;
    }
    case "output_audio_buffer.started": {
      effects.push({ kind: "cancelTimer", key: "echoTail" });
      const leadIn = !guarded(state) && !state.pewAudio;
      if (leadIn) effects.push({ kind: "timer", key: "leadIn", ms: LEAD_IN_MS, input: { type: "leadIn" } });
      return gateMic(
        state,
        { ...state, pewAudio: true, echoTail: false, leadIn: leadIn || state.leadIn, activity: state.tools.length > 0 ? "working" : "speaking" },
        effects,
      );
    }
    case "output_audio_buffer.stopped":
    case "output_audio_buffer.cleared": {
      if (state.hangUpPending && !state.responding && state.tools.length === 0) return finish(state, effects, "hangup");
      // Cleared means cut off (an interrupt already opened the mic): no tail.
      const tail = event.type === "output_audio_buffer.stopped" && state.pewAudio && guarded(state);
      if (tail) effects.push({ kind: "timer", key: "echoTail", ms: ECHO_TAIL_MS, input: { type: "echoTail" } });
      if (state.leadIn) effects.push({ kind: "cancelTimer", key: "leadIn" });
      return gateMic(state, { ...state, pewAudio: false, echoTail: tail, leadIn: false, activity: state.tools.length > 0 ? "working" : "listening" }, effects);
    }
    case "input_audio_buffer.speech_started": {
      // Talked over Pew (only heard without the echo guard): stop it at once,
      // as a tap would. The server cancels the reply itself, but audio
      // already sent keeps playing until the buffer is cleared.
      const base = state.pewAudio && !guarded(state) ? cutOff(state, effects) : state;
      const next = setCaption(base, "you", "", false, str(event.item_id));
      return { ...next, userSpeaking: true, activity: state.tools.length > 0 ? "working" : "listening" };
    }
    case "input_audio_buffer.speech_stopped":
      return { ...state, userSpeaking: false };
    // The user's words are in: the reply the server starts for them may act.
    // Marked here, not on the transcript, which can land after that reply's
    // first tool call.
    case "input_audio_buffer.committed":
      return { ...state, heardUser: true, unprompted: false, userTurns: state.userTurns + 1 };
    case "conversation.item.input_audio_transcription.delta":
      return captionDelta(state, "you", event.delta, str(event.item_id));
    case "conversation.item.input_audio_transcription.completed":
      return addTranscript(captionDone(state, "you", event.transcript, str(event.item_id)), "user", event.transcript);
    case "response.output_audio_transcript.delta":
      return captionDelta(state, "pew", event.delta, str(event.response_id));
    case "response.output_audio_transcript.done": {
      const next = addTranscript(captionDone(state, "pew", event.transcript, str(event.response_id)), "assistant", event.transcript);
      return { ...next, held: dropSaid(next.held, str(event.transcript) ?? "") };
    }
    case "error": {
      const error = isRecord(event.error) ? event.error : {};
      // A create that raced a VAD-started response: retry it after that one.
      if (error.code === "conversation_already_has_active_response") return { ...state, createQueued: true, responding: true };
      return state;
    }
    default:
      return state;
  }
}

/** Stop Pew's reply, drop what is still queued to play, and listen now. */
function cutOff(state: CallState, effects: CallEffect[]): CallState {
  if (state.responding) effects.push({ kind: "realtime", event: { type: "response.cancel" } });
  effects.push(
    { kind: "realtime", event: { type: "output_audio_buffer.clear" } },
    { kind: "cancelTimer", key: "echoTail" },
    { kind: "cancelTimer", key: "leadIn" },
  );
  return gateMic(state, { ...state, pewAudio: false, echoTail: false, leadIn: false, activity: "listening" }, effects);
}

/** One step of the call. Pure: the same state and input always give the same answer. */
export function stepCall(state: CallState, input: CallInput): CallStep {
  const step = stepInner(state, input);
  if (step.state.phase !== "live" && !step.state.held.pauseArmed) return step;
  const effects = [...step.effects];
  return { state: pace(step.state, effects), effects };
}

function stepInner(state: CallState, input: CallInput): CallStep {
  const effects: CallEffect[] = [];
  switch (input.type) {
    case "start": {
      if (callActive(state)) return { state, effects };
      effects.push(
        {
          kind: "daemon",
          message: {
            t: "voice.session",
            requestId: input.requestId,
            ...(input.focus ? { focus: input.focus } : {}),
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input.place?.cwd ? { cwd: input.place.cwd } : {}),
            ...(input.place?.providerId ? { providerId: input.place.providerId } : {}),
          },
        },
        { kind: "timer", key: "session", ms: SESSION_TIMEOUT_MS, input: { type: "timeout", what: "session" } },
      );
      return {
        state: { ...IDLE_CALL, inbox: state.inbox, phase: "connecting", requestId: input.requestId, focus: input.focus, echoGuard: input.echoGuard ?? true },
        effects,
      };
    }
    case "daemon":
      return { state: onDaemon(state, input.message, effects), effects };
    case "open": {
      if (state.phase !== "connecting" || !state.callId) return { state, effects };
      // The mic waits out the connect chime (and Pew is about to speak):
      // heard by the mic, it would be taken for the user's first words.
      effects.push({ kind: "timer", key: "echoTail", ms: ECHO_TAIL_MS, input: { type: "echoTail" } });
      let next: CallState = gateMic(state, { ...state, phase: "live", activity: "listening", echoTail: true }, effects);
      next = reconcile(next, effects);
      // Pew speaks first: the bound instructions say how to open. A greeting,
      // never an action: nobody has asked for anything yet.
      next = speakUnprompted(next, effects);
      return { state: next, effects };
    }
    case "server":
      return { state: onServer(state, input.event, effects), effects };
    case "failed":
      if (!callActive(state)) return { state, effects };
      return { state: finish(state, effects, "failed", input.error), effects };
    case "hangup":
      if (!callActive(state)) return { state, effects };
      return { state: finish(state, effects, input.reason ?? "hangup"), effects };
    case "mute":
      if (!callActive(state)) return { state, effects };
      return { state: gateMic(state, { ...state, muted: input.muted }, effects), effects };
    case "interrupt": {
      if (state.phase !== "live" || !state.pewAudio) return { state, effects };
      return { state: cutOff(state, effects), effects };
    }
    case "echoTail":
      if (!state.echoTail) return { state, effects };
      return { state: gateMic(state, { ...state, echoTail: false }, effects), effects };
    case "leadIn":
      if (!state.leadIn) return { state, effects };
      return { state: gateMic(state, { ...state, leadIn: false }, effects), effects };
    case "reconnected": {
      // A tool request sent while the link was down went nowhere, and the
      // call sat on "Setting an alarm…" for the full tool timeout. Send each
      // unanswered one again; the computer runs a tool call id once only,
      // so one that did arrive is answered, not done twice.
      if (state.phase !== "live" || !state.callId) return { state, effects };
      for (const tool of state.tools) {
        effects.push({
          kind: "daemon",
          message: { t: "voice.tool", requestId: tool.requestId, callId: state.callId, toolCallId: tool.toolCallId, name: tool.name, arguments: tool.arguments },
        });
      }
      return { state, effects };
    }
    case "route":
      if (state.speaker === input.speaker) return { state, effects };
      return { state: gateMic(state, { ...state, speaker: input.speaker }, effects), effects };
    case "timeout": {
      if (input.what === "session") {
        if (state.phase !== "connecting" || state.callId) return { state, effects };
        return { state: finish(state, effects, "failed", CALL_ERRORS.noAnswer), effects };
      }
      if (input.what === "goodbye") {
        if (!state.hangUpPending) return { state, effects };
        return { state: finish(state, effects, "hangup"), effects };
      }
      if (input.what === "gather") {
        const held = { ...state.held, gathering: false, gathered: state.held.finished.length > 0 };
        return { state: { ...state, held }, effects };
      }
      if (input.what === "pause") {
        if (!state.held.pauseArmed) return { state, effects };
        return { state: pace({ ...state, held: { ...state.held, pauseArmed: false } }, effects, true), effects };
      }
      const output = JSON.stringify({ error: "The computer didn't answer in time.", say: "I couldn't reach your computer for that one." });
      return { state: completeTool(state, effects, input.toolCallId, output, false), effects };
    }
    case "reset":
      if (callActive(state)) return { state, effects };
      return { state: { ...IDLE_CALL, inbox: state.inbox }, effects };
    case "answeredOnScreen": {
      if (!callActive(state)) return { state, effects };
      const item = state.inbox?.find((entry) => entry.id === input.itemId);
      // Answered here: its leaving the inbox is not "handled elsewhere".
      const answeredHere = state.answeredHere.includes(input.itemId) ? state.answeredHere : [...state.answeredHere, input.itemId];
      effects.push({ kind: "daemon", message: input.message });
      const toolCounter = state.toolCounter + 1;
      // On the end card like any answer Pew gave.
      const completed: CompletedTool[] = [
        ...state.completed,
        {
          toolCallId: `screen-${toolCounter}`,
          name: input.tool,
          arguments: JSON.stringify(input.arguments),
          sessionId: item?.sessionId,
          item: item ? { kind: item.kind, title: item.title, folder: item.folder, agentName: item.agentName } : undefined,
          ok: true,
        },
      ];
      let next: CallState = { ...state, answeredHere, completed, toolCounter, heardUser: true, unprompted: false };
      if (state.phase === "live") {
        effects.push({ kind: "realtime", event: systemText(input.tell) });
        next = requestResponse(next, effects);
      }
      return { state: next, effects };
    }
  }
}

/** True when a `voice.session` secret can no longer open a call. */
export function secretExpired(expiresAt: number | undefined, now: number): boolean {
  return expiresAt !== undefined && now >= expiresAt;
}

// ── Status, settings and entry points ─────────────────────────

/**
 * What the phone knows about voice on this daemon.
 *  - `unknown`: not asked yet, or asked with no answer (hidden).
 *  - `unsupported`: an older daemon refused `voice.status` (hidden).
 *  - `known`: the daemon answered.
 */
export type VoiceKnowledge =
  | { kind: "unknown"; asked?: string }
  | { kind: "unsupported" }
  | { kind: "known"; status: VoiceStatus };

export const VOICE_UNKNOWN: VoiceKnowledge = { kind: "unknown" };

/** Fold one daemon frame into what is known about voice. */
export function foldVoiceStatus(knowledge: VoiceKnowledge, message: unknown): VoiceKnowledge {
  if (!isRecord(message)) return knowledge;
  if (message.t === "voice.status" && typeof message.available === "boolean") {
    return { kind: "known", status: message as unknown as VoiceStatus };
  }
  // The rejection names no request, so it is read as voice's only while a
  // `voice.status` is outstanding and nothing has answered it.
  if (message.t === "error" && message.code === "unknown_message" && knowledge.kind === "unknown" && knowledge.asked) {
    return { kind: "unsupported" };
  }
  return knowledge;
}

/** Whether a call can start right now: the daemon has a usable OpenAI login. */
export function canTalk(knowledge: VoiceKnowledge): boolean {
  return knowledge.kind === "known" && knowledge.status.available;
}

/**
 * Whether to show the Talk button: a call can start, or one sign-in away.
 *
 * Not just `canTalk`: a machine whose agents have no OpenAI login (Claude
 * Code only) would otherwise never show Talk at all, and voice would be a
 * feature nobody finds. Tapping it there opens the sign-in instead of a call.
 * Hidden for an older daemon or an unanswered ask.
 */
export function talkVisible(knowledge: VoiceKnowledge): boolean {
  if (knowledge.kind !== "known") return false;
  const status = knowledge.status;
  return status.available || status.canLogin === true || status.login !== undefined;
}

/** Whether the settings row exists at all (any daemon that answered). */
export function voiceSettingsVisible(knowledge: VoiceKnowledge): boolean {
  return knowledge.kind === "known";
}

const SOURCE_LABEL: Record<wire.VoiceSource, string> = {
  ggcoder: "Using your GG Coder OpenAI login",
  codex: "Using your Codex OpenAI login",
  pew2: "Signed in to OpenAI",
  apikey: "Using an OpenAI API key",
};

/** One line for the settings row. */
export function voiceStatusLine(status: VoiceStatus): string {
  if (status.available) {
    const base = status.source ? SOURCE_LABEL[status.source] : "Ready";
    return status.account ? `${base} (${status.account})` : base;
  }
  if (status.login) return "Waiting for you to sign in…";
  return status.reason ?? (status.canLogin ? "Sign in to OpenAI" : "Voice isn't available");
}

export type VoiceMode = wire.VoicePrefsValues["mode"];
export const VOICE_MODES: readonly { mode: VoiceMode; label: string; hint: string }[] = [
  { mode: "off", label: "Off", hint: "No calls. Banners as usual." },
  { mode: "notify", label: "Notify", hint: "Banners, with a Talk action." },
  { mode: "onthego", label: "On the go", hint: "Pew rings when things pile up." },
];

export const DEVICE_CODE_NOTE = "Needs device code sign-in on: ChatGPT → Settings → Security.";

/**
 * A notification's data, read as a request to open a call.
 * `{voice:true, focus?}` → `{focus}`; anything else → undefined.
 */
export function voicePushRequest(data: unknown): { focus?: string } | undefined {
  if (!isRecord(data) || data.voice !== true) return undefined;
  const focus = str(data.focus);
  return focus ? { focus } : {};
}

/** The orb's caption. */
export function activityLabel(state: CallState): string {
  if (state.phase === "connecting") return "Calling Pew…";
  if (state.phase === "ending") return "Saying goodbye…";
  if (state.phase === "ended") return "Call ended";
  if (state.phase === "failed") return "Call failed";
  if (state.activity === "working") return "On it…";
  if (state.activity === "speaking") return "Pew is talking";
  return state.muted ? "Muted" : "Listening";
}
