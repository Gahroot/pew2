/** Voice wire types, re-exported flat: `@pew2/protocol` only exposes them under `wire`. */
import type { wire } from "@pew2/protocol";

export type EventClass = wire.EventClass;
export type RiskLevel = wire.RiskLevel;
export type TaskState = wire.TaskState;
export type VoiceEvent = wire.VoiceEvent;
export type VoiceProject = wire.VoiceProject;
export type VoiceSnapshot = wire.VoiceSnapshot;
export type VoiceTask = wire.VoiceTask;
export type VoiceDebrief = wire.VoiceDebrief;
export type VoiceRepo = wire.VoiceRepo;
export type VoiceAttachment = wire.VoiceAttachment;

/** A conversation this daemon holds open, as the voice model may hear of it. */
export interface RunningSession {
  sessionId: string;
  providerId: string;
  agentName?: string;
  cwd: string;
  /** Same three states the sidebar draws: a turn in flight, blocked on the user, or at rest. */
  state: "working" | "needs_you" | "idle";
  /** Milliseconds since it was last used; lets the model say "just now". */
  idleMs: number;
}
