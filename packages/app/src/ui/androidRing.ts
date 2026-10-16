/**
 * Android ringing for the "Native call screen" setting.
 *
 * iOS rings through PushKit and CallKit. Android has neither, so the daemon
 * sends a high-priority, data-only Expo push (`pew2Call: "1"`, no title or
 * body, so the OS draws nothing). `expo-notifications` hands it to the task
 * defined here even when the app was swiped away, and the task shows the
 * Telecom incoming-call screen through callkeep's ConnectionService.
 *
 * If Telecom cannot ring (pew2 not enabled as a calling account, or a build
 * without callkeep), it falls back to a max-importance banner on the
 * `incoming-call` channel whose data is an ordinary voice callback, so tapping
 * it opens voice through the existing route.
 *
 * `defineCallTask` must run at module scope, early (from `index.ts`), because
 * the background task loads the JS bundle without mounting the app.
 *
 * Ported from AutomationGods/pew2 (`src/voice/androidRing.ts`). UNTESTED ON DEVICE.
 */
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { ringAndroid } from "./callkit";
import { fallbackData, findCallPush } from "../voice/callPush";
import type { VoiceCallPush } from "../voice/types";
import { loadNativeCall } from "../preferences";

export const CALL_TASK = "pew2-incoming-call";
/** Must match `CALL_CHANNEL` in the daemon's push.ts. */
export const CALL_CHANNEL = "incoming-call";

/** Calls already rung, so a push seen by both the task and the foreground listener rings once. */
const rung = new Set<string>();

async function ensureChannel(): Promise<void> {
  await Notifications.setNotificationChannelAsync(CALL_CHANNEL, {
    name: "Incoming calls",
    description: "pew2 rings you when an agent finishes or needs you.",
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 800, 400, 800, 400, 800],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    // Do Not Disturb still wins, as it does for every other pew2 notification.
    bypassDnd: false,
  });
}

/** Ring with the system call screen, or a loud banner if that is not possible. */
export async function ringAndroidOrNotify(call: VoiceCallPush): Promise<void> {
  if (Platform.OS !== "android" || rung.has(call.callId)) return;
  // Fail closed: a stale daemon registration must not ring a phone that turned this off.
  if (!(await loadNativeCall())) return;
  rung.add(call.callId);
  if (await ringAndroid(call)) return;
  try {
    await ensureChannel();
    await Notifications.scheduleNotificationAsync({
      content: {
        title: call.caller,
        body: "Tap to talk to Pew.",
        priority: Notifications.AndroidNotificationPriority.MAX,
        data: { ...fallbackData(call), local: true },
      },
      trigger: { channelId: CALL_CHANNEL },
    });
  } catch {
    // Nothing else to try; the voice log still has the event.
  }
}

/** Register the background task. Call once, at module scope, from `index.ts`. */
export function defineCallTask(): void {
  if (Platform.OS !== "android") return;
  try {
    TaskManager.defineTask(CALL_TASK, async ({ data, error }) => {
      if (error) return;
      const call = findCallPush(data);
      if (call) await ringAndroidOrNotify(call);
    });
    void Notifications.registerTaskAsync(CALL_TASK).catch(() => undefined);
    // Created up front so a push naming it is never filed into a missing channel.
    void ensureChannel().catch(() => undefined);
  } catch {
    // A build without expo-task-manager: foreground ringing still works.
  }
}

/** A ring that arrives while the app is open goes to this listener rather than the task. */
export function listenForegroundRings(): () => void {
  if (Platform.OS !== "android") return () => {};
  const subscription = Notifications.addNotificationReceivedListener((notification) => {
    const call =
      findCallPush(notification.request.content.data) ?? findCallPush(notification.request.trigger);
    if (call) void ringAndroidOrNotify(call);
  });
  return () => subscription.remove();
}
