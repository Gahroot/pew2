/**
 * The conversation with OpenAI Realtime, minus the network.
 *
 * `ui/realtimeTransport.ts` owns the WebRTC peer and its `oai-events` data
 * channel and gives this module a `RealtimeChannel`. Everything the app *decides*
 * about the Realtime protocol lives here so it can be tested with a fake:
 *
 *  - apply the daemon's `realtime.session` verbatim via `session.update`;
 *  - forward every function call, untouched, as a tool call (the app never
 *    interprets a tool name) and feed the daemon's answer back as
 *    `function_call_output`, then `response.create`;
 *  - report speech/turn boundaries to the state machine.
 *
 * Only one `response.create` may be in flight, so results are batched: when a
 * response made several calls, the model is asked to continue once all of them
 * have been answered and the current response has finished.
 */

/** The data channel as this module needs it. */
export interface RealtimeChannel {
  /** Returns false when nothing was sent (channel not open). */
  send(message: Record<string, unknown>): boolean;
}

export interface ToolCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  ok: boolean;
  output: unknown;
  error?: string;
  endSession?: boolean;
}

export interface RealtimeHandlers {
  /** The session config was accepted: the conversation is live. */
  onReady(): void;
  onUserSpeech(): void;
  onModelSpeaking(): void;
  /** The model's audio has actually stopped (or it produced none). */
  onModelDone(): void;
  onToolCall(call: ToolCall): void;
  /** A result carried `endSession`. The machine waits for the model to stop speaking. */
  onEndSession(): void;
  onError(message: string, fatal: boolean): void;
  /** A finished utterance, for the on-screen transcript only. */
  onTranscript?(role: "user" | "assistant", text: string): void;
}

export interface RealtimeSessionOptions {
  channel: RealtimeChannel;
  /** `voice.ready.realtime.session`, passed through untouched. */
  session: Record<string, unknown>;
  /** Model speaks first (a notification brought the user here). */
  speakFirst: boolean;
  handlers: RealtimeHandlers;
}

export interface RealtimeSession {
  /** Call when the data channel opens. */
  start(): void;
  /** Feed one data-channel message. */
  handleMessage(raw: string): void;
  /** Answer a function call with the daemon's `voice.tool.result`. */
  submitResult(result: ToolResult): void;
  /** Anything still waiting on the daemon (for tests and teardown). */
  outstanding(): string[];
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Realtime sends function arguments as a JSON string. */
export function parseArguments(raw: unknown): { args: Json; valid: boolean } {
  if (isRecord(raw)) return { args: raw, valid: true };
  if (typeof raw !== "string" || raw.trim() === "") return { args: {}, valid: true };
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? { args: parsed, valid: true } : { args: {}, valid: false };
  } catch {
    return { args: {}, valid: false };
  }
}

/** What goes back to the model for a result. Errors carry a message, never a stack. */
export function outputText(result: ToolResult): string {
  const body = result.ok ? result.output : { error: result.error ?? "The tool failed." };
  try {
    return JSON.stringify(body ?? null) ?? "null";
  } catch {
    return JSON.stringify({ error: "The result could not be serialised." });
  }
}

export function createRealtimeSession(options: RealtimeSessionOptions): RealtimeSession {
  const { channel, handlers } = options;
  /** Calls forwarded and not yet answered. */
  const pending = new Set<string>();
  /** Every call id ever seen: function calls arrive twice (arguments.done + response.done). */
  const seen = new Set<string>();
  let responseActive = false;
  let wantResponse = false;
  let ready = false;
  let endRequested = false;

  const continueIfIdle = () => {
    if (!wantResponse || responseActive || pending.size > 0) return;
    wantResponse = false;
    responseActive = true;
    channel.send({ type: "response.create" });
  };

  const forward = (callId: unknown, name: unknown, rawArgs: unknown) => {
    if (typeof callId !== "string" || !callId || typeof name !== "string" || !name) return;
    if (seen.has(callId)) return;
    seen.add(callId);
    const { args, valid } = parseArguments(rawArgs);
    if (!valid) {
      // Unreadable arguments cannot be sent to the daemon as an object. Tell the
      // model so it can retry; this is about the transport, not the tool.
      channel.send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({ error: "The arguments were not valid JSON." }),
        },
      });
      wantResponse = true;
      continueIfIdle();
      return;
    }
    pending.add(callId);
    handlers.onToolCall({ callId, name, args });
  };

  const hasAudio = (item: unknown): boolean => {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) return false;
    return item.content.some((part) => isRecord(part) && (part.type === "audio" || part.type === "output_audio"));
  };

  const onResponseDone = (response: unknown) => {
    responseActive = false;
    const output = isRecord(response) && Array.isArray(response.output) ? response.output : [];
    let calls = 0;
    let audio = false;
    for (const item of output) {
      if (isRecord(item) && item.type === "function_call") {
        calls++;
        forward(item.call_id, item.name, item.arguments);
      } else if (hasAudio(item)) {
        audio = true;
      }
    }
    // No audio and no call to wait on: nothing will ever fire the playback-stopped
    // event, so this is the end of the model's turn. (Audio ends on
    // `output_audio_buffer.stopped`, not here: the response finishes generating
    // well before it finishes playing.)
    if (!audio && calls === 0 && pending.size === 0 && !wantResponse) handlers.onModelDone();
    continueIfIdle();
  };

  const handleMessage = (raw: string) => {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message.type !== "string") return;

    switch (message.type) {
      case "session.updated":
        if (!ready) {
          ready = true;
          handlers.onReady();
          if (options.speakFirst) {
            responseActive = true;
            channel.send({ type: "response.create" });
          }
        }
        return;
      case "input_audio_buffer.speech_started":
        handlers.onUserSpeech();
        return;
      case "conversation.item.input_audio_transcription.completed":
        if (typeof message.transcript === "string") handlers.onTranscript?.("user", message.transcript);
        return;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        if (typeof message.transcript === "string") handlers.onTranscript?.("assistant", message.transcript);
        return;
      case "response.created":
        responseActive = true;
        return;
      case "output_audio_buffer.started":
        handlers.onModelSpeaking();
        return;
      case "response.output_audio.delta":
      case "response.audio.delta":
        handlers.onModelSpeaking();
        return;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        if (pending.size === 0 && !wantResponse) handlers.onModelDone();
        return;
      case "response.function_call_arguments.done":
        forward(message.call_id, message.name, message.arguments);
        return;
      case "response.done":
        onResponseDone(message.response);
        return;
      case "error": {
        const detail = isRecord(message.error) ? message.error : {};
        const code = typeof detail.code === "string" ? detail.code : "";
        // Racing a cancel against a finishing response is routine, not a failure.
        if (code === "response_cancel_not_active" || code === "conversation_already_has_active_response") {
          if (code === "conversation_already_has_active_response") responseActive = true;
          return;
        }
        const text = typeof detail.message === "string" ? detail.message : "Voice error.";
        const fatal = code === "invalid_api_key" || code === "session_expired" || code === "model_not_found";
        handlers.onError(text, fatal);
        return;
      }
      default:
        return;
    }
  };

  return {
    start() {
      // `session` is the daemon's, applied as-is (instructions, tools, VAD).
      channel.send({ type: "session.update", session: options.session });
    },
    handleMessage,
    submitResult(result) {
      if (!pending.delete(result.callId)) return; // unknown or already answered
      channel.send({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: result.callId, output: outputText(result) },
      });
      wantResponse = true;
      if (result.endSession && !endRequested) {
        endRequested = true;
        handlers.onEndSession();
      }
      continueIfIdle();
    },
    outstanding: () => [...pending],
  };
}
