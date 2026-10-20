/**
 * Notification permission, asked properly: an explainer card first, the system
 * prompt only after "Allow", Settings once iOS has refused. The rules live in
 * `notificationAsk.ts`; this binds them to Expo, SecureStore and the screen.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking } from "react-native";
import { askDecision, cardMode, type AlertStatus, type AskTrigger, type CardMode } from "../notificationAsk";
import { loadAlertsDismissedAt, saveAlertsDismissedAt } from "../preferences";
import { ensureNotificationPermission, notificationStatus } from "./notifier";

export interface Alerts {
  /** Undefined until first read. */
  status: AlertStatus | undefined;
  /** The card, when it is up. */
  card: CardMode | undefined;
  /** Re-read the permission (sheet opened, app foregrounded). */
  refresh: () => void;
  /** Run the flow for a trigger; resolves whether alerts ended up allowed. */
  ask: (trigger: AskTrigger) => Promise<boolean>;
  allow: () => void;
  notNow: () => void;
}

/** `registered` is true once the daemon already holds this phone's push address. */
export function useAlerts(registerPush: () => void, registered: { readonly current: boolean | undefined }): Alerts {
  const [status, setStatus] = useState<AlertStatus | undefined>(undefined);
  const [card, setCard] = useState<CardMode | undefined>(() =>
    __DEV__ && process.env.EXPO_PUBLIC_DEV_ASK_ALERTS === "1" ? "allow" : undefined,
  );
  const pending = useRef<((allowed: boolean) => void) | undefined>(undefined);
  const register = useRef({ registerPush, registered });
  useEffect(() => {
    register.current = { registerPush, registered };
  }, [registerPush, registered]);
  const handOver = useCallback(() => {
    if (!register.current.registered.current) register.current.registerPush();
  }, []);

  const refresh = useCallback(() => {
    void notificationStatus().then(setStatus);
  }, []);

  // Read at launch and whenever the app comes back: Settings is where a "no" is undone.
  useEffect(() => {
    refresh();
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const finish = useCallback((allowed: boolean) => {
    setCard(undefined);
    const resolve = pending.current;
    pending.current = undefined;
    resolve?.(allowed);
  }, []);

  const ask = useCallback(async (trigger: AskTrigger): Promise<boolean> => {
    const current = await notificationStatus();
    setStatus(current);
    const decision = askDecision({ status: current, trigger, dismissedAt: await loadAlertsDismissedAt(), now: Date.now() });
    if (decision === "register") {
      handOver();
      return true;
    }
    if (decision === "none") return false;
    // A card already up answers for both askers.
    const previous = pending.current;
    return new Promise<boolean>((resolve) => {
      pending.current = (allowed) => {
        previous?.(allowed);
        resolve(allowed);
      };
      setCard(cardMode(current));
    });
  }, [handOver]);

  const allow = useCallback(() => {
    if (card === "settings") {
      void Linking.openSettings().catch(() => {});
      finish(false);
      return;
    }
    setCard(undefined);
    void ensureNotificationPermission().then((allowed) => {
      if (allowed) handOver();
      refresh();
      finish(allowed);
    });
  }, [card, finish, refresh, handOver]);

  const notNow = useCallback(() => {
    void saveAlertsDismissedAt(Date.now());
    finish(false);
  }, [finish]);

  return { status, card, refresh, ask, allow, notNow };
}
