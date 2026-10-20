/**
 * A scripted ~50 s call for seeing Mission control without OpenAI or a daemon:
 * five sessions, Pew answering a question, typing to a session, approving a
 * migration, and a fifth session arriving that folds the stalest lane away.
 *
 * Three of the agents work through dozens of steps a few times a second, so
 * the screen is seen holding one thing per lane however fast work arrives.
 *
 * Pure: `demoAt(seconds)` replays the script up to that moment through the
 * real `foldBoard` and returns the call and board the screen would have. The
 * names are long on purpose ("customer-portal-frontend", "Cursor Agent") so
 * truncation is exercised, not assumed. Used by `ui/CallScreen.harness.tsx`.
 */
import { IDLE_CALL, inboxItemId, type CallCaption, type CallState, type CompletedTool, type VoiceInboxItem } from "./voiceCall";
import { IDLE_BOARD, foldBoard, type BoardLine, type BoardSession, type BoardState, type BoardStatus } from "./voiceBoard";

/** Epoch ms the demo's clock starts at; any fixed value works. */
export const DEMO_EPOCH = 1_760_000_000_000;
export const DEMO_DURATION_S = 54;

/** Brand colours for the demo's providers (the app takes them from `providers`). */
export const DEMO_COLORS: Record<string, string> = {
  cursor: "#d97757",
  codex: "#10a37f",
  gemini: "#4285f4",
  ggcoder: "#4ade80",
  claude: "#e4e4e7",
};

interface Seed {
  id: string;
  providerId: string;
  folder: string;
  agentName: string;
  status: BoardStatus;
  touched: number;
  lines: [BoardLine["kind"], string][];
}

const SEEDS: Seed[] = [
  {
    id: "sf",
    providerId: "cursor",
    folder: "customer-portal-frontend",
    agentName: "Cursor Agent",
    status: "working",
    touched: 0,
    lines: [
      ["text", "Adding refunds to checkout."],
      ["tool", "Edit src/features/checkout/components/RefundSummaryPanel.tsx"],
      ["tool", "Run npm test -- checkout --runInBand --coverage"],
    ],
  },
  {
    id: "bill",
    providerId: "codex",
    folder: "billing-api",
    agentName: "Codex",
    status: "working",
    touched: 0,
    lines: [["text", "Removing the v1 /charges endpoint."]],
  },
  {
    id: "ios",
    providerId: "gemini",
    folder: "ios-app",
    agentName: "Gemini CLI",
    status: "working",
    touched: 0,
    lines: [
      ["tool", "xcodebuild -scheme App -configuration Release -destination generic/platform=iOS"],
      ["text", "Compiling 214 files…"],
    ],
  },
  {
    id: "docs",
    providerId: "ggcoder",
    folder: "docs",
    agentName: "GG Coder",
    status: "idle",
    touched: 0,
    lines: [
      ["text", "Updated the API reference."],
      ["result", "✓ Published to docs"],
    ],
  },
];

const LAND: Seed = { id: "land", providerId: "claude", folder: "landing", agentName: "Claude Code", status: "needs", touched: 0, lines: [] };

type Ev =
  | { t: number; k: "phase"; phase: CallState["phase"] }
  | { t: number; k: "say"; who: CallCaption["who"]; dur: number; text: string }
  | { t: number; k: "line"; id: string; kind: BoardLine["kind"]; text: string }
  | { t: number; k: "status"; id: string; st: BoardStatus }
  | { t: number; k: "touch"; id: string }
  | { t: number; k: "tool"; name: string; args: Record<string, unknown>; dur: number; note?: [string, string] }
  | { t: number; k: "arrive"; seed: Seed; line: [BoardLine["kind"], string] };

const PERM_SF = inboxItemId("sf", "approval", "r-migrate");
const PERM_LAND = inboxItemId("land", "approval", "r-deploy");
const ASK_BILL = inboxItemId("bill", "question", "r-v1");

/**
 * An agent working through a lot, fast: one tool every `every` seconds from
 * `from` to `to`, cycling `steps`. Far quicker than anyone could read, which is
 * the point: the lane must hold one thing at a time and stay put.
 */
