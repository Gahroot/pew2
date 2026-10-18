import { describe, expect, test } from "bun:test";
import { accountLabel, createVoiceAccount } from "./account";

function fixture() {
  let now = 0;
  let sequence = 0;
  let online = true;
  const sent: unknown[] = [];
  const account = createVoiceAccount({
    now: () => now,
    id: () => `r${++sequence}`,
    changed: () => {},
    send: (message) => {
      if (!online) return false;
      sent.push(message);
      return true;
    },
  });
  return {
    account,
    sent,
    time: (value: number) => {
      now = value;
    },
    offline: () => {
      online = false;
    },
  };
}
const reply = (requestId: string, extra = {}) => ({
  t: "voice.account.state",
  requestId,
  supported: true,
  state: "not-connected",
  voiceReady: false,
  ...extra,
});
const authorization = {
  attemptId: "12345678-1234-4234-8234-123456789012",
  userCode: "ABCD-1234",
  verificationUrl: "https://auth.openai.com/codex/device",
  expiresAt: 30_000,
};

describe("voice account controls", () => {
  test("offline commands are never queued; reconnect always refreshes status", () => {
    const { account, sent } = fixture();
    expect(account.command("connect")).toBe(false);
    expect(account.command("disconnect")).toBe(false);
    account.online();
    account.receive(reply("r1", { state: "connected", voiceReady: true }));
    expect(accountLabel(account.view)).toBe("Voice ready");
    account.offline();
    expect(account.view.account).toBeUndefined();
    account.online();
    expect(sent).toEqual([
      { t: "voice.account.status", requestId: "r1" },
      { t: "voice.account.status", requestId: "r2" },
    ]);
    account.receive(reply("r1", { state: "connected" }));
    expect(account.view.availability).toBe("checking");
  });
  test("correlates connect, polls owned attempt, cancels and ignores late replies", () => {
    const { account, sent, time } = fixture();
    account.online();
    account.receive(reply("r1"));
    expect(account.command("connect")).toBe(true);
    account.receive(reply("r2", { state: "authorizing", authorization }));
    time(2_000);
    account.tick();
    expect(sent[2]).toEqual({
      t: "voice.account.status",
      requestId: "r3",
      attemptId: authorization.attemptId,
    });
    account.receive(reply("r3", { state: "authorizing", authorization }));
    expect(account.command("cancel")).toBe(true);
    expect(sent[3]).toEqual({
      t: "voice.account.cancel",
      requestId: "r4",
      attemptId: authorization.attemptId,
    });
    account.receive(reply("r2", { state: "connected" }));
    expect(account.view.pending).toBe("cancel");
    account.receive(reply("r4"));
    expect(account.view.account?.state).toBe("not-connected");
  });
  test("old daemon times out without a spinner; retry probes again", () => {
    const { account, time } = fixture();
    account.online();
    time(10_000);
    account.tick();
    expect(account.view.availability).toBe("unsupported");
    expect(accountLabel(account.view)).toBe("Update Pew2 on your computer");
    account.command("status");
    account.receive(reply("r2"));
    expect(account.view.availability).toBe("supported");
  });
  test("expires codes and rejects secret-bearing or nonofficial browser URLs", () => {
    const { account, time } = fixture();
    account.online();
    account.receive(reply("r1", { accessToken: "must-not-enter-display" }));
    expect(account.view.account).toBeUndefined();
    account.receive(
      reply("r1", {
        state: "authorizing",
        authorization: { ...authorization, verificationUrl: "https://example.com" },
      }),
    );
    expect(account.view.account).toBeUndefined();
    account.receive(reply("r1", { state: "authorizing", authorization }));
    time(30_000);
    account.tick();
    expect(account.view.account?.authorization).toBeUndefined();
    expect(account.view.message).toContain("expired");
  });
  test("disconnect is explicit; send failure clears display without replay", () => {
    const { account, sent, offline } = fixture();
    account.online();
    account.receive(reply("r1", { state: "connected" }));
    account.command("disconnect");
    expect(sent[1]).toEqual({ t: "voice.account.disconnect", requestId: "r2" });
    account.receive(reply("r2"));
    offline();
    expect(account.command("connect")).toBe(false);
    expect(account.view.availability).toBe("offline");
    expect(account.view.account).toBeUndefined();
  });
});
