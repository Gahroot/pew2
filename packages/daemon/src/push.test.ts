import { describe, expect, it } from "bun:test";
import { PushRegistry, applyTickets, pushMessages, pushVoiceEvent, voiceMessages } from "./push.js";
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

describe("voice call setting", () => {
  const ev = (cls: VoiceEvent["class"]): VoiceEvent => ({
    eventId: 3, taskId: "t1", projectId: "p1", projectName: "pew2", kind: "task.completed", class: cls, text: "Done.", at: 1,
  });
  const reg = (voiceCall?: boolean) => {
    const r = new PushRegistry();
    r.register("d", "ExponentPushToken[abc]", "ios", voiceCall);
    return r;
  };

  it("is off by default: a phone that never said so gets the ordinary title", () => {
    const [m] = voiceMessages(reg(), ev("completed"));
    expect(m?.title).toBe("pew2: finished");
    expect(voiceMessages(reg(false), ev("completed"))[0]?.title).toBe("pew2: finished");
  });

  it("rings for finished, blocked and approval on a phone that turned it on, with the same data", () => {
    for (const cls of ["completed", "blocked", "approval"] as const) {
      const [m] = voiceMessages(reg(true), ev(cls));
      expect(m?.title.startsWith("Pew is calling: ")).toBe(true);
      expect(m?.data).toEqual({ type: "voice.callback", eventId: 3, taskId: "t1", projectId: "p1", class: cls });
    }
  });

  it("never sets an interruption level, so Do Not Disturb and Sleep Focus still hold it back", () => {
    for (const cls of ["completed", "blocked", "approval", "informational"] as const) {
      expect(voiceMessages(reg(true), ev(cls))[0]).not.toHaveProperty("interruptionLevel");
    }
  });

  it("never rings for chatter", () => {
    const [m] = voiceMessages(reg(true), ev("informational"));
    expect(m?.title.startsWith("Pew is calling")).toBe(false);
  });

  it("is per phone: one on, one off", () => {
    const r = new PushRegistry();
    r.register("a", "ExponentPushToken[a]", "ios", true);
    r.register("b", "ExponentPushToken[b]", "ios");
    const titles = voiceMessages(r, ev("completed")).map((m) => m.title.startsWith("Pew is calling"));
    expect(titles).toEqual([true, false]);
  });

  it("turning it off re-registers without the flag", () => {
    const r = reg(true);
    r.register("d", "ExponentPushToken[abc]", "ios", false);
    expect(voiceMessages(r, ev("completed"))[0]?.title).toBe("pew2: finished");
  });

  it("falls back silently: a failed send throws nothing and no phone sends nothing", async () => {
    await pushVoiceEvent(reg(true), ev("completed"), (async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    let sent = 0;
    await pushVoiceEvent(new PushRegistry(), ev("completed"), (async () => { sent++; return new Response("{}"); }) as unknown as typeof fetch);
    expect(sent).toBe(0);
  });
});

describe("native call screen", () => {
  const ev = (cls: VoiceEvent["class"]): VoiceEvent => ({
    eventId: 3, taskId: "t1", projectId: "p1", projectName: "pew2", kind: "task.completed", class: cls, text: "Done.", at: 1,
  });
  const CALL_ID = "6f9619ff-8b86-4d11-b42d-00c04fc964ff";
  const VOIP = { token: "ab".repeat(32), environment: "production" as const, bundleId: "io.github.kenkaiii.pew2" };
  /** Captures what reached Expo, one array of messages per request. */
  const expo = () => {
    const batches: Record<string, unknown>[][] = [];
    const send = (async (_url: unknown, init?: RequestInit) => {
      batches.push(JSON.parse(init?.body as string) as Record<string, unknown>[]);
      return new Response(JSON.stringify({ data: [] }));
    }) as unknown as typeof fetch;
    return { batches, send };
  };
  const voip = (outcome: "sent" | "gone" | "unconfigured" | "failed") => {
    const calls: unknown[] = [];
    return { calls, sender: { send: async (_t: unknown, payload: unknown) => (calls.push(payload), outcome) } };
  };

  it("is off unless the phone said so: a ringing event stays a banner and APNs is never called", async () => {
    const registry = new PushRegistry();
    registry.register("d", TOKEN, "ios", false);
    const { batches, send } = expo();
    const apns = voip("sent");
    await pushVoiceEvent(registry, ev("completed"), send, { voip: apns.sender });
    expect(apns.calls).toHaveLength(0);
    expect(batches[0]?.[0]?.title).toBe("pew2: finished");
  });

  it("rings an iPhone through APNs instead of a banner, with the focus a banner tap would give", async () => {
    const registry = new PushRegistry();
    registry.register("d", TOKEN, "ios", false, { voip: VOIP });
    const { batches, send } = expo();
    const apns = voip("sent");
    await pushVoiceEvent(registry, ev("approval"), send, { voip: apns.sender, newCallId: () => CALL_ID });
    expect(apns.calls).toEqual([
      { type: "voice.call", callId: CALL_ID, caller: "pew2: needs approval", eventId: 3, taskId: "t1", projectId: "p1", class: "approval" },
    ]);
    expect(batches).toHaveLength(0);
  });

  it("falls back to the banner whenever a ring cannot go out, and forgets a dead VoIP token", async () => {
    for (const outcome of ["unconfigured", "failed", "gone"] as const) {
      const registry = new PushRegistry();
      registry.register("d", TOKEN, "ios", false, { voip: VOIP });
      const { batches, send } = expo();
      await pushVoiceEvent(registry, ev("completed"), send, { voip: voip(outcome).sender });
      expect(batches[0]?.[0]?.title).toBe("pew2: finished");
      expect(registry.list()[0]?.voip === undefined).toBe(outcome === "gone");
    }
    // Setting on but no PushKit token (simulator, older build): banner, no APNs.
    const registry = new PushRegistry();
    registry.register("d", TOKEN, "ios", false, {});
    const { batches, send } = expo();
    const apns = voip("sent");
    await pushVoiceEvent(registry, ev("blocked"), send, { voip: apns.sender });
    expect(apns.calls).toHaveLength(0);
    expect(batches[0]).toHaveLength(1);
  });

  it("rings Android with a data-only push on the call channel: nothing for the OS to draw", async () => {
    const registry = new PushRegistry();
    registry.register("d", TOKEN, "android", false, {});
    const { batches, send } = expo();
    await pushVoiceEvent(registry, ev("completed"), send, { newCallId: () => CALL_ID });
    const [message] = batches[0] ?? [];
    expect(message).toEqual({
      to: TOKEN,
      data: { type: "voice.call", callId: CALL_ID, caller: "pew2: finished", eventId: 3, taskId: "t1", projectId: "p1", class: "completed", pew2Call: "1" },
      priority: "high",
      channelId: "incoming-call",
      ttl: 30,
    });
    expect(message).not.toHaveProperty("title");
  });

  it("never rings for chatter, and a later registration without the setting turns it off", async () => {
    const registry = new PushRegistry();
    registry.register("d", TOKEN, "ios", false, { voip: VOIP });
    const apns = voip("sent");
    const { batches, send } = expo();
    await pushVoiceEvent(registry, ev("informational"), send, { voip: apns.sender });
    expect(apns.calls).toHaveLength(0);
    expect(batches).toHaveLength(1);

    registry.register("d", TOKEN, "ios", false);
    expect(registry.list()[0]).toEqual({ token: TOKEN, platform: "ios" });
  });

  it("keeps the caller short: Apple and Google can read it", async () => {
    const registry = new PushRegistry();
    registry.register("d", TOKEN, "android", false, {});
    const { batches, send } = expo();
    await pushVoiceEvent(registry, { ...ev("completed"), projectName: "x".repeat(200) }, send);
    const data = (batches[0]?.[0] as { data: { caller: string } }).data;
    expect(data.caller.length).toBeLessThanOrEqual(80);
  });
});
