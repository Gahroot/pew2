/**
 * What the voice model may be told, and what it may be allowed to do.
 *
 * Two jobs, both pure. Redaction: everything handed to the Realtime model is
 * short and secret-scrubbed, because that text leaves the machine. Risk: a
 * permission request or tool call is tiered, and the tier decides whether a
 * spoken "yes" is enough, needs a confirmation round trip, or is refused.
 */
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import type { RiskLevel } from "./types.js";

// ---- redaction -------------------------------------------------------------

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\bAKIA[0-9A-Z]{12,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bek_[A-Za-z0-9]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  // scheme://user:password@host
  /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
  // NAME=value where the name smells like a credential
  /\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*\S+/gi,
  // Long opaque runs: hashes, base64 blobs.
  /\b[A-Za-z0-9+/_-]{40,}={0,2}/g,
];

/** Replace anything that looks like a credential. Idempotent. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, scheme: unknown) =>
      typeof scheme === "string" && match.startsWith(scheme) && match.includes("@")
        ? `${scheme}[redacted]@`
        : "[redacted]",
    );
  }
  return out;
}

/**
 * Make agent text safe and short enough to say aloud.
 *
 * Code fences and long logs become a marker rather than being truncated
 * mid-source, so the model never receives a fragment of someone's code.
 */
export function speakable(text: string | undefined, max = 200): string {
  if (!text) return "";
  let out = text.replace(/```[\s\S]*?(?:```|$)/g, " [code omitted] ");
  out = redactSecrets(out);
  // Absolute paths are noise when spoken and reveal the directory layout.
  out = out.replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@~-]+){2,}/g, (path) =>
    basename(path.replace(/\\/g, "/")),
  );
  out = out.replace(/\s+/g, " ").trim();
  if (out.length <= max) return out;
  const cut = out.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  return `${stop > max / 2 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, "")}…`;
}

// ---- risk ------------------------------------------------------------------

export const RISK_ORDER: readonly RiskLevel[] = [
  "read",
  "edit",
  "shell",
  "merge",
  "deploy",
  "destructive",
];

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
}

const DESTRUCTIVE =
  /\brm\s+(?:-[a-z]*[rf][a-z]*\s)|\brmdir\b|\bdel\s+\/[sq]|\bRemove-Item\b.*-Recurse|\bgit\s+reset\s+--hard|\bgit\s+clean\b|\bgit\s+push\b.*(?:--force|-f\b)|\bgit\s+branch\s+-D\b|\bdrop\s+(?:table|database)\b|\btruncate\s+table\b|\bmkfs\b|\bdd\s+if=|\bformat\s+[a-z]:|\bgit\s+checkout\s+--\s|\bgit\s+restore\b|\bshred\b/i;
const MERGE = /\bgit\s+(?:merge|rebase|cherry-pick)\b|\bgh\s+pr\s+merge\b|\bgit\s+pull\b/i;
const DEPLOY =
  /\bdeploy\b|\bpublish\b|\bgit\s+push\b|\bkubectl\s+(?:apply|delete|rollout)\b|\bterraform\s+(?:apply|destroy)\b|\bdocker\s+push\b|\bvercel\b.*--prod|\bwrangler\s+(?:deploy|publish)\b|\bgh\s+release\b|\bhelm\s+(?:install|upgrade)\b|\bfirebase\s+deploy\b/i;

export interface RiskInput {
  /** ACP tool kind: read | edit | delete | move | search | execute | think | fetch | other. */
  kind?: string;
  title?: string;
  rawInput?: unknown;
}

function commandText(input: RiskInput): string {
  const raw = input.rawInput;
  const parts: string[] = [];
  if (typeof raw === "string") parts.push(raw);
  else if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    for (const key of ["command", "cmd", "script", "args"]) {
      const value = record[key];
      if (typeof value === "string") parts.push(value);
      else if (Array.isArray(value)) parts.push(value.filter((v) => typeof v === "string").join(" "));
    }
  }
  if (input.title) parts.push(input.title);
  return parts.join(" ");
}

