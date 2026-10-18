import { describe, expect, test } from "bun:test";
import { reconnectDelay } from "./daemonState";

describe("reconnectDelay", () => {
  test("doubles from one second", () => {
    expect([0, 1, 2, 3].map((n) => reconnectDelay(n, true))).toEqual([1000, 2000, 4000, 8000]);
  });
  test("caps at ten seconds on screen", () => {
    expect(reconnectDelay(4, true)).toBe(10_000);
    expect(reconnectDelay(20, true)).toBe(10_000);
  });
  test("backs off to a minute off screen, without slowing the first tries", () => {
    expect(reconnectDelay(0, false)).toBe(1000);
    expect(reconnectDelay(5, false)).toBe(32_000);
    expect(reconnectDelay(20, false)).toBe(60_000);
  });
});
