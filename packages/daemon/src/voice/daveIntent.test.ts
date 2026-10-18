import { expect, test } from "bun:test";
import {
  type DaveRoute,
  daveSense,
  isBacklogQuery,
  isDaveProject,
  isTodoQuestion,
  routeDave,
} from "./daveIntent.js";
import { buildRegistry } from "./registry.js";

const [dave, pew2] = buildRegistry(["/code/dave", "/code/pew2"], {});

test("talking to Dave as a person reads as the assistant", () => {
  for (const said of [
    "checking Dave, what are the next items on my to-do list?",
    "check in with Dave",
    "Checking with Dave",
    "ask Dave what I should do",
    "what does Dave think I should work on",
    "Dave says the billing work is first",
    "read me Dave's to-do list",
    "Dave's priorities",
    "hey Dave",
    "Dave, what's next?",
    "according to Dave",
  ]) {
    expect([said, daveSense(said)]).toEqual([said, "assistant"]);
  }
});

test("naming the code project reads as the project", () => {
  for (const said of [
    "the dave project",
    "in the dave repo, fix the login",
    "Dave's codebase",
    "the repo called dave",
    "in dave",
    "commit the dave app",
  ]) {
    expect([said, daveSense(said)]).toEqual([said, "project"]);
  }
});

test("a bare 'dave', both cues at once, and no Dave at all", () => {
  expect(daveSense("dave")).toBe("bare");
  expect(daveSense("fix the bug Dave reported")).toBe("bare");
  expect(daveSense("ask Dave about the dave project")).toBe("unclear");
  expect(daveSense("pew two")).toBe("none");
  // A misheard "check in with Dave" is not "in dave", the project.
  expect(daveSense("check in Dave")).toBe("assistant");
});

test("a to-do question is not a coding instruction that mentions a TODO", () => {
  expect(isTodoQuestion("what are the next items on my to-do list")).toBe(true);
  expect(isTodoQuestion("what's next")).toBe(true);
  expect(isTodoQuestion("what should I work on")).toBe(true);
  expect(isTodoQuestion("add a to-do for Dave to review the API")).toBe(false);
  expect(isTodoQuestion("what are the next items in the TODO file")).toBe(false);
  expect(isTodoQuestion("fix the login screen")).toBe(false);
});

test("the dave project is recognised by name, worktree repo and alias", () => {
  expect(isDaveProject(dave)).toBe(true);
  expect(isDaveProject(pew2)).toBe(false);
  expect(isDaveProject(undefined)).toBe(false);
  expect(
    isDaveProject({
      projectId: "p",
      name: "dave (fix/x)",
      path: "/w/ez-1",
      aliases: [],
      worktree: { repo: "dave" },
    }),
  ).toBe(true);
});

test("routeDave: 'checking Dave' plus a to-do question goes to DAVE, not the dave project", () => {
  expect(
    routeDave({
      query: "dave",
      instruction: "checking Dave, what are the next items on my to-do list",
      target: dave,
      daveAvailable: true,
    }),
  ).toEqual({ kind: "assistant", about: "priorities" });
  expect(routeDave({ query: "checking Dave", daveAvailable: true })).toEqual({
    kind: "assistant",
    about: "overview",
  });
});

test("routeDave: real work in the dave project goes ahead", () => {
  expect(
    routeDave({
      query: "dave",
      instruction: "fix the login screen",
      target: dave,
      daveAvailable: true,
    }),
  ).toEqual({ kind: "project" });
  expect(
    routeDave({
      query: "the dave project",
      instruction: "what are the next items on my to-do list",
      target: dave,
      daveAvailable: true,
    }),
  ).toEqual({ kind: "project" });
  // A person named Dave inside an instruction for the dave repo is not DAVE.
  expect(
    routeDave({
      query: "dave",
      instruction: "fix the bug Dave reported",
      target: dave,
      daveAvailable: true,
    }),
  ).toEqual({ kind: "project" });
  // A projectId is the model's settled choice, e.g. after the user answered "the project".
  expect(
    routeDave({
      query: dave?.projectId ?? "",
      instruction: "what's next on my to-do list",
      target: dave,
      byId: true,
      daveAvailable: true,
    }),
  ).toEqual({ kind: "project" });
});