/** Tier an operation from what the agent said it is about to do. */
export function classifyRisk(input: RiskInput): RiskLevel {
  const kind = input.kind ?? "other";
  const text = commandText(input);
  let risk: RiskLevel;
  switch (kind) {
    case "read":
    case "search":
    case "think":
    case "fetch":
      risk = "read";
      break;
    case "edit":
    case "move":
      risk = "edit";
      break;
    case "delete":
      risk = "destructive";
      break;
    case "execute":
      risk = "shell";
      break;
    default:
      // Unknown kinds are treated as shell: unknown is not harmless.
      risk = "shell";
  }
  // A command is judged by its text whatever the agent called it.
  if (kind === "execute" || kind === "other") {
    if (DESTRUCTIVE.test(text)) risk = maxRisk(risk, "destructive");
    else if (DEPLOY.test(text)) risk = maxRisk(risk, "deploy");
    else if (MERGE.test(text)) risk = maxRisk(risk, "merge");
  }
  return risk;
}

export interface SafetyPolicy {
  /** Shell commands need an explicit spoken or tapped approval. Default true. */
  shellNeedsApproval: boolean;
}

export const DEFAULT_POLICY: SafetyPolicy = { shellNeedsApproval: true };

/** Does this tier need a deliberate human answer (not auto-handled by the model)? */
export function needsExplicitApproval(risk: RiskLevel, policy = DEFAULT_POLICY): boolean {
  if (risk === "merge" || risk === "deploy" || risk === "destructive") return true;
  if (risk === "shell") return policy.shellNeedsApproval;
  return false;
}

/** Does approving this tier need a confirmation round trip first? */
export function needsConfirmation(risk: RiskLevel): boolean {
  return risk === "merge" || risk === "deploy" || risk === "destructive";
}

/** A short, secret-free phrase describing a tool call, for speech and event text. */
export function describeTool(input: RiskInput): string {
  const title = speakable(input.title, 90);
  return title || (input.kind ? `a ${input.kind} step` : "a step");
}

// ---- ACP permission options ------------------------------------------------

export interface PermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

/** The option to send for approve / deny. Never picks the "always" variants. */
export function pickOption(
  options: readonly PermissionOption[],
  decision: "approve" | "deny",
): PermissionOption | undefined {
  const once = decision === "approve" ? "allow_once" : "reject_once";
  const any = decision === "approve" ? "allow" : "reject";
  return (
    options.find((o) => o.kind === once) ??
    options.find((o) => o.kind?.startsWith(any) && !o.kind.endsWith("always"))
  );
}

// ---- confirmation tokens ---------------------------------------------------

interface Pending {
  subject: string;
  expiresAt: number;
}

/**
 * Single-use, short-lived tokens for "are you sure?" round trips.
 *
 * The model cannot satisfy a confirmation by itself: the first call returns a
 * token and a question for the user; only a second call carrying that token for
 * the same subject proceeds. A subject is a string naming the exact action (for
 * example `approve:task_1:perm_3`), so a token for one action never unlocks another.
 */
export class ConfirmationTokens {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 120_000,
  ) {}

  issue(subject: string): string {
    this.sweep();
    const token = `cf_${randomBytes(6).toString("hex")}`;
    this.pending.set(token, { subject, expiresAt: this.now() + this.ttlMs });
    return token;
  }

  /** True once, only for the subject it was issued for and before it expires. */
  redeem(token: string | undefined, subject: string): boolean {
    if (!token) return false;
    const entry = this.pending.get(token);
    if (!entry) return false;
    this.pending.delete(token);
    return entry.subject === subject && entry.expiresAt >= this.now();
  }

  private sweep() {
    const now = this.now();
    for (const [token, entry] of this.pending) if (entry.expiresAt < now) this.pending.delete(token);
  }
}

// ---- spoken approvals ------------------------------------------------------

/** A permission request, judged and worded for the ear. */
export interface ApprovalAssessment {
  risk: RiskLevel;
  /** True only for clearly read-only work inside the project: eligible for auto-approval. */
  safe: boolean;
  /** Why it is not safe, in plain words (empty when safe). */
  concerns: string[];
  /** One short sentence, no ids or paths, e.g. "Run the tests." */
  speech: string;
}

const READ_ONLY_COMMAND =
  /^\s*(?:ls|dir|cat|type|head|tail|wc|pwd|echo|grep|rg|find|tree|stat|which|where|git\s+(?:status|diff|log|show|branch(?!\s+-[dDmM])|rev-parse|ls-files|blame)|npm\s+(?:ls|list|outdated)|bun\s+(?:pm\s+ls))\b/i;
