import { describe, expect, test } from "bun:test";
import {
  LONG_WAIT_MS,
  SNOOZE_MS,
  STALE_CALL_MS,
  callEnded,
  inQuietHours,
  localMinutes,
  markSeen,
  ringExpired,
  callMeBack,
  callStarted,
  initialState,
  tick,
  withDefaults,
  type PolicyState,
} from "./policy.js";

const S = 1000;
const M = 60 * S;
const T0 = 1_800_000_000_000;
/** Quiet hours off, so a test's verdict never depends on the clock's time of day. */
const ON = { mode: "onthego", quietHours: { on: false, from: 0, to: 0 } } as const;
const item = (id: string, since = T0) => ({ id, since });

/** Tick at `now` and return the decision. */
const at = (state: PolicyState, now: number, items = [item("a")], prefs: object = ON) =>
  tick(state, now, items, prefs);

describe("defaults", () => {
  test("notify mode, 90 s batch, 10 min cooldown, 4 per hour, no quiet hours, nothing armed by default", () => {
    expect(withDefaults(undefined)).toEqual({
      mode: "notify",
      batchSeconds: 90,
      cooldownMinutes: 10,
      maxCallsPerHour: 4,
      ringUntil: 0,
      quietHours: { on: false, from: 22 * 60, to: 8 * 60 },
      armNewSessions: false,
      ringScope: "all",
    });
  });
});

describe("modes", () => {
  test("off and notify never ring and never wake", () => {
    for (const mode of ["off", "notify"] as const) {
      const d = at(initialState(), T0 + 30 * M, [item("a")], { mode });
      expect(d.ring).toBeUndefined();
      expect(d.wakeAt).toBeUndefined();
    }
  });
});

describe("batch window", () => {
  test("a new item opens the window and wakes when it closes", () => {
    const d = at(initialState(), T0);
    expect(d.ring).toBeUndefined();
    expect(d.wakeAt).toBe(T0 + 90 * S);
    expect(d.state.batchStartedAt).toBe(T0);
  });

  test("one ring covers everything that arrived within the window", () => {
    let s = at(initialState(), T0).state;
    s = at(s, T0 + 30 * S, [item("a"), item("b", T0 + 30 * S)]).state;
    const d = at(s, T0 + 90 * S, [item("a"), item("b", T0 + 30 * S)]);
    expect(d.ring).toEqual({ itemIds: ["a", "b"], reason: "batch" });
    // and only once
    expect(at(d.state, T0 + 91 * S, [item("a"), item("b", T0 + 30 * S)]).ring).toBeUndefined();
  });

  test("batchSeconds 0 rings at once", () => {
    expect(at(initialState(), T0, [item("a")], { ...ON, batchSeconds: 0 }).ring?.reason).toBe("batch");
  });

  test("the window closes without a ring when everything was answered", () => {
    const s = at(initialState(), T0).state;
    const d = at(s, T0 + 90 * S, []);
    expect(d.ring).toBeUndefined();
    expect(d.state.batchStartedAt).toBeUndefined();
    expect(d.wakeAt).toBeUndefined();
  });
});

describe("one call at a time", () => {
  test("no ring during a call; new items join it", () => {
    let s = callStarted(initialState(), T0, [item("a")]);
    const d = at(s, T0 + 5 * M, [item("a"), item("b", T0 + M)]);
    expect(d.ring).toBeUndefined();
    expect(d.state.covered).toContain("b");
    s = callEnded(d.state, T0 + 6 * M);
    // b was covered by the call: nothing to ring about after it
    const after = at(s, T0 + 30 * M, [item("a"), item("b", T0 + M)]);
    expect(after.ring).toBeUndefined();
  });

  test("a call nobody ended stops blocking after an hour", () => {
    const s = callStarted(initialState(), T0, []);
    const later = T0 + STALE_CALL_MS + M;
    let d = at(s, later, [item("x", later)]);
    expect(d.state.callStartedAt).toBeUndefined();
    d = at(d.state, later + 10 * M, [item("x", later)]);
    expect(d.ring?.reason).toBe("batch");
  });
});

describe("cooldown", () => {
  test("after a call, a new batch waits for the cooldown to end", () => {
    let s = callEnded(callStarted(initialState(), T0, []), T0 + M);
    const t = T0 + 2 * M;
    s = at(s, t, [item("n", t)]).state;
    const d = at(s, t + 90 * S, [item("n", t)]);
    expect(d.ring).toBeUndefined();
    expect(d.wakeAt).toBe(T0 + M + 10 * M);
    expect(at(d.state, T0 + 11 * M, [item("n", t)]).ring?.reason).toBe("batch");
  });

  test("a missed or declined ring counts toward cooldown", () => {
    let d = at(initialState(), T0, [item("a")], { ...ON, batchSeconds: 0 });
    expect(d.ring).toBeDefined();
    const s = callEnded(d.state, T0 + 30 * S); // phone reported missed
    const t = T0 + M;
    d = at(s, t, [item("a"), item("b", t)], { ...ON, batchSeconds: 0 });
    expect(d.ring).toBeUndefined();
    expect(d.wakeAt).toBe(T0 + 30 * S + 10 * M);
  });

  test("a ring with no report back still starts the cooldown", () => {
    const d = at(initialState(), T0, [item("a")], { ...ON, batchSeconds: 0 });
    const t = T0 + 2 * M;
    expect(at(d.state, t, [item("a"), item("b", t)], { ...ON, batchSeconds: 0 }).ring).toBeUndefined();
  });
});

