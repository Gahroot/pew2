/**
 * Turn one transcript row into running state, per agent file format.
 *
 * These files belong to other programs and change shape without notice, so
 * every read is defensive: an unknown row is a no-op, never a throw. The
 * working/idle signal is exact for GG/EZ Coder (`run_started`/`run_finished`)
 * and Codex (`task_started`/`task_complete`); Claude Code writes no run marker,
 * so a user prompt opens a turn and an assistant `end_turn` (or the
 * `turn_duration` system row) closes it.
 */

export type DeskFormat = "claude" | "gg" | "codex";

/** What a transcript has told us so far. Mutated in place by `foldRow`. */
export interface DeskFileState {
  agentSessionId?: string;
  cwd?: string;
  title?: string;
  working: boolean;
  tool?: string;
  lastPrompt?: string;
  lastText?: string;
}

export const MAX_TITLE = 200;
export const MAX_TOOL = 80;
const MAX_TEXT = 1024;

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Keep the tail: the latest words of a reply are the ones worth saying. */
function tailText(text: string): string {
  const t = text.trim();
  return t.length > MAX_TEXT ? t.slice(t.length - MAX_TEXT) : t;
}

/** Plain text of a message `content`, string or block list; tool results and images skipped. */
function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return str(content);
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return str(parts.join("\n"));
}

function hasBlock(content: unknown, type: string): boolean {
  return Array.isArray(content) && content.some((b) => asRecord(b)?.type === type);
}

function lastToolName(content: unknown, type: string): string | undefined {
  if (!Array.isArray(content)) return undefined;
  let name: string | undefined;
  for (const block of content) {
    const b = asRecord(block);
    if (b?.type === type) name = str(b.name) ?? name;
  }
  return name ? name.slice(0, MAX_TOOL) : undefined;
}

/** A prompt the user typed, not harness noise like `<command-name>` or caveats. */
function userPrompt(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const t = text.trim();
  if (t.startsWith("<")) return undefined;
  return t;
}

function setPrompt(state: DeskFileState, prompt: string) {
  state.lastPrompt = oneLine(prompt, MAX_TEXT);
  state.title ??= oneLine(prompt, MAX_TITLE);
}

function foldGg(state: DeskFileState, row: Rec) {
  if (row.type === "session") {
    state.agentSessionId = str(row.id) ?? state.agentSessionId;
    state.cwd = str(row.cwd) ?? state.cwd;
    const preview = str(row.preview);
    if (preview) state.title ??= oneLine(preview, MAX_TITLE);
    return;
  }
  if (row.type === "custom") {
    const data = asRecord(row.data);
    switch (row.kind) {
      case "run_started":
        state.working = true;
        return;
      case "run_finished":
        state.working = false;
        state.tool = undefined;
        return;
      case "turn_metric": {
        // Not every run writes `run_started` (autopilot turns don't), so the
        // per-step metric is the fallback: `end_turn` closes the turn.
        const stop = str(data?.stopReason);
        if (stop === "tool_use") state.working = true;
        else if (stop) {
          state.working = false;
          state.tool = undefined;
        }
        return;
      }
      case "app_transcript_marker": {
        const title = str(asRecord(data?.data)?.title);
        if (title) state.title = oneLine(title, MAX_TITLE);
        return;
      }
      default:
        return;
    }
  }
  if (row.type === "message") {
    const message = asRecord(row.message);
    if (!message) return;
    if (message.role === "user") {
      const prompt = userPrompt(textOf(message.content));
      if (prompt) {
        setPrompt(state, prompt);
        state.working = true;
        state.tool = undefined;
      }
    } else if (message.role === "assistant") {
      const text = textOf(message.content);
      if (text) state.lastText = tailText(text);
      const tool = lastToolName(message.content, "tool_call");
      if (tool) {
        state.tool = tool;
        state.working = true;
      }
    }
  }
}

function foldClaude(state: DeskFileState, row: Rec) {
  state.cwd = str(row.cwd) ?? state.cwd;
  state.agentSessionId = str(row.sessionId) ?? state.agentSessionId;
  if (row.isSidechain === true) return;
  if (row.type === "summary" || row.type === "ai-title") {
    const title = str(row.summary) ?? str(row.aiTitle) ?? str(row.title);
    if (title) state.title = oneLine(title, MAX_TITLE);
    return;
  }
  if (row.type === "system" && row.subtype === "turn_duration") {
    state.working = false;
    state.tool = undefined;
    return;
  }
  const message = asRecord(row.message);
  if (!message) return;
  if (row.type === "user" && row.isMeta !== true) {
    if (hasBlock(message.content, "tool_result")) return;
    const prompt = userPrompt(textOf(message.content));
    if (prompt) {
      setPrompt(state, prompt);
      state.working = true;
      state.tool = undefined;
    }
    return;
  }
  if (row.type === "assistant") {
    const text = textOf(message.content);
    if (text) state.lastText = tailText(text);
    const tool = lastToolName(message.content, "tool_use");
    if (tool) {
      state.tool = tool;
      state.working = true;
    }
    const stop = message.stop_reason;
    if (stop === "end_turn" || stop === "stop_sequence") {
      state.working = false;
      state.tool = undefined;
    }
  }
}

function foldCodex(state: DeskFileState, row: Rec) {
  const payload = asRecord(row.payload);
  if (!payload) return;
  if (row.type === "session_meta") {
    state.agentSessionId = str(payload.id) ?? state.agentSessionId;
    state.cwd = str(payload.cwd) ?? state.cwd;
    return;
  }
  if (row.type === "event_msg") {
    switch (payload.type) {
      case "task_started":
        state.working = true;
        return;
      case "task_complete":
        state.working = false;
        state.tool = undefined;
        if (typeof payload.last_agent_message === "string")
          state.lastText = tailText(payload.last_agent_message);
        return;
      case "user_message": {
        const prompt = userPrompt(str(payload.message));
        if (prompt) setPrompt(state, prompt);
        return;
      }
      case "agent_message":
        if (typeof payload.message === "string") state.lastText = tailText(payload.message);
        return;
      default:
        return;
    }
  }
  if (row.type === "response_item" && payload.type === "function_call") {
    const name = str(payload.name);
    if (name) state.tool = name.slice(0, MAX_TOOL);
  }
}

/** Fold one parsed JSONL row into `state`. Never throws. */
export function foldRow(format: DeskFormat, state: DeskFileState, row: unknown): void {
  const rec = asRecord(row);
  if (!rec) return;
  try {
    if (format === "gg") foldGg(state, rec);
    else if (format === "claude") foldClaude(state, rec);
    else foldCodex(state, rec);
  } catch {
    // A row shaped in a way nobody planned for is skipped, never fatal.
  }
}

/** Parse and fold each complete line; malformed lines are skipped. */
export function foldLines(
  format: DeskFormat,
  state: DeskFileState,
  lines: readonly string[],
): void {
  for (const line of lines) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    foldRow(format, state, row);
  }
}
