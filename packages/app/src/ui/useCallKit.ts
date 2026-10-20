/**
 * Pew rings like a phone call: the system's incoming-call screen (CallKit),
 * woken by a VoIP push the daemon sends through the relay.
 *
 * - The phone's VoIP token goes to the daemon on every connect, but only once
 *   the user agreed to voice calls: no consent, no ring (banners instead).
 * - Answer starts the call (once the daemon is reachable: a lock-screen answer
 *   can launch the app cold); decline and missed tell the daemon, which holds
 *   the next ring off (snooze); hang up and mute on the system screen act on
 *   the call; a call that ends in the app leaves the system screen too.
 */
import { useEffect, useRef, useState } from "react";
import type { wire } from "@pew2/protocol";
import { canRing, endSystemCall, listen, onToken, simulateRing, voipToken, type CallEvent } from "../../modules/pew-call";

interface Options {
  post: (message: unknown) => boolean;
  online: boolean;
  consented: boolean;
  /** The voice call is active (connecting or live). */
  callActive: boolean;
  onAnswer: (focus: string | undefined) => void;
  onHangUp: () => void;
  onMute: (muted: boolean) => void;
}

export function useCallKit({ post, online, consented, callActive, onAnswer, onHangUp, onMute }: Options) {
  const handlers = useRef({ onAnswer, onHangUp, onMute });
  handlers.current = { onAnswer, onHangUp, onMute };
  /** Declines and misses not yet told to the daemon (the app may have woken offline). */
  const [unsent, setUnsent] = useState<wire.VoiceEnd[]>([]);
  /** The system call is on screen: ringing, or answered and live. */
  const systemCall = useRef(false);

  // The token, on every connect and whenever iOS rotates it.
  useEffect(() => {
    if (!canRing || !online || !consented) return;
    const send = (token: string | null, env: "sandbox" | "production") =>
      post({ t: "app.voip", token, env } satisfies wire.VoipRegister);
    const now = voipToken();
    if (now?.token) send(now.token, now.env);
    const subscription = onToken((next) => send(next.token, next.env));
    return () => subscription?.remove();
  }, [online, consented, post]);

  useEffect(() => {
    if (!canRing) return;
    const handle = (event: CallEvent) => {
      switch (event.type) {
        case "ringing":
          systemCall.current = true;
          break;
        case "answer":
          systemCall.current = true;
          handlers.current.onAnswer(event.focus ?? undefined);
          break;
        case "declined":
        case "missed":
          systemCall.current = false;
          setUnsent((list) => [...list, { t: "voice.end", callId: event.ring ?? "ring", reason: event.type }]);
          break;
        case "hangup":
          systemCall.current = false;
          handlers.current.onHangUp();
          break;
        case "mute":
          handlers.current.onMute(event.muted);
          break;
      }
    };
    const { missed, remove } = listen(handle);
    for (const event of missed) handle(event);
    return remove;
  }, []);

  // Development only: `EXPO_PUBLIC_DEV_RING=1` shows the incoming-call screen
  // 8 s after launch, with no push (a simulator gets no VoIP pushes).
  useEffect(() => {
    if (!__DEV__ || process.env.EXPO_PUBLIC_DEV_RING !== "1" || !canRing) return;
    const timer = setTimeout(() => simulateRing("2 things waiting"), 8000);
    return () => clearTimeout(timer);
  }, []);

  // Tell the daemon about declines and misses once it can hear.
  useEffect(() => {
    if (!online || unsent.length === 0) return;
    const left = unsent.filter((message) => !post(message));
    if (left.length !== unsent.length) setUnsent(left);
  }, [online, unsent, post]);

  // The call ended in the app (hang up, failed, Pew said bye): off the system screen too.
  const wasActive = useRef(callActive);
  useEffect(() => {
    if (wasActive.current && !callActive && systemCall.current) {
      systemCall.current = false;
      endSystemCall();
    }
    wasActive.current = callActive;
  }, [callActive]);
}
