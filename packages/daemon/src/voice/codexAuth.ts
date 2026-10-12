/**
 * Subscription credential: the ChatGPT login the Codex CLI keeps in
 * `~/.codex/auth.json`. It is the default way to mint Realtime secrets, with
 * OPENAI_API_KEY as the fallback. The token stays in this process; the phone
 * only ever receives the ephemeral client secret.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
/** Refresh when the token has less than this left. */
const SKEW_SECONDS = 120;

interface AuthFile {
  auth_mode?: string;
  tokens?: { access_token?: string; refresh_token?: string; id_token?: string; account_id?: string };
  last_refresh?: string;
  [k: string]: unknown;
}

export function codexAuthPath(env: NodeJS.ProcessEnv): string {
  return join(env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "auth.json");
}

function jwtExp(token: string): number | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

/** A usable ChatGPT access token, refreshed (and saved back) when stale. Undefined if not logged in. */
export async function subscriptionToken(
  env: NodeJS.ProcessEnv,
  doFetch: typeof fetch = fetch,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<string | undefined> {
  const path = codexAuthPath(env);
  let auth: AuthFile;
  try {
    auth = JSON.parse(await readFile(path, "utf8")) as AuthFile;
  } catch {
    return undefined;
  }
  if (auth.auth_mode && auth.auth_mode !== "chatgpt") return undefined;
  const access = auth.tokens?.access_token;
  const refresh = auth.tokens?.refresh_token;
  const exp = access ? jwtExp(access) : undefined;
  if (access && exp !== undefined && exp - now() > SKEW_SECONDS) return access;
  if (!refresh) return undefined;
  try {
    const response = await doFetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: refresh, scope: "openid profile email" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
    if (!body.access_token) return undefined;
    const next: AuthFile = {
      ...auth,
      tokens: {
        ...auth.tokens,
        access_token: body.access_token,
        refresh_token: body.refresh_token ?? refresh,
        ...(body.id_token ? { id_token: body.id_token } : null),
      },
      last_refresh: new Date().toISOString(),
    };
    const tmp = `${path}.pew2.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(tmp, path);
    return body.access_token;
  } catch {
    return undefined;
  }
}
