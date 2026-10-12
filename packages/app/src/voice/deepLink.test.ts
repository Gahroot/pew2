import { describe, expect, test } from "bun:test";
import { isRepeatLink, parseVoiceLink, voiceLink } from "./deepLink";

describe("parseVoiceLink", () => {
  test("reads the source", () => {
    expect(parseVoiceLink("pew2://voice?source=action_button")).toEqual({ source: "action_button" });
    expect(parseVoiceLink("pew2://voice?source=airpods")).toEqual({ source: "airpods" });
  });
  test("accepts friendly aliases and defaults unknown sources to in_app", () => {
    expect(parseVoiceLink("pew2://voice?source=Siri")?.source).toBe("siri_shortcut");
    expect(parseVoiceLink("pew2://voice?source=nonsense")?.source).toBe("in_app");
    expect(parseVoiceLink("pew2://voice")?.source).toBe("in_app");
    expect(parseVoiceLink("pew2://voice/")?.source).toBe("in_app");
  });
  test("reads focus hints and ignores junk ones", () => {
    expect(parseVoiceLink("pew2://voice?source=notification&focusEventId=42&focusTaskId=t%201")).toEqual({
      source: "notification",
      focusEventId: 42,
      focusTaskId: "t 1",
    });
    expect(parseVoiceLink("pew2://voice?focusEventId=-1&focusTaskId=")).toEqual({ source: "in_app" });
  });
  test("rejects anything that is not the voice link", () => {
    expect(parseVoiceLink(undefined)).toBeUndefined();
    expect(parseVoiceLink("pew2://pair?key=1")).toBeUndefined();
    expect(parseVoiceLink("pew2://voicex")).toBeUndefined();
    expect(parseVoiceLink("https://voice?source=airpods")).toBeUndefined();
    expect(parseVoiceLink("pew2://voice.evil.com/?source=airpods")).toBeUndefined();
  });
  test("survives a malformed escape", () => {
    expect(parseVoiceLink("pew2://voice?source=airpods&focusTaskId=%E0%A4%A")).toEqual({ source: "airpods" });
  });
  test("round-trips", () => {
    const a = { source: "notification" as const, focusEventId: 7, focusTaskId: "a b" };
    expect(parseVoiceLink(voiceLink(a))).toEqual(a);
  });
});

describe("isRepeatLink", () => {
  test("only the same url inside the window", () => {
    const last = { url: "pew2://voice", at: 1000 };
    expect(isRepeatLink(last, "pew2://voice", 1500)).toBe(true);
    expect(isRepeatLink(last, "pew2://voice", 4000)).toBe(false);
    expect(isRepeatLink(last, "pew2://voice?source=airpods", 1500)).toBe(false);
    expect(isRepeatLink(undefined, "pew2://voice", 1500)).toBe(false);
  });
});