function burst(id: string, from: number, to: number, every: number, steps: readonly string[]): Ev[] {
  const out: Ev[] = [];
  let n = 0;
  for (let t = from; t < to; t = Math.round((t + every) * 1000) / 1000) {
    const step = steps[n % steps.length]!;
    out.push({ t, k: "line", id, kind: step.startsWith("✓") ? "result" : "tool", text: step });
    n += 1;
  }
  return out;
}

const SF_STEPS = [
  "Read src/features/checkout/lib/calculateOrderTotalsWithRefunds.ts",
  "Grep \"refundId\" in src/",
  "Read src/features/checkout/api/orders.ts",
  "Edit src/features/checkout/components/RefundSummaryPanel.tsx",
  "Read src/features/checkout/hooks/useRefund.ts",
  "Edit src/features/checkout/hooks/useRefund.ts",
  "Run npm run typecheck",
  "Read prisma/schema.prisma",
  "Edit prisma/schema.prisma",
  "Run npm test -- checkout --runInBand",
  "✓ 42 passed",
  "Edit checkout/refund.ts",
];
const BILL_STEPS = ["Edit routes/v1/charges.ts", "Read middleware/index.ts", "Edit middleware/deprecation.ts", "Grep \"v1/charges\" in docs/", "Run npm test", "Read test/v1.spec.ts", "Edit test/v1.spec.ts"];
const DOCS_STEPS = ["git log --since=yesterday --oneline", "Read CHANGELOG.md", "Read ios-app/CHANGELOG.draft.md", "Grep \"1.4.0\" in content/", "Edit CHANGELOG.md", "Edit content/releases/1-4-0.mdx", "Run npm run lint:docs"];

