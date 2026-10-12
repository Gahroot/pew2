/**
 * Do-not-disturb for voice notifications. Pure; persisted by `../preferences.ts`.
 *
 * Quiet hours silence everything that can wait (completions, progress). A
 * decision the agent cannot proceed without (`approval`, `blocked`) still
 * produces a silent banner unless the user chose `strict`.
 */
import type { EventClass } from "./types";

export interface QuietHours {
  enabled: boolean;
  /** Minutes after local midnight, 0..1439. */
  startMin: number;
  endMin: number;
  /** True: nothing at all gets through, urgent included. */
  strict: boolean;
}

export const DEFAULT_QUIET_HOURS: QuietHours = { enabled: false, startMin: 22 * 60, endMin: 7 * 60, strict: false };

const clampMin = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(1439, Math.max(0, Math.trunc(v))) : fallback;

/** Tolerant of a missing, older or corrupt stored value. */
export function decodeQuietHours(raw: string | null | undefined): QuietHours {
  if (!raw) return DEFAULT_QUIET_HOURS;
  try {
    const o: unknown = JSON.parse(raw);
    if (typeof o !== "object" || o === null) return DEFAULT_QUIET_HOURS;
    const r = o as Record<string, unknown>;
    return {
      enabled: r.enabled === true,
      startMin: clampMin(r.startMin, DEFAULT_QUIET_HOURS.startMin),
      endMin: clampMin(r.endMin, DEFAULT_QUIET_HOURS.endMin),
      strict: r.strict === true,
    };
  } catch {
    return DEFAULT_QUIET_HOURS;
  }
}

export function encodeQuietHours(q: QuietHours): string {
  return JSON.stringify(q);
}

/** Handles windows that cross midnight (22:00-07:00). Equal start/end means never. */
export function inQuietHours(q: QuietHours, at: Date): boolean {
  if (!q.enabled || q.startMin === q.endMin) return false;
  const m = at.getHours() * 60 + at.getMinutes();
  return q.startMin < q.endMin ? m >= q.startMin && m < q.endMin : m >= q.startMin || m < q.endMin;
}

export type Tier = "interrupt" | "batch" | "silent";

/** decision/blocker interrupt; completions batch; progress stays silent. */
export function tierOf(eventClass: EventClass): Tier {
  switch (eventClass) {
    case "approval":
    case "blocked":
      return "interrupt";
    case "completed":
      return "batch";
    case "informational":
      return "silent";
  }
}

/** Whether a banner for this class may be raised right now. */
export function allowedDuringQuiet(q: QuietHours, eventClass: EventClass, at: Date): boolean {
  if (!inQuietHours(q, at)) return true;
  return !q.strict && tierOf(eventClass) === "interrupt";
}
