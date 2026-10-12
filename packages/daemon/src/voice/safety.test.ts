import { expect, test } from "bun:test";
import {
  ConfirmationTokens,
  classifyRisk,
  needsConfirmation,
  needsExplicitApproval,
  pickOption,
  redactSecrets,
  speakable,
} from "./safety.js";

test("secrets are scrubbed", () => {
  const dirty =
    "key sk-abcdefghijklmnopqrstuvwx and ghp_abcdefghijklmnopqrstuv and OPENAI_API_KEY=hunter2 " +
    "postgres://bob:pw@db/x and Bearer abcdefghijklmnop1234";
  const clean = redactSecrets(dirty);
  for (const leak of ["sk-abc", "ghp_abc", "hunter2", "bob:pw", "abcdefghijklmnop1234"]) {
    expect(clean).not.toContain(leak);
  }
});

test("speakable drops code, paths and length", () => {
  const out = speakable("Done.\n```ts\nconst secret = 1;\n```\nSee /home/me/proj/src/App.tsx " + "x ".repeat(300), 80);
  expect(out).not.toContain("const secret");
  expect(out).not.toContain("/home/me");
  expect(out.length).toBeLessThanOrEqual(82);
  expect(speakable(undefined)).toBe("");
});

test("risk tiers from tool kind and command text", () => {
  expect(classifyRisk({ kind: "read" })).toBe("read");
  expect(classifyRisk({ kind: "edit" })).toBe("edit");
  expect(classifyRisk({ kind: "execute", rawInput: { command: "npm test" } })).toBe("shell");
  expect(classifyRisk({ kind: "execute", rawInput: { command: "git merge main" } })).toBe("merge");
  expect(classifyRisk({ kind: "execute", rawInput: { command: "wrangler deploy" } })).toBe("deploy");
  expect(classifyRisk({ kind: "execute", rawInput: { command: "rm -rf build" } })).toBe("destructive");
  expect(classifyRisk({ kind: "execute", title: "git push --force origin main" })).toBe("destructive");
  expect(classifyRisk({ kind: "delete" })).toBe("destructive");
  expect(classifyRisk({})).toBe("shell");
});

test("approval policy", () => {
  expect(needsExplicitApproval("edit")).toBe(false);
  expect(needsExplicitApproval("shell")).toBe(true);
  expect(needsExplicitApproval("shell", { shellNeedsApproval: false })).toBe(false);
  expect(needsExplicitApproval("deploy")).toBe(true);
  expect(needsConfirmation("shell")).toBe(false);
  expect(needsConfirmation("destructive")).toBe(true);
});

test("approve picks allow_once, never an always option", () => {
  const options = [
    { optionId: "a", kind: "allow_always" },
    { optionId: "b", kind: "allow_once" },
    { optionId: "c", kind: "reject_once" },
  ];
  expect(pickOption(options, "approve")?.optionId).toBe("b");
  expect(pickOption(options, "deny")?.optionId).toBe("c");
  expect(pickOption([{ optionId: "a", kind: "allow_always" }], "approve")).toBeUndefined();
});

test("confirmation tokens are single-use, subject-bound and expire", () => {
  let now = 0;
  const tokens = new ConfirmationTokens(() => now, 1000);
  const t = tokens.issue("a");
  expect(tokens.redeem(t, "b")).toBe(false);
  expect(tokens.redeem(t, "a")).toBe(false); // consumed by the failed attempt
  const u = tokens.issue("a");
  expect(tokens.redeem(u, "a")).toBe(true);
  expect(tokens.redeem(u, "a")).toBe(false);
  const v = tokens.issue("a");
  now = 2000;
  expect(tokens.redeem(v, "a")).toBe(false);
  expect(tokens.redeem(undefined, "a")).toBe(false);
});