describe("long-wait override", () => {
  test("an item waiting over 15 min rings through the cooldown, once", () => {
    // rung (missed) at T0, cooldown long
    const prefs = { ...ON, batchSeconds: 0, cooldownMinutes: 60 };
    let d = at(initialState(), T0, [item("a")], prefs);
    expect(d.ring?.reason).toBe("batch");
    d = at(d.state, T0 + M, [item("a")], prefs);
    expect(d.wakeAt).toBe(T0 + LONG_WAIT_MS);
    d = at(d.state, T0 + LONG_WAIT_MS, [item("a")], prefs);
    expect(d.ring?.reason).toBe("long_wait");
    d = at(d.state, T0 + LONG_WAIT_MS + 5 * M, [item("a")], prefs);
    expect(d.ring).toBeUndefined();
  });

  test("an item talked through on a call gets no override ring", () => {
    const s = callEnded(callStarted(initialState(), T0, [item("a")]), T0 + M);
    expect(at(s, T0 + LONG_WAIT_MS + M, [item("a")]).ring).toBeUndefined();
  });
});

describe("max per hour", () => {
  test("caps rings in a rolling hour and wakes when a slot frees", () => {
    const prefs = { ...ON, batchSeconds: 0, cooldownMinutes: 0, maxCallsPerHour: 2 };
    let s = initialState();
    let d = at(s, T0, [item("a", T0)], prefs);
    expect(d.ring).toBeDefined();
    d = at(d.state, T0 + M, [item("b", T0 + M)], prefs);
    expect(d.ring).toBeDefined();
    d = at(d.state, T0 + 2 * M, [item("c", T0 + 2 * M)], prefs);
    expect(d.ring).toBeUndefined();
    expect(d.wakeAt).toBe(T0 + 60 * M);
    s = d.state;
    expect(at(s, T0 + 60 * M, [item("c", T0 + 2 * M)], prefs).ring).toBeDefined();
  });

  test("the cap also holds the long-wait override", () => {
    const prefs = { ...ON, batchSeconds: 0, cooldownMinutes: 0, maxCallsPerHour: 1 };
    const d = at(initialState(), T0, [item("a")], prefs);
    expect(at(d.state, T0 + LONG_WAIT_MS, [item("a")], prefs).ring).toBeUndefined();
  });
});

describe("call_me_back", () => {
  test("holds rings until the callback, then rings if something waits", () => {
    let s = callEnded(callStarted(initialState(), T0, [item("a")]), T0 + M);
    s = callMeBack(s, T0 + M, 20);
    const t = T0 + 2 * M;
    let d = at(s, t + 5 * M, [item("a"), item("b", t)]);
    expect(d.ring).toBeUndefined();
    expect(d.wakeAt).toBe(T0 + 21 * M);
    d = at(d.state, T0 + 21 * M, [item("a"), item("b", t)]);
    expect(d.ring).toEqual({ itemIds: ["a", "b"], reason: "callback" });
    expect(d.state.callbackAt).toBeUndefined();
  });

  test("rings even when nothing is waiting: they asked for the call", () => {
    const s = callMeBack(initialState(), T0, 5);
    const d = at(s, T0 + 5 * M, []);
    expect(d.ring).toEqual({ itemIds: [], reason: "callback" });
    expect(d.state.callbackAt).toBeUndefined();
  });

  test("rings with Ring me off, and through quiet hours and the hourly cap", () => {
    const off = { ...ON, mode: "notify" as const };
    expect(at(callMeBack(initialState(), T0, 1), T0 + M, [], off).ring?.reason).toBe("callback");
    const busy = { ...initialState(), rings: [T0 - 4 * M, T0 - 3 * M, T0 - 2 * M, T0 - M] };
    expect(at(callMeBack(busy, T0, 1), T0 + M, []).ring?.reason).toBe("callback");
  });

  test("calling Pew yourself before then replaces the callback: you're already talking", () => {
    let s = callMeBack(initialState(), T0, 1);
    s = callStarted(s, T0 + 30 * S, []);
    expect(at(s, T0 + M, []).ring).toBeUndefined();
    s = callEnded(s, T0 + 2 * M);
    expect(at(s, T0 + 2 * M, []).ring).toBeUndefined();
  });

  test("asked for during a call: rings once that call has ended", () => {
    let s = callStarted(initialState(), T0, []);
    s = callMeBack(s, T0 + 10 * S, 1);
    s = callEnded(s, T0 + 20 * S);
    expect(at(s, T0 + 50 * S, []).ring).toBeUndefined();
    expect(at(s, T0 + 10 * S + M, []).ring?.reason).toBe("callback");
  });

  test("half a minute is the shortest", () => {
    expect(callMeBack(initialState(), T0, 0.5).callbackAt).toBe(T0 + 30 * S);
    expect(callMeBack(initialState(), T0, 0).callbackAt).toBe(T0 + 30 * S);
  });

  test("ignores the cooldown", () => {
    let s = callEnded(callStarted(initialState(), T0, []), T0);
    s = callMeBack(s, T0, 1);
    expect(at(s, T0 + M, [item("a")]).ring?.reason).toBe("callback");
  });
});

