/**
 * Does Apple accept our provider token? Signs a JWT with ./apns.ts and sends a
 * VoIP push to the APNs *sandbox* with a fake device token.
 *
 *   APNS_KEY_FILE=/path/AuthKey_XXXX.p8 bun run packages/relay/src/apns-probe.ts
 *
 * 400 BadDeviceToken → key and JWT accepted. 403 InvalidProviderToken → not.
 * Prints only the HTTP status and APNs reason, never the key or the JWT.
 */
import { readFileSync } from "node:fs";
import { connect } from "node:http2";
import { signJwt } from "./apns.js";

const file = process.env.APNS_KEY_FILE;
if (!file) {
  console.error("set APNS_KEY_FILE to the .p8 path");
  process.exit(2);
}
const jwt = await signJwt(
  { key: readFileSync(file, "utf8"), keyId: "G9J85F9X9S", teamId: "396M7LY29W" },
  Date.now(),
);
// APNs speaks HTTP/2 only, and Bun's fetch is HTTP/1.1, so use node:http2.
const client = connect("https://api.sandbox.push.apple.com");
const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
  const req = client.request({
    ":method": "POST",
    ":path": `/3/device/${"0".repeat(64)}`,
    authorization: `bearer ${jwt}`,
    "apns-topic": "io.github.kenkaiii.pew2.voip",
    "apns-push-type": "voip",
    "apns-priority": "10",
    "apns-expiration": String(Math.floor(Date.now() / 1000) + 30),
    "content-type": "application/json",
  });
  let code = 0;
  let text = "";
  req.on("response", (headers) => {
    code = Number(headers[":status"]);
  });
  req.setEncoding("utf8");
  req.on("data", (chunk: string) => {
    text += chunk;
  });
  req.on("end", () => resolve({ status: code, body: text }));
  req.on("error", reject);
  req.end("{}");
});
client.close();
let reason = "";
try {
  reason = (JSON.parse(body) as { reason?: string }).reason ?? "";
} catch {
  // empty body
}
console.log(`${status} ${reason}`.trim());
