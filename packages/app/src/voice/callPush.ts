/**
 * The native call screen's payload, wherever it turns up.
 *
 * The daemon rings with a `voice.call` (wire `VoiceCallPush`): as a VoIP push
 * on iOS, reported to CallKit natively before JavaScript runs and handed back
 * as the call's `payload`; as a data-only Expo push on Android, marked
 * `pew2Call: "1"`. Depending on the path (background task, foreground
 * listener, CallKit event) the fields sit at different depths and sometimes
 * inside a JSON string, so this digs.
 *
 * Pure and Expo-free: `ui/callkit.ts` and `ui/androidRing.ts` bind it.
 */
import type { VoiceActivation } from "./deepLink";
import { VoiceCallPushSchema, type VoiceCallbackPush, type VoiceCallPush } from "./types";

const MAX_DEPTH = 5;

/** A call payload at this level (case-insensitive id, as CallKit lowercases UUIDs). */
export function parseCallPush(value: unknown): VoiceCallPush | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const fields = value as Record<string, unknown>;
  // Android data arrives stringly typed: FCM data values are strings.
  const eventId = typeof fields.eventId === "string" ? Number(fields.eventId) : fields.eventId;
  const parsed = VoiceCallPushSchema.safeParse({ ...fields, eventId });
  return parsed.success ? { ...parsed.data, callId: parsed.data.callId.toLowerCase() } : undefined;
}

/** The call inside any push or event, at any depth up to five, or undefined. */
export function findCallPush(value: unknown, depth = 0): VoiceCallPush | undefined {
  if (depth > MAX_DEPTH || value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    if (!value.includes("voice.call")) return undefined;
    try {
      return findCallPush(JSON.parse(value), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (typeof value !== "object") return undefined;
  const direct = parseCallPush(value);
  if (direct) return direct;
  for (const inner of Object.values(value as Record<string, unknown>)) {
    const found = findCallPush(inner, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** What answering opens: voice, focused exactly where the banner's tap would have. */
export function activationFor(call: Pick<VoiceCallPush, "eventId" | "taskId">): VoiceActivation {
  return { source: "notification", focusEventId: call.eventId, focusTaskId: call.taskId };
}

/**
 * The banner a ring becomes when it cannot ring (Android without pew2 enabled
 * as a calling account). Its data is an ordinary voice callback, so the tap is
 * handled by the existing voice notification route with nothing new.
 */
export function fallbackData(call: VoiceCallPush): VoiceCallbackPush {
  return {
    type: "voice.callback",
    eventId: call.eventId,
    taskId: call.taskId,
    projectId: call.projectId,
    class: call.class,
  };
}

/** A call the user started in the app; the system screen names it like this. */
export const OUTGOING_CALLER = "Pew";
