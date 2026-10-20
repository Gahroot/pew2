import { expect, test } from "bun:test";
import { NEW_CLOCK, highlightRuns, learnPace, planWords, revealed, sayPosition, syllables, tickClock, voicedNow } from "./speechSync";

test("syllables, roughly", () => {
  expect(syllables("I")).toBe(1);
  expect(syllables("banana")).toBe(3);
  expect(syllables("make")).toBe(1);
  expect(syllables("table")).toBe(2);
  expect(syllables("tests,")).toBe(1);
  expect(syllables("42")).toBe(2);
});

test("words land on the clock by syllables, appearing whole", () => {
  const text = "Two things. Okay?";
  expect(planWords(text).map((w) => w.at)).toEqual([0, 1, 2]);
  expect(revealed(text, 0, 200)).toBe(0);
  expect(revealed(text, 1, 200)).toBe(3); // "Two"
  expect(revealed(text, 210, 200)).toBe(11); // "Two things."
  expect(revealed(text, 450, 200)).toBe(text.length);
});

test("the clock runs only while the voice sounds", () => {
  let clock = tickClock(NEW_CLOCK, 0, 0, 0);
  // 100 ms of speech at rms 0.1: energy = rms^2 * seconds.
  clock = tickClock(clock, 0.01 * 0.1, 0.1, 100);
  expect(Math.round(clock.voicedMs)).toBe(100);
  // 200 ms of silence.
  clock = tickClock(clock, 0.01 * 0.1 + 0.0000001, 0.3, 300);
  expect(Math.round(clock.voicedMs)).toBe(100);
  // A restarted stream (duration went back) re-bases, never jumps.
  clock = tickClock(clock, 0, 0, 400);
  expect(Math.round(clock.voicedMs)).toBe(100);
});

test("pace is learned within a human range", () => {
  expect(learnPace(175, 20, 3000)).toBe(162.5);
  expect(learnPace(175, 2, 3000)).toBe(175);
  expect(learnPace(175, 10, 10000)).toBe(237.5);
});

test("between samples the clock glides while the voice sounds, and stops when it doesn't", () => {
  let clock = tickClock(NEW_CLOCK, 0, 0, 0);
  clock = tickClock(clock, 0.01 * 0.05, 0.05, 50);
  expect(clock.voicing).toBe(true);
  expect(voicedNow(clock, 80)).toBe(clock.voicedMs + 30);
  expect(voicedNow(clock, 1000)).toBe(clock.voicedMs + 70);
  const quiet = tickClock(clock, 0.01 * 0.05, 0.1, 100);
  expect(voicedNow(quiet, 150)).toBe(quiet.voicedMs);
});

test("the sweep moves through a word with its syllables", () => {
  const text = "Two things.";
  expect(sayPosition(text, 0, 200)).toBe(0);
  expect(sayPosition(text, 100, 200)).toBeCloseTo(1.5);
  expect(sayPosition(text, 300, 200)).toBeCloseTo(4 + 3.5);
  expect(sayPosition(text, 2000, 200)).toBe(text.length);
});

test("highlight runs: lit behind the sweep, dim ahead, a soft edge between", () => {
  const runs = highlightRuns("abcdefghij", 5, 4, 4);
  expect(runs[0]).toEqual({ text: "abcd", level: 1 });
  expect(runs.at(-1)).toEqual({ text: "hij", level: 0 });
  expect(runs.map((r) => r.text).join("")).toBe("abcdefghij");
  expect(highlightRuns("abc", 99)).toEqual([{ text: "abc", level: 1 }]);
});
