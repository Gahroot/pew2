/**
 * Which voice events earn a notification, how they are batched, and where a tap
 * or action goes. Extends `../notificationPolicy.ts` (finished turns) without
 * touching it; no Expo imports, bound by `ui/voiceNotifier.ts`.
 *
 * Principles:
 *  - Never notify for what the user is hearing or has just heard.
 *  - `approval` and `blocked` interrupt now; `completed` and `informational`
 *    wait and are coalesced into one notice after a quiet spell.
 *  - A decision is never made from the Lock Screen. iOS cannot start the mic
 *    from a background notification, and approving a shell command or a deploy
 *    with one thumb-tap on a locked phone is exactly what the safety rules
 *    forbid. So every action *opens the app*, into voice or the approval sheet.
 */
import { VoiceCallbackPushSchema, type EventClass, type VoiceCallbackPush, type VoiceEvent, type VoiceSource } from "./types";

// ---- categories & actions ----------------------------------------------------

/** No `:` or `-` in identifiers: expo-notifications documents they break matching. */
export const VOICE_CATEGORY = "voiceCallback";
export const VOICE_APPROVAL_CATEGORY = "voiceApproval";
export const ACTION_TALK = "voiceTalk";
export const ACTION_REVIEW = "voiceReview";

/** Default tap (no action button). */
export const DEFAULT_ACTION = "expo.modules.notifications.actions.DEFAULT";

export function categoryFor(eventClass: EventClass): string {
  return eventClass === "approval" ? VOICE_APPROVAL_CATEGORY : VOICE_CATEGORY;
}

// ---- parsing & routing -------------------------------------------------------

