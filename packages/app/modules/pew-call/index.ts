/**
 * Pew rings like a phone call (see `ios/PewCallCenter.swift`): the PushKit
 * token the daemon rings, and the CallKit call's events.
 *
 * Optional, so a build without the native module (Android, web, an older dev
 * client) reads as "can't ring here" and the daemon keeps sending banners.
 */
import { requireOptionalNativeModule } from "expo";

interface EventSubscription {
  remove(): void;
}

export type CallEvent =
  | { type: "ringing"; focus?: string | null; ring?: string | null }
  | { type: "answer"; focus?: string | null; ring?: string | null }
  | { type: "declined"; ring?: string | null }
  | { type: "missed"; ring?: string | null }
  | { type: "hangup" }
  | { type: "mute"; muted: boolean };

export interface VoipToken {
  token: string | null;
  env: "sandbox" | "production";
}

interface PewCallNative {
  allowed(): boolean;
  token(): VoipToken | null;
  ready(): CallEvent[];
  endCall(): void;
  connected(): void;
  simulateRing(body: string): void;
  addListener(event: "onCall", listener: (event: CallEvent) => void): EventSubscription;
  addListener(event: "onToken", listener: (event: VoipToken) => void): EventSubscription;
}

const native = requireOptionalNativeModule<PewCallNative>("PewCall");

/** This build can ring with CallKit, and this phone is allowed to (not China). */
export const canRing = native !== null && native.allowed();

export function voipToken(): VoipToken | null {
  return native?.token() ?? null;
}

export function onToken(listener: (token: VoipToken) => void): EventSubscription | undefined {
  return native?.addListener("onToken", listener);
}

/** Listen, and get what happened before JavaScript was ready (a ring answered from a cold launch). */
export function listen(listener: (event: CallEvent) => void): { missed: CallEvent[]; remove: () => void } {
  if (!native) return { missed: [], remove: () => {} };
  const subscription = native.addListener("onCall", listener);
  return { missed: native.ready(), remove: () => subscription.remove() };
}

export function endSystemCall(): void {
  native?.endCall();
}

export function systemCallConnected(): void {
  native?.connected();
}

/** Development only: the incoming-call screen without a push. */
export function simulateRing(body: string): void {
  native?.simulateRing(body);
}
