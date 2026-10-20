import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "./index.js";
import { PushRegistry, applyTickets, pushMessages, pushVoiceRing, relayOrigin } from "./push.js";

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
    expect(message?.data).toEqual({ sessionId: "s1", kind: "finished" });
    // The field that makes this instant on Android: normal priority lets FCM
    // hold a message back on a sleeping device, which is the phone-in-a-pocket
    // case the whole feature exists for.
    expect(message?.priority).toBe("high");
  });

  it("still says something for a turn that ended without a message", () => {
    const [message] = pushMessages(registry, { sessionId: "s1", folder: "pew2" });
    expect(message?.body).toBe("Finished and waiting on you.");
  });

  it("calls a failed turn a failure, not a finish", () => {
    const [message] = pushMessages(registry, { sessionId: "s1", kind: "failed", lastText: "Rate limited" });
    expect(message?.body).toBe("Stopped on an error: Rate limited");
    expect(message?.data.kind).toBe("failed");
  });

  it("says an approval is waiting, without a reply box that would only queue", () => {
    // A typed reply to a blocked agent lands behind the request it meant to
    // answer, so an approval opens the app where the real sheet is.
    const [message] = pushMessages(registry, {
      sessionId: "s1",
      folder: "pew2",
      kind: "approval",
      lastText: "rm -rf build",
      badge: 2,
    });
    expect(message?.body).toBe("Needs your OK to run: rm -rf build");
    expect(message?.categoryId).toBeUndefined();
    expect(message?.badge).toBe(2);
  });

  it("wakes the iPhone's widget updater, and only on iOS", () => {
    // The notification service extension is what moves the home-screen widget
    // to "needs you" while the app is asleep; it only runs on mutable content.
    const both = new PushRegistry();
    both.register("phone", TOKEN, "ios");
    both.register("tablet", "ExponentPushToken[other]", "android");
    const [ios, android] = pushMessages(both, { sessionId: "s1", kind: "approval" });
    expect(ios?.mutableContent).toBe(true);
    expect(android?.mutableContent).toBeUndefined();
  });

  it("keeps the reply box on a turn that ended", () => {
    const [message] = pushMessages(registry, { sessionId: "s1" });
    expect(message?.categoryId).toBe("agentTurn");
  });

  it("quotes the question an agent asked", () => {
    const [message] = pushMessages(registry, { sessionId: "s1", kind: "question", lastText: "Which database?" });
    expect(message?.body).toBe("Asks: Which database?");
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

describe("notifyPhones", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** A daemon with one phone registered, and every push it sends captured. */
  function daemonWithPhone() {
    const env = { ...process.env, PEW2_HOME: mkdtempSync(join(tmpdir(), "pew2-push-")) };
    const daemon = new Daemon({ id: "test", name: "test" }, true, env);
    daemon.pushTargets.register("phone", TOKEN, "ios");
    const sent: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      sent.push(...(JSON.parse(String(init?.body)) as Array<Record<string, unknown>>));
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const sessions = (daemon as unknown as { sessions: Map<string, Record<string, unknown>> }).sessions;
    return { daemon, sent, sessions };
  }

  it("badges the icon with every conversation stopped on an answer", async () => {
    const { daemon, sent, sessions } = daemonWithPhone();
    sessions.set("a", { cwd: "/work/pew2", providerId: "echo", permissions: new Map([["r1", {}]]) });
    sessions.set("b", { cwd: "/work/site", providerId: "echo", asks: new Map([["q1", []]]) });
    sessions.set("c", { cwd: "/work/idle", providerId: "echo", permissions: new Map() });
    expect(daemon.waitingOnYou()).toBe(2);

    daemon.notifyPhones("a", "approval", "rm -rf build");
    await Promise.resolve();
    expect(sent[0]).toMatchObject({
      title: "pew2",
      body: "Needs your OK to run: rm -rf build",
      badge: 2,
      data: { sessionId: "a", kind: "approval" },
    });
  });

  it("quotes the closing message only when a turn finished", async () => {
    // An approval must never quote the previous turn's last words as if they
    // were the tool it is waiting on.
    const { daemon, sent, sessions } = daemonWithPhone();
    sessions.set("a", { cwd: "/work/pew2", providerId: "echo", turnText: "All done." });
    daemon.notifyPhones("a", "finished");
    daemon.notifyPhones("a", "approval");
    await Promise.resolve();
    expect(sent.map((m) => m.body)).toEqual(["All done.", "Needs your OK to continue."]);
    expect(sent[0]?.badge).toBe(0);
  });
});

describe("voice rings: CallKit through the relay, banners for the rest", () => {
  const VOIP = "ab".repeat(32);
  const ring = { body: "2 things waiting", focus: "s1:approval:p1" };

  function setup(relayStatus: number) {
    const registry = new PushRegistry();
    registry.register("callkit-phone", "ExponentPushToken[a]", "ios");
    registry.register("banner-phone", "ExponentPushToken[b]", "ios");
    registry.registerVoip("callkit-phone", VOIP, "sandbox");
    const calls: { url: string; body: any }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response("{}", { status: relayStatus });
    }) as unknown as typeof fetch;
    return { registry, calls, fetchImpl };
  }

  it("the VoIP phone is rung through the relay and skipped for the banner", async () => {
    const { registry, calls, fetchImpl } = setup(200);
    const realFetch = globalThis.fetch;
    const banners: any[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      banners.push(...JSON.parse(init.body as string));
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const rung = await pushVoiceRing(registry, ring, { relay: "https://relay.example", fetchImpl, ringId: "r1" });
      expect(rung).toEqual(["callkit-phone"]);
      expect(calls[0]?.url).toBe("https://relay.example/voip");
      expect(calls[0]?.body).toEqual({
        token: VOIP,
        env: "sandbox",
        payload: { pew: { title: "Pew", body: "2 things waiting", focus: "s1:approval:p1", ring: "r1" } },
      });
      expect(banners.map((m) => m.to)).toEqual(["ExponentPushToken[b]"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a relay that can't ring falls back to the banner; a dead token is dropped", async () => {
    for (const status of [503, 410]) {
      const { registry, fetchImpl } = setup(status);
      const realFetch = globalThis.fetch;
      const banners: any[] = [];
      globalThis.fetch = (async (_url: string, init: RequestInit) => {
        banners.push(...JSON.parse(init.body as string));
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as unknown as typeof fetch;
      try {
        expect(await pushVoiceRing(registry, ring, { relay: "https://relay.example", fetchImpl })).toEqual([]);
        expect(banners.map((m) => m.to).sort()).toEqual(["ExponentPushToken[a]", "ExponentPushToken[b]"]);
        expect(registry.voipList().length).toBe(status === 410 ? 0 : 1);
      } finally {
        globalThis.fetch = realFetch;
      }
    }
  });

  it("relay origin from the pairing URL", () => {
    expect(relayOrigin("wss://pew2-relay.example.workers.dev")).toBe("https://pew2-relay.example.workers.dev");
    expect(relayOrigin("ws://localhost:8799/x")).toBe("http://localhost:8799");
    expect(relayOrigin(undefined)).toBeUndefined();
    expect(relayOrigin("nonsense")).toBeUndefined();
  });
});
