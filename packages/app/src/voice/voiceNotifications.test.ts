import { describe, expect, test } from "bun:test";
import {
  ACTION_REVIEW,
  ACTION_TALK,
  BATCH_MAX_MS,
  BATCH_QUIET_MS,
  DEFAULT_ACTION,
  JUST_HEARD_MS,
  VOICE_APPROVAL_CATEGORY,
  VOICE_CATEGORY,
  categoryFor,
  emptyBatch,
  flush,
  flushDueAt,
  offerEvent,
  parseVoicePush,
  routeVoiceResponse,
  suppressVoicePush,
  type Presence,
} from "./voiceNotifications";
import type { VoiceEvent } from "./types";

const event = (eventId: number, over: Partial<VoiceEvent> = {}): VoiceEvent => ({
  eventId,
  taskId: "t1",
  projectId: "p1",
  projectName: "pew2",
  kind: "task.completed",
  class: "completed",
  text: "Tests pass",
  at: eventId,
  ...over,
});
const away: Presence = {
  foreground: false,
  voiceActive: false,
  voiceSheetOpen: false,
  heardEventId: 0,
  pushExpected: false,
  now: 1000,
};

describe("routing", () => {
  const data = { type: "voice.callback", eventId: 7, taskId: "t1", projectId: "p1", class: "approval" };
  test("tap and Talk open voice with the focus", () => {
    const expected = { kind: "voice", source: "notification", focusEventId: 7, focusTaskId: "t1" } as const;
    expect(routeVoiceResponse(DEFAULT_ACTION, data)).toEqual(expected);
    expect(routeVoiceResponse(ACTION_TALK, data)).toEqual(expected);
  });
  test("Review opens the on-screen sheet, never decides", () => {
    expect(routeVoiceResponse(ACTION_REVIEW, data)).toEqual({ kind: "review", focusEventId: 7, focusTaskId: "t1" });
  });
  test("there is no action that approves or denies by itself", () => {
    for (const action of [DEFAULT_ACTION, ACTION_TALK, ACTION_REVIEW, "approve", "deny"]) {
      expect(["voice", "review"]).toContain(routeVoiceResponse(action, data)?.kind ?? "voice");
    }
  });
  test("other notifications are not ours", () => {
    expect(routeVoiceResponse(DEFAULT_ACTION, { sessionId: "s" })).toBeUndefined();
    expect(parseVoicePush({ type: "voice.callback", eventId: -1 })).toBeUndefined();
    expect(parseVoicePush(undefined)).toBeUndefined();
  });
  test("category by class", () => {
    expect(categoryFor("approval")).toBe(VOICE_APPROVAL_CATEGORY);
    expect(categoryFor("completed")).toBe(VOICE_CATEGORY);
  });
});

describe("offerEvent", () => {
  test("approval and blocked interrupt immediately", () => {
    const a = offerEvent(emptyBatch, event(1, { class: "approval", text: "Run rm?" }), away);
    expect(a.show?.title).toContain("needs your approval");
    expect(a.show?.category).toBe(VOICE_APPROVAL_CATEGORY);
    expect(offerEvent(emptyBatch, event(2, { class: "blocked" }), away).show).toBeDefined();
  });
  test("completed and informational wait", () => {
    const a = offerEvent(emptyBatch, event(1), away);
    expect(a.show).toBeUndefined();
    expect(a.state.pending.length).toBe(1);
    expect(flushDueAt(a.state)).toBe(1000 + BATCH_QUIET_MS);
  });
  test("a duplicate eventId is ignored", () => {
    const a = offerEvent(emptyBatch, event(1, { class: "approval" }), away);
    expect(offerEvent(a.state, event(1, { class: "approval" }), away).show).toBeUndefined();
  });
  test("nothing for what the user is hearing", () => {
    const a = offerEvent(emptyBatch, event(1, { class: "approval" }), { ...away, voiceActive: true });
    expect(a.show).toBeUndefined();
    expect(a.state.pending).toEqual([]);
  });
  test("nothing for what was just heard, or earlier than the heard cursor", () => {
    expect(offerEvent(emptyBatch, event(3, { class: "blocked" }), { ...away, heardEventId: 3 }).show).toBeUndefined();
    const justEnded = { ...away, voiceEndedAt: 1000 - JUST_HEARD_MS + 1 };
    expect(offerEvent(emptyBatch, event(4, { class: "blocked" }), justEnded).show).toBeUndefined();
    expect(offerEvent(emptyBatch, event(5, { class: "blocked" }), { ...away, voiceEndedAt: 1000 - JUST_HEARD_MS - 1 }).show).toBeDefined();
  });
  test("a backgrounded app with a working push stays quiet locally", () => {
    expect(offerEvent(emptyBatch, event(1, { class: "approval" }), { ...away, pushExpected: true }).show).toBeUndefined();
  });
  test("foreground: only urgent events, and not over an open voice sheet", () => {
    const fg = { ...away, foreground: true };
    expect(offerEvent(emptyBatch, event(1), fg).state.pending).toEqual([]);
    expect(offerEvent(emptyBatch, event(2, { class: "approval" }), fg).show).toBeDefined();
    expect(offerEvent(emptyBatch, event(3, { class: "approval" }), { ...fg, voiceSheetOpen: true }).show).toBeUndefined();
  });
  test("an urgent event supersedes waiting chatter for the same task", () => {
    const a = offerEvent(emptyBatch, event(1), away);
    const b = offerEvent(a.state, event(2, { class: "blocked" }), away);
    expect(b.state.pending).toEqual([]);
  });
});