export function parseVoicePush(data: unknown): VoiceCallbackPush | undefined {
  const parsed = VoiceCallbackPushSchema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

export type VoiceRoute =
  | { kind: "voice"; source: VoiceSource; focusEventId: number; focusTaskId: string }
  /** Open the in-app approval sheet for this task instead of starting audio. */
  | { kind: "review"; focusEventId: number; focusTaskId: string };

/**
 * Where a response to a voice notification goes, or undefined when it is not
 * one of ours. Tapping the banner and pressing Talk both start voice; Review
 * opens the on-screen sheet so a decision can be read before it is made.
 */
export function routeVoiceResponse(actionId: string, data: unknown): VoiceRoute | undefined {
  const push = parseVoicePush(data);
  if (!push) return undefined;
  const focus = { focusEventId: push.eventId, focusTaskId: push.taskId };
  if (actionId === ACTION_REVIEW) return { kind: "review", ...focus };
  return { kind: "voice", source: "notification", ...focus };
}

// ---- deciding & batching -----------------------------------------------------

export const BATCH_QUIET_MS = 20_000;
/** Even a steady trickle is flushed this long after its first event. */
export const BATCH_MAX_MS = 90_000;
/** How long after a voice conversation ends its events are still "just heard". */
export const JUST_HEARD_MS = 30_000;

export interface BatchState {
  /** Non-urgent events waiting, oldest first. */
  pending: VoiceEvent[];
  firstAt?: number;
  lastAt?: number;
  /** Highest eventId already notified (or deliberately skipped); dedupe floor. */
  notified: number;
}

export const emptyBatch: BatchState = { pending: [], notified: 0 };

export interface Presence {
  foreground: boolean;
  /** A voice conversation is live: the user is hearing events. */
  voiceActive: boolean;
  /** Voice sheet or a task screen showing the events. */
  voiceSheetOpen: boolean;
  /** Highest eventId the user has heard or seen. */
  heardEventId: number;
  /** When the last voice conversation ended, if any. */
  voiceEndedAt?: number;
  /** The daemon has somewhere to push; the push covers a backgrounded app. */
  pushExpected: boolean;
  now: number;
}

export interface VoiceNotice {
  title: string;
  body: string;
  /** Goes back to us on tap as notification data. */
  data: VoiceCallbackPush;
  category: string;
  /** Replaces an earlier banner for the same task rather than stacking. */
  threadId: string;
}

export interface Offered {
  state: BatchState;
  /** Show now, if anything. */
  show?: VoiceNotice;
}

const URGENT: ReadonlySet<EventClass> = new Set(["approval", "blocked"]);

export function isUrgent(eventClass: EventClass): boolean {
  return URGENT.has(eventClass);
}

function pushData(event: VoiceEvent): VoiceCallbackPush {
  return {
    type: "voice.callback",
    eventId: event.eventId,
    taskId: event.taskId,
    projectId: event.projectId,
    class: event.class,
  };
}

function titleFor(event: VoiceEvent): string {
  switch (event.class) {
    case "approval":
      return `${event.projectName}: needs your approval`;
    case "blocked":
      return `${event.projectName}: blocked`;
    case "completed":
      return `${event.projectName}: done`;
    case "informational":
      return event.projectName;
  }
}

function single(event: VoiceEvent): VoiceNotice {
  return {
    title: titleFor(event),
    body: event.text,
    data: pushData(event),
    category: categoryFor(event.class),
    threadId: event.taskId,
  };
}

/** One notice for several quiet updates. Points at the newest, so a tap opens the latest. */
export function summarise(events: VoiceEvent[]): VoiceNotice | undefined {
  const last = events.at(-1);
  if (!last) return undefined;
  if (events.length === 1) return single(last);
  const projects = [...new Set(events.map((e) => e.projectName))].sort();
  const done = events.filter((e) => e.class === "completed").length;
  const head =
    projects.length === 1
      ? projects[0]
      : `${projects.length} projects`;
  const body = done === events.length ? `${done} tasks finished` : `${events.length} updates`;
  return {
    title: head ?? "PEW2",
    body: `${body}. Tap to talk it through.`,
    data: pushData(last),
    category: VOICE_CATEGORY,
    threadId: "batch",
  };
}

/** True when the user is, or just was, listening to this event. */
export function alreadyHeard(event: VoiceEvent, presence: Presence): boolean {
  if (event.eventId <= presence.heardEventId) return true;
  if (presence.voiceActive) return true;
  if (presence.voiceEndedAt !== undefined && presence.now - presence.voiceEndedAt < JUST_HEARD_MS) return true;
  return false;
}

/**
 * Whether the local banner route should fire at all. A backgrounded app with a
 * working push yields to the push (it is the only route iOS lets run once we
 * are suspended); a foreground app already shows state on screen, so only the
 * urgent events earn a banner there, and only when the sheet is not already
 * open on them.
 */
export function localRouteOpen(event: VoiceEvent, presence: Presence): boolean {
  if (!presence.foreground) return !presence.pushExpected;
  if (presence.voiceSheetOpen) return false;
  return isUrgent(event.class);
}

/** Feed one live event. Returns the new batch state and a notice to show now, if any. */
export function offerEvent(batch: BatchState, event: VoiceEvent, presence: Presence): Offered {
  if (event.eventId <= batch.notified) return { state: batch }; // dedupe
  const state: BatchState = { ...batch, notified: Math.max(batch.notified, event.eventId) };

  if (alreadyHeard(event, presence) || !localRouteOpen(event, presence)) return { state };

  if (isUrgent(event.class)) {
    // An urgent event supersedes waiting chatter about the same task; the rest keeps waiting.
    return {
      state: { ...state, pending: state.pending.filter((e) => e.taskId !== event.taskId) },
      show: single(event),
    };
  }
  const pending = [...state.pending.filter((e) => e.taskId !== event.taskId || e.class !== event.class), event];
  return {
    state: { ...state, pending, firstAt: state.firstAt ?? presence.now, lastAt: presence.now },
  };
}

/** When a flush is due, or undefined with nothing waiting. A timer should call `flush` then. */
export function flushDueAt(batch: BatchState): number | undefined {
  if (batch.pending.length === 0 || batch.lastAt === undefined || batch.firstAt === undefined) return undefined;
  return Math.min(batch.lastAt + BATCH_QUIET_MS, batch.firstAt + BATCH_MAX_MS);
}

/** Emit the waiting batch (re-checking it was not heard in the meantime). */
export function flush(batch: BatchState, presence: Presence): Offered {
  const waiting = batch.pending.filter((e) => !alreadyHeard(e, presence) && localRouteOpen(e, presence));
  const state: BatchState = { ...batch, pending: [], firstAt: undefined, lastAt: undefined };
  const show = summarise(waiting);
  return show ? { state, show } : { state };
}

/**
 * A push arriving while the app is open: swallow it when the user is already
 * hearing or seeing that event. (The push cannot be made smarter on the server;
 * only the phone knows what the user just heard.)
 */
export function suppressVoicePush(data: unknown, presence: Presence): boolean {
  const push = parseVoicePush(data);
  if (!push) return false;
  if (push.eventId <= presence.heardEventId) return true;
  if (presence.voiceActive) return true;
  if (presence.voiceEndedAt !== undefined && presence.now - presence.voiceEndedAt < JUST_HEARD_MS) return true;
  return presence.foreground && presence.voiceSheetOpen;
}
