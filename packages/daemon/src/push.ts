/**
 * Remote push, sent by the machine that is still awake.
 *
 * The app can only raise a local banner while its JavaScript is running, and
 * iOS suspends that within seconds of the app being backgrounded — taking the
 * relay socket with it. So the notification that matters most, a long turn
 * finishing while the phone is in a pocket, arrived only when the app was next
 * opened. This closes that: the daemon never sleeps, so the daemon sends it.
 *
 * Two deliberate non-choices:
 *
 * - **The relay is not involved.** It would be the obvious place for a device
 *   registry, and it is the one component that must stay a dumb pipe holding no
 *   user state. The desktop has internet; it can call the push service itself.
 * - **Tokens are held in memory only.** A push token identifies a phone, and
 *   writing one to disk gives the daemon a persistent record of a device for no
 *   gain: the app re-registers on every connect, and a daemon that just started
 *   has nothing to announce yet anyway.
 *
 * The cost of the feature is honest and belongs here rather than buried: the
 * banner's title and body are rendered by iOS with no JavaScript involved, so
 * they cannot be encrypted end-to-end. Expo, Apple and Google see the project
 * name and the agent's opening line. Everything else in pew2 stays sealed; this
 * one string does not, and that is the price of an instant notification.
 */
import {
  endsTurn,
  noticeBody,
  noticeTitle,
  type NoticeKind,
  type NoticeOrigin,
  type wire,
} from "@pew2/protocol";
import { randomUUID } from "node:crypto";
import { placeTitle } from "./voice/place.js";
import type { VoipSender, VoipTarget } from "./voip.js";

type VoiceEvent = wire.VoiceEvent;
type VoiceCallbackPush = wire.VoiceCallbackPush;

/** Expo's push endpoint. Needs no credentials of ours; EAS holds those. */
const PUSH_URL = "https://exp.host/--/api/v2/push/send";

/** Matches what `getExpoPushTokenAsync` returns, so junk never reaches Expo. */
const TOKEN_SHAPE = /^Expo(nent)?PushToken\[[^\]]+\]$/;

/** A phone that has asked to be told when its agents finish. */
interface Target {
  token: string;
  platform: "ios" | "android";
  /** Android needs the channel named on the message, not just on the device. */
  channelId?: string;
  /** This phone turned "voice call" on in its settings. Absent means off. */
  voiceCall?: boolean;
  /** This phone turned "Native call screen" on: ring with CallKit / Telecom. Absent means off. */
  nativeCall?: boolean;
  /** iOS PushKit address, held only while `nativeCall` is on. */
  voip?: VoipTarget;
}

/** The "Native call screen" half of a registration. Absent means the setting is off. */
export interface NativeCallRegistration {
  voip?: VoipTarget;
}

export interface FinishedTurnPush extends NoticeOrigin {
  sessionId: string;
  /** What the banner is about. Absent = a turn that finished normally. */
  kind?: NoticeKind;
  /**
   * The text the banner quotes: the agent's closing message, the error, the
   * tool waiting for approval or the question, depending on `kind`.
   */
  lastText?: string;
  /**
   * The app icon's badge: how many conversations are stopped on an answer
   * from this phone right now. Sent on every push, so a finished turn also
   * clears a badge left by an approval that has since been given.
   */
  badge?: number;
}

/**
 * The Android channel the app creates in `ui/notifier.ts`.
 *
 * Restated rather than imported because the daemon cannot depend on the app
 * package. Worth the visible duplication: Expo documents that naming a channel
 * the device has not created means the notification is **not shown at all**, so
 * a drift here is silent and total rather than merely untidy.
 */
const ANDROID_CHANNEL = "agent-turns";

/** The notification category the app registers, which carries the reply box. */
const CATEGORY = "agentTurn";

/**
 * Every phone paired to this daemon, keyed by device.
 *
 * Keyed by `deviceId` rather than by token so that a phone whose token rotated
 * replaces its old entry instead of accumulating one per launch — otherwise a
 * week of app restarts means a week of duplicate banners.
 */
