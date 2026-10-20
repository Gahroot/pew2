/**
 * When to ring the user about waiting items. Pure: no timers, no clock. Every
 * function takes `now` and returns the next state; `tick` also returns whether
 * to ring and when it next needs to run. `scheduler.ts` owns the timer.
 *
 * Mode `onthego`:
 *  - A new item opens a batch window; when it closes, one ring covers
 *    everything waiting.
 *  - Never while a call is active, nor within the cooldown after the last call
 *    or ring (a missed or declined ring counts, so an unanswered phone is not
 *    rung again a minute later).
 *  - Except: an item waiting longer than `longWaitMs` rings through the
 *    cooldown, once per item.
 *  - At most `maxCallsPerHour` rings in any rolling hour.
 *  - `call_me_back(n)` holds rings until then, and at that time rings only if
 *    something is still waiting.
 *  - A declined or missed ring holds the next one for `SNOOZE_MS`, long waits
 *    included: "not now" is an answer.
 *  - Never in quiet hours; what arrives then is covered (it got its banner),
 *    so nothing rings the moment they end.
 *  - `ringUntil` passed means `notify` (the controller also writes it back).
 * Modes `off` and `notify` never ring (the ordinary banners are unaffected).
 *
 * Which sessions may ring at all is the controller's (`ringScope`: every
 * chat, or only armed ones): it passes only those items here.
 */
import type { wire } from "@pew2/protocol";

/**
 * Off by default: ringing already ends by itself (`ringUntil`), so a quiet
 * window nobody can see on the phone would only make a wanted call not come.
 * Kept for a phone that sets one.
 */
export const DEFAULT_QUIET_HOURS: wire.VoiceQuietHours = { on: false, from: 22 * 60, to: 8 * 60 };

export const DEFAULT_PREFS: Prefs = {
  mode: "notify",
  batchSeconds: 90,
  cooldownMinutes: 10,
  maxCallsPerHour: 4,
  ringUntil: 0,
  quietHours: DEFAULT_QUIET_HOURS,
  armNewSessions: false,
  // Ring me means ring me: any chat that gets stuck on them. "This chat"
  // narrows it to the armed ones.
  ringScope: "all",
};

export type Prefs = Required<wire.VoicePrefsValues>;

/** A declined or missed ring holds the next one this long. */
export const SNOOZE_MS = 30 * 60_000;

export const LONG_WAIT_MS = 15 * 60_000;
/** A call nobody ended (phone died mid-call) stops blocking rings after this. */
export const STALE_CALL_MS = 60 * 60_000;
const HOUR_MS = 60 * 60_000;

export function withDefaults(prefs: Partial<wire.VoicePrefsValues> | undefined): Prefs {
  return {
    mode: prefs?.mode ?? DEFAULT_PREFS.mode,
    batchSeconds: prefs?.batchSeconds ?? DEFAULT_PREFS.batchSeconds,
    cooldownMinutes: prefs?.cooldownMinutes ?? DEFAULT_PREFS.cooldownMinutes,
    maxCallsPerHour: prefs?.maxCallsPerHour ?? DEFAULT_PREFS.maxCallsPerHour,
    ringUntil: prefs?.ringUntil ?? DEFAULT_PREFS.ringUntil,
    quietHours: prefs?.quietHours ?? DEFAULT_PREFS.quietHours,
    armNewSessions: prefs?.armNewSessions ?? DEFAULT_PREFS.armNewSessions,
    ringScope: prefs?.ringScope ?? DEFAULT_PREFS.ringScope,
  };
}

/** `onthego` whose `ringUntil` has passed. */
export function ringExpired(prefs: Prefs, now: number): boolean {
  return prefs.mode === "onthego" && prefs.ringUntil > 0 && now >= prefs.ringUntil;
}

/** Minutes after midnight at `now` in `tz` (the computer's zone when absent or unknown). */
export function localMinutes(now: number, tz?: string): number {
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date(now));
      const hour = Number(parts.find((part) => part.type === "hour")?.value);
      const minute = Number(parts.find((part) => part.type === "minute")?.value);
      if (Number.isFinite(hour) && Number.isFinite(minute)) return (hour % 24) * 60 + minute;
    } catch {
      // An unknown zone falls back to the computer's.
    }
  }
  const date = new Date(now);
  return date.getHours() * 60 + date.getMinutes();
}

