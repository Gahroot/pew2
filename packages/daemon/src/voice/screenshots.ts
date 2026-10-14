/**
 * Screenshots handed to voice: checked, written to disk, read back for an agent.
 *
 * The use is a partner's fix arriving as a picture — "here's what they
 * changed, put it in billing". The phone uploads it once; the daemon keeps it
 * until a task is told to use it, which may be minutes later or after a
 * restart, so it cannot live only in a voice session's memory.
 *
 * Where it is kept, and why:
 *
 * - **Never in a project.** An agent's cwd is a git repository whose
 *   uncommitted count is on screen, and `git add .` would commit the picture.
 *   These go beside the rest of the voice state (`<dataDir>/voice-attachments`),
 *   owner-only, and are copied into the session's own attachment directory only
 *   when a prompt carries them (`Daemon.prompt`, which owns that path).
 * - **The name came off a phone.** It is a label, not a path: it goes through
 *   `safeSegment`, and the file is named by the daemon's own id first.
 * - **The bytes came off a phone too.** Only raster image types are accepted,
 *   and the first bytes must actually be that type — a picture with an `.svg`
 *   or HTML payload behind an `image/png` label is refused, not stored.
 *
 * File I/O only; which screenshots exist, and where each went, is recorded in
 * the voice store so it is persisted with everything else.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { wire } from "@pew2/protocol";
import { base64Bytes, safeSegment } from "../attachments.js";

const { MAX_ATTACHMENT_BYTES } = wire;

/** Kept at most; the oldest beyond this are deleted with their files. */
export const MAX_SCREENSHOTS = 20;
/** Older than this, a screenshot that was never used is not going to be. */
export const SCREENSHOT_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * Types an agent can look at, each with the bytes its files start with.
 *
 * SVG is absent on purpose: it is a document that can carry script, not a
 * picture, and no vision model reads it as one.
 */
const SIGNATURES: Record<string, (bytes: Buffer) => boolean> = {
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => b.subarray(0, 4).toString("latin1") === "GIF8",
  "image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  "image/heic": isHeif,
  "image/heif": isHeif,
};

/** An ISO-BMFF box whose brand is one of the HEIF family's. */
function isHeif(bytes: Buffer): boolean {
  if (bytes.subarray(4, 8).toString("latin1") !== "ftyp") return false;
  return ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(bytes.subarray(8, 12).toString("latin1"));
}

/** `image/jpg` is common and wrong; anything after `;` is a parameter, not the type. */
export function normaliseImageType(mimeType: string): string {
  const type = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "image/jpg" ? "image/jpeg" : type;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export type Checked = { ok: true; bytes: Buffer; mimeType: string } | { ok: false; error: string };

/**
 * Why this upload cannot be kept, or its decoded bytes when it can.
 *
 * Every refusal is a sentence for the phone to show as-is: the user picked a
 * picture and needs to know what to do instead, not which check fired.
 */
export function checkScreenshot(mimeType: string, data: string): Checked {
  const type = normaliseImageType(mimeType);
  const signature = SIGNATURES[type];
  if (!signature) return { ok: false, error: "Only pictures can be sent to voice: a PNG, JPEG, HEIC, GIF or WebP screenshot." };
  // Measured before decoding, so an oversized upload never becomes a buffer.
  const size = base64Bytes(data);
  if (size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: `That picture is ${(size / 1024 / 1024).toFixed(1)}MB, over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB limit.` };
  }
  if (data.length % 4 !== 0 || !BASE64.test(data)) return { ok: false, error: "That picture arrived damaged. Try attaching it again." };
  const bytes = Buffer.from(data, "base64");
  if (bytes.byteLength === 0) return { ok: false, error: "That picture is empty." };
  if (!signature(bytes)) return { ok: false, error: "That file says it is a picture but isn't one pew2 can read." };
  return { ok: true, bytes, mimeType: type };
}

export function screenshotDir(dataDir: string): string {
  return join(dataDir, "voice-attachments");
}

/** Write one checked screenshot under its id; returns where it went. */
export async function writeScreenshot(dataDir: string, attachmentId: string, name: string, bytes: Buffer): Promise<string> {
  const dir = screenshotDir(dataDir);
  // Owner-only, like a prompt's attachments: these are someone's screens.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${safeSegment(attachmentId, "shot")}-${safeSegment(name, "screenshot")}`);
  await writeFile(path, bytes, { mode: 0o600 });
  return path;
}

/** The bytes, as a prompt attachment carries them. Throws a speakable error when the file is gone. */
export async function readScreenshot(path: string, name: string): Promise<string> {
  try {
    return (await readFile(path)).toString("base64");
  } catch {
    throw new Error(`The screenshot "${name}" is no longer on the computer. Attach it again.`);
  }
}

/** Best effort: a file that is already gone is the outcome wanted. */
export async function deleteScreenshot(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
}
