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
import { endsTurn, noticeBody, noticeTitle, type NoticeKind, type NoticeOrigin } from "@pew2/protocol";

/** Expo's push endpoint. Needs no credentials of ours; EAS holds those. */
const PUSH_URL = "https://exp.host/--/api/v2/push/send";

/** Matches what `getExpoPushTokenAsync` returns, so junk never reaches Expo. */
const TOKEN_SHAPE = /^Expo(nent)?PushToken\[[^\]]+\]$/;

/** A phone that can be rung like a call: its PushKit token and which APNs it belongs to. */
export interface VoipTarget {
  token: string;
  env: "sandbox" | "production";
}

/** A phone that has asked to be told when its agents finish. */
interface Target {
  token: string;
  platform: "ios" | "android";
  /** Android needs the channel named on the message, not just on the device. */
  channelId?: string;
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
  /** Phones that can ring like a call (PushKit), by device. In memory: phones re-send on every connect. */
  private readonly voipTargets = new Map<string, VoipTarget>();

  /** Remember (or, with `null`, forget) a device's VoIP token. */
  registerVoip(deviceId: string, token: string | null, env: VoipTarget["env"]): void {
    if (token === null) this.voipTargets.delete(deviceId);
    else this.voipTargets.set(deviceId, { token, env });
  }

  forgetVoip(token: string): void {
    for (const [deviceId, target] of this.voipTargets) {
      if (target.token === token) this.voipTargets.delete(deviceId);
    }
  }

  voipList(): [deviceId: string, target: VoipTarget][] {
    return [...this.voipTargets];
  }

  /** Banner targets with their device, so a phone already rung by VoIP is skipped. */
  entries(): [deviceId: string, target: Target][] {
    return [...this.targets];
  }

  /**
   * Remember where to push for a device, or reject a token that is not one.
   *
   * @returns whether the token was accepted, so a caller can log the refusal.
   */
  register(deviceId: string, token: string, platform: "ios" | "android"): boolean {
    if (!TOKEN_SHAPE.test(token)) return false;
    this.targets.set(deviceId, {
      token,
      platform,
      ...(platform === "android" ? { channelId: ANDROID_CHANNEL } : null),
    });
    return true;
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
interface ExpoMessage<Data = { sessionId: string; kind: NoticeKind }> {
  to: string;
  title: string;
  body: string;
  data: Data;
  sound: "default";
  /** iOS: `time-sensitive` breaks through Focus; used for voice rings only. */
  interruptionLevel?: "active" | "critical" | "passive" | "time-sensitive";
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
  messages: { to: string }[],
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
  await sendMessages(registry, pushMessages(registry, turn));
}

/** What a voice "ring" says: one alert for everything waiting. */
export interface VoiceRingPush {
  /** "3 things waiting: …" */
  body: string;
  /**
   * Who is waiting, as the lock screen should name it: one project
   * ("billing"), or "billing +2". Absent: the generic title.
   */
  who?: string;
  /** The inbox item the call should lead with. */
  focus?: string;
  badge?: number;
}

export const VOICE_RING_TITLE = "pew2 needs you";

/** The banner's title: the project waiting ("billing needs you"), else the generic one. */
export function ringTitle(ring: Pick<VoiceRingPush, "who">): string {
  return ring.who ? `${ring.who} needs you` : VOICE_RING_TITLE;
}

/** The incoming call's caller name: Pew, and which project ("Pew · billing"). */
export function ringCaller(ring: Pick<VoiceRingPush, "who">): string {
  return ring.who ? `Pew · ${ring.who}` : "Pew";
}

/**
 * The v1 ring: a time-sensitive push that opens the app straight into a call.
 * No reply category: the answer is the call itself.
 */
export type VoiceRingMessage = ExpoMessage<{ voice: true; focus?: string }>;

export function voiceRingMessages(registry: PushRegistry, ring: VoiceRingPush): VoiceRingMessage[] {
  return registry.list().map((target) => ({
    to: target.token,
    title: ringTitle(ring),
    body: ring.body,
    data: { voice: true, ...(ring.focus ? { focus: ring.focus } : {}) },
    sound: "default",
    interruptionLevel: "time-sensitive",
    ...(target.channelId ? { channelId: target.channelId } : null),
    ...(ring.badge !== undefined ? { badge: ring.badge } : null),
    ...(target.platform === "ios" ? { mutableContent: true } : null),
    priority: "high",
  }));
}

/**
 * The VoIP push's payload, which the app's PushKit handler reads before
 * anything else runs: it must report a CallKit call at once, so it carries
 * everything the incoming-call screen shows.
 */
export interface VoipRingPayload {
  pew: { title: string; body: string; focus?: string; ring: string };
}

export function voipRingPayload(ring: VoiceRingPush, ringId: string): VoipRingPayload {
  return {
    pew: {
      title: ringCaller(ring),
      body: ring.body.slice(0, 160),
      ...(ring.focus ? { focus: ring.focus } : {}),
      ring: ringId,
    },
  };
}

export interface RingOptions {
  /** The relay's https origin, which holds the Apple key. Absent: banners only. */
  relay?: string;
  fetchImpl?: typeof fetch;
  ringId?: string;
  /** One line per outcome (the daemon's console): where the ring went. */
  log?: (line: string) => void;
}

/** `wss://host/...` → `https://host`. Undefined for anything that isn't a relay URL. */
export function relayOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "wss:" || parsed.protocol === "https:") return `https://${parsed.host}`;
    if (parsed.protocol === "ws:" || parsed.protocol === "http:") return `http://${parsed.host}`;
  } catch {
    // Not a URL.
  }
  return undefined;
}

