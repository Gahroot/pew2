import { expect, test } from "bun:test";
import { turnFinished } from "./turnFinished";

const f = (busy: boolean, sessionId: string | undefined = "a", loading = false) => ({ busy, sessionId, loading });

test("a reply finishing on screen chimes", () => {
  expect(turnFinished(f(true), f(false))).toBe(true);
});

test("opening a conversation never chimes (busy while its history loads)", () => {
  expect(turnFinished(f(true, "a", true), f(false, "a", false))).toBe(false);
});

test("switching away from a working conversation never chimes", () => {
  expect(turnFinished(f(true, "a"), f(false, "b"))).toBe(false);
  expect(turnFinished(f(true, "a"), { busy: false, sessionId: undefined, loading: false })).toBe(false);
});

test("nothing on the first frame, nor while still busy", () => {
  expect(turnFinished(undefined, f(false))).toBe(false);
  expect(turnFinished(f(true), f(true))).toBe(false);
  expect(turnFinished(f(false), f(false))).toBe(false);
});
