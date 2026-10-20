import { describe, expect, test } from "bun:test";
import { resolveCredential, voicePaths } from "./credentials.js";
import { buildInbox, summariseInbox } from "./inbox.js";
import {
  REALTIME_CALLS_URL,
  REALTIME_MODEL,
  buildInstructions,
  buildSessionConfig,
  mintClientSecret,
  voiceTools,
} from "./session.js";
import { isDestructive, pickOption, runVoiceTool, type VoicePort } from "./tools.js";
import { PushRegistry, voiceRingMessages } from "../push.js";

const NOW = 1_800_000_000_000;
const item = (over: object = {}) => ({
  id: "s1:approval:p1",
  sessionId: "s1",
  kind: "approval" as const,
  requestId: "p1",
  folder: "pew2",
  title: "npm test",
  since: NOW - 120_000,
  ...over,
});

describe("inbox", () => {
  test("oldest first across sessions, since kept from first sight", () => {
    const seen = new Map<string, number>();
    const sources = [
      {
        sessionId: "b",
        folder: "two",
        permissions: new Map([["p", { toolCall: { title: "rm -rf dist" } }]]),
        plan: { t: "plan.state" as const, sessionId: "b", planMode: true, pending: { planPath: "x", content: "", generation: 3 } },
      },
      { sessionId: "a", asks: new Map([["q", [{ question: "Which DB?" }]]]) },
    ];
    const first = buildInbox(sources, seen, NOW);
    expect(first.map((i) => i.id)).toEqual(["a:question:q", "b:approval:p", "b:plan:3"]);
    const later = buildInbox(sources.slice(0, 1), seen, NOW + 5000);
    expect(later.every((i) => i.since === NOW)).toBe(true);
    expect(seen.has("a:question:q")).toBe(false);
    expect(summariseInbox(first)).toBe(
      "3 things waiting: an agent asks: Which DB?; two wants to run: rm -rf dist; two has a plan ready for review",
    );
  });
});

describe("session config", () => {
  test("model, voice, tools and the briefing", () => {
    const text = buildInstructions([item(), item({ id: "s2:question:q", kind: "question", sessionId: "s2", title: "Which DB?" })], [
      { sessionId: "s1", folder: "pew2", working: false, lastLines: ["Tests are ready to run."] },
    ], "s2:question:q", NOW);
    expect(text).toContain("Never grant \"always\"");
    expect(text).toContain("Briefing: 2 items waiting.");
    expect(text.indexOf("[s2:question:q]")).toBeLessThan(text.indexOf("[s1:approval:p1]"));
    expect(text).toContain("Tests are ready to run.");
    const config = buildSessionConfig(text);
    expect(config.model).toBe(REALTIME_MODEL);
    expect(config.audio.output.voice).toBe("marin");
    expect(voiceTools().map((t) => t.name)).toEqual([
      "list_waiting", "answer_permission", "answer_question", "decide_plan",
      "tell_agent", "get_status", "call_me_back", "set_ring", "open_chat", "start_chat", "end_call",
    ]);
  });

  test("mint returns the secret and ms expiry; 401 is a sign-in message", async () => {
    const ok = await mintClientSecret("tok", buildSessionConfig("x"), (async () =>
      Response.json({ value: "ek_1", expires_at: NOW / 1000, session: { model: "m" } })) as never);
    expect(ok).toEqual({ ok: true, secret: "ek_1", expiresAt: NOW, model: "m" });
    const denied = await mintClientSecret("tok", buildSessionConfig("x"), (async () =>
      new Response("{}", { status: 401 })) as never);
    expect(denied.ok).toBe(false);
  });
});

describe("tools", () => {
  const port = (over: Partial<VoicePort> = {}): VoicePort => ({
    items: () => [item(), item({ id: "s1:plan:4", kind: "plan", requestId: "4", title: "Plan ready for review" })],
    permissionOptions: () => [{ optionId: "a", kind: "allow_always" }, { optionId: "r", kind: "reject_once" }],
    answerPermission: () => true,
    answerAsk: () => true,
    decidePlan: () => {},
    tellAgent: () => ({ ok: true, queued: true }),
    statuses: () => [],
    callMeBack: () => {},
    ...over,
  });

  test("never allow_always", () => {
    expect(pickOption([{ optionId: "a", kind: "allow_always" }], "allow")).toBeUndefined();
    const result = JSON.parse(runVoiceTool("answer_permission", '{"item_id":"s1:approval:p1","decision":"allow"}', port()).output);
    expect(result.ok).toBe(false);
  });

  test("destructive titles", () => {
    for (const t of ["npm publish", "rm -rf build", "git push --force", "DROP TABLE x", "wrangler deploy"]) expect(isDestructive(t)).toBe(true);
    for (const t of ["npm test", "git status", "Read src/format.ts"]) expect(isDestructive(t)).toBe(false);
  });

  test("decide_plan passes the generation; call_me_back hangs up", () => {
    const decided: unknown[] = [];
    let back = 0;
    const p = port({ decidePlan: (...args) => void decided.push(args), callMeBack: (m) => void (back = m) });
    expect(JSON.parse(runVoiceTool("decide_plan", '{"item_id":"s1:plan:4","action":"accept"}', p).output).say).toBe("Plan accepted.");
    expect(decided).toEqual([["s1", "accept", 4, undefined]]);
    const cb = runVoiceTool("call_me_back", '{"minutes":20}', p);
    expect(cb.hangUp).toBe(true);
    expect(back).toBe(20);
    expect(runVoiceTool("end_call", "", p).hangUp).toBe(true);
    expect(JSON.parse(runVoiceTool("tell_agent", '{"session_id":"s1","text":"go"}', p).output).say).toBe("Queued.");
    expect(JSON.parse(runVoiceTool("bogus", "{", p).output).ok).toBe(false);
  });
});