const SCRIPT: Ev[] = [
  { t: 0, k: "phase", phase: "connecting" },
  { t: 1.5, k: "phase", phase: "live" },
  // Pew alone, centred, until there is a session to work with.
  { t: 1.6, k: "say", who: "pew", dur: 3.0, text: "Hey, it's Pew. Your agents are busy. Nothing needs you yet." },
  // A question lands: the board comes in and Pew moves to its corner.
  { t: 5.0, k: "status", id: "bill", st: "asks" },
  { t: 5.0, k: "line", id: "bill", kind: "ask", text: "Keep v1 for a month, or remove it now?" },
  { t: 5.2, k: "touch", id: "bill" },
  { t: 5.8, k: "say", who: "pew", dur: 3.8, text: "billing-api just asked: keep the v1 endpoint for a month, or remove it now? It's on your screen too." },
  { t: 6.6, k: "line", id: "ios", kind: "text", text: "Linking App…" },
  { t: 10.0, k: "say", who: "you", dur: 2.6, text: "Keep it a month, and add a deprecation warning." },
  { t: 12.8, k: "tool", name: "answer_question", args: { item_id: ASK_BILL, answers: { v1: "Keep for a month" } }, dur: 1.2 },
  { t: 12.8, k: "touch", id: "bill" },
  // The answer lands: the question leaves the inbox (and the card leaves the screen).
  { t: 14.0, k: "status", id: "bill", st: "working" },
  { t: 14.1, k: "tool", name: "tell_agent", args: { session_id: "bill", text: "Keep v1 for a month. Add a Deprecation header to every v1 response." }, dur: 1.6 },
  { t: 14.1, k: "line", id: "bill", kind: "pew", text: "Keep v1 for a month. Add a Deprecation header to every v1 response." },
  { t: 15.9, k: "say", who: "pew", dur: 1.0, text: "Sent." },
  { t: 16.0, k: "line", id: "ios", kind: "result", text: "✓ Build succeeded" },
  { t: 16.4, k: "status", id: "ios", st: "done" },
  { t: 16.6, k: "line", id: "ios", kind: "text", text: "1.4.0 is ready for TestFlight." },
  { t: 16.9, k: "say", who: "pew", dur: 3.0, text: "And ios-app just finished. The 1.4.0 build passed." },
  { t: 16.9, k: "touch", id: "ios" },
  { t: 19.4, k: "line", id: "sf", kind: "tool", text: "prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-schema-datasource" },
  { t: 20.4, k: "say", who: "you", dur: 2.4, text: "Nice. Tell docs to write the changelog for it." },
  { t: 20.9, k: "line", id: "bill", kind: "result", text: "✓ 128 passed" },
  { t: 21.5, k: "line", id: "bill", kind: "text", text: "v1 stays until Nov 18, with a Deprecation header." },
  { t: 21.8, k: "status", id: "bill", st: "done" },
  { t: 23.0, k: "tool", name: "tell_agent", args: { session_id: "docs", text: "Write the 1.4.0 changelog from today's ios-app commits." }, dur: 2.4 },
  { t: 23.0, k: "touch", id: "docs" },
  { t: 23.0, k: "line", id: "docs", kind: "pew", text: "Write the 1.4.0 changelog from today's ios-app commits." },
  { t: 25.4, k: "status", id: "docs", st: "working" },
  { t: 25.5, k: "say", who: "pew", dur: 1.2, text: "Sent to docs." },
  { t: 26.4, k: "line", id: "sf", kind: "perm", text: "prisma migrate deploy (production database, customer-portal-prod)" },
  { t: 26.5, k: "status", id: "sf", st: "needs" },
  { t: 27.2, k: "say", who: "pew", dur: 3.8, text: "customer-portal-frontend wants to run a database migration on production. Approve?" },
  { t: 27.2, k: "touch", id: "sf" },
  { t: 28.6, k: "line", id: "docs", kind: "text", text: "Writing the 1.4.0 entry…" },
  { t: 31.2, k: "say", who: "you", dur: 1.4, text: "What does it change?" },
  { t: 32.8, k: "tool", name: "get_status", args: { session_id: "sf" }, dur: 1.2, note: ["sf", "Read migration.sql: adds orders.refund_id"] },
  { t: 34.2, k: "say", who: "pew", dur: 3.2, text: "It adds one column to orders. Nothing is deleted. Sure?" },
  { t: 37.6, k: "say", who: "you", dur: 0.9, text: "Yes, go." },
  { t: 38.6, k: "tool", name: "answer_permission", args: { item_id: PERM_SF, decision: "allow", confirmed: true }, dur: 0.7, note: ["sf", "Approved once: prisma migrate deploy"] },
  { t: 39.3, k: "status", id: "sf", st: "working" },
  { t: 39.5, k: "line", id: "sf", kind: "tool", text: "prisma migrate deploy" },
  { t: 39.6, k: "arrive", seed: LAND, line: ["perm", "Deploy to production on Vercel (landing-site-2026-redesign)"] },
  { t: 39.8, k: "say", who: "pew", dur: 3.4, text: "Done. One more just came in: landing wants to deploy to Vercel." },
  { t: 40.8, k: "line", id: "sf", kind: "result", text: "✓ 1 migration applied" },
  { t: 41.6, k: "line", id: "docs", kind: "result", text: "✓ CHANGELOG.md updated" },
  { t: 41.9, k: "status", id: "docs", st: "done" },
  { t: 42.2, k: "line", id: "sf", kind: "tool", text: "Run npm test -- checkout" },
  { t: 43.6, k: "say", who: "you", dur: 1.6, text: "Later. Call me back in twenty." },
  { t: 45.4, k: "tool", name: "call_me_back", args: { minutes: 20 }, dur: 0.6 },
  { t: 46.2, k: "say", who: "pew", dur: 2.0, text: "Parked. Talk in twenty. Bye." },
  { t: 48.4, k: "phase", phase: "ended" },
  // The bursts: dozens of steps, a few a second.
  ...burst("sf", 2.0, 19.2, 0.42, SF_STEPS),
  ...burst("bill", 15.9, 20.8, 0.38, BILL_STEPS),
  ...burst("docs", 25.8, 41.4, 0.55, DOCS_STEPS),
  ...burst("sf", 42.6, 48.4, 0.45, ["Run npm test -- checkout", "Read test/refund.spec.ts", "Edit test/refund.spec.ts", "✓ 44 passed"]),
];

const ms = (t: number) => DEMO_EPOCH + Math.round(t * 1000);

