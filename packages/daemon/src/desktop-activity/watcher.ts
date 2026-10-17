/**
 * Conversations running on this computer that the daemon does not hold.
 *
 * A session started at the desk (Claude Code, GG/EZ Coder or Codex in a
 * terminal) reaches the phone only as a history stub from the provider probe,
 * with no running state. The agents' own transcript files do say whether a turn
 * is in flight, so this watches them: a slow scan finds recently touched files,
 * a fast poll reads only the bytes appended since, and the folded result is the
 * `desktop.activity` snapshot.
 *
 * Polling is authoritative; `fs.watch` only nudges an early tail. Every fs
 * error is swallowed per file, and any doubt answers "not running": a crashed
 * CLI that wrote `run_started` and nothing else is idle after `STALE_MS`.
 */
import { watch, type FSWatcher } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { wire } from "@pew2/protocol";
import { foldLines, type DeskFileState, type DeskFormat } from "./parsers.js";

export interface DeskRoot {
  providerId: string;
  format: DeskFormat;
  dir: string;
}

export type DeskSession = wire.DesktopSession & { lastPrompt?: string; lastText?: string };

export interface DesktopActivityOptions {
  roots: DeskRoot[];
  /** Agent session ids the daemon itself holds; its own ACP children write these same files. */
  ownedAgentSessionIds: () => Set<string>;
  onChange: (sessions: DeskSession[]) => void;
  now?: () => number;
  scanMs?: number;
  tailMs?: number;
}

/** A file untouched this long is not a live conversation. */
export const RECENT_MS = 30 * 60 * 1000;
/** Working only while the transcript is still being written to. */
export const STALE_MS = 15 * 60 * 1000;
const MAX_FILES = 10_000;
const MAX_TRACKED = 64;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const MAX_APPEND = 2 * 1024 * 1024;
/** Codex files live under YYYY/MM/DD; a session older than a week is not running. */
const CODEX_DAYS = 7;

interface Tracked {
  root: DeskRoot;
  path: string;
  offset: number;
  partial: string;
  mtimeMs: number;
  state: DeskFileState;
}

/** Where each agent keeps its transcripts, honouring the same overrides the agents do. */
export function defaultDeskRoots(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): DeskRoot[] {
  return [
    {
      providerId: "claude-code",
      format: "claude",
      dir: join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects"),
    },
    {
      providerId: "ggcoder",
      format: "gg",
      dir: join(env.GG_AGENT_DIR || join(home, ".gg"), "sessions"),
    },
    { providerId: "ezcoder", format: "gg", dir: join(home, ".ezcoder", "sessions") },
    {
      providerId: "codex",
      format: "codex",
      dir: join(env.CODEX_HOME || join(home, ".codex"), "sessions"),
    },
  ];
}

async function dirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function jsonl(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => join(path, e.name));
  } catch {
    return [];
  }
}

/** Candidate transcript files under one root. Bounded by `budget`. */
async function filesUnder(root: DeskRoot, budget: number): Promise<string[]> {
  const out: string[] = [];
  if (root.format === "codex") {
    // Newest day directories first, a week of them at most.
    const days: string[] = [];
    for (const y of (await dirs(root.dir)).reverse()) {
      for (const m of (await dirs(join(root.dir, y))).reverse()) {
        for (const d of (await dirs(join(root.dir, y, m))).reverse()) {
          days.push(join(root.dir, y, m, d));
          if (days.length >= CODEX_DAYS) break;
        }
        if (days.length >= CODEX_DAYS) break;
      }
      if (days.length >= CODEX_DAYS) break;
    }
    for (const day of days) {
      out.push(...(await jsonl(day)));
      if (out.length >= budget) break;
    }
    return out.slice(0, budget);
  }
  for (const project of await dirs(root.dir)) {
    out.push(...(await jsonl(join(root.dir, project))));
    if (out.length >= budget) break;
  }
  return out.slice(0, budget);
}