test("the ring is a time-sensitive push with voice data", () => {
  const registry = new PushRegistry();
  registry.register("d", "ExpoPushToken[abc]", "ios");
  expect(voiceRingMessages(registry, { body: "1 thing waiting", focus: "s1:approval:p1", badge: 1 })).toEqual([
    {
      to: "ExpoPushToken[abc]",
      title: "pew2 needs you",
      body: "1 thing waiting",
      data: { voice: true, focus: "s1:approval:p1" },
      sound: "default",
      interruptionLevel: "time-sensitive",
      badge: 1,
      mutableContent: true,
      priority: "high",
    },
  ]);
});

// Opt-in: PEW2_VOICE_LIVE=1 mints with this machine's real login and opens a
// WebRTC call offer with the secret. Never prints a token.
test.skipIf(process.env.PEW2_VOICE_LIVE !== "1")("live: mint + SDP offer answers 201", async () => {
  const found = await resolveCredential(voicePaths());
  if (!found.ok) throw new Error(found.reason);
  const config = buildSessionConfig(buildInstructions([item({ since: Date.now() })], []));
  const minted = await mintClientSecret(found.credential.token, config);
  if (!minted.ok) throw new Error(minted.error);
  const offer = [
    "v=0", "o=- 0 0 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111", "c=IN IP4 0.0.0.0", "a=rtcp:9 IN IP4 0.0.0.0",
    "a=ice-ufrag:abcd", "a=ice-pwd:abcdefghijklmnopqrstuvwx",
    "a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF",
    "a=setup:actpass", "a=mid:0", "a=sendrecv", "a=rtcp-mux", "a=rtpmap:111 opus/48000/2", "",
  ].join("\r\n");
  const call = await fetch(REALTIME_CALLS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${minted.secret}`, "Content-Type": "application/sdp" },
    body: offer,
  });
  const answer = await call.text();
  console.log(JSON.stringify({ source: found.credential.source, model: minted.model, status: call.status, sdp: answer.startsWith("v=0") }));
  expect(call.status).toBe(201);
}, 30_000);

test("the briefing lists every open session with its id, idle ones too", async () => {
  const { buildInstructions } = await import("./session.js");
  const text = buildInstructions([], [
    { sessionId: "echo-1", folder: "pew2-voice", agentName: "Echo (test)", working: false, lastLines: ["Hello back.", "Done."] },
    { sessionId: "gg-2", folder: "docs", agentName: "GG Coder", working: true, lastLines: ["Editing CHANGELOG.md"] },
  ]);
  expect(text).toContain("Sessions (2 open):");
  expect(text).toContain("- pew2-voice (Echo (test)): idle. [tool id: echo-1]");
  expect(text).toContain("- docs (GG Coder): working. [tool id: gg-2]");
  // Working first, with its lines; an idle one gets only its last line.
  expect(text.indexOf("tool id: gg-2")).toBeLessThan(text.indexOf("tool id: echo-1"));
  expect(text).toContain("Done.");
  expect(text).not.toContain("Hello back.");
});

test("the briefing names the chat they called from, and treats folders as projects", () => {
  const text = buildInstructions(
    [],
    [
      { sessionId: "s1", folder: "drjones", agentName: "Claude Code", working: true, activity: "Edit src/app.ts", lastLines: [] },
      { sessionId: "s2", folder: "docs", working: false, lastLines: ["Done."] },
    ],
    undefined,
    Date.now(),
    "s1",
  );
  expect(text).toContain("They called from the drjones (Claude Code) chat");
  expect(text).toContain("drjones (Claude Code): working, Edit src/app.ts.");
  expect(text).toContain("never a person");
  expect(text).toContain("If nothing is waiting, never say so.");
  expect(text).toContain("don't add steps, checks, requirements or details they didn't ask for");
  expect(text).not.toContain("0 items waiting");
  expect(text).not.toContain("health");
});

test("the briefing names their projects, so Pew can reach chats that aren't open", () => {
  const text = buildInstructions([], [], undefined, Date.now(), undefined, ["billing-api", "storefront"]);
  expect(text).toContain("Sessions: none open.");
  expect(text).toContain("Projects you can reach (worked in over the last two weeks; open_chat and start_chat reach only these and the open sessions): billing-api, storefront.");
  expect(text).toContain("name at most three");
  expect(text).toContain("Never ask them to open it on the phone.");
  expect(buildInstructions([], [], undefined, Date.now())).not.toContain("Their projects");
});

test("a call from a new, empty chat names its project; with no clue, the greeting names none", () => {
  const text = buildInstructions([], [], undefined, Date.now(), undefined, [], { folder: "storefront", agentName: "Claude Code" });
  expect(text).toContain("They called from a new, empty storefront (Claude Code) chat");
  expect(text).toContain("call start_chat with project storefront and agent Claude Code");
  expect(buildInstructions([], [], undefined, Date.now())).toContain("Never pick one from the session list to greet with.");
});

test("Pew is told never to act, invent a message or pick an answer on its own", () => {
  const text = buildInstructions([], [], undefined, Date.now(), undefined, [], { folder: "storefront" });
  expect(text).toContain("Until they ask for something, you may look (get_status, list_waiting) but never send, start, open, answer or decide anything.");
  expect(text).toContain("Never pick an answer to an agent's question or approval yourself, not even the recommended one.");
  expect(text).toContain("Only when they ask for work in it, call start_chat");
});