/** The card data a current daemon sends with each item, so the demo shows the on-screen card too. */
const BILL_QUESTIONS = [
  {
    id: "v1",
    question: "Keep the v1 /charges endpoint for a month, or remove it now?",
    kind: "choice" as const,
    detail: "Three integrations still call it, all on the old SDK.",
    options: [
      { label: "Keep for a month", value: "keep", hint: "Add a Deprecation header, remove on Nov 18", recommended: true },
      { label: "Remove now", value: "remove", hint: "The three integrations break until they upgrade" },
    ],
  },
];
const APPROVAL_OPTIONS = [
  { optionId: "allow", kind: "allow_once", name: "Allow once" },
  { optionId: "reject", kind: "reject_once", name: "Deny" },
];

function inboxOf(sessions: Map<string, BoardSession>): VoiceInboxItem[] {
  const items: VoiceInboxItem[] = [];
  const bill = sessions.get("bill");
  if (bill?.status === "asks") items.push({ id: ASK_BILL, sessionId: "bill", kind: "question", requestId: "r-v1", folder: bill.folder, agentName: bill.agentName, title: "Keep v1 for a month, or remove it now?", since: bill.since, questions: BILL_QUESTIONS });
  const sf = sessions.get("sf");
  if (sf?.status === "needs") items.push({ id: PERM_SF, sessionId: "sf", kind: "approval", requestId: "r-migrate", folder: sf.folder, agentName: sf.agentName, title: "prisma migrate deploy", since: sf.since, options: APPROVAL_OPTIONS, detail: "prisma migrate deploy (production database, customer-portal-prod)" });
  const land = sessions.get("land");
  if (land?.status === "needs") items.push({ id: PERM_LAND, sessionId: "land", kind: "approval", requestId: "r-deploy", folder: land.folder, agentName: land.agentName, title: "Deploy to production on Vercel", since: land.since, options: APPROVAL_OPTIONS, detail: "vercel deploy --prod (landing-site-2026-redesign)" });
  return items;
}

export interface DemoFrame {
  call: CallState;
  board: BoardState;
  /** The demo's clock, epoch ms, for every `now` the screen reads. */
  now: number;
}

