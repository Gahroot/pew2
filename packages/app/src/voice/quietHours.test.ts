import { describe, expect, test } from "bun:test";
import { allowedDuringQuiet, decodeQuietHours, DEFAULT_QUIET_HOURS, encodeQuietHours, inQuietHours, tierOf } from "./quietHours";

const at = (h: number, m = 0) => new Date(2026, 0, 5, h, m);
const night = { enabled: true, startMin: 22 * 60, endMin: 7 * 60, strict: false };

describe("quiet hours", () => {
  test("window crossing midnight", () => {
    expect(inQuietHours(night, at(23))).toBe(true);
    expect(inQuietHours(night, at(3))).toBe(true);
    expect(inQuietHours(night, at(7))).toBe(false);
    expect(inQuietHours(night, at(12))).toBe(false);
  });
  test("same-day window and disabled/empty", () => {
    const day = { ...night, startMin: 9 * 60, endMin: 17 * 60 };
    expect(inQuietHours(day, at(10))).toBe(true);
    expect(inQuietHours(day, at(18))).toBe(false);
    expect(inQuietHours({ ...night, enabled: false }, at(23))).toBe(false);
    expect(inQuietHours({ ...night, endMin: night.startMin }, at(23))).toBe(false);
  });
  test("urgent passes unless strict", () => {
    expect(allowedDuringQuiet(night, "approval", at(23))).toBe(true);
    expect(allowedDuringQuiet(night, "completed", at(23))).toBe(false);
    expect(allowedDuringQuiet({ ...night, strict: true }, "blocked", at(23))).toBe(false);
    expect(allowedDuringQuiet(night, "completed", at(12))).toBe(true);
  });
  test("tiers", () => {
    expect(tierOf("approval")).toBe("interrupt");
    expect(tierOf("completed")).toBe("batch");
    expect(tierOf("informational")).toBe("silent");
  });
  test("codec tolerates junk", () => {
    expect(decodeQuietHours(null)).toEqual(DEFAULT_QUIET_HOURS);
    expect(decodeQuietHours("{nope")).toEqual(DEFAULT_QUIET_HOURS);
    expect(decodeQuietHours(encodeQuietHours(night))).toEqual(night);
    expect(decodeQuietHours('{"enabled":true,"startMin":99999}').startMin).toBe(1439);
  });
});