test("state forgets items that are gone", () => {
  const d = at(initialState(), T0, [item("a")], { ...ON, batchSeconds: 0 });
  expect(at(d.state, T0 + S, []).state.covered).toEqual([]);
});

describe("ringUntil", () => {
  test("a passed ringUntil stops rings, as notify does", () => {
    const prefs = { ...ON, batchSeconds: 0, ringUntil: T0 + 10 * M };
    expect(at(initialState(), T0, [item("a")], prefs).ring?.reason).toBe("batch");
    const after = at(initialState(), T0 + 10 * M, [item("a")], prefs);
    expect(after.ring).toBeUndefined();
    expect(after.wakeAt).toBeUndefined();
  });

  test("0 means until switched off", () => {
    expect(ringExpired(withDefaults({ mode: "onthego", ringUntil: 0 }), T0 + 1000 * M)).toBe(false);
    expect(ringExpired(withDefaults({ mode: "onthego", ringUntil: T0 }), T0)).toBe(true);
    expect(ringExpired(withDefaults({ mode: "notify", ringUntil: T0 }), T0 + M)).toBe(false);
  });
});

describe("quiet hours", () => {
  // 2027-01-15 is a Friday; London is on UTC in January.
  const london = (hh: number, mm = 0) => Date.UTC(2027, 0, 15, hh, mm);
  const quiet = { on: true, from: 22 * 60, to: 8 * 60, tz: "Europe/London" };

  test("local minutes come from the phone's zone", () => {
    expect(localMinutes(london(23, 30), "Europe/London")).toBe(23 * 60 + 30);
    expect(localMinutes(london(23, 30), "Asia/Tokyo")).toBe(8 * 60 + 30);
  });

  test("a window past midnight, an empty window, and off", () => {
    expect(inQuietHours(quiet, london(23))).toBe(true);
    expect(inQuietHours(quiet, london(3))).toBe(true);
    expect(inQuietHours(quiet, london(8))).toBe(false);
    expect(inQuietHours(quiet, london(21, 59))).toBe(false);
    expect(inQuietHours({ ...quiet, from: 9 * 60, to: 17 * 60 }, london(12))).toBe(true);
    expect(inQuietHours({ ...quiet, from: 600, to: 600 }, london(10))).toBe(false);
    expect(inQuietHours({ ...quiet, on: false }, london(23))).toBe(false);
  });

  test("an unknown zone falls back to the computer's clock instead of throwing", () => {
    expect(() => localMinutes(T0, "Not/AZone")).not.toThrow();
  });

  test("no ring in quiet hours, and what arrived then never rings after", () => {
    const prefs = { mode: "onthego", batchSeconds: 0, quietHours: quiet } as const;
    const eve = Date.UTC(2027, 0, 14, 23);
    const night = at(initialState(), eve, [item("a", eve)], prefs);
    expect(night.ring).toBeUndefined();
    const morning = at(night.state, london(8, 30), [item("a", eve)], prefs);
    expect(morning.ring).toBeUndefined();
    // Something new in the morning rings as usual.
    const fresh = at(morning.state, london(8, 31), [item("a", eve), item("b", london(8, 31))], prefs);
    expect(fresh.ring?.itemIds).toEqual(["a", "b"]);
  });
});

describe("snooze", () => {
  test("declined or missed holds every ring for 30 min, long waits included", () => {
    for (const reason of ["declined", "missed"] as const) {
      const s = callEnded(initialState(), T0, reason);
      const prefs = { ...ON, batchSeconds: 0, cooldownMinutes: 0 };
      const d = at(s, T0 + M, [item("a", T0 - LONG_WAIT_MS)], prefs);
      expect(d.ring).toBeUndefined();
      expect(d.wakeAt).toBe(T0 + SNOOZE_MS);
      expect(at(d.state, T0 + SNOOZE_MS, [item("a", T0 - LONG_WAIT_MS)], prefs).ring).toBeDefined();
    }
  });

  test("a hang-up does not snooze; call_me_back still wins", () => {
    expect(callEnded(initialState(), T0, "hangup").snoozeUntil).toBeUndefined();
    const s = callMeBack(callEnded(initialState(), T0, "declined"), T0, 5);
    expect(at(s, T0 + 5 * M, [item("a")]).ring?.reason).toBe("callback");
  });
});

test("markSeen: no ring and no long-wait ring about what the user already saw", () => {
  const s = markSeen(initialState(), ["a"]);
  const prefs = { ...ON, batchSeconds: 0, cooldownMinutes: 0 };
  expect(at(s, T0 + LONG_WAIT_MS, [item("a")], prefs).ring).toBeUndefined();
});
