import { describe, expect, it } from "bun:test";
import { PushRegistry, applyTickets, callStyleEnabled, pushMessages, pushVoiceEvent, voiceMessages } from "./push.js";
import type { VoiceEvent } from "./voice/types.js";

const TOKEN = "ExponentPushToken[abcdef123456]";

describe("PushRegistry", () => {
  it("keeps one address per device, so a rotated token replaces the old one", () => {
    // Otherwise every app restart adds another copy of every banner.
    const registry = new PushRegistry();
    registry.register("phone", TOKEN, "ios");
    registry.register("phone", "ExponentPushToken[rotated]", "ios");
    expect(registry.list()).toEqual([{ token: "ExponentPushToken[rotated]", platform: "ios" }]);
  });

  it("keeps two phones apart", () => {
    const registry = new PushRegistry();
    registry.register("phone", TOKEN, "ios");
    registry.register("tablet", "ExponentPushToken[other]", "android");
    expect(registry.size).toBe(2);
  });

  it("refuses anything that is not an Expo push token", () => {
    // A rejected token is reported to the client; a silently stored one looks
    // exactly like a working one until a notification never arrives.
    const registry = new PushRegistry();
    expect(registry.register("phone", "not-a-token", "ios")).toBe(false);
    expect(registry.size).toBe(0);
  });

  it("names the Android channel, without which the banner is filed silently", () => {
    const registry = new PushRegistry();
    registry.register("phone", TOKEN, "android");
    expect(registry.list()[0]?.channelId).toBe("agent-turns");
  });
});

describe("pushMessages", () => {
  const registry = new PushRegistry();
  registry.register("phone", TOKEN, "ios");

  it("says which project and agent, and quotes the reply", () => {
    const [message] = pushMessages(registry, {
      sessionId: "s1",
      folder: "pew2",
      agentName: "Claude Code",
      lastText: "## Done\n\nRenamed the handler and fixed the test.",
    });
    expect(message?.title).toBe("pew2 · Claude Code");
    expect(message?.body).toBe("Done");
    // Read back by the app on tap, to open the conversation the banner is
    // about — the same payload the local banner carries.
    expect(message?.data).toEqual({ sessionId: "s1" });
    // The field that makes this instant on Android: normal priority lets FCM
    // hold a message back on a sleeping device, which is the phone-in-a-pocket
    // case the whole feature exists for.
    expect(message?.priority).toBe("high");
  });

  it("still says something for a turn that ended without a message", () => {
    const [message] = pushMessages(registry, { sessionId: "s1", folder: "pew2" });
    expect(message?.body).toBe("Finished and waiting on you.");
  });

  it("sends nothing when no phone has registered", () => {
    expect(pushMessages(new PushRegistry(), { sessionId: "s1" })).toEqual([]);
  });
});

describe("applyTickets", () => {
  it("forgets a token the push service says is gone", () => {
    // Uninstalled app or revoked permission. Continuing to send to it is what
    // gets a sender rate limited.
    const registry = new PushRegistry();
    registry.register("phone", TOKEN, "ios");
    const messages = pushMessages(registry, { sessionId: "s1" });
    applyTickets(registry, messages, [
      { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
    ]);
    expect(registry.size).toBe(0);
  });

  it("keeps a token through a transient failure", () => {
    // A rate limit or an Expo outage says nothing about whether the phone is
    // still there; dropping it would silence that device for good.
    const registry = new PushRegistry();
    registry.register("phone", TOKEN, "ios");
    const messages = pushMessages(registry, { sessionId: "s1" });
    applyTickets(registry, messages, [
      { status: "error", message: "too many", details: { error: "MessageRateExceeded" } },
    ]);
    expect(registry.size).toBe(1);
  });

  it("ignores a malformed reply rather than throwing on it", () => {
    const registry = new PushRegistry();
    registry.register("phone", TOKEN, "ios");
    applyTickets(registry, pushMessages(registry, { sessionId: "s1" }), "nonsense");
    expect(registry.size).toBe(1);
  });
});

describe("call-style voice callbacks", () => {
  const ev = (cls: VoiceEvent["class"]): VoiceEvent => ({
    eventId: 3, taskId: "t1", projectId: "p1", projectName: "pew2", kind: "task.completed", class: cls, text: "Done.", at: 1,
  });
  const reg = () => {
    const r = new PushRegistry();
    r.register("d", "ExponentPushToken[abc]", "ios");
    return r;
  };

  it("is off unless the flag is exactly 1", () => {
    expect(callStyleEnabled({})).toBe(false);
    expect(callStyleEnabled({ PEW2_VOICE_CALL: "true" })).toBe(false);
    expect(callStyleEnabled({ PEW2_VOICE_CALL: "1" })).toBe(true);
  });

  it("changes nothing by default: same title, no interruption level", () => {
    const [m] = voiceMessages(reg(), ev("completed"));
    expect(m?.title).toBe("pew2: finished");
    expect(m).not.toHaveProperty("interruptionLevel");
  });

  it("rings for finished, blocked and approval, time-sensitive, with the same data an old app reads", () => {
    for (const cls of ["completed", "blocked", "approval"] as const) {
      const [m] = voiceMessages(reg(), ev(cls), { callStyle: true });
      expect(m?.title.startsWith("Pew is calling: ")).toBe(true);
      expect(m?.interruptionLevel).toBe("time-sensitive");
      expect(m?.data).toEqual({ type: "voice.callback", eventId: 3, taskId: "t1", projectId: "p1", class: cls });
    }
  });

  it("never rings for chatter", () => {
    const [m] = voiceMessages(reg(), ev("informational"), { callStyle: true });
    expect(m?.title.startsWith("Pew is calling")).toBe(false);
    expect(m).not.toHaveProperty("interruptionLevel");
  });

  it("falls back silently: a failed send throws nothing and a push with no phone sends nothing", async () => {
    await pushVoiceEvent(reg(), ev("completed"), (async () => { throw new Error("offline"); }) as unknown as typeof fetch, { callStyle: true });
    let sent = 0;
    await pushVoiceEvent(new PushRegistry(), ev("completed"), (async () => { sent++; return new Response("{}"); }) as unknown as typeof fetch, { callStyle: true });
    expect(sent).toBe(0);
  });
});