/**
 * Ring every paired phone: a CallKit call through the relay where the phone
 * registered for one, the time-sensitive banner everywhere else, and the
 * banner too for any phone the VoIP push didn't reach (relay without the key,
 * offline, refused). Same never-throw, no-retry rules as a turn push.
 *
 * @returns the devices rung by VoIP, for tests and logs.
 */
export async function pushVoiceRing(registry: PushRegistry, ring: VoiceRingPush, options: RingOptions = {}): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const ringId = options.ringId ?? `ring_${Date.now().toString(36)}`;
  const rung: string[] = [];
  if (options.relay) {
    const payload = voipRingPayload(ring, ringId);
    await Promise.all(
      registry.voipList().map(async ([deviceId, target]) => {
        const status = await sendVoip(fetchImpl, options.relay!, target, payload);
        options.log?.(`[voice] call to '${deviceId}': ${status === "ok" ? "sent" : status}`);
        if (status === "ok") rung.push(deviceId);
        else if (status === "gone") registry.forgetVoip(target.token);
      }),
    );
  }
  const banners = registry.entries().filter(([deviceId]) => !rung.includes(deviceId));
  if (!options.relay) options.log?.("[voice] no relay: no call, banner only");
  else if (registry.voipList().length === 0) options.log?.("[voice] no phone registered for calls: banner only");
  if (banners.length > 0) options.log?.(`[voice] banner to ${banners.length} phone(s)`);
  if (rung.length === 0 && banners.length === 0) options.log?.("[voice] nothing to ring: no phone registered for alerts");
  if (banners.length > 0) {
    const messages = voiceRingMessages(registry, ring).filter((message) =>
      banners.some(([, target]) => target.token === message.to),
    );
    await sendMessages(registry, messages);
  }
  return rung;
}

async function sendVoip(
  fetchImpl: typeof fetch,
  relay: string,
  target: VoipTarget,
  payload: VoipRingPayload,
): Promise<"ok" | "gone" | "failed"> {
  try {
    const response = await fetchImpl(`${relay}/voip`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: target.token, env: target.env, payload }),
      // A ring that takes longer than this has lost to the banner.
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) return "ok";
    // APNs says the token is dead (app deleted, push revoked): stop using it.
    return response.status === 410 ? "gone" : "failed";
  } catch {
    return "failed";
  }
}

async function sendMessages(registry: PushRegistry, messages: { to: string }[]): Promise<void> {
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
