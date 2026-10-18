/**
 * Keep the home and Lock Screen widget in step with the app, and open what it
 * links to.
 *
 * The native half of `widgetSnapshot.ts`. The widget runs in its own process
 * with no JavaScript, so the app writes a JSON snapshot into the App Group and
 * asks WidgetKit to redraw; while the app is asleep the notification service
 * extension (`targets/notifications`) edits the same snapshot as pushes land.
 */
import { useEffect, useRef } from "react";
import { Linking, Platform } from "react-native";
import { writeWidgetSnapshot } from "../../modules/pew-widget";
import {
  WIDGET_APP_GROUP,
  WIDGET_KEY,
  sameSnapshot,
  widgetLink,
  type WidgetLink,
  type WidgetContent,
} from "../widgetSnapshot";

/**
 * Write the snapshot whenever it would draw a different widget.
 *
 * iOS only: the widget is a WidgetKit extension. Errors are swallowed for the
 * same reason as the notification layer's: a widget that failed to update
 * must never cost the conversation anything.
 */
export function useHomeWidget(snapshot: WidgetContent): void {
  const written = useRef<WidgetContent | undefined>(undefined);
  useEffect(() => {
    if (Platform.OS !== "ios" || sameSnapshot(written.current, snapshot)) return;
    try {
      if (writeWidgetSnapshot(WIDGET_APP_GROUP, WIDGET_KEY, JSON.stringify({ ...snapshot, at: Date.now() }))) {
        written.current = snapshot;
      }
    } catch {
      // Next change tries again.
    }
  }, [snapshot]);
}

/**
 * Report what a widget was tapped for: a conversation, or a new chat.
 *
 * Covers both the link that launched the app from cold and one arriving
 * while it runs. Only the two widget links are acted on; see `widgetLink` for
 * why they are safe to accept from anywhere.
 *
 * @returns an unsubscribe function.
 */
export function onWidgetLink(act: (link: WidgetLink) => void): () => void {
  const handle = (url: string | null) => {
    const link = url ? widgetLink(url) : undefined;
    if (link) act(link);
  };
  Linking.getInitialURL()
    .then(handle)
    .catch(() => {});
  const subscription = Linking.addEventListener("url", ({ url }) => handle(url));
  return () => subscription.remove();
}
