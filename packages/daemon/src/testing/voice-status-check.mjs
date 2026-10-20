// Ask a running daemon what voice can do, the way the app does: hello, then a
// sealed `voice.status`. Prints the answer without anything secret in it.
//   PEW2_HOME=... PEW2_PORT=... bun run packages/daemon/src/testing/voice-status-check.mjs
import { loadPairing } from "../pairing.js";
import { CLI_DEVICE_PREFIX } from "../device-claim.js";
import { SecureChannel, e2e, wire } from "@pew2/protocol";

const port = process.env.PEW2_PORT ?? "8787";
const pairing = await loadPairing();
const channel = new SecureChannel(e2e.fromHex(pairing.key), "app");
const deviceId = `${CLI_DEVICE_PREFIX}voice-status-check`;
const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${pairing.token}`);
const send = (m) => ws.send(JSON.stringify(channel.seal(m)));
const answer = new Promise((resolve) => {
  ws.addEventListener("message", (e) => {
    const frame = JSON.parse(e.data);
    const message = e2e.isEnvelope(frame) ? channel.open(frame) : frame;
    if (message?.t === "voice.status" && message.requestId === "check") resolve(message);
  });
});
ws.addEventListener("error", () => {
  console.log("could not connect");
  process.exit(1);
});
await new Promise((r) => ws.addEventListener("open", r));
ws.send(JSON.stringify({ t: "hello", wire: wire.WIRE_VERSION, role: "app", deviceId, proof: channel.proof(deviceId), cursors: {} }));
await new Promise((r) => setTimeout(r, 300));
send({ t: "voice.status", requestId: "check" });
const status = await Promise.race([answer, new Promise((r) => setTimeout(() => r({ timeout: true }), 8000))]);
const { login, ...rest } = status;
console.log(JSON.stringify({ ...rest, ...(login ? { login: { verificationUrl: login.verificationUrl, userCode: "(hidden)" } } : {}) }, null, 1));
ws.close();
process.exit(0);