/** Inside the quiet window. `from === to` is an empty window. */
export function inQuietHours(quiet: wire.VoiceQuietHours | undefined, now: number): boolean {
  if (!quiet?.on || quiet.from === quiet.to) return false;
  const minutes = localMinutes(now, quiet.tz);
  return quiet.from < quiet.to
    ? minutes >= quiet.from && minutes < quiet.to
    : minutes >= quiet.from || minutes < quiet.to;
}

/** The bit of an inbox item the policy needs. */
export interface PolicyItem {
  id: string;
  since: number;
}

export interface PolicyState {
  /** Ring times within the last hour, oldest first. */
  rings: number[];
  /** Call in progress, since when. */
  callStartedAt?: number;
  lastCallEndedAt?: number;
  lastRingAt?: number;
  /** A batch window is open since this time. */
  batchStartedAt?: number;
  /** Items already covered by a ring or a call. */
  covered: string[];
  /** Items that have used their one long-wait override. */
  overridden: string[];
  /** `call_me_back` time. */
  callbackAt?: number;
  /** A declined or missed ring: nothing rings before this. */
  snoozeUntil?: number;
}

export const initialState = (): PolicyState => ({ rings: [], covered: [], overridden: [] });

export interface Decision {
  state: PolicyState;
  /** Ring now, about these items (oldest first). */
  ring?: { itemIds: string[]; reason: "batch" | "long_wait" | "callback" };
  /** Call `tick` again at this time, if anything is pending. */
  wakeAt?: number;
}

const callActive = (state: PolicyState, now: number) =>
  state.callStartedAt !== undefined && now - state.callStartedAt < STALE_CALL_MS;

/** A call started (a secret was minted). Everything waiting is now covered by it. */
export function callStarted(state: PolicyState, now: number, items: readonly PolicyItem[]): PolicyState {
  return {
    ...state,
    callStartedAt: now,
    batchStartedAt: undefined,
    callbackAt: undefined,
    covered: union(state.covered, items.map((item) => item.id)),
    // Talked through on a call: no long-wait ring about it afterwards.
    overridden: union(state.overridden, items.map((item) => item.id)),
  };
}

/**
 * A call ended. Every reason feeds the cooldown; declined and missed also
 * snooze (`SNOOZE_MS`), since the user said "not now" or wasn't there.
 */
export function callEnded(state: PolicyState, now: number, reason?: wire.VoiceEnd["reason"]): PolicyState {
  const snooze = reason === "declined" || reason === "missed";
  return {
    ...state,
    callStartedAt: undefined,
    lastCallEndedAt: now,
    ...(snooze ? { snoozeUntil: now + SNOOZE_MS } : {}),
  };
}

/** Items the user has already seen: no ring about them, now or as a long wait. */
export function markSeen(state: PolicyState, ids: readonly string[]): PolicyState {
  if (ids.length === 0) return state;
  return { ...state, covered: union(state.covered, ids), overridden: union(state.overridden, ids) };
}

export function callMeBack(state: PolicyState, now: number, minutes: number): PolicyState {
  return { ...state, callbackAt: now + Math.max(0.5, minutes) * 60_000 };
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}

const minDefined = (...values: (number | undefined)[]) => {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length > 0 ? Math.min(...defined) : undefined;
};