export class PushRegistry {
  private readonly targets = new Map<string, Target>();

  /**
   * Remember where to push for a device, or reject a token that is not one.
   *
   * @returns whether the token was accepted, so a caller can log the refusal.
   */
  register(
    deviceId: string,
    token: string,
    platform: "ios" | "android",
    voiceCall = false,
    nativeCall?: NativeCallRegistration,
  ): boolean {
    if (!TOKEN_SHAPE.test(token)) return false;
    // Replaced whole, never merged: a registration without `nativeCall` is the
    // phone saying the setting is off, and a VoIP push to a phone that no
    // longer reports calls gets the app killed by iOS.
    this.targets.set(deviceId, {
      token,
      platform,
      ...(platform === "android" ? { channelId: ANDROID_CHANNEL } : null),
      ...(voiceCall ? { voiceCall: true } : null),
      ...(nativeCall ? { nativeCall: true } : null),
      ...(nativeCall?.voip && platform === "ios" ? { voip: nativeCall.voip } : null),
    });
    return true;
  }

  /** Apple said this VoIP token is dead: stop ringing it, keep the banner. */
  forgetVoip(voipToken: string): void {
    for (const target of this.targets.values()) {
      if (target.voip?.token.toLowerCase() === voipToken.toLowerCase()) delete target.voip;
    }
  }

  /**
   * Stop pushing to a token the push service has told us is dead.
   *
   * Expo reports `DeviceNotRegistered` when the app was uninstalled or the user
   * revoked permission. Continuing to send to it is what gets a sender rate
   * limited, so this is not merely tidy.
   */
  forget(token: string): void {
    for (const [deviceId, target] of this.targets) {
      if (target.token === token) this.targets.delete(deviceId);
    }
  }

  list(): Target[] {
    return [...this.targets.values()];
  }

  get size(): number {
    return this.targets.size;
  }
}

/** One message in Expo's push API shape. */
interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: { sessionId: string; kind: NoticeKind } | VoiceCallbackPush;
  sound: "default";
  /** Only on a turn ending: the inline reply box makes no sense for an approval. */
  categoryId?: string;
  channelId?: string;
  /** iOS: the icon's badge, absolute rather than an increment. */
  badge?: number;
  /**
   * iOS: wake the app's notification service extension, which folds the push
   * into the home-screen widget's snapshot. The banner itself is unchanged,
   * and an app too old to have the extension simply shows it as before.
   */
  mutableContent?: boolean;
  /**
   * High, which is what makes this instant on Android.
   *
   * Normal priority lets FCM hold a message back on a sleeping device to save
   * battery — precisely the phone-in-a-pocket case this whole feature exists
   * for, and it would reproduce the original complaint (the banner arriving
   * long after the turn ended) through a different mechanism. On iOS high is
   * already the default.
   */
  priority: "high";
}

/** Expo's per-message result. Errors are reported here, not as an HTTP status. */
interface ExpoTicket {
  status?: string;
  message?: string;
  details?: { error?: string };
}

export function pushMessages(registry: PushRegistry, turn: FinishedTurnPush): ExpoMessage[] {
  const kind = turn.kind ?? "finished";
  const title = noticeTitle(turn);
  const body = noticeBody(turn.lastText, kind);
  return registry.list().map((target) => ({
    to: target.token,
    title,
    body,
    // Read back on tap to open the right conversation, and on an inline reply
    // to address the right agent. `kind` lets the app judge a duplicate: only
    // a turn ending has a local banner it could be racing.
    data: { sessionId: turn.sessionId, kind },
    sound: "default",
    // The reply box answers a turn that ended. On an approval or a question
    // a typed line would only queue behind the request it was meant to
    // answer, so those open the app, where the real sheet is.
    ...(endsTurn(kind) ? { categoryId: CATEGORY } : null),
    ...(target.channelId ? { channelId: target.channelId } : null),
    ...(turn.badge !== undefined ? { badge: turn.badge } : null),
    ...(target.platform === "ios" ? { mutableContent: true } : null),
    priority: "high",
  }));
}

