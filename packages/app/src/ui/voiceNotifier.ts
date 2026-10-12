/**
 * Notification binding for voice callbacks. Rules are in
 * `../voice/voiceNotifications.ts`; this registers the categories, raises local
 * notices and reports taps. Complements `notifier.ts` (finished turns), which
 * ignores responses without a `sessionId`, so the two never both act.
 *
 * Every action opens the app: iOS cannot start the microphone from a background
 * notification, and a decision is never taken silently from a Lock Screen.
 * UNTESTED ON DEVICE.
 */
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { ensureNotificationPermission } from "./notifier";
import {
  ACTION_REVIEW,
  ACTION_TALK,
  VOICE_APPROVAL_CATEGORY,
  VOICE_CATEGORY,
  routeVoiceResponse,
  type VoiceNotice,
  type VoiceRoute,
} from "../voice/voiceNotifications";

let registered: Promise<void> | undefined;

/** Adds the Talk / Review buttons. Both open the app. */
export function registerVoiceCategories(): Promise<void> {
  registered ??= (async () => {
    const open = { opensAppToForeground: true } as const;
    await Notifications.setNotificationCategoryAsync(VOICE_CATEGORY, [
      { identifier: ACTION_TALK, buttonTitle: "Talk", options: open },
    ]);
    await Notifications.setNotificationCategoryAsync(VOICE_APPROVAL_CATEGORY, [
      { identifier: ACTION_TALK, buttonTitle: "Talk", options: open },
      { identifier: ACTION_REVIEW, buttonTitle: "Review", options: open },
    ]);
  })().catch(() => {
    registered = undefined;
  });
  return registered;
}

export async function notifyVoice(notice: VoiceNotice): Promise<void> {
  try {
    if (!(await ensureNotificationPermission())) return;
    await registerVoiceCategories();
    await Notifications.scheduleNotificationAsync({
      content: {
        title: notice.title,
        body: notice.body,
        data: { ...notice.data, local: true },
        categoryIdentifier: notice.category,
        ...(Platform.OS === "android" ? { channelId: "agent-turns" } : null),
      },
      trigger: null,
    });
  } catch {
    // Notifications are an addition; never break the session over one.
  }
}

const handled = new Set<string>();

/** Reports a tap or action on a voice notification, including the one that launched the app. */
export function onVoiceNotificationChoice(act: (route: VoiceRoute) => void): () => void {
  void registerVoiceCategories();
  const once = (response: Notifications.NotificationResponse | null) => {
    if (!response) return;
    const key = `${response.notification.request.identifier}:${response.actionIdentifier}`;
    if (handled.has(key)) return;
    const route = routeVoiceResponse(response.actionIdentifier, response.notification.request.content.data);
    if (!route) return;
    handled.add(key);
    act(route);
  };
  once(Notifications.getLastNotificationResponse());
  const subscription = Notifications.addNotificationResponseReceivedListener(once);
  return () => subscription.remove();
}