test("routeDave: a bare 'dave' with a to-do question asks; other projects are never touched", () => {
  expect(
    routeDave({
      query: "dave",
      instruction: "what's next on my to-do list",
      target: dave,
      daveAvailable: true,
    }),
  ).toEqual({
    kind: "ask",
    about: "priorities",
  });
  // With DAVE off there is no assistant to mean, so the project stands.
  expect(
    routeDave({
      query: "dave",
      instruction: "what's next on my to-do list",
      target: dave,
      daveAvailable: false,
    }),
  ).toEqual({ kind: "project" });
  expect(
    routeDave({
      query: "pew2",
      instruction: "ask Dave to review it",
      target: pew2,
      daveAvailable: true,
    }),
  ).toEqual({ kind: "project" });
});

test("'backlog' is a backlog query when it is asked about, not when it is built or named", () => {
  for (const said of [
    "backlog",
    "the backlog",
    "check the backlog",
    "Checking the backlog",
    "what's on the backlog",
    "what's next on my backlog",
    "read me the backlog",
    "go through the back log",
    "top of the backlog",
    "backlog items",
  ]) {
    expect([said, isBacklogQuery(said)]).toEqual([said, true]);
  }
  for (const said of [
    "add a backlog screen",
    "fix the backlog page layout",
    "the backlog repo",
    "the project called backlog",
    "update BACKLOG.md",
    "what's next on my to-do list",
  ]) {
    expect([said, isBacklogQuery(said)]).toEqual([said, false]);
  }
});

test("opening or working on dave is the project; Dave's backlog is the assistant", () => {
  for (const said of [
    "open the dave project",
    "open dave",
    "work on dave",
    "switch to dave",
    "inspect the dave repo",
  ]) {
    expect([said, daveSense(said)]).toEqual([said, "project"]);
  }
  expect(daveSense("open Dave's backlog")).toBe("assistant");
});

test("routeDave: the backlog keyword goes to the backlog lookup", () => {
  const backlog = { kind: "assistant", about: "priorities" } satisfies DaveRoute;
  expect(
    routeDave({
      query: "dave",
      instruction: "check the backlog",
      target: dave,
      daveAvailable: true,
    }),
  ).toEqual(backlog);
  expect(routeDave({ query: "the backlog", daveAvailable: true })).toEqual(backlog);
  // Even when the backlog fuzzily matches a project.
  expect(routeDave({ query: "check the backlog", target: pew2, daveAvailable: true })).toEqual(
    backlog,
  );
  // "Dave's backlog" names the assistant's list, not the repo.
  expect(routeDave({ query: "dave's backlog", target: dave, daveAvailable: true })).toEqual(
    backlog,
  );
});

test("routeDave: opening or working on the dave project stays with the project", () => {
  const project = { kind: "project" } satisfies DaveRoute;
  expect(routeDave({ query: "open the dave project", target: dave, daveAvailable: true })).toEqual(
    project,
  );
  expect(
    routeDave({
      query: "dave",
      instruction: "work on dave and fix the login",
      target: dave,
      daveAvailable: true,
    }),
  ).toEqual(project);
  expect(
    routeDave({
      query: "dave",
      instruction: "open dave and fix the backlog screen",
      target: dave,
      daveAvailable: true,
    }),
  ).toEqual(project);
  // A project really named backlog, named as one.
  expect(routeDave({ query: "the backlog repo", target: pew2, daveAvailable: true })).toEqual(
    project,
  );
  // Another project's own backlog is that project's business.
  expect(
    routeDave({
      query: "pew2",
      instruction: "check the backlog",
      target: pew2,
      daveAvailable: true,
    }),
  ).toEqual(project);
  // With DAVE off there is no backlog to read, so a real match stands.
  expect(routeDave({ query: "the backlog", target: pew2, daveAvailable: false })).toEqual(project);
});
