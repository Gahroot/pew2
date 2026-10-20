import { expect, test } from "bun:test";
import { plainText } from "./plain";

test("emphasis, code and headings lose their marks, keep their words", () => {
  expect(plainText("**Done.** Ran `npm test`: *all* green")).toBe("Done. Ran npm test: all green");
  expect(plainText("## Summary")).toBe("Summary");
  expect(plainText("__bold__ and _it_ and ~~gone~~")).toBe("bold and it and gone");
});

test("links and images keep their text", () => {
  expect(plainText("See [the docs](https://x.dev/a_(b)) and ![chart](c.png)")).toBe("See the docs and chart");
});

test("lists, quotes, tasks and rules", () => {
  expect(plainText("- one\n* two\n- [x] three\n> quoted\n---")).toBe("one\ntwo\nthree\nquoted\n");
});

test("code fences keep the code", () => {
  expect(plainText("```ts\nconst a = 1;\n```")).toBe("\nconst a = 1;\n");
});

test("tables read as cells", () => {
  expect(plainText("| File | Status |\n|---|---|\n| a.ts | ok |")).toBe("File · Status\n\na.ts · ok");
});

test("snake_case, maths and plain text are left alone", () => {
  expect(plainText("set user_id and 2 * 3 * 4")).toBe("set user_id and 2 * 3 * 4");
  expect(plainText("Fixed 3 tests.")).toBe("Fixed 3 tests.");
});
