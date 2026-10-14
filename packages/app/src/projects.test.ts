import { describe, expect, test } from "bun:test";
import {
  placeTitle,
  projectFor,
  projectTabItems,
  projectLabel,
  projectsForProvider,
  projectSourceKey,
  projectTitle,
  readWorktree,
  sessionsInProject,
} from "./projects";
import type { Session } from "./useDaemon";

function session(partial: Partial<Session> & { id: string }): Session {
  return {
    providerId: "claude-code",
    title: "A conversation",
    startedAt: 0,
    turns: [],
    configOptions: [],
    ...partial,
  };
}

test("the daemon's list is used as announced, newest project first", () => {
  const projects = projectsForProvider(
    [
      { path: "/a/site", name: "site", sessions: 2, updatedAt: "2026-07-01T00:00:00Z" },
      { path: "/a/pew2", name: "pew2", sessions: 9, updatedAt: "2026-08-01T00:00:00Z" },
    ],
    [],
    "claude-code",
  );

  expect(projects.map((p) => p.name)).toEqual(["pew2", "site"]);
  expect(projects[0]!.sessions).toBe(9);
});

test("a project seen only in the sessions on screen is still offered", () => {
  const projects = projectsForProvider(
    [],
    [session({ id: "1", cwd: "/a/fresh" })],
    "claude-code",
  );

  expect(projects.map((p) => p.name)).toEqual(["fresh"]);
});

test("a project used a minute ago sorts above the agent's dated ones", () => {
  // It has no announced stamp of its own, and undated would put the most
  // recent work last in a menu that promises newest first.
  const projects = projectsForProvider(
    [{ path: "/a/old", name: "old", updatedAt: "2020-01-01T00:00:00Z" }],
    [session({ id: "1", cwd: "/a/fresh", startedAt: Date.now() })],
    "claude-code",
  );

  expect(projects.map((p) => p.name)).toEqual(["fresh", "old"]);
});

test("another agent's projects are never offered under this one", () => {
  const projects = projectsForProvider(
    [],
    [session({ id: "1", cwd: "/a/other", providerId: "codex" })],
    "claude-code",
  );

  expect(projects).toEqual([]);
});

test("a project in both sources is listed once, keeping the daemon's count", () => {
  const projects = projectsForProvider(
    [{ path: "/a/pew2", name: "pew2", sessions: 12 }],
    [session({ id: "1", cwd: "/a/pew2" })],
    "claude-code",
  );

  expect(projects).toHaveLength(1);
  expect(projects[0]!.sessions).toBe(12);
});

test("choosing a project keeps only its conversations", () => {
  const sessions = [
    session({ id: "1", cwd: "/a/pew2" }),
    session({ id: "2", cwd: "/a/site" }),
  ];

  const kept = sessionsInProject(sessions, { path: "/a/pew2", name: "pew2" });
  expect(kept.map((s) => s.id)).toEqual(["1"]);
});

test("a conversation started on this phone matches by the folder the daemon stamped", () => {
  // It never had a `cwd` of its own; without this fallback it would vanish out
  // of the very project it was started in.
  const local = session({ id: "1", folder: "pew2" });

  expect(sessionsInProject([local], { path: "/a/pew2", name: "pew2" })).toHaveLength(1);
  expect(sessionsInProject([local], { path: "/a/site", name: "site" })).toHaveLength(0);
});

test("a session with neither path nor folder is not claimed by a project", () => {
  expect(sessionsInProject([session({ id: "1" })], { path: "/a/pew2", name: "pew2" })).toEqual([]);
});

test("no choice shows everything", () => {
  const sessions = [session({ id: "1", cwd: "/a/pew2" }), session({ id: "2" })];
  expect(sessionsInProject(sessions, undefined)).toHaveLength(2);
});

test("the control always has a label", () => {
  expect(projectLabel(undefined)).toBe("All projects");
  expect(projectLabel({ path: "/a/pew2", name: "pew2" })).toBe("pew2");
});

test("the memo key ignores a streamed chunk landing on a session's turns", () => {
  // The exact case this exists for: a chunk arrives, the sessions array is
  // rebuilt with new turns on the active session, and the project list is
  // unaffected. A changed key here would put the sort back on every chunk.
  const before = [session({ id: "1", cwd: "/a/pew2" })];
  const after = [session({ id: "1", cwd: "/a/pew2", turns: [{ id: "t1" }] as never })];

  expect(projectSourceKey(after, "claude-code")).toBe(projectSourceKey(before, "claude-code"));
});

