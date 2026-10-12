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

import { cueFor, shouldResumeAfterInterruption } from "./audioPolicy";
import { describe as d2, expect as e2, test as t2 } from "bun:test";

d2("cues", () => {
  t2("low priority never takes the audio", () => {
    e2(cueFor("batch", { audioLive: false, foreground: true, quiet: false })).toBe("haptic");
    e2(cueFor("batch", { audioLive: false, foreground: false, quiet: false })).toBe("none");
    e2(cueFor("silent", { audioLive: true, foreground: true, quiet: false })).toBe("none");
    e2(cueFor("interrupt", { audioLive: true, foreground: true, quiet: true })).toBe("speak");
    e2(cueFor("interrupt", { audioLive: false, foreground: true, quiet: true })).toBe("none");
  });
  t2("session ducks and interrupts spoken audio", () => {
    e2(voiceSessionConfig().options).toContain("duckOthers");
    e2(shouldResumeAfterInterruption(true, true)).toBe(false);
  });
});
