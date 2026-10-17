import { expect, test } from "bun:test";
import { sessionMark } from "./sessionMark";

test("desk-running counts as live; permission still wins", () => {
  expect(sessionMark({ deskBusy: true })).toBe("live");
  expect(sessionMark({ deskBusy: true, permission: {} })).toBe("attention");
  expect(sessionMark({ unread: true })).toBe("unread");
  expect(sessionMark({})).toBeUndefined();
});
