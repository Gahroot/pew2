/**
 * The WebRTC half of a Realtime connection (react-native-webrtc).
 *
 * WebRTC rather than a raw WebSocket because it brings the platform's echo
 * cancellation and device audio routing (AirPods) with it, and plays the
 * model's audio itself. The ephemeral secret from `voice.ready` is the only
 * credential involved; the OpenAI API key never reaches the phone.
 *
 * Message handling lives in `../voice/realtime.ts`; this file only moves bytes.
 * UNTESTED ON DEVICE.
 */
import { RTCPeerConnection, mediaDevices } from "react-native-webrtc";
import type { RealtimeChannel } from "../voice/realtime";

const CALLS_URL = "https://api.openai.com/v1/realtime/calls";

export interface TransportCallbacks {
  onOpen(): void;
  onMessage(raw: string): void;
  /** The peer or channel died after being up (or failed to come up). */
  onClosed(reason: string): void;
  onMicDenied(): void;
}

export interface RealtimeTransport extends RealtimeChannel {
  close(): void;
  /** Stop or resume sending the microphone (the system call screen's mute). */
  setMuted(muted: boolean): void;
}

/** Connects; resolves once the offer/answer exchange is done. Rejects on failure. */
export async function connectRealtime(
  secret: string,
  model: string,
  callbacks: TransportCallbacks,
  signal?: AbortSignal,
): Promise<RealtimeTransport> {
  let stream: Awaited<ReturnType<typeof mediaDevices.getUserMedia>>;
  try {
    stream = await mediaDevices.getUserMedia({ audio: true, video: false });
  } catch {
    callbacks.onMicDenied();
    throw new Error("microphone unavailable");
  }

  const peer = new RTCPeerConnection();
  let closed = false;
  const finish = (reason: string) => {
    if (closed) return;
    closed = true;
    callbacks.onClosed(reason);
  };

  for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
  const channel = peer.createDataChannel("oai-events");

  channel.onopen = () => callbacks.onOpen();
  channel.onmessage = (event: { data: unknown }) => {
    if (typeof event.data === "string") callbacks.onMessage(event.data);
  };
  channel.onclose = () => finish("channel closed");
  peer.onconnectionstatechange = () => {
    const state = peer.connectionState;
    if (state === "failed" || state === "disconnected" || state === "closed") finish(`peer ${state}`);
  };

  const transport: RealtimeTransport = {
    send(message) {
      if (channel.readyState !== "open") return false;
      channel.send(JSON.stringify(message));
      return true;
    },
    setMuted(muted) {
      for (const track of stream.getAudioTracks()) track.enabled = !muted;
    },
    close() {
      closed = true;
      try {
        channel.close();
      } catch {
        // already closed
      }
      for (const track of stream.getTracks()) track.stop();
      peer.close();
    },
  };

  try {
    const offer = await peer.createOffer({});
    await peer.setLocalDescription(offer);
    const response = await fetch(`${CALLS_URL}?model=${encodeURIComponent(model)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/sdp" },
      body: offer.sdp,
      signal,
    });
    if (!response.ok) throw new Error(`Realtime refused the connection (${response.status})`);
    await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
  } catch (error) {
    transport.close();
    throw error;
  }
  return transport;
}
