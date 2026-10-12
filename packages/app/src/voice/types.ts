/**
 * The voice wire types, re-exported from one place.
 *
 * `@pew2/protocol` exposes the wire schemas through the `wire` namespace, so
 * every voice module would otherwise repeat that indirection.
 */
import { wire } from "@pew2/protocol";

export const VoiceSourceSchema = wire.VoiceSource;
export const VoiceTaskSchema = wire.VoiceTask;
export const VoiceCallbackPushSchema = wire.VoiceCallbackPush;

export type VoiceSource = wire.VoiceSource;
export type VoiceTask = wire.VoiceTask;
export type VoiceEvent = wire.VoiceEvent;
export type VoiceSnapshot = wire.VoiceSnapshot;
export type VoiceCallbackPush = wire.VoiceCallbackPush;
export type EventClass = wire.EventClass;
export type RiskLevel = wire.RiskLevel;
