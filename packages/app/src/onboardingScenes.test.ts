import { expect, test } from "bun:test";
import { ALERT_EVERY_MS, SAMPLE_ALERTS, INSTALL_TYPE, PAIR_TYPE, alertsAt, alertsMood, installAt, voiceAt } from "./onboardingScenes";

test("banners arrive one at a time, newest first, a stack of three at most", () => {
  expect(alertsAt(0).map((a) => a.index)).toEqual([0]);
  expect(alertsAt(ALERT_EVERY_MS * 3 + 10).map((a) => a.index)).toEqual([3, 2, 1]);
  expect(alertsAt(ALERT_EVERY_MS * 4).at(0)?.alert).toEqual(alertsAt(0).at(0)?.alert);
  expect(alertsMood(10)).toBe("talking");
  expect(alertsMood(ALERT_EVERY_MS - 10)).toBe("happy");
});

test("install: setup answers, then pair types and shows the code, then links", () => {
  expect(installAt(0)).toMatchObject({ typed: 0, setupDone: false, pairTyped: 0, qr: false, mood: "typing" });
  expect(installAt(1600)).toMatchObject({ typed: INSTALL_TYPE.length, setupDone: false });
  expect(installAt(2400)).toMatchObject({ setupDone: true, pairTyped: 0 });
  expect(installAt(3700).pairTyped).toBe(PAIR_TYPE.length);
  expect(installAt(4200)).toMatchObject({ qr: true, linking: false, mood: "happy" });
  expect(installAt(4800)).toMatchObject({ linking: true, mood: "reading" });
  expect(installAt(7600 + 100)).toMatchObject({ typed: 0, qr: false });
});

test("voice: Pew talks, then listens", () => {
  expect(voiceAt(100)).toEqual({ userSpeaking: false, mood: "talking" });
  expect(voiceAt(2100)).toEqual({ userSpeaking: true, mood: "listening" });
});

test("the sample banners use the real notification wording", () => {
  expect(SAMPLE_ALERTS[0]).toEqual({ title: "storefront · Claude Code", body: "Added the cart tests. All 42 pass." });
  expect(SAMPLE_ALERTS[1]?.body).toBe("Needs your OK to run: npm run migrate");
  expect(SAMPLE_ALERTS[3]?.body.startsWith("Asks: ")).toBe(true);
});