describe("batching", () => {
  test("several quiet updates become one notice pointing at the newest", () => {
    let s = emptyBatch;
    s = offerEvent(s, event(1, { taskId: "a", projectName: "pew2" }), away).state;
    s = offerEvent(s, event(2, { taskId: "b", projectName: "pew2" }), { ...away, now: 5000 }).state;
    expect(flushDueAt(s)).toBe(5000 + BATCH_QUIET_MS);
    const out = flush(s, { ...away, now: 30000 });
    expect(out.show?.title).toBe("pew2");
    expect(out.show?.body).toBe("2 tasks finished. Tap to talk it through.");
    expect(out.show?.data.eventId).toBe(2);
    expect(out.state.pending).toEqual([]);
  });
  test("a lone update keeps its own text", () => {
    const s = offerEvent(emptyBatch, event(1), away).state;
    expect(flush(s, away).show?.body).toBe("Tests pass");
  });
  test("a steady trickle is still flushed by the max window", () => {
    let s = emptyBatch;
    for (let i = 1; i <= 8; i++) s = offerEvent(s, event(i, { taskId: `t${i}` }), { ...away, now: 1000 + i * 15000 }).state;
    expect(flushDueAt(s)).toBe(16000 + BATCH_MAX_MS);
  });
  test("what was heard while waiting is not announced", () => {
    const s = offerEvent(emptyBatch, event(1), away).state;
    expect(flush(s, { ...away, heardEventId: 1 }).show).toBeUndefined();
    expect(flush(s, { ...away, voiceActive: true }).show).toBeUndefined();
  });
  test("nothing waiting means no flush time", () => {
    expect(flushDueAt(emptyBatch)).toBeUndefined();
  });
});

describe("suppressVoicePush", () => {
  const data = { type: "voice.callback", eventId: 7, taskId: "t1", projectId: "p1", class: "completed" };
  test("swallowed while the user is in voice, or has heard it", () => {
    expect(suppressVoicePush(data, { ...away, foreground: true, voiceActive: true })).toBe(true);
    expect(suppressVoicePush(data, { ...away, foreground: true, heardEventId: 7 })).toBe(true);
    expect(suppressVoicePush(data, { ...away, foreground: true, voiceSheetOpen: true })).toBe(true);
  });
  test("shown otherwise, and non-voice data is never touched", () => {
    expect(suppressVoicePush(data, { ...away, foreground: true })).toBe(false);
    expect(suppressVoicePush({ sessionId: "s" }, { ...away, voiceActive: true })).toBe(false);
  });
});

describe("quiet hours", () => {
  const quiet = { ...away, quiet: true, quietAllowsUrgent: true };
  test("completions are held, decisions still show", () => {
    const done = event(1, { class: "completed" });
    expect(offerEvent(emptyBatch, done, quiet).state.pending).toEqual([]);
    expect(offerEvent(emptyBatch, event(2, { class: "approval" }), quiet).show).toBeDefined();
  });
  test("strict silences decisions too", () => {
    expect(offerEvent(emptyBatch, event(3, { class: "blocked" }), { ...quiet, quietAllowsUrgent: false }).show).toBeUndefined();
  });
});