const SHELL_CHAINING = /[;&|><`]|\$\(|\n/;
const NETWORK = /\b(?:curl|wget|ssh|scp|rsync|nc|ncat|telnet|ftp|invoke-webrequest|iwr|git\s+(?:push|pull|fetch|clone)|gh\s)|https?:\/\//i;
const INSTALL = /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove|uninstall|update|upgrade)\b|\bpip3?\s+install\b|\bbrew\s+install\b|\bapt(?:-get)?\s+install\b|\bcargo\s+install\b|\bgo\s+install\b|\bnpx\b|\bbunx\b|\bwinget\b|\bchoco\b/i;
const GIT_PUSH = /\bgit\s+push\b/i;
const SECRET_FILE = /(?:^|[\\/])(?:\.env[\w.]*|id_rsa|id_ed25519|credentials|\.npmrc|\.netrc)$/i;

function inputPaths(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ["file_path", "filePath", "path", "file", "destination", "target", "paths"]) {
    const v = record[key];
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") out.push(x);
  }
  return out;
}

function isAbsolutePath(p: string): boolean {
  return /^(?:[A-Za-z]:)?[\\/]/.test(p) || p.startsWith("~");
}

function outsideProject(path: string, cwd: string | undefined): boolean {
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(path) || path.startsWith("~")) return true;
  if (!isAbsolutePath(path)) return false;
  if (!cwd) return true;
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const p = norm(path);
  const root = norm(cwd);
  return !(p === root || p.startsWith(`${root}/`));
}

/**
 * Judge and word one permission request. Pure. `safe` is deliberately narrow:
 * read-only kind or a plain read-only command, nothing touching the network, an
 * install, a secret file, or a path outside `cwd`. Unknown means not safe.
 */
export function assessApproval(input: RiskInput, cwd?: string): ApprovalAssessment {
  const risk = classifyRisk(input);
  const kind = input.kind ?? "other";
  const command = commandText({ ...input, title: undefined });
  const concerns: string[] = [];

  const paths = inputPaths(input.rawInput);
  if (paths.some((p) => outsideProject(p, cwd))) concerns.push("touches files outside the project");
  if (paths.some((p) => SECRET_FILE.test(p))) concerns.push("touches a secrets file");
  if (kind === "fetch" || NETWORK.test(command)) concerns.push("uses the network");
  if (INSTALL.test(command)) concerns.push("installs packages");
  if (GIT_PUSH.test(command)) concerns.push("pushes to a remote");
  if (risk === "destructive") concerns.push("deletes or discards work");
  if (risk === "merge") concerns.push("changes git history");
  if (risk === "deploy") concerns.push("publishes or deploys");
  if (risk === "edit") concerns.push("changes files");

  let readOnly = false;
  if (risk === "read") readOnly = true;
  else if (kind === "execute" && command.trim() && READ_ONLY_COMMAND.test(command) && !SHELL_CHAINING.test(command)) {
    readOnly = true;
  } else if (risk === "shell") concerns.push("runs a command");
  const unique = [...new Set(concerns)];
  const safe = readOnly && unique.length === 0;

  return { risk, safe, concerns: unique, speech: speakApproval(input, kind, command) };
}

function speakApproval(input: RiskInput, kind: string, command: string): string {
  const raw = input.rawInput && typeof input.rawInput === "object" ? (input.rawInput as Record<string, unknown>) : {};
  const file = inputPaths(raw)[0];
  const name = file ? basename(file.replace(/\\/g, "/")) : undefined;
  const cmd = speakable(command, 80);
  switch (kind) {
    case "read":
      return name ? `Read ${name}.` : "Read some files.";
    case "search":
      return "Search the project.";
    case "edit":
      return name ? `Edit ${name}.` : "Edit a file.";
    case "move":
      return name ? `Move ${name}.` : "Move a file.";
    case "delete":
      return name ? `Delete ${name}.` : "Delete files.";
    case "fetch":
      return "Fetch something from the internet.";
    case "execute":
      return cmd ? `Run: ${cmd}` : "Run a command.";
    default: {
      const title = speakable(input.title, 90);
      return title ? `${title.replace(/[.…]+$/, "")}.` : "Do something I can't describe.";
    }
  }
}

/** Per-voice-session approval policy. Default: only clearly read-only requests are auto-approved; everything else is asked. */
export interface ApprovalPolicy {
  /** Auto-approve requests assessed as safe. Never applies to risky ones. */
  autoApproveSafe: boolean;
}

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = { autoApproveSafe: true };
