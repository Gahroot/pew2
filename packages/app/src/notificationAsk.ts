/**
 * When to ask for notification permission, and what the ask looks like.
 *
 * iOS shows its system prompt once; a "Don't Allow" given cold is close to
 * permanent. So the app explains first, in a card, at the moments alerts earn
 * themselves: the first message sent (the user is about to wait on an agent),
 * and picking a "Ring me" option. Expo-free, so `bun test` can run it;
 * `ui/useAlerts.ts` binds the SDK. Same split as `notificationPolicy.ts`.
 */

/** Notification permission, as the app reasons about it. */
export type AlertStatus = "granted" | "denied" | "undetermined";

/** Why the ask is happening: a sent message, a Ring me pick, the Alerts row. */
export type AskTrigger = "send" | "ring" | "row";

/** What the card offers: the system prompt, or (iOS already said no) Settings. */
export type CardMode = "allow" | "settings";

/** "Not now" keeps the card away this long. */
export const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

export const ALERTS_TITLE = "Get told when it's done";
export const ALERTS_LINE = "Pew lets you know when an agent finishes or needs you.";
export const RING_NEEDS_ALERTS = "Allow alerts to get calls.";

/** The fields of `Notifications.getPermissionsAsync()` that matter here. */
export interface PermissionRead {
  granted: boolean;
  canAskAgain: boolean;
  status?: string;
}

export function alertStatus(read: PermissionRead): AlertStatus {
  if (read.granted || read.status === "granted") return "granted";
  // iOS clears canAskAgain after a refusal; from then on only Settings can help.
  if (read.canAskAgain && read.status !== "denied") return "undetermined";
  return "denied";
}

export interface AskInput {
  status: AlertStatus;
  trigger: AskTrigger;
  /** When "Not now" was last tapped, if ever. */
  dismissedAt?: number;
  now: number;
}

/**
 * What to do: hand the daemon the push address (`register`), show the card,
 * or nothing.
 *
 * A send never shows the card once iOS has refused (it would nag on every
 * message) nor inside the snooze. A Ring me pick or the Alerts row is the user
 * asking, so the card shows whatever the snooze says.
 */
export function askDecision(input: AskInput): "register" | "card" | "none" {
  if (input.status === "granted") return "register";
  if (input.trigger !== "send") return "card";
  if (input.status === "denied") return "none";
  if (input.dismissedAt !== undefined && input.now - input.dismissedAt < SNOOZE_MS && input.now >= input.dismissedAt) return "none";
  return "card";
}

export function cardMode(status: AlertStatus): CardMode {
  return status === "denied" ? "settings" : "allow";
}

/** The Alerts row's value in the Connection sheet. */
export function alertsRowValue(status: AlertStatus | undefined): string {
  if (status === "granted") return "On";
  if (status === "denied") return "Off";
  return "Not set";
}

/** A stored timestamp, or undefined for anything unreadable. */
export function parseDismissedAt(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const at = Number(raw);
  return Number.isFinite(at) && at > 0 ? at : undefined;
}
