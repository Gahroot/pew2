import { expect, test } from "bun:test";
import { devStep, gate, INSTALL_COMMAND, nextStep, PAIR_COMMAND, parseProgress, previousStep, SETUP_COMMAND, STEPS } from "./onboarding";

test("order is welcome → alerts → install → pair → voice → done", () => {
  expect([...STEPS]).toEqual(["welcome", "alerts", "install", "pair", "voice", "done"]);
  expect(nextStep("welcome")).toBe("alerts");
  expect(nextStep("pair")).toBe("voice");
  expect(nextStep("done")).toBeUndefined();
});

test("a first run starts at welcome", () => {
  expect(gate(undefined, false)).toEqual({ step: "welcome", repair: false });
});

test("an existing paired user never sees onboarding", () => {
  expect(gate(undefined, true)).toEqual({ step: undefined, repair: false });
  expect(gate("finished", true)).toEqual({ step: undefined, repair: false });
});

test("after a forget, back to Welcome, the first state", () => {
  expect(gate("finished", false)).toEqual({ step: "welcome", repair: false });
});

test("the pair-only step still leads straight to the app", () => {
  expect(nextStep("pair", true)).toBeUndefined();
  expect(previousStep("pair", true)).toBeUndefined();
});

test("a relaunch resumes the stored step", () => {
  expect(gate("install", false).step).toBe("install");
  expect(gate("voice", true).step).toBe("voice");
  expect(gate("done", true).step).toBe("done");
});

test("steps after pair need a pairing; steps before it are skipped with one", () => {
  expect(gate("voice", false).step).toBe("pair");
  expect(gate("alerts", true).step).toBe("voice");
});

test("back exists only before and on pair", () => {
  expect(previousStep("welcome")).toBeUndefined();
  expect(previousStep("alerts")).toBe("welcome");
  expect(previousStep("pair")).toBe("install");
  expect(previousStep("voice")).toBeUndefined();
});

test("stored and dev values are validated", () => {
  expect(parseProgress("pair")).toBe("pair");
  expect(parseProgress("finished")).toBe("finished");
  expect(parseProgress("nope")).toBeUndefined();
  expect(parseProgress(null)).toBeUndefined();
  expect(devStep("voice")).toBe("voice");
  expect(devStep(undefined)).toBeUndefined();
});

test("the commands run in the real order: install, setup, then pair (which shows the QR)", () => {
  expect(INSTALL_COMMAND).toContain("install.sh | sh");
  expect(SETUP_COMMAND).toBe("pew2 setup");
  expect(PAIR_COMMAND).toBe("pew2 pair");
});
