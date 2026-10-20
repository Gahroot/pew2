// Start an echo-agent session on a running daemon and send it one prompt, so a
// voice call has a real (harmless) session to work with. Prints the session id.
//   PEW2_HOME=... PEW2_PORT=... bun run packages/daemon/src/testing/echo-session.mjs ["prompt text"]
import { loadPairing } from "../pairing.js";
import { CLI_DEVICE_PREFIX } from "../device-claim.js";
import { SecureChannel, e2e, wire } from "@pew2/protocol";

const port = process.env.PEW2_PORT ?? "8787";
const text = process.argv[2] ?? "Hello from the voice end-to-end test.";
const pairing = await loadPairing();
const channel = new SecureChannel(e2e.fromHex(pairing.key), "app");
const deviceId = `${CLI_DEVICE_PREFIX}echo-session`;
const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${pairing.token}`);
const send = (m) => ws.send(JSON.stringify(channel.seal(m)));
const started = new Promise((resolve) => {
  ws.addEventListener("message", (e) => {
    const frame = JSON.parse(e.data);
    const message = e2e.isEnvelope(frame) ? channel.open(frame) : frame;
    if (message?.t === "session.started" && message.requestId === "e2e") resolve(message.sessionId);
    if (message?.t === "error") console.log("error:", message.message ?? message.code);
  });
});
await new Promise((r) => ws.addEventListener("open", r));
ws.send(JSON.stringify({ t: "hello", wire: wire.WIRE_VERSION, role: "app", deviceId, proof: channel.proof(deviceId), cursors: {} }));
await new Promise((r) => setTimeout(r, 300));
send({ t: "session.start", requestId: "e2e", providerId: "echo" });
const sessionId = await Promise.race([started, new Promise((r) => setTimeout(() => r(undefined), 20000))]);
if (!sessionId) {
  console.log("no session");
  process.exit(1);
}
send({ t: "session.prompt", sessionId, text, attachments: [] });
await new Promise((r) => setTimeout(r, 2500));
console.log(JSON.stringify({ sessionId }));
ws.close();
process.exit(0);