/**
 * Interpret Expo's reply and drop tokens it has declared dead.
 *
 * Exported for tests: the failure that matters is a token that keeps being sent
 * to forever, and that is invisible without asserting on this.
 */
export function applyTickets(
  registry: PushRegistry,
  messages: readonly { to: string }[],
  tickets: unknown,
): void {
  if (!Array.isArray(tickets)) return;
  tickets.forEach((ticket: ExpoTicket, index) => {
    if (ticket?.status !== "error") return;
    if (ticket.details?.error !== "DeviceNotRegistered") return;
    const message = messages[index];
    if (message) registry.forget(message.to);
  });
}

/**
 * Announce a finished turn to every paired phone.
 *
 * Never throws and never blocks the turn: a notification is an addition to the
 * session, and a push service outage must not surface as a failed prompt. The
 * caller deliberately does not await it.
 *
 * No retry. Expo's guidance is exponential backoff on 429/5xx, but this
 * particular message is worthless once it is late — the whole point is
 * immediacy, and a banner arriving after the user has already picked up the
 * phone and read the reply is noise. A dropped push degrades to what the app did
 * before: the banner appears when the socket reconnects.
 */
export async function pushFinishedTurn(
  registry: PushRegistry,
  turn: FinishedTurnPush,
): Promise<void> {
  if (registry.size === 0) return;
  const messages = pushMessages(registry, turn);
  try {
    const response = await fetch(PUSH_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(messages),
      // A push that has not been accepted in ten seconds has already lost the
      // race with the user reaching for their phone.
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return;
    const payload = (await response.json()) as { data?: unknown };
    applyTickets(registry, messages, payload?.data);
  } catch {
    // Offline desktop, DNS failure, Expo outage. Nothing here is worth
    // interrupting the session that just finished successfully.
  }
}

/**
 * "Voice call" is a per-phone setting (off by default), sent with `app.push`.
 *
 * This is *not* a CallKit call: that is the separate "Native call screen"
 * setting (`pushVoiceEvent` below), which needs a VoIP push only APNs can carry
 * and the user's own APNs key (`pew2 voice apns`). This is the same push,
 * worded as Pew calling. It is sent at
 * iOS's ordinary level on purpose, so Do Not Disturb, Sleep and every other
 * Focus hold it back exactly as they would a call from nobody in your
 * favourites. Tapping it opens voice, so "answering" is a tap.
 */
/** Only news worth interrupting someone for rings; chatter stays an ordinary push. */
const RINGS = new Set<string>(["completed", "blocked", "approval"]);

/** One voice callback in Expo's shape. `data` is exactly `VoiceCallbackPush`. */
export function voiceMessages(registry: PushRegistry, event: VoiceEvent): ExpoMessage[] {
  return bannerMessages(registry.list(), event);
}

function bannerMessages(targets: Target[], event: VoiceEvent): ExpoMessage[] {
  const data: VoiceCallbackPush = {
    type: "voice.callback",
    eventId: event.eventId,
    taskId: event.taskId,
    projectId: event.projectId,
    class: event.class,
  };
  // "black-mountain-fund · fix/login: finished": the repository, with the
  // branch as a detail, never the worktree as a project of its own.
  const place = placeTitle(event);
  const title =
    event.class === "approval"
      ? `${place}: needs approval`
      : event.class === "blocked"
        ? `${place}: needs you`
        : event.class === "completed"
          ? `${place}: finished`
          : place;
  return targets.map((target) => ({
    to: target.token,
    title: target.voiceCall === true && RINGS.has(event.class) ? `Pew is calling: ${title}` : title,
    // Already short and secret-scrubbed by the voice layer; capped again because
    // this string is readable by Expo, Apple and Google.
    body: event.text.slice(0, 140),
    data,
    sound: "default",
    // No `categoryId`: the agent-turn category carries an inline reply box
    // addressed to a session, and a voice callback has none.
    ...(target.channelId ? { channelId: target.channelId } : null),
    priority: "high",
  }));
}

/** The Android channel the app creates for rings (`ui/androidRing.ts`). Restated for the same reason as `ANDROID_CHANNEL`. */
export const CALL_CHANNEL = "incoming-call";

/** What the system call screen shows as the caller. Short, because Apple and Google can read it. */
export function callerFor(event: VoiceEvent): string {
  const place = placeTitle(event);
  const what = event.class === "approval" ? "needs approval" : event.class === "blocked" ? "needs you" : "finished";
  const caller = `${place}: ${what}`;
  return caller.length > 80 ? `${caller.slice(0, 79)}…` : caller;
}

export function callPush(event: VoiceEvent, callId: string): wire.VoiceCallPush {
  return {
    type: "voice.call",
    callId,
    caller: callerFor(event),
    eventId: event.eventId,
    taskId: event.taskId,
    projectId: event.projectId,
    class: event.class,
  };
}

/**
 * Android ringing: a high-priority, data-only push. With no title or body the
 * OS draws nothing; the app's background task wakes (even when swiped away)
 * and shows the Telecom incoming-call screen, or a loud banner if the user has
 * not enabled pew2 as a calling account.
 */
interface ExpoCallMessage {
  to: string;
  data: wire.VoiceCallPush & { pew2Call: "1" };
  priority: "high";
  channelId: string;
  /** Seconds. A ring that arrives late is worse than none. */
  ttl: number;
}

export function androidCallMessage(target: Target, payload: wire.VoiceCallPush): ExpoCallMessage {
  return { to: target.token, data: { ...payload, pew2Call: "1" }, priority: "high", channelId: CALL_CHANNEL, ttl: 30 };
}

export interface RingOptions {
  /** Present only when this daemon can send VoIP pushes at all. */
  voip?: Pick<VoipSender, "send">;
  newCallId?: () => string;
}

/**
 * Push one voice event (approval, blocked, completed). Same contract as
 * `pushFinishedTurn`: never throws, never retried. Which events deserve a push,
 * and when, is decided upstream by the batcher; this only delivers.
 *
 * A phone with "Native call screen" on is rung instead of bannered, for the
 * same events "voice call" words as a call. iOS rings through APNs (VoIP), so
 * an iPhone is rung only when `pew2 voice apns` is configured and the phone
 * sent its PushKit token; any ring that does not go out becomes the ordinary
 * banner, so turning the setting on can never cost a notification.
 */
export async function pushVoiceEvent(
  registry: PushRegistry,
  event: VoiceEvent,
  send: typeof fetch = fetch,
  ring: RingOptions = {},
): Promise<void> {
  if (registry.size === 0) return;
  const rings = RINGS.has(event.class);
  type Delivery = { kind: "banner"; target: Target } | { kind: "call"; message: ExpoCallMessage } | { kind: "rung" };
  // Resolved in registry order, so the batch sent to Expo is deterministic.
  const deliveries = await Promise.all(
    registry.list().map(async (target): Promise<Delivery> => {
      if (!rings || target.nativeCall !== true) return { kind: "banner", target };
      const payload = callPush(event, (ring.newCallId ?? randomUUID)());
      if (target.platform === "android") return { kind: "call", message: androidCallMessage(target, payload) };
      if (!target.voip || !ring.voip) return { kind: "banner", target };
      const outcome = await ring.voip.send(target.voip, payload);
      if (outcome === "sent") return { kind: "rung" };
      if (outcome === "gone") registry.forgetVoip(target.voip.token);
      return { kind: "banner", target };
    }),
  );
  const bannered = deliveries.flatMap((d) => (d.kind === "banner" ? [d.target] : []));
  const calls = deliveries.flatMap((d) => (d.kind === "call" ? [d.message] : []));
  const messages: (ExpoMessage | ExpoCallMessage)[] = [...bannerMessages(bannered, event), ...calls];
  if (messages.length === 0) return;
  try {
    const response = await send(PUSH_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(messages),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return;
    const payload = (await response.json()) as { data?: unknown };
    applyTickets(registry, messages, payload?.data);
  } catch {
    // Offline desktop or Expo outage: the event is still in the voice log.
  }
}
