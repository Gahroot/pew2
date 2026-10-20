import { describe, expect, test } from "bun:test";
import { topBarRight } from "./topBarRight";

const home = { inGoal: false, inThread: false, talk: true, backHome: false, tasks: true };

describe("topBarRight", () => {
  test("home offers Talk beside Tasks, so a call is one tap", () => {
    expect(topBarRight(home)).toEqual(["talk", "tasks"]);
  });

  test("home without voice still offers Tasks", () => {
    expect(topBarRight({ ...home, talk: false })).toEqual(["tasks"]);
  });

  test("a conversation offers Talk beside compose, not Tasks", () => {
    expect(topBarRight({ ...home, inThread: true })).toEqual(["talk", "compose"]);
  });

  test("a new conversation offers Talk beside the way home", () => {
    expect(topBarRight({ ...home, backHome: true, tasks: false })).toEqual(["talk", "home"]);
  });

  test("a goal keeps the side for its own controls", () => {
    expect(topBarRight({ ...home, inGoal: true, inThread: true })).toEqual([]);
  });
});
