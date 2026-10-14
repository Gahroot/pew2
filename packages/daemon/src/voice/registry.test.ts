import { expect, test } from "bun:test";
import { scratch } from "./scratch.js";
import {
  addAlias,
  buildRegistry,
  chooseProvider,
  normalise,
  projectIdFor,
  readAliases,
  repoForPath,
  resolveProject,
} from "./registry.js";

const projects = buildRegistry(
  ["/code/pew2", "/code/pew2-ios", "/code/ezcoder", "/code/billing-api", "/code/billing-web"],
  { "/code/ezcoder": ["ez goals"] },
);

test("normalise folds spoken numbers, case and separators", () => {
  expect(normalise("Pew Two")).toBe("pew 2");
  expect(normalise("billing_API")).toBe("billing api");
  expect(normalise("pewTwo")).toBe("pew 2");
});

test("exact and ASR-garbled names resolve to one project", () => {
  expect(resolveProject("ezcoder", projects).best?.name).toBe("ezcoder");
  expect(resolveProject("easy coder", projects).best?.name).toBe("ezcoder");
  expect(resolveProject("ez goals", projects).best?.name).toBe("ezcoder");
  expect(resolveProject("Pew two", projects).best?.name).toBe("pew2");
});

test("close matches are ambiguous and carry ranked candidates", () => {
  const result = resolveProject("billing", projects);
  expect(result.ambiguous).toBe(true);
  expect(result.best).toBeUndefined();
  expect(result.candidates.map((c) => c.project.name).sort()).toEqual(["billing-api", "billing-web"]);
});

test("nonsense and empty queries never resolve", () => {
  expect(resolveProject("zzzzqqq", projects)).toEqual({ candidates: [], ambiguous: true });
  expect(resolveProject("  ", projects).ambiguous).toBe(true);
});

test("a project id is accepted verbatim", () => {
  const target = projects[2]!;
  expect(resolveProject(target.projectId, projects).best).toEqual(target);
});

test("ids are stable across builds", () => {
  expect(buildRegistry(["/code/a"], {})[0]?.projectId).toBe(buildRegistry(["/code/a"], {})[0]?.projectId);
});

test("ezcoder is preferred, then last used, then first", () => {
  expect(chooseProvider(["codex", "ezcoder"], "codex")).toBe("ezcoder");
  expect(chooseProvider(["codex", "gemini"], "gemini")).toBe("gemini");
  expect(chooseProvider(["codex", "gemini"])).toBe("codex");
  expect(chooseProvider([])).toBeUndefined();
});

test("aliases persist and deduplicate", async () => {
  const dir = scratch();
  await addAlias(dir, "/code/x", "the ex");
  await addAlias(dir, "/code/x", "The  Ex");
  expect(await readAliases(dir)).toEqual({ "/code/x": ["the ex"] });
});

test("worktrees are named for their repo and branch, and the repo is added beside them", () => {
  const info: Record<string, { repo: string; root?: string; branch?: string }> = {
    "/wt/bmf/ez-mun7ig9t": { repo: "black-mountain-fund", root: "/code/black-mountain-fund", branch: "ez/mun7ig9t" },
    "/wt/bmf/fact-total": { repo: "black-mountain-fund", root: "/code/black-mountain-fund", branch: "fix/yardi-fact-total" },
    "/wt/bare/detached": { repo: "api" },
  };
  const registry = buildRegistry(Object.keys(info), {}, undefined, (path) => info[path]);
  expect(registry.map((p) => p.name)).toEqual([
    "black-mountain-fund",
    "black-mountain-fund (ez/mun7ig9t)",
    "black-mountain-fund (fix/yardi-fact-total)",
    "api (detached)",
  ]);
  const main = registry[0]!;
  expect(main.worktree).toBeUndefined();
  expect(registry[1]?.worktree).toEqual({ repo: "black-mountain-fund", repoId: main.projectId, branch: "ez/mun7ig9t" });
  // A bare repository has no checkout to group under.
  expect(registry[3]?.worktree).toEqual({ repo: "api" });

  // The repo's own name means the main checkout, never a coin toss between worktrees.
  expect(resolveProject("black mountain fund", registry).best?.projectId).toBe(main.projectId);
  // The worktree's folder or branch picks it out.
  expect(resolveProject("fact total", registry).best?.path).toBe("/wt/bmf/fact-total");
  expect(resolveProject("yardi fact total", registry).best?.path).toBe("/wt/bmf/fact-total");
});

test("worktrees without their main checkout are ambiguous by repo name, not silently picked", () => {
  const registry = buildRegistry(["/wt/api/one", "/wt/api/two"], {}, undefined, (path) => ({
    repo: "api",
    branch: path.endsWith("one") ? "feat/one" : "feat/two",
  }));
  const result = resolveProject("api", registry);
  expect(result.ambiguous).toBe(true);
  expect(result.candidates.map((c) => c.project.name).sort()).toEqual(["api (feat/one)", "api (feat/two)"]);
});

test("one entry per directory, and two that would sound alike are named apart", () => {
  const registry = buildRegistry(["/code/x", "/code/x/", "/work/api", "/oss/api"], {});
  expect(registry.map((p) => p.name)).toEqual(["x", "api (in work)", "api (in oss)"]);
  // Asking for "api" is a real question with two different answers, never "api or api".
  const result = resolveProject("api", registry);
  expect(result.ambiguous).toBe(true);
  expect(new Set(result.candidates.map((c) => c.project.name)).size).toBe(result.candidates.length);
});

test("a deleted worktree is not offered, but still brings in its repo's checkout by name", () => {
  const registry = buildRegistry(["/wt/billing/ez-old", "/code/billing"], {}, undefined, (path) =>
    path === "/wt/billing/ez-old" ? { repo: "billing", gone: true } : undefined,
  );
  expect(registry.map((p) => p.path)).toEqual(["/code/billing"]);
});

test("a path's id does not depend on a trailing separator", () => {
  expect(projectIdFor("/code/x/")).toBe(projectIdFor("/code/x"));
  expect(projectIdFor("/code/x")).not.toBe(projectIdFor("/code/y"));
});

test("a task's repository is found from its directory, even once the checkout is deleted", () => {
  const registry = buildRegistry(["/code/billing", "/code/pew2"], {});
  const billing = registry.find((p) => p.name === "billing");
  // Git named the checkout.
  expect(repoForPath("/wt/billing/ez-1", { repo: "billing", root: "/code/billing", branch: "fix/x" }, registry)).toEqual({
    projectId: billing?.projectId,
    name: "billing",
    branch: "fix/x",
  });
  // Deleted: only the layout is left, so the one checkout named billing is it, and the folder stands in for the branch.
  expect(repoForPath("/wt/billing/ez-old", { repo: "billing", gone: true }, registry)).toEqual({
    projectId: billing?.projectId,
    name: "billing",
    branch: "ez-old",
  });
  // An ordinary checkout belongs to no other repository.
  expect(repoForPath("/code/pew2", undefined, registry)).toBeUndefined();
});
