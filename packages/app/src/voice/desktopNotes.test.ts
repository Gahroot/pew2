import { expect, test } from "bun:test";
import type { DeskEntry } from "../deskActivity";
import { desktopActivityNotes } from "./desktopNotes";

const e = (over: Partial<DeskEntry> = {}): DeskEntry => ({
  providerId: "claude-code",
  agentSessionId: "a",
  cwd: "/Users/me/repo",
  state: "working",
  updatedAt: 1,
  ...over,
});
const names = (id: string) => (id === "claude-code" ? "Claude Code" : undefined);

test("start, finish, disappear; fallback name; no repeats", () => {
  expect(desktopActivityNotes([], [e({ title: "Fix login" })], names)).toEqual([
    "[Update] Claude Code in repo started working at the computer: Fix login.",
  ]);
  expect(desktopActivityNotes([e({ state: "idle" })], [e({ providerId: "codex" })], names)).toEqual(
    ["[Update] codex in repo started working at the computer."],
  );
  const done =
    "[Update] Claude Code in repo at the computer finished its turn. Tell the user briefly; call peek_session if they want detail.";
  expect(desktopActivityNotes([e()], [e({ state: "idle" })], names)).toEqual([done]);
  expect(desktopActivityNotes([e()], [], names)).toEqual([done]);
  expect(desktopActivityNotes([e()], [e()], names)).toEqual([]);
  expect(desktopActivityNotes([], [e({ state: "idle" })], names)).toEqual([]);
});
