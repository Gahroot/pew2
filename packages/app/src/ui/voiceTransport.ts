/**
 * The native half of a voice call: microphone, WebRTC peer, `oai-events`.
 *
 * Everything this does is decided in `voiceCall.ts`; this only carries it out.
 * Audio never touches JS: the mic track goes up the peer connection and the
 * remote track plays on its own (react-native-webrtc renders remote audio
 * without an element).
 *
 * iOS audio session: react-native-webrtc 124 sets none itself (its JS API is
 * only CallKit's activate/deactivate). `useVoice` sets playAndRecord +
 * allowBluetooth (no defaultToSpeaker) through expo-audio before this opens
 * the mic, and hands it back to `sounds` when the call closes. The voiceChat
 * mode is left to the WebRTC framework's audio unit; unverified on device.
 */
import { mediaDevices, RTCPeerConnection, type MediaStream } from "react-native-webrtc";
import { CALL_ERRORS, offerErrorMessage, secretExpired, type RealtimeEvent } from "../voiceCall";

const CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const OFFER_TIMEOUT_MS = 20_000;
/** The longest a new call waits on the previous one's teardown. */
const RELEASE_CAP_MS = 5_000;
/** Pause before the one retry of an offer that failed on the network. */
const OFFER_RETRY_MS = 600;

export interface AudioLevels {
  mic?: number;
  outEnergy?: number;
  outDuration?: number;
}

export interface VoiceTransport {
  send(event: RealtimeEvent): void;
  setMuted(muted: boolean): void;
  /**
   * How loud the microphone is right now, 0..1, from WebRTC's own stats (the
   * level of what is being sent). Undefined when the stats don't say. Only
   * drives the listening animation: turn-taking is the server's.
   */
  micLevel(): Promise<number | undefined>;
  /** One stats read: the mic's level, and Pew's received audio (cumulative energy and seconds) for the speaking clock. */
  levels(): Promise<AudioLevels>;
  /**
   * End the call. With `lingerMs`, it goes silent at once (mic off, Pew's
   * audio off, events closed) and the connection itself closes after: the
   * hang-up tone plays inside the call's audio session, and WebRTC shutting
   * that session down would cut it short.
   */
  close(lingerMs?: number): void;
  /**
   * Resolves once this call's audio is really let go: the peer connection
   * reported "closed" (WebRTC stops its audio unit and releases the iOS audio
   * session there, which takes seconds), or `RELEASE_CAP_MS` after it was
   * closed, whichever is first. Never rejects. The next call waits on it.
   */
  released: Promise<void>;
}

export interface TransportHandlers {
  onOpen(): void;
  onEvent(event: unknown): void;
  /** User-facing message. Called at most once, never after `close()`. */
  onFailed(error: string): void;
}

