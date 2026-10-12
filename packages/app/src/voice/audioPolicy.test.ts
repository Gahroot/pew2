import { describe, expect, test } from "bun:test";
import {
  DEACTIVATE,
  interruptionAction,
  routeChangeAction,
  routeLabel,
  voiceSessionConfig,
  type AudioRoute,
} from "./audioPolicy";

const airpods: AudioRoute = { output: "bluetooth", input: "bluetooth" };
const speaker: AudioRoute = { output: "builtin_speaker", input: "builtin_mic" };

describe("voiceSessionConfig", () => {
  const config = voiceSessionConfig();
  test("echo-cancelled duplex session", () => {
    expect(config.category).toBe("playAndRecord");
    expect(config.mode).toBe("voiceChat");
  });
  test("routes to bluetooth, falls back to speaker, interrupts others", () => {
    expect(config.options).toContain("allowBluetooth");
    expect(config.options).toContain("defaultToSpeaker");
    expect(config.options).toContain("interruptSpokenAudioAndMixWithOthers");
  });
});

test("deactivation notifies others so playback resumes", () => {
  expect(DEACTIVATE.notifyOthersOnDeactivation).toBe(true);
});

describe("routeChangeAction", () => {
  test("a headset disappearing ends the session instead of moving to the speaker", () => {
    expect(routeChangeAction("oldDeviceUnavailable", airpods, speaker)).toBe("end");
  });
  test("the speaker disappearing from under a speaker route is nothing", () => {
    expect(routeChangeAction("oldDeviceUnavailable", speaker, speaker)).toBe("ignore");
  });
  test("headset swapped for another headset keeps going", () => {
    expect(routeChangeAction("oldDeviceUnavailable", airpods, { output: "wired", input: "wired" })).toBe("ignore");
  });
  test("a new device reconfigures so it is picked up", () => {
    expect(routeChangeAction("newDeviceAvailable", speaker, airpods)).toBe("reconfigure");
  });
  test("our own category changes are ignored (no feedback loop)", () => {
    expect(routeChangeAction("categoryChange", speaker, speaker)).toBe("ignore");
  });
});

test("interruptions", () => {
  expect(interruptionAction("began", true)).toEqual({ kind: "suspend" });
  expect(interruptionAction("ended", true)).toEqual({ kind: "resume", resume: true });
  expect(interruptionAction("ended", false)).toEqual({ kind: "resume", resume: false });
});

test("routeLabel", () => {
  expect(routeLabel(airpods)).toBe("Headset");
  expect(routeLabel(undefined)).toBe("");
});
