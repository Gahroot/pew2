import { describe, expect, test } from "bun:test";
import { backoffMs, OFFLINE_GRACE_MS, onNetworkLost, onNetworkRestored } from "./connectivity";

describe("connectivity", () => {
  test("announces only when audio is live", () => {
    expect(onNetworkLost("listening", false)).toEqual({ kind: "hold", graceMs: OFFLINE_GRACE_MS, announce: true });
    expect(onNetworkLost("connecting", false)).toEqual({ kind: "hold", graceMs: OFFLINE_GRACE_MS, announce: false });
    expect(onNetworkLost("idle", false)).toEqual({ kind: "ignore" });
    expect(onNetworkLost("speaking", true)).toEqual({ kind: "ignore" });
  });
  test("resumes only a held conversation", () => {
    expect(onNetworkRestored(false, "listening")).toEqual({ kind: "ignore" });
    expect(onNetworkRestored(true, "error")).toEqual({ kind: "ignore" });
    expect(onNetworkRestored(true, "connecting")).toEqual({ kind: "resume", sync: true });
  });
  test("backoff doubles, caps, jitters down", () => {
    expect([1, 2, 3].map((a) => backoffMs(a))).toEqual([1000, 2000, 4000]);
    expect(backoffMs(20)).toBe(30000);
    expect(backoffMs(1, 1000, 30000, 1)).toBe(750);
  });
});
