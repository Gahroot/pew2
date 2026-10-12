/** Test scratch dirs that survive the shared test root being swept between files. */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function scratch(prefix = "pew2-voice-"): string {
  mkdirSync(tmpdir(), { recursive: true });
  return mkdtempSync(join(tmpdir(), prefix));
}