/** Decide, given what is waiting right now. */
export function tick(
  input: PolicyState,
  now: number,
  items: readonly PolicyItem[],
  prefsIn: Partial<wire.VoicePrefsValues> | undefined,
): Decision {
  const prefs = withDefaults(prefsIn);
  const present = new Set(items.map((item) => item.id));
  // Forget what is gone, so state stays bounded and a re-raised id is new.
  let state: PolicyState = {
    ...input,
    rings: input.rings.filter((at) => now - at < HOUR_MS),
    covered: input.covered.filter((id) => present.has(id)),
    overridden: input.overridden.filter((id) => present.has(id)),
  };
  if (state.callStartedAt !== undefined && !callActive(state, now)) {
    state = callEnded(state, state.callStartedAt + STALE_CALL_MS);
  }

  if (state.snoozeUntil !== undefined && now >= state.snoozeUntil) state = { ...state, snoozeUntil: undefined };

  // "Call me back in 10 minutes" is a request, not a setting: it rings at
  // that time whether or not anything is waiting, with Ring me on or off,
  // through quiet hours and the pacing. It used to be dropped silently when
  // nothing was waiting, which is exactly when people ask for it. Held while
  // a call is on, and rung once that call is over.
  if (state.callbackAt !== undefined && !callActive(state, now)) {
    if (now < state.callbackAt) return { state, wakeAt: state.callbackAt };
    const ids = [...items].sort((a, b) => a.since - b.since || (a.id < b.id ? -1 : 1)).map((item) => item.id);
    return {
      state: {
        ...state,
        callbackAt: undefined,
        rings: [...state.rings, now],
        lastRingAt: now,
        covered: union(state.covered, ids),
        batchStartedAt: undefined,
      },
      ring: { itemIds: ids, reason: "callback" },
    };
  }

  if (prefs.mode !== "onthego" || ringExpired(prefs, now)) {
    return { state: { ...state, batchStartedAt: undefined } };
  }

  // During a call, whatever arrives joins it (the phone tells the model).
  if (callActive(state, now)) {
    return {
      state: {
        ...state,
        covered: union(state.covered, [...present]),
        overridden: union(state.overridden, [...present]),
        batchStartedAt: undefined,
      },
    };
  }

  // Quiet hours: what is waiting got its banner, so it never rings, then or after.
  if (inQuietHours(prefs.quietHours, now)) {
    return {
      state: {
        ...state,
        covered: union(state.covered, [...present]),
        overridden: union(state.overridden, [...present]),
        batchStartedAt: undefined,
      },
    };
  }

  if (items.length === 0) return { state: { ...state, batchStartedAt: undefined } };

  const ordered = [...items].sort((a, b) => a.since - b.since || (a.id < b.id ? -1 : 1));
  const allIds = ordered.map((item) => item.id);
  const fresh = ordered.filter((item) => !state.covered.includes(item.id));
  const capOpenAt =
    state.rings.length >= prefs.maxCallsPerHour
      ? (state.rings[state.rings.length - prefs.maxCallsPerHour] ?? now) + HOUR_MS
      : undefined;

  const ring = (reason: "batch" | "long_wait" | "callback", extra: Partial<PolicyState> = {}): Decision => ({
    state: {
      ...state,
      ...extra,
      rings: [...state.rings, now],
      lastRingAt: now,
      covered: union(state.covered, allIds),
      batchStartedAt: undefined,
    },
    ring: { itemIds: allIds, reason },
  });

  // Open a batch window on the first uncovered item.
  if (fresh.length > 0 && state.batchStartedAt === undefined) state = { ...state, batchStartedAt: now };
  if (fresh.length === 0) state = { ...state, batchStartedAt: undefined };

  const lastContact = Math.max(state.lastCallEndedAt ?? Number.NEGATIVE_INFINITY, state.lastRingAt ?? Number.NEGATIVE_INFINITY);
  const cooldownEndsAt = Number.isFinite(lastContact) ? lastContact + prefs.cooldownMinutes * 60_000 : undefined;
  const inCooldown = cooldownEndsAt !== undefined && now < cooldownEndsAt;

  // Snoozed: nothing rings, long waits included; look again when it ends.
  if (state.snoozeUntil !== undefined) return { state, wakeAt: state.snoozeUntil };

  // Long wait: rings through the cooldown, once per item. Not through the cap.
  const overdue = ordered.filter(
    (item) => now - item.since >= LONG_WAIT_MS && !state.overridden.includes(item.id),
  );
  const nextOverdueAt = minDefined(
    ...ordered.filter((item) => !state.overridden.includes(item.id)).map((item) => item.since + LONG_WAIT_MS),
  );

  const batchClosesAt =
    state.batchStartedAt !== undefined ? state.batchStartedAt + prefs.batchSeconds * 1000 : undefined;
  const batchReady = batchClosesAt !== undefined && now >= batchClosesAt;

  if (capOpenAt === undefined) {
    if (batchReady && !inCooldown) {
      return ring("batch", { overridden: union(state.overridden, overdue.map((item) => item.id)) });
    }
    if (overdue.length > 0) {
      return ring("long_wait", { overridden: union(state.overridden, overdue.map((item) => item.id)) });
    }
  }

  const wakeAt =
    capOpenAt !== undefined
      ? capOpenAt
      : minDefined(
          batchClosesAt === undefined ? undefined : Math.max(batchClosesAt, inCooldown ? (cooldownEndsAt ?? 0) : 0),
          nextOverdueAt,
        );
  return { state, ...(wakeAt !== undefined ? { wakeAt } : {}) };
}
