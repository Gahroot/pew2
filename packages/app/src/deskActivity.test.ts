import { expect, test } from "bun:test";
import { mergeAgentSessions } from "./agentHistory";
import { applyDesktopActivity, readDesktopActivity, type DeskEntry } from "./deskActivity";
import type { Session } from "./daemonTypes";

const providers = [{ id: "claude-code" }];
const entry = (over: Partial<DeskEntry> = {}): DeskEntry => ({
  providerId: "claude-code",
  agentSessionId: "abc",
  cwd: "/repo",
  state: "working",
  updatedAt: 50,
  ...over,
});
const row = (over: Partial<Session> = {}): Session => ({
  id: "agent:claude-code:abc",
  providerId: "claude-code",
  title: "T",
  startedAt: 10,
  turns: [],
  configOptions: [],
  agentSessionId: "abc",
  ...over,
});

test("readDesktopActivity drops malformed entries and ignores other frames", () => {
  expect(readDesktopActivity({ t: "providers" })).toBeUndefined();
  expect(readDesktopActivity(null)).toBeUndefined();
  expect(
    readDesktopActivity({
      t: "desktop.activity",
      sessions: [entry(), { providerId: 1 }, { ...entry(), state: "x" }, "no"],
    }),
  ).toEqual([entry()]);
});

test("marks matching rows, clears the rest, keeps identity", () => {
  const a = row();
  const b = row({ id: "b", agentSessionId: "other", deskBusy: true });
  const c = row({ id: "c", agentSessionId: undefined });
  const next = applyDesktopActivity([a, b, c], providers, [entry()], 0);
  expect(next[0]?.deskBusy).toBe(true);
  expect(next[1]?.deskBusy).toBeUndefined();
  expect(next[2]).toBe(c);
  expect(applyDesktopActivity(next, providers, [entry()], 0)).toEqual(next);
  const same = applyDesktopActivity(next, providers, [entry({ agentSessionId: "abc" })], 0);
  expect(same[0]).toBe(next[0]);
});

test("same array when nothing changed; provider must match", () => {
  const list = [row()];
  expect(applyDesktopActivity(list, providers, [entry({ state: "idle" })], 0)).toBe(list);
  expect(applyDesktopActivity(list, providers, [entry({ providerId: "codex" })], 0)).toBe(list);
});

test("unknown working conversation becomes a stub a later probe does not duplicate", () => {
  const added = applyDesktopActivity(
    [row({ id: "x", agentSessionId: "x", startedAt: 100 })],
    providers,
    [entry({ title: "Fix it" })],
    0,
  );
  expect(added).toHaveLength(2);
  expect(added[1]).toMatchObject({
    id: "agent:claude-code:abc",
    title: "Fix it",
    startedAt: 50,
    cwd: "/repo",
    deskBusy: true,
    turns: [],
  });
  const merged = mergeAgentSessions(
    added,
    "claude-code",
    [{ sessionId: "abc", cwd: "/repo", title: "Fix it" }],
    true,
  );
  expect(merged).toBe(added);
  expect(merged.find((s) => s.agentSessionId === "abc")?.deskBusy).toBe(true);
  expect(applyDesktopActivity([], [{ id: "codex" }], [entry()], 0)).toEqual([]);
});
