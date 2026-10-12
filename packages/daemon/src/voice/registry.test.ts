import { expect, test } from "bun:test";
import { scratch } from "./scratch.js";
import {
  addAlias,
  buildRegistry,
  chooseProvider,
  normalise,
  readAliases,
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
