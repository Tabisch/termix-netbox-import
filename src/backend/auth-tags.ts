// Pure: picking a host's login method from NetBox tags like tauth:sshkey.
//
// A tag name can hold a colon ("tauth:sshkey:deploy key") but a NetBox slug
// can't, so the slug form ("tauth-sshkey-deploy-key") is read too.

import type { SyncConfig } from "./config.js";

export type AuthMethod = "none" | "password" | "credential";

export interface AuthChoice {
  authType: AuthMethod;
  credentialId: number | null;
}

/** SSH key credentials by lower-cased name and by slug of the name. */
export type KeyIndex = Map<string, number>;

const METHODS: Record<string, AuthMethod> = {
  sshkey: "credential",
  key: "credential",
  userpass: "password",
  password: "password",
  none: "none",
  ask: "none",
};

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function indexKeys(keys: Array<{ id: number; name: string }>): KeyIndex {
  const index: KeyIndex = new Map();
  for (const key of keys) {
    const lower = key.name.trim().toLowerCase();
    if (lower && !index.has(lower)) index.set(lower, key.id);
    const slug = slugify(key.name);
    if (slug && !index.has(slug)) index.set(slug, key.id);
  }
  return index;
}

interface ParsedTag {
  /** The tag as written in NetBox, for messages. */
  label: string;
  method: string;
  argument: string;
}

/** The login part of a tag, or null when it isn't a login tag. */
export function parseAuthTag(
  tag: { name?: string; slug?: string },
  prefix: string,
): ParsedTag | null {
  const p = prefix.toLowerCase();
  const name = (tag.name ?? "").trim();
  if (name.toLowerCase().startsWith(`${p}:`)) {
    const rest = name.slice(p.length + 1);
    const colon = rest.indexOf(":");
    return {
      label: name,
      method: (colon < 0 ? rest : rest.slice(0, colon)).trim().toLowerCase(),
      argument: colon < 0 ? "" : rest.slice(colon + 1).trim(),
    };
  }
  const slug = (tag.slug ?? "").trim().toLowerCase();
  if (slug.startsWith(`${p}-`)) {
    const rest = slug.slice(p.length + 1);
    const dash = rest.indexOf("-");
    return {
      label: tag.name || slug,
      method: dash < 0 ? rest : rest.slice(0, dash),
      argument: dash < 0 ? "" : rest.slice(dash + 1),
    };
  }
  return null;
}

export function isAuthTag(
  tag: { name?: string; slug?: string },
  prefix: string,
): boolean {
  return parseAuthTag(tag, prefix) !== null;
}

/**
 * The login method an object's tags ask for. null with no login tag, so the
 * config's defaults apply. An error, with no choice, when a tag can't be
 * used: an unknown method, a key that doesn't exist, or tags that disagree.
 */
export function authFromTags(
  tags: Array<{ name?: string; slug?: string }>,
  config: Pick<SyncConfig, "authTagPrefix" | "credentialId">,
  keys: KeyIndex,
): { auth: AuthChoice | null; error?: string } {
  const choices = new Map<string, AuthChoice>();
  for (const tag of tags) {
    const parsed = parseAuthTag(tag, config.authTagPrefix);
    if (!parsed) continue;
    const authType = METHODS[parsed.method];
    if (!authType) {
      return { auth: null, error: `unknown login tag ${parsed.label}` };
    }
    let credentialId: number | null = null;
    if (authType === "credential") {
      if (parsed.argument) {
        credentialId =
          keys.get(parsed.argument.toLowerCase()) ??
          keys.get(slugify(parsed.argument)) ??
          null;
        if (credentialId === null) {
          return {
            auth: null,
            error: `no SSH key named "${parsed.argument}" for ${parsed.label}`,
          };
        }
      } else {
        credentialId = config.credentialId;
        if (credentialId === null) {
          return {
            auth: null,
            error: `${parsed.label} needs an SSH key: pick one under New hosts, or name one like ${config.authTagPrefix}:sshkey:<key name>`,
          };
        }
      }
    }
    choices.set(`${authType}:${credentialId ?? ""}`, {
      authType,
      credentialId,
    });
  }
  if (choices.size > 1) {
    return { auth: null, error: "login tags disagree" };
  }
  return { auth: choices.values().next().value ?? null };
}
