/**
 * `pew2 voice apns`: give this machine the APNs key that rings an iPhone's
 * native call screen (the app's "Native call screen" setting).
 *
 *   pew2 voice apns                                   status
 *   pew2 voice apns --key <AuthKey.p8> --key-id <ID> --team-id <TEAM>
 *   pew2 voice apns off                               forget the key
 *
 * The key is the user's own, from the Apple developer account the app is
 * signed with. It is copied into the daemon's data directory owner-only and
 * never printed. Android needs nothing here: it rings through the same Expo
 * push as every banner.
 */
import { dirname } from "node:path";
import { userProvidersDir } from "../providers/registry.js";
import { clearApns, configureApns, readApnsConfig } from "../voip.js";

export type ApnsArgs =
  | { action: "status" }
  | { action: "off" }
  | { action: "set"; key: string; keyId: string; teamId: string }
  | { action: "usage"; problem: string };

const USAGE = "pew2 voice apns --key <AuthKey.p8> --key-id <KEY_ID> --team-id <TEAM_ID>";

/** Everything after `pew2 voice apns`. Pure, for tests. */
export function parseApnsArgs(args: readonly string[]): ApnsArgs {
  if (args.length === 0) return { action: "status" };
  if (args.length === 1 && args[0] === "off") return { action: "off" };
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag !== "--key" && flag !== "--key-id" && flag !== "--team-id") {
      return { action: "usage", problem: `Unknown argument '${flag ?? ""}'.` };
    }
    if (value === undefined || value.startsWith("--"))
      return { action: "usage", problem: `${flag} needs a value.` };
    values[flag] = value;
  }
  const key = values["--key"];
  const keyId = values["--key-id"];
  const teamId = values["--team-id"];
  if (!key || !keyId || !teamId)
    return { action: "usage", problem: "All of --key, --key-id and --team-id are needed." };
  return { action: "set", key, keyId, teamId };
}

export async function cmdVoice(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "apns") {
    console.error(`Usage: ${USAGE}`);
    return 1;
  }
  const dataDir = dirname(userProvidersDir(env));
  const parsed = parseApnsArgs(rest);
  switch (parsed.action) {
    case "status": {
      const config = await readApnsConfig(dataDir);
      console.log(
        config
          ? `iPhone ringing is set up (key ${config.keyId}, team ${config.teamId}).`
          : `iPhone ringing is not set up; iPhones get a banner instead.\nSet it up: ${USAGE}`,
      );
      return 0;
    }
    case "off":
      await clearApns(dataDir);
      console.log("APNs key removed. iPhones get a banner instead of a ring.");
      return 0;
    case "set":
      try {
        await configureApns(dataDir, parsed.key, parsed.keyId, parsed.teamId);
      } catch (error) {
        console.error(error instanceof Error ? error.message : "Could not store the key.");
        return 1;
      }
      console.log(
        'APNs key stored. Phones with "Native call screen" on will ring. No restart needed.',
      );
      return 0;
    case "usage":
      console.error(`${parsed.problem}\nUsage: ${USAGE}`);
      return 1;
  }
}
