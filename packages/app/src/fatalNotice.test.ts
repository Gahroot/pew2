import { expect, test } from "bun:test";
import { fatalNotice, refusalText } from "./fatalNotice";

const REFUSED =
  "This pairing is already in use by another device. A pairing link works once: " +
  "if this is your phone and you reinstalled the app, run `pew2 pair --rotate` on " +
  "your machine and scan the new code.";

test("the first sentence is the headline; the fix is the note, with its command picked out", () => {
  const notice = fatalNotice(REFUSED);
  expect(notice.headline).toBe("This pairing is already in use by another device.");
  expect(notice.detail).toEqual([
    { text: "A pairing link works once: if this is your phone and you reinstalled the app, run " },
    { text: "pew2 pair --rotate", command: true },
    { text: " on your machine and scan the new code." },
  ]);
});

test("one sentence is all headline", () => {
  expect(fatalNotice("This device is no longer paired.")).toEqual({ headline: "This device is no longer paired.", detail: [] });
});

test("a full stop inside a command never splits the message", () => {
  const notice = fatalNotice("Run `pew2 update. now` to fix it. Then reconnect.");
  expect(notice.headline).toBe("Run pew2 update. now to fix it.");
  expect(notice.detail).toEqual([{ text: "Then reconnect." }]);
});

test("an unclosed backtick is plain text, not a runaway command", () => {
  expect(fatalNotice("Broken. Run `pew2 pair and scan.").detail).toEqual([{ text: "Run pew2 pair and scan." }]);
});

test("the unpaired refusal reads the same way", () => {
  const notice = fatalNotice("This device is not paired with this machine. Run `pew2 pair` and scan again.");
  expect(notice.headline).toBe("This device is not paired with this machine.");
  expect(notice.detail.find((run) => run.command)?.text).toBe("pew2 pair");
});

test("refusals the app knows get its own two short sentences, with the command picked out", () => {
  const refused = fatalNotice(refusalText("device-refused", REFUSED));
  expect(refused.headline).toBe("Paired to another device.");
  expect(refused.detail).toEqual([{ text: "Run " }, { text: "pew2 pair --rotate", command: true }, { text: ", then scan." }]);
  expect(fatalNotice(refusalText("unpaired", "long text")).headline).toBe("Not paired with this computer.");
  expect(refusalText("wire-version", "This app speaks protocol v3, but this machine only has v2. Update pew2 on your computer.")).toContain("on your computer is out of date");
  expect(refusalText("wire-version", "This app speaks protocol v1, but this machine needs v2. Update the app and pair again.")).toContain("This app is out of date");
});

test("a refusal this app doesn't know keeps the daemon's words", () => {
  expect(refusalText("something-new", "A newer daemon explains itself.")).toBe("A newer daemon explains itself.");
  expect(refusalText("something-new", undefined)).toBe("This device is no longer paired.");
});