test("the memo key changes when a session introduces a new project", () => {
  const before = [session({ id: "1", cwd: "/a/pew2" })];
  const after = [...before, session({ id: "2", cwd: "/a/site" })];

  expect(projectSourceKey(after, "claude-code")).not.toBe(
    projectSourceKey(before, "claude-code"),
  );
});

test("the memo key is scoped to one agent", () => {
  // Another agent's conversations cannot change this agent's project list, so
  // they must not invalidate it either.
  const sessions = [
    session({ id: "1", cwd: "/a/pew2" }),
    session({ id: "2", cwd: "/a/site", providerId: "codex" }),
  ];

  expect(projectSourceKey(sessions, "claude-code")).toBe(
    projectSourceKey([sessions[0]!], "claude-code"),
  );
});

test("the memo key separates fields so neighbouring values cannot merge", () => {
  // Without a separator, {cwd:"/a", startedAt:11} and {cwd:"/a1", startedAt:1}
  // would produce the same key and one would be silently skipped.
  const a = [session({ id: "1", cwd: "/a", startedAt: 11 })];
  const b = [session({ id: "1", cwd: "/a1", startedAt: 1 })];

  expect(projectSourceKey(a, "claude-code")).not.toBe(projectSourceKey(b, "claude-code"));
});

describe("projectTabItems", () => {
  test("All first, then one chip per project in order", () => {
    const items = projectTabItems([
      { path: "/a/one", name: "one" },
      { path: "/b/two", name: "two" },
    ]);
    expect(items).toEqual([
      { label: "All", a11y: "All projects" },
      { path: "/a/one", label: "one", a11y: "Project one" },
      { path: "/b/two", label: "two", a11y: "Project two" },
    ]);
  });

  test("scales linearly to a GG Coder-sized list", () => {
    const projects = Array.from({ length: 1000 }, (_, i) => ({ path: `/p/${i}`, name: `p${i}` }));
    const items = projectTabItems(projects);
    expect(items).toHaveLength(1001);
    expect(items[1000]?.path).toBe("/p/999");
  });
});

describe("worktrees", () => {
  const wire = {
    path: "/Users/me/.ezcoder/worktrees/billing/ez-mun7ig9t",
    name: "ez-mun7ig9t",
    sessions: 2,
    updatedAt: "2026-10-13T10:00:00Z",
    worktree: { repo: "billing", root: "/Users/me/billing", branch: "fix/login" },
  };

  test("a worktree is listed as a branch of its repository, not a project of its own", () => {
    const projects = projectsForProvider([wire], [], "ezcoder");
    // The checkout was never worked in directly, so it is added for the branch to sit under.
    expect(projects.map((p) => p.path)).toEqual(["/Users/me/billing"]);
    const [project] = projects;
    expect(project && projectTitle(project)).toBe("billing");
    expect(project?.sessions).toBe(2);
    expect(project?.branches).toEqual([
      { path: wire.path, name: "ez-mun7ig9t", label: "fix/login", sessions: 2, updatedAt: wire.updatedAt },
    ]);
    expect(projectTabItems(projects)[1]).toEqual({ path: "/Users/me/billing", label: "billing", a11y: "Project billing, 1 branch" });
    // Its conversations file under the repo, by path or by the folder the daemon stamped.
    expect(project && sessionsInProject([session({ id: "a", cwd: wire.path }), session({ id: "b", folder: "ez-mun7ig9t" })], project)).toHaveLength(2);
    expect(placeTitle(projects, wire.path)).toBe("billing · fix/login");
    expect(placeTitle(projects, "/Users/me/billing")).toBe("billing");
    expect(projectFor(projects, wire.path)?.path).toBe("/Users/me/billing");
  });

  test("a detached worktree falls back to its folder; malformed data is ignored", () => {
    expect(projectTitle({ name: "ez-1", worktree: { repo: "api" } })).toBe("api · ez-1");
    expect(readWorktree({ repo: "" })).toBeUndefined();
    expect(readWorktree({ repo: 3 })).toBeUndefined();
    expect(readWorktree("billing")).toBeUndefined();
    expect(readWorktree({ repo: "api", root: 1, branch: "" })).toEqual({ repo: "api" });
    const [plain] = projectsForProvider([{ ...wire, worktree: { nope: true } }], [], "ezcoder");
    expect(plain?.worktree).toBeUndefined();
    expect(plain && projectTitle(plain)).toBe("ez-mun7ig9t");
    expect(readWorktree({ repo: "api", gone: "yes" })).toEqual({ repo: "api" });
  });
});

