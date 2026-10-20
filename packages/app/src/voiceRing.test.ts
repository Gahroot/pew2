import { describe, expect, test } from "bun:test";
import type { wire } from "@pew2/protocol";
import {
  armedCount,
  armingSupported,
  callsLine,
  isArmed,
  ringScope,
  scopeSupported,
  ringPatch,
  ringTimeLeft,
  ringing,
  selectedRing,
} from "./voiceRing";

const T0 = 1_800_000_000_000;
const M = 60_000;
const status = (extra: object = {}) => ({ t: "voice.status" as const, available: true, ...extra });

describe("the ring switch", () => {
  test("choices map to prefs; off is notify", () => {
    expect(ringPatch("off", T0)).toEqual({ mode: "notify", ringUntil: 0 });
    expect(ringPatch("1h", T0)).toEqual({ mode: "onthego", ringUntil: T0 + 60 * M });
    expect(ringPatch("always", T0)).toEqual({ mode: "onthego", ringUntil: 0 });
  });

  test("an expired ringUntil reads as off before the daemon says so", () => {
    const prefs = { mode: "onthego" as const, ringUntil: T0 };
    expect(ringing(prefs, T0 - 1)).toBe(true);
    expect(ringing(prefs, T0)).toBe(false);
    expect(selectedRing(prefs, T0)).toBe("off");
  });

  test("selected choice and time left", () => {
    expect(selectedRing(undefined, T0)).toBe("off");
    expect(selectedRing({ mode: "onthego" }, T0)).toBe("always");
    expect(selectedRing({ mode: "onthego", ringUntil: T0 + 150 * M }, T0)).toBe("3h");
    expect(selectedRing({ mode: "onthego", ringUntil: T0 + 40 * M }, T0)).toBe("1h");
    expect(ringTimeLeft({ mode: "onthego", ringUntil: T0 + 134 * M }, T0)).toBe("2h 14m left");
    expect(ringTimeLeft({ mode: "onthego", ringUntil: T0 + 40 * M }, T0)).toBe("40m left");
    expect(ringTimeLeft({ mode: "onthego", ringUntil: T0 + 20_000 }, T0)).toBe("<1m left");
    expect(ringTimeLeft({ mode: "onthego" }, T0)).toBeUndefined();
  });
});

describe("arming", () => {
  test("an older daemon sends no armed list", () => {
    expect(armingSupported(status())).toBe(false);
    expect(armingSupported(status({ armed: [] }))).toBe(true);
  });

  test("armed only until its expiry", () => {
    const s = status({ armed: [{ sessionId: "a", until: T0 + M }] });
    expect(isArmed(s, "a", T0)).toBe(true);
    expect(isArmed(s, "a", T0 + M)).toBe(false);
    expect(isArmed(s, "b", T0)).toBe(false);
    expect(isArmed(s, undefined, T0)).toBe(false);
    expect(armedCount(s, T0)).toBe(1);
  });


});

describe("which chats ring", () => {
  const status = (prefs: Partial<wire.VoicePrefsValues> | undefined, extra: Partial<wire.VoiceStatus> = {}) =>
    ({ available: true, prefs: prefs ? { mode: "notify", ...prefs } : undefined, ...extra }) as wire.VoiceStatus;
  test("a new daemon says; an older one only knows chosen chats", () => {
    expect(ringScope({ mode: "onthego", ringScope: "all" })).toBe("all");
    expect(ringScope({ mode: "onthego" })).toBe("chosen");
    expect(scopeSupported({ mode: "onthego" })).toBe(false);
    expect(scopeSupported({ mode: "onthego", ringScope: "chosen" })).toBe(true);
  });
  test("the settings row says what calls will do, in one short line", () => {
    const now = 1_000_000;
    expect(callsLine(status({ mode: "notify" }), now)).toBe("Ring me off");
    expect(callsLine(status({ mode: "onthego", ringUntil: 0 }), now)).toBe("Ring me on");
    expect(callsLine(status({ mode: "onthego", ringUntil: now + 40 * 60_000 }), now)).toBe("Ring me on · 40m left");
    expect(callsLine(status(undefined, { available: false, canLogin: true }), now)).toBe("Sign in to OpenAI");
  });
});
