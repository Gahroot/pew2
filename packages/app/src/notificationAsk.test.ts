import { describe, expect, test } from "bun:test";
import { SNOOZE_MS, alertStatus, alertsRowValue, askDecision, cardMode, parseDismissedAt } from "./notificationAsk";

const NOW = 1_800_000_000_000;

describe("alertStatus", () => {
  test("granted wins", () => expect(alertStatus({ granted: true, canAskAgain: false })).toBe("granted"));
  test("can still ask = undetermined", () => expect(alertStatus({ granted: false, canAskAgain: true, status: "undetermined" })).toBe("undetermined"));
  test("refused = denied", () => expect(alertStatus({ granted: false, canAskAgain: false, status: "denied" })).toBe("denied"));
  test("denied status beats canAskAgain", () => expect(alertStatus({ granted: false, canAskAgain: true, status: "denied" })).toBe("denied"));
});

describe("askDecision", () => {
  test("granted registers on every trigger", () => {
    for (const trigger of ["send", "ring", "row"] as const) expect(askDecision({ status: "granted", trigger, now: NOW })).toBe("register");
  });
  test("first send asks", () => expect(askDecision({ status: "undetermined", trigger: "send", now: NOW })).toBe("card"));
  test("Not now holds for 7 days on send", () => {
    expect(askDecision({ status: "undetermined", trigger: "send", dismissedAt: NOW - SNOOZE_MS + 1, now: NOW })).toBe("none");
    expect(askDecision({ status: "undetermined", trigger: "send", dismissedAt: NOW - SNOOZE_MS, now: NOW })).toBe("card");
  });
  test("a dismissal in the future (clock moved) does not snooze forever", () =>
    expect(askDecision({ status: "undetermined", trigger: "send", dismissedAt: NOW + 1000, now: NOW })).toBe("card"));
  test("send never nags once iOS refused", () => expect(askDecision({ status: "denied", trigger: "send", now: NOW })).toBe("none"));
  test("ring and row ignore the snooze", () => {
    expect(askDecision({ status: "undetermined", trigger: "ring", dismissedAt: NOW, now: NOW })).toBe("card");
    expect(askDecision({ status: "denied", trigger: "row", dismissedAt: NOW, now: NOW })).toBe("card");
  });
});

test("cardMode", () => {
  expect(cardMode("denied")).toBe("settings");
  expect(cardMode("undetermined")).toBe("allow");
});

test("alertsRowValue", () => {
  expect(alertsRowValue("granted")).toBe("On");
  expect(alertsRowValue("denied")).toBe("Off");
  expect(alertsRowValue("undetermined")).toBe("Not set");
  expect(alertsRowValue(undefined)).toBe("Not set");
});

test("parseDismissedAt", () => {
  expect(parseDismissedAt(null)).toBeUndefined();
  expect(parseDismissedAt("junk")).toBeUndefined();
  expect(parseDismissedAt(String(NOW))).toBe(NOW);
});