/** The call and board `seconds` into the scripted demo. */
export function demoAt(seconds: number): DemoFrame {
  const t = Math.max(0, Math.min(DEMO_DURATION_S, seconds));
  const now = ms(t);
  const sessions = new Map<string, BoardSession>();
  for (const seed of SEEDS) {
    sessions.set(seed.id, {
      sessionId: seed.id,
      providerId: seed.providerId,
      folder: seed.folder,
      agentName: seed.agentName,
      status: seed.status,
      since: ms(-30),
      // 0 is "not this call": the screen starts on Pew alone until one is touched.
      touchedAt: seed.touched === 0 ? 0 : ms(seed.touched),
      lines: seed.lines.map(([kind, text], n) => ({ kind, text, at: ms(-10 + n) })),
    });
  }
  let board = IDLE_BOARD;
  const push = (at: number) => {
    board = foldBoard(board, { t: "voice.board", sessions: [...sessions.values()].map((s) => ({ ...s, lines: s.lines.slice(-12) })) }, at);
  };
  push(ms(0));
  let call: CallState = { ...IDLE_CALL, phase: "connecting", activity: "connecting", requestId: "demo", callId: "demo", focus: ASK_BILL };
  const completed: CompletedTool[] = [];
  const tools: CallState["tools"] = [];
  let serial = 0;
  let speakingUntil = 0;
  let youUntil = 0;
  let toolN = 0;
  // Tool completions are events too: expand them in time order.
  const timeline: { t: number; run: () => void; touchesBoard: boolean }[] = [];
  for (const ev of SCRIPT) {
    const at = ms(ev.t);
    switch (ev.k) {
      case "phase":
        timeline.push({ t: ev.t, touchesBoard: false, run: () => (call = { ...call, phase: ev.phase, activity: ev.phase === "live" ? "listening" : call.activity }) });
        break;
      case "say": {
        // Arrives the way a real call's transcript does: a few words at a
        // time across the line's duration, then marked final. The screen
        // streams it, so this exercises the same path as a live call.
        const words = ev.text.split(" ");
        // Yours arrive a word at a time as you speak. Pew's arrive almost all
        // at once, well ahead of its voice, as OpenAI's transcript does: the
        // screen has to hold them back to the voice.
        const chunks = ev.who === "pew" ? 1 : Math.max(1, words.length);
        let line = 0;
        timeline.push({
          t: ev.t,
          touchesBoard: false,
          run: () => {
            serial += 1;
            line = serial;
            call = { ...call, caption: { who: ev.who, text: "", final: false, serial } };
            if (ev.who === "pew") speakingUntil = ev.t + ev.dur;
            else youUntil = ev.t + ev.dur;
          },
        });
        for (let c = 1; c <= chunks; c++) {
          const upTo = ev.who === "pew" ? ev.text : words.slice(0, c).join(" ");
          timeline.push({
            t: ev.who === "pew" ? ev.t + 0.05 : ev.t + (ev.dur * 0.85 * c) / chunks,
            touchesBoard: false,
            run: () => {
              if (call.caption?.serial !== line) return;
              call = { ...call, caption: { ...call.caption, text: upTo, final: c === chunks } };
            },
          });
        }
        break;
      }
      case "line":
        timeline.push({
          t: ev.t,
          touchesBoard: true,
          run: () => {
            const s = sessions.get(ev.id);
            if (s) s.lines = [...s.lines, { kind: ev.kind, text: ev.text, at }];
          },
        });
        break;
      case "status":
        timeline.push({
          t: ev.t,
          touchesBoard: true,
          run: () => {
            const s = sessions.get(ev.id);
            if (s) Object.assign(s, { status: ev.st, since: at });
          },
        });
        break;
      case "touch":
        timeline.push({
          t: ev.t,
          touchesBoard: true,
          run: () => {
            const s = sessions.get(ev.id);
            if (s) s.touchedAt = at;
          },
        });
        break;
      case "arrive":
        timeline.push({
          t: ev.t,
          touchesBoard: true,
          run: () =>
            sessions.set(ev.seed.id, {
              sessionId: ev.seed.id,
              providerId: ev.seed.providerId,
              folder: ev.seed.folder,
              agentName: ev.seed.agentName,
              status: ev.seed.status,
              since: at,
              touchedAt: 0,
              lines: [{ kind: ev.line[0], text: ev.line[1], at }],
            }),
        });
        break;
      case "tool": {
        const toolCallId = `demo-tool-${++toolN}`;
        const args = JSON.stringify(ev.args);
        timeline.push({ t: ev.t, touchesBoard: false, run: () => tools.push({ toolCallId, name: ev.name, arguments: args, requestId: toolCallId }) });
        timeline.push({
          t: Math.round((ev.t + ev.dur) * 1000) / 1000,
          touchesBoard: true,
          run: () => {
            const i = tools.findIndex((x) => x.toolCallId === toolCallId);
            if (i >= 0) tools.splice(i, 1);
            const inbox = inboxOf(sessions);
            const itemId = typeof ev.args.item_id === "string" ? ev.args.item_id : undefined;
            const item = itemId ? inbox.find((x) => x.id === itemId) : undefined;
            const sessionId = typeof ev.args.session_id === "string" ? ev.args.session_id : item?.sessionId;
            completed.push({ toolCallId, name: ev.name, arguments: args, sessionId, item: item ? { kind: item.kind, title: item.title, folder: item.folder, agentName: item.agentName } : undefined, ok: true });
            if (ev.note) {
              const s = sessions.get(ev.note[0]);
              if (s) s.lines = [...s.lines, { kind: "note", text: ev.note[1], at: ms(ev.t + ev.dur) }];
            }
          },
        });
        break;
      }
    }
  }
  timeline.sort((a, b) => a.t - b.t);
  for (const step of timeline) {
    if (step.t > t) break;
    step.run();
    if (step.touchesBoard) push(ms(step.t));
  }
  const live = call.phase === "live" || call.phase === "ending";
  const activity: CallState["activity"] = !live ? call.activity : tools.length > 0 ? "working" : t < speakingUntil ? "speaking" : "listening";
  // Pew's voice is playing for the line's duration, as output_audio_buffer
  // started/stopped mark it on a real call.
  const pewAudio = live && tools.length === 0 && t < speakingUntil && call.caption?.who === "pew";
  const userSpeaking = live && t < youUntil;
  call = { ...call, activity, pewAudio, userSpeaking, tools: live ? [...tools] : [], completed: [...completed], inbox: inboxOf(sessions) };
  return { call, board, now };
}