/** Open a call. Resolves with a handle at once; failures arrive on `onFailed`. */
export function openTransport(
  secret: string,
  expiresAt: number | undefined,
  handlers: TransportHandlers,
  /**
   * Resolves once the app's audio session is set for a call. WebRTC starts
   * its voice-processing audio unit as the call connects; reconfiguring the
   * session underneath it at that moment deadlocked Core Audio ("RPC timeout,
   * apparently deadlocked", SIGABRT), so nothing touches the mic before this.
   */
  audioReady: Promise<unknown> = Promise.resolve(),
): VoiceTransport {
  let closed = false;
  /** Hung up and lingering for the tone: nothing may reach the handlers any more. */
  let silenced = false;
  let markReleased: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    markReleased = resolve;
  });
  let stream: MediaStream | undefined;
  let pc: RTCPeerConnection | undefined;
  let channel: ReturnType<RTCPeerConnection["createDataChannel"]> | undefined;
  const abort = new AbortController();
  let lingering: ReturnType<typeof setTimeout> | undefined;

  const fail = (error: string) => {
    if (closed) return;
    if (silenced) {
      // Our own hang-up closing the channel: not a dropped call. Reported,
      // it reached whatever call was current by then (a redial), and closing
      // here cut the hang-up tone's linger short. The linger timer closes.
      devLog(`ignored after hang-up: ${error}`);
      return;
    }
    devLog(`fail: ${error}`);
    close();
    handlers.onFailed(error);
  };

  function close(lingerMs = 0) {
    if (closed) return;
    silenced = true;
    if (lingerMs > 0) {
      if (lingering) return;
      for (const track of stream?.getAudioTracks() ?? []) track.enabled = false;
      for (const receiver of pc?.getReceivers?.() ?? []) {
        if (receiver.track) receiver.track.enabled = false;
      }
      try {
        channel?.close();
      } catch {
        // Already closed.
      }
      devLog(`close, lingering ${lingerMs}ms`);
      lingering = setTimeout(() => close(), lingerMs);
      return;
    }
    clearTimeout(lingering);
    devLog("close: peer down");
    closed = true;
    abort.abort();
    // Nothing was ever opened: nothing to wait for.
    if (!pc) markReleased();
    else setTimeout(markReleased, RELEASE_CAP_MS);
    try {
      channel?.close();
    } catch {
      // Already closed: tearing down is best-effort.
    }
    try {
      pc?.close();
    } catch {
      // Already closed: tearing down is best-effort.
    }
    for (const track of stream?.getTracks() ?? []) {
      try {
        track.stop();
      } catch {
        // Already closed: tearing down is best-effort.
      }
    }
    try {
      stream?.release();
    } catch {
      // Already closed: tearing down is best-effort.
    }
  }

  void (async () => {
    await audioReady.catch(() => {});
    if (closed) return close();
    try {
      stream = await mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (error) {
      devLog(`getUserMedia failed: ${String(error)}`);
      return fail(CALL_ERRORS.microphone);
    }
    if (closed) return close();
    devLog("mic open");
    pc = new RTCPeerConnection({});
    channel = pc.createDataChannel("oai-events");
    channel.onopen = () => {
      if (!closed && !silenced) handlers.onOpen();
    };
    channel.onmessage = (event: { data?: unknown }) => {
      if (closed || silenced || typeof event.data !== "string") return;
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (__DEV__ && process.env.EXPO_PUBLIC_DEV_VOICE_LOG === "1") logRealtime(parsed);
        handlers.onEvent(parsed);
      } catch {
        // A frame that is not JSON carries nothing to act on.
      }
    };
    channel.onclose = () => fail(CALL_ERRORS.dropped);
    pc.onconnectionstatechange = () => {
      const state = pc?.connectionState;
      devLog(`peer ${state ?? "?"}`);
      if (state === "closed") {
        devLog("released");
        markReleased();
      }
      if (state === "failed" || state === "closed") fail(CALL_ERRORS.dropped);
    };
    for (const track of stream.getTracks()) pc.addTrack(track, stream);

    let step = "createOffer";
    try {
      const offer = await pc.createOffer({});
      step = "setLocalDescription";
      await pc.setLocalDescription(offer);
      if (secretExpired(expiresAt, Date.now())) return fail(CALL_ERRORS.expired);
      step = "fetch";
      const timer = setTimeout(() => abort.abort(), OFFER_TIMEOUT_MS);
      const post = () =>
        fetch(CALLS_URL, {
          method: "POST",
          body: offer.sdp,
          headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/sdp" },
          signal: abort.signal,
        });
      const response = await post()
        .catch(async (error: unknown) => {
          // One retry for a request that never got an answer (a network
          // blip); not for the timeout, a hang-up, or an answer OpenAI gave.
          if (closed || abort.signal.aborted) throw error;
          devLog(`offer fetch failed, retrying once: ${String(error)}`);
          await new Promise((resolve) => setTimeout(resolve, OFFER_RETRY_MS));
          if (closed || abort.signal.aborted) throw error;
          return post();
        })
        .finally(() => clearTimeout(timer));
      if (closed) return;
      if (!response.ok) {
        devLog(`offer refused ${response.status}`);
        return fail(offerErrorMessage(response.status));
      }
      const sdp = await response.text();
      if (closed) return;
      step = "setRemoteDescription";
      await pc.setRemoteDescription({ type: "answer", sdp });
      devLog("offer answered");
    } catch (error) {
      devLog(`offer failed at ${step}: ${error instanceof Error ? `${error.name} ${error.message}` : String(error)}`);
      fail(CALL_ERRORS.generic);
    }
  })();

  return {
    send(event) {
      if (closed || channel?.readyState !== "open") return;
      channel.send(JSON.stringify(event));
    },
    setMuted(muted) {
      for (const track of stream?.getAudioTracks() ?? []) track.enabled = !muted;
    },
    async levels() {
      if (closed || !pc) return {};
      const out: AudioLevels = {};
      try {
        const report: Map<string, Record<string, unknown>> | Record<string, Record<string, unknown>> = await pc.getStats();
        const entries = report instanceof Map ? [...report.values()] : Object.values(report);
        for (const stat of entries) {
          if (stat.kind !== "audio") continue;
          if ((stat.type === "media-source" || stat.type === "track") && typeof stat.audioLevel === "number" && out.mic === undefined) {
            out.mic = Math.max(0, Math.min(1, stat.audioLevel));
          }
          if (stat.type === "inbound-rtp" && typeof stat.totalAudioEnergy === "number" && typeof stat.totalSamplesDuration === "number") {
            out.outEnergy = stat.totalAudioEnergy;
            out.outDuration = stat.totalSamplesDuration;
          }
        }
      } catch {
        // Best-effort: no levels means calmer waves and captions paced by time.
      }
      return out;
    },
    async micLevel() {
      if (closed || !pc) return undefined;
      try {
        const report: Map<string, Record<string, unknown>> | Record<string, Record<string, unknown>> = await pc.getStats();
        const entries = report instanceof Map ? [...report.values()] : Object.values(report);
        for (const stat of entries) {
          if ((stat.type === "media-source" || stat.type === "track") && stat.kind === "audio" && typeof stat.audioLevel === "number") {
            return Math.max(0, Math.min(1, stat.audioLevel));
          }
        }
      } catch {
        // Stats are best-effort: no level just means a calmer animation.
      }
      return undefined;
    },
    close,
    released,
  };
}

/** Development only (`EXPO_PUBLIC_DEV_VOICE_LOG=1`): one transport step. */
function devLog(line: string): void {
  if (__DEV__ && process.env.EXPO_PUBLIC_DEV_VOICE_LOG === "1") console.log(`[voice] +${Math.round(performance.now())}ms transport ${line}`);
}

/**
 * Development only (`EXPO_PUBLIC_DEV_VOICE_LOG=1`): one line per realtime event
 * that matters for turn-taking, with what each side said, so a call can be
 * read back from the Metro log. Deltas and audio frames are skipped.
 */
function logRealtime(event: unknown): void {
  const e = event as { type?: string; transcript?: string; item?: { type?: string; name?: string }; response?: { status?: string; status_details?: unknown } };
  const type = e.type ?? "?";
  if (type.endsWith(".delta") || type === "response.output_audio.done") return;
  const said = typeof e.transcript === "string" ? ` "${e.transcript.slice(0, 80)}"` : "";
  const extra = type === "response.done" ? ` ${e.response?.status ?? ""} ${JSON.stringify(e.response?.status_details ?? "")}` : e.item?.name ? ` ${e.item.name}` : "";
  console.log(`[voice] +${Math.round(performance.now())}ms ${type}${said}${extra}`);
}
