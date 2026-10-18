import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";

/**
 * Termix's own credentials list, read as one user. ctx.credentials only lists
 * SSH keys and leaves out tags, and a credential is found here by its tags
 * (like the Dashlane plugin's "dashlane:<id>"), so this calls core's
 * GET /credentials with a short-lived session from ctx.auth.issueUserToken.
 * That user's permissions apply unchanged: it needs credentials.view.
 */

/** Core's HTTP server, which always listens on loopback in the same process. */
function coreUrl(): string {
  const port = Number(process.env.EMBEDDED_BACKEND_PORT) || 30001;
  return `http://127.0.0.1:${port}`;
}

export interface CoreCredential {
  id: number;
  name: string;
  tags: string[];
  /** A copy someone shared with the user, not their own. */
  shared: boolean;
}

export async function listCoreCredentials(
  ctx: PluginContext,
  userId: string,
): Promise<CoreCredential[]> {
  const { token } = await ctx.auth.issueUserToken(userId, {
    purpose: "NetBox sync credential tags",
    ttlSeconds: 120,
  });
  const base = coreUrl();
  const response = await ctx.fetch(`${base}/credentials`, {
    headers: { authorization: `Bearer ${token}` },
    allowPrivateHosts: [new URL(base).hostname],
    timeoutMs: 30_000,
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Left null; reported below.
  }
  if (response.status !== 200 || !Array.isArray(body)) {
    const error =
      body && typeof body === "object" && "error" in body
        ? `: ${String((body as { error: unknown }).error)}`
        : "";
    throw new Error(
      `Termix refused to list credentials (${response.status}${error})`,
    );
  }
  const credentials: CoreCredential[] = [];
  for (const entry of body as Array<Record<string, unknown>>) {
    if (!entry || typeof entry.id !== "number") continue;
    credentials.push({
      id: entry.id,
      name: typeof entry.name === "string" ? entry.name : "",
      tags: Array.isArray(entry.tags)
        ? entry.tags.filter((tag): tag is string => typeof tag === "string")
        : [],
      shared: !!entry.isShared || !!entry.sharedCopy,
    });
  }
  return credentials;
}

/**
 * Credential ids by tag, lower case, for the tags that start with prefix.
 * The user's own credentials win over shared ones, then the lowest id.
 */
export function credentialsByTag(
  credentials: CoreCredential[],
  prefix: string,
): Map<string, number> {
  const wanted = prefix.toLowerCase();
  const sorted = [...credentials].sort(
    (a, b) => Number(a.shared) - Number(b.shared) || a.id - b.id,
  );
  const byTag = new Map<string, number>();
  for (const credential of sorted) {
    for (const tag of credential.tags) {
      const key = tag.trim().toLowerCase();
      if (key.startsWith(wanted) && !byTag.has(key)) {
        byTag.set(key, credential.id);
      }
    }
  }
  return byTag;
}