describe("grouping worktrees under their repository", () => {
  const ez = (id: string, extra: Record<string, unknown>, updatedAt = "2026-10-01T00:00:00Z") => ({
    path: `/Users/me/.ezcoder/worktrees/bmf/${id}`,
    name: id,
    sessions: 1,
    updatedAt,
    worktree: { repo: "black-mountain-fund", ...extra },
  });

  test("a dozen ezcoder checkouts are one project with a dozen branches", () => {
    const root = "/Users/me/black-mountain-fund";
    const announced = [
      { path: root, name: "black-mountain-fund", sessions: 195, updatedAt: "2026-10-10T00:00:00Z" },
      ...Array.from({ length: 12 }, (_, i) => ez(`ez-${i}`, { root, branch: `feat/${i}` }, `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00Z`)),
      { path: "/Users/me/pew2", name: "pew2", sessions: 11, updatedAt: "2026-10-05T00:00:00Z" },
    ];
    const projects = projectsForProvider(announced, [], "ezcoder");
    expect(projects.map((p) => projectTitle(p))).toEqual(["black-mountain-fund", "pew2"]);
    const [bmf] = projects;
    expect(bmf?.path).toBe(root);
    expect(bmf?.sessions).toBe(195 + 12);
    // Newest work in any branch is the repo's newest work.
    expect(bmf?.updatedAt).toBe("2026-10-12T00:00:00Z");
    expect(bmf?.branches?.map((b) => b.label).slice(0, 3)).toEqual(["feat/11", "feat/10", "feat/9"]);
  });

  test("a deleted checkout joins the repo with its name, after the live branches", () => {
    const root = "/Users/me/black-mountain-fund";
    const projects = projectsForProvider(
      [
        { path: root, name: "black-mountain-fund", sessions: 3 },
        ez("ez-old", { gone: true }, "2026-10-09T00:00:00Z"),
        ez("ez-live", { root, branch: "fix/x" }, "2026-10-01T00:00:00Z"),
      ],
      [],
      "ezcoder",
    );
    expect(projects).toHaveLength(1);
    expect(projects[0]?.branches?.map((b) => [b.label, b.gone ?? false])).toEqual([
      ["fix/x", false],
      ["ez-old", true],
    ]);
  });

  test("worktrees whose checkout is unknown group by repo, and a new chat goes to the newest live one", () => {
    const projects = projectsForProvider(
      [
        ez("ez-a", { branch: "a" }, "2026-10-01T00:00:00Z"),
        ez("ez-gone", { branch: "g", gone: true }, "2026-10-09T00:00:00Z"),
        ez("ez-b", { branch: "b" }, "2026-10-05T00:00:00Z"),
      ],
      [],
      "ezcoder",
    );
    expect(projects).toHaveLength(1);
    expect(projectTitle(projects[0]!)).toBe("black-mountain-fund");
    expect(projects[0]?.path).toBe("/Users/me/.ezcoder/worktrees/bmf/ez-b");
  });

  test("one entry per directory, however the path was written", () => {
    const projects = projectsForProvider(
      [
        { path: "/code/x", name: "x", sessions: 2, updatedAt: "2026-10-01T00:00:00Z" },
        { path: "/code/x/", name: "x", sessions: 3, updatedAt: "2026-10-02T00:00:00Z" },
      ],
      [],
      "ezcoder",
    );
    expect(projects).toHaveLength(1);
    expect(projects[0]?.sessions).toBe(5);
    expect(projects[0] && sessionsInProject([session({ id: "a", cwd: "/code/x/" })], projects[0])).toHaveLength(1);
  });

  test("two projects that would read the same are titled apart; their identity is untouched", () => {
    const projects = projectsForProvider(
      [
        { path: "/work/api", name: "api", updatedAt: "2026-10-02T00:00:00Z" },
        { path: "/oss/api", name: "api", updatedAt: "2026-10-01T00:00:00Z" },
        // Which `api` this belongs to is a coin toss, so it is grouped by name and named apart too.
        { path: "/wt/api/ez-1", name: "ez-1", worktree: { repo: "api", branch: "x" } },
      ],
      [],
      "ezcoder",
    );
    const titles = projects.map((p) => projectTitle(p));
    expect(new Set(titles).size).toBe(titles.length);
    expect(titles).toContain("api (work)");
    expect(titles).toContain("api (oss)");
    expect(projects.map((p) => p.name).filter((n) => n === "api")).toHaveLength(3);
  });

  test("two branches that would read the same within a project get their folders", () => {
    const root = "/Users/me/black-mountain-fund";
    const [project] = projectsForProvider(
      [ez("ez-1", { root }), ez("ez-2", { root, branch: "ez-1" })],
      [],
      "ezcoder",
    );
    const labels = project?.branches?.map((b) => b.label) ?? [];
    expect(new Set(labels).size).toBe(labels.length);
  });
});
