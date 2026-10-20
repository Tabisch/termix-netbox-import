import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { hasCredentialPrefix } from "./mapping.js";

/**
 * Termix's own credentials list, read as one user. ctx.credentials only lists
 * SSH keys and leaves out tags, and a credential is found here by its tags
 * (like the Dashlane plugin's "dashlane:<id>"), so this calls core's
 * GET /credentials with a short-lived session from ctx.auth.issueUserToken.
 * That user's permissions apply unchanged: it needs credentials.view, and
 * credentials.create to make the empty ones for termix: tags.
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

export interface CoreCredentialsClient {
  list: () => Promise<CoreCredential[]>;
  /**
   * Makes a password credential with an empty username and password, for
   * the user to fill in, and returns its id. Needs credentials.create.
   */
  createEmpty: (input: { name: string; tags: string[] }) => Promise<number>;
}

/**
 * Core's credentials API as one user. The token is issued on the first call
 * and shared by the rest, so a sync asks for at most one.
 */
export function coreCredentialsFor(
  ctx: PluginContext,
  userId: string,
): CoreCredentialsClient {
  const base = coreUrl();
  let token: Promise<string> | null = null;
  const call = async (method: string, path: string, body?: unknown) => {
    token ??= ctx.auth
      .issueUserToken(userId, {
        purpose: "NetBox sync credential tags",
        ttlSeconds: 120,
      })
      .then((issued) => issued.token);
    const response = await ctx.fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      allowPrivateHosts: [new URL(base).hostname],
      timeoutMs: 30_000,
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Left null; the status says what happened.
    }
    return { status: response.status, json };
  };
  const errorOf = (json: unknown) =>
    json && typeof json === "object" && "error" in json
      ? `: ${String((json as { error: unknown }).error)}`
      : "";

  return {
    async list() {
      const { status, json: body } = await call("GET", "/credentials");
      if (status !== 200 || !Array.isArray(body)) {
        throw new Error(
          `Termix refused to list credentials (${status}${errorOf(body)})`,
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
    },

    async createEmpty({ name, tags }) {
      const { status, json } = await call("POST", "/credentials", {
        name,
        description: "Made by NetBox Sync. Fill in the login.",
        folder: "",
        tags,
        authType: "password",
        username: "",
        password: "",
      });
      const id =
        json && typeof json === "object"
          ? (json as { id?: unknown }).id
          : undefined;
      if ((status !== 200 && status !== 201) || typeof id !== "number") {
        throw new Error(
          `Termix refused to create a credential (${status}${errorOf(json)})`,
        );
      }
      return id;
    },
  };
}

/**
 * Credential ids by tag, lower case, for the tags that start with one of the
 * prefixes. The user's own credentials win over shared ones, then the lowest
 * id.
 */
export function credentialsByTag(
  credentials: CoreCredential[],
  prefixes: string[],
): Map<string, number> {
  const sorted = [...credentials].sort(
    (a, b) => Number(a.shared) - Number(b.shared) || a.id - b.id,
  );
  const byTag = new Map<string, number>();
  for (const credential of sorted) {
    for (const tag of credential.tags) {
      const key = tag.trim().toLowerCase();
      if (hasCredentialPrefix(key, prefixes) && !byTag.has(key)) {
        byTag.set(key, credential.id);
      }
    }
  }
  return byTag;
}