async function readRange(path: string, start: number, length: number): Promise<string> {
  if (length <= 0) return "";
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Split into complete lines plus the unterminated remainder. */
function splitLines(text: string): { lines: string[]; rest: string } {
  const lines = text.split("\n");
  const rest = lines.pop() ?? "";
  return { lines, rest };
}

export class DesktopActivityWatcher {
  private readonly tracked = new Map<string, Tracked>();
  private readonly now: () => number;
  private readonly scanMs: number;
  private readonly tailMs: number;
  private scanTimer?: ReturnType<typeof setInterval>;
  private tailTimer?: ReturnType<typeof setInterval>;
  private watchers: FSWatcher[] = [];
  private last = "[]";
  private current: DeskSession[] = [];
  /** Serialises scan/tail so two never fold the same file at once. */
  private chain: Promise<void> = Promise.resolve();
  private nudged = false;

  constructor(private readonly options: DesktopActivityOptions) {
    this.now = options.now ?? Date.now;
    this.scanMs = options.scanMs ?? 30_000;
    this.tailMs = options.tailMs ?? 2_000;
  }

  start() {
    if (this.scanTimer) return;
    void this.scan();
    this.scanTimer = setInterval(() => void this.scan(), this.scanMs);
    this.scanTimer.unref?.();
    this.tailTimer = setInterval(() => void this.tail(), this.tailMs);
    this.tailTimer.unref?.();
    for (const root of this.options.roots) {
      try {
        const watcher = watch(root.dir, { recursive: true, persistent: false }, () => this.nudge());
        watcher.on("error", () => watcher.close());
        this.watchers.push(watcher);
      } catch {
        // No recursive watch on this platform, or the directory is absent: polling covers it.
      }
    }
  }

  stop() {
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.tailTimer) clearInterval(this.tailTimer);
    this.scanTimer = undefined;
    this.tailTimer = undefined;
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // already closed
      }
    }
    this.watchers = [];
  }

  /** The latest snapshot, newest first. */
  snapshot(): DeskSession[] {
    return this.current;
  }

  /** One conversation's latest state, if it is still in the snapshot. */
  peek(agentSessionId: string): DeskSession | undefined {
    return this.current.find((s) => s.agentSessionId === agentSessionId);
  }

  /** Find recently touched transcripts, start tracking new ones, drop old ones. */
  scan(): Promise<void> {
    return this.serial(() => this.scanNow());
  }

  /** Read what was appended to tracked files since the last look. */
  tail(): Promise<void> {
    return this.serial(() => this.tailNow());
  }

  /** A burst of fs events becomes one early tail, not one per write. */
  private nudge() {
    if (this.nudged) return;
    this.nudged = true;
    void this.tail().finally(() => (this.nudged = false));
  }

  private serial(work: () => Promise<void>): Promise<void> {
    const next = this.chain.then(work).catch(() => undefined);
    this.chain = next;
    return next;
  }

  private async scanNow() {
    const now = this.now();
    const found: { root: DeskRoot; path: string; mtimeMs: number }[] = [];
    let budget = MAX_FILES;
    for (const root of this.options.roots) {
      if (budget <= 0) break;
      const files = await filesUnder(root, budget);
      budget -= files.length;
      for (const path of files) {
        try {
          const info = await stat(path);
          if (now - info.mtimeMs < RECENT_MS) found.push({ root, path, mtimeMs: info.mtimeMs });
        } catch {
          // gone between readdir and stat
        }
      }
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
    const keep = new Set(found.slice(0, MAX_TRACKED).map((f) => f.path));
    for (const path of [...this.tracked.keys()]) if (!keep.has(path)) this.tracked.delete(path);
    for (const f of found.slice(0, MAX_TRACKED)) {
      if (this.tracked.has(f.path)) continue;
      try {
        this.tracked.set(f.path, await this.firstSight(f.root, f.path));
      } catch {
        // unreadable: try again next scan
      }
    }
    await this.tailNow();
  }

  /** Head for identity, tail for current state; the middle of a long file says nothing about now. */
  private async firstSight(root: DeskRoot, path: string): Promise<Tracked> {
    const info = await stat(path);
    const size = info.size;
    const state: DeskFileState = { working: false };
    let partial: string;
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      const { lines, rest } = splitLines(await readRange(path, 0, size));
      foldLines(root.format, state, lines);
      partial = rest;
    } else {
      const head = splitLines(await readRange(path, 0, HEAD_BYTES));
      foldLines(root.format, state, head.lines);
      const tail = splitLines(await readRange(path, size - TAIL_BYTES, TAIL_BYTES));
      // The first line of the window is almost certainly cut mid-row.
      foldLines(root.format, state, tail.lines.slice(1));
      partial = tail.rest;
    }
    return { root, path, offset: size, partial, mtimeMs: info.mtimeMs, state };
  }

  private async tailNow() {
    for (const [path, file] of [...this.tracked]) {
      try {
        const info = await stat(path);
        if (info.size < file.offset) {
          // Rewritten or truncated: start over.
          this.tracked.set(path, await this.firstSight(file.root, path));
          continue;
        }
        file.mtimeMs = info.mtimeMs;
        if (info.size === file.offset) continue;
        let start = file.offset;
        let carry = file.partial;
        if (info.size - start > MAX_APPEND) {
          start = info.size - MAX_APPEND;
          carry = "";
        }
        const text = carry + (await readRange(path, start, info.size - start));
        const { lines, rest } = splitLines(text);
        // A skipped gap leaves the first line cut mid-row.
        foldLines(file.root.format, file.state, start === file.offset ? lines : lines.slice(1));
        file.partial = rest;
        file.offset = info.size;
      } catch {
        this.tracked.delete(path);
      }
    }
    this.publish();
  }

  private publish() {
    const now = this.now();
    const owned = this.options.ownedAgentSessionIds();
    const byId = new Map<string, DeskSession>();
    for (const [path, file] of this.tracked) {
      if (now - file.mtimeMs >= RECENT_MS) {
        this.tracked.delete(path);
        continue;
      }
      const { agentSessionId, cwd } = file.state;
      if (!agentSessionId || !cwd || owned.has(agentSessionId)) continue;
      const working = file.state.working && now - file.mtimeMs < STALE_MS;
      const session: DeskSession = {
        providerId: file.root.providerId,
        agentSessionId,
        cwd,
        ...(file.state.title ? { title: file.state.title } : null),
        state: working ? "working" : "idle",
        updatedAt: Math.round(file.mtimeMs),
        ...(working && file.state.tool ? { tool: file.state.tool } : null),
        ...(file.state.lastPrompt ? { lastPrompt: file.state.lastPrompt } : null),
        ...(file.state.lastText ? { lastText: file.state.lastText } : null),
      };
      // One conversation, one entry: the most recently written file wins.
      const key = `${session.providerId}:${agentSessionId}`;
      const seen = byId.get(key);
      if (!seen || seen.updatedAt < session.updatedAt) byId.set(key, session);
    }
    const sessions = [...byId.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt || a.agentSessionId.localeCompare(b.agentSessionId),
    );
    this.current = sessions;
    // `updatedAt` moves on every write; a change worth sending is a state, title or tool change.
    const wireJson = JSON.stringify(sessions.map((s) => ({ ...toWire(s), updatedAt: 0 })));
    if (wireJson === this.last) return;
    this.last = wireJson;
    this.options.onChange(sessions);
  }
}

/** The fields that cross the wire; prompts and reply text stay on this machine. */
export function toWire(s: DeskSession): wire.DesktopSession {
  return {
    providerId: s.providerId,
    agentSessionId: s.agentSessionId,
    cwd: s.cwd,
    ...(s.title ? { title: s.title } : null),
    state: s.state,
    updatedAt: s.updatedAt,
    ...(s.tool ? { tool: s.tool } : null),
  };
}
