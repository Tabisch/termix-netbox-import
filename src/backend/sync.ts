import type {
  PluginContext,
  PluginHostCreateInput,
  PluginHostRecord,
  PluginHostUpdateInput,
} from "@termix-ssh/plugin-sdk/backend";
import { MISSING_TAG, type SyncConfig } from "./config.js";
import {
  credentialsByTag,
  listCoreCredentials,
  type CoreCredential,
} from "./core-credentials.js";
import {
  desiredHost,
  itemName,
  linkKey,
  mergeTags,
  splitTags,
  type DesiredHost,
} from "./mapping.js";
import { NetboxClient, NetboxError } from "./netbox.js";
import type { LinkRow, Store } from "./store.js";

export const TOKEN_SECRET = "token";

export type PlanAction =
  "create" | "update" | "adopt" | "unchanged" | "skip" | "missing" | "delete";

export interface PlanEntry {
  action: PlanAction;
  kind: string;
  netboxId: number;
  name: string;
  ip: string | null;
  hostId: number | null;
  /** Host fields that change, for update and adopt. */
  changes?: string[];
  reason?: string;
}

export interface SyncResult {
  dryRun: boolean;
  found: number;
  created: number;
  updated: number;
  adopted: number;
  unchanged: number;
  skipped: number;
  missing: number;
  deleted: number;
  errors: string[];
  /** Every planned change. Sent back from a preview or sync, never stored. */
  entries?: PlanEntry[];
}

export class SyncError extends Error {
  constructor(
    readonly code: "notConfigured" | "noToken" | "alreadyRunning",
    message: string,
  ) {
    super(message);
    this.name = "SyncError";
  }
}

function emptyResult(dryRun: boolean): SyncResult {
  return {
    dryRun,
    found: 0,
    created: 0,
    updated: 0,
    adopted: 0,
    unchanged: 0,
    skipped: 0,
    missing: 0,
    deleted: 0,
    errors: [],
    entries: [],
  };
}

function sameTags(a: string | null | undefined, b: string[]): boolean {
  const left = splitTags(a).map((t) => t.toLowerCase());
  const right = b.map((t) => t.toLowerCase());
  return (
    left.length === right.length &&
    left.every((tag) => right.includes(tag)) &&
    right.every((tag) => left.includes(tag))
  );
}

/**
 * The fields to change on a host that already exists, and their names.
 * credentialId is the credential a NetBox tag names: the host is switched to
 * it. Without one the host's auth is left as it is.
 */
export function planUpdate(
  host: PluginHostRecord,
  desired: DesiredHost,
  previousManaged: string[],
  credentialId: number | null = null,
): { patch: PluginHostUpdateInput; changes: string[] } {
  const patch: PluginHostUpdateInput = {};
  const changes: string[] = [];
  if (host.name !== desired.name) {
    patch.name = desired.name;
    changes.push("name");
  }
  if (host.ip !== desired.ip) {
    patch.ip = desired.ip;
    changes.push("ip");
  }
  if ((host.folder ?? "") !== desired.folder) {
    patch.folder = desired.folder || null;
    changes.push("folder");
  }
  const tags = mergeTags(host.tags, previousManaged, desired.managedTags, [
    MISSING_TAG,
  ]);
  if (!sameTags(host.tags, tags)) {
    patch.tags = tags;
    changes.push("tags");
  }
  if (desired.notes !== null && (host.notes ?? "") !== desired.notes) {
    patch.notes = desired.notes;
    changes.push("notes");
  }
  if (desired.port !== null && host.port !== desired.port) {
    patch.port = desired.port;
    changes.push("port");
  }
  if (desired.username !== null && host.username !== desired.username) {
    patch.username = desired.username;
    changes.push("username");
  }
  if (credentialId !== null) {
    const override = desired.username !== null;
    if (
      host.authType !== "credential" ||
      host.credentialId !== credentialId ||
      host.overrideCredentialUsername !== override
    ) {
      patch.authType = "credential";
      patch.credentialId = credentialId;
      patch.overrideCredentialUsername = override;
      changes.push("credential");
    }
  }
  return { patch, changes };
}

/**
 * A new host for a NetBox object, with the config's connection defaults. A
 * credential a NetBox tag names (tagCredentialId) wins over the default one.
 */
export function planCreate(
  desired: DesiredHost,
  config: SyncConfig,
  tagCredentialId: number | null = null,
): PluginHostCreateInput {
  const credential =
    tagCredentialId !== null || config.authType === "credential";
  return {
    name: desired.name,
    ip: desired.ip,
    port: desired.port ?? config.port,
    // A credential brings its own username unless NetBox names one.
    username: desired.username ?? (credential ? "" : config.username),
    authType: credential ? "credential" : "none",
    credentialId: tagCredentialId ?? (credential ? config.credentialId : null),
    overrideCredentialUsername: credential && desired.username !== null,
    connectionType: "ssh",
    enableSsh: true,
    tags: desired.managedTags,
    folder: desired.folder || null,
    notes: desired.notes,
    pin: false,
  };
}

/**
 * Whether a host that is missing from NetBox is deleted on this sync:
 * always with "delete", and with auto remove once it has been missing for
 * removeAfterDays (counted from the sync that first found it missing).
 */
export function shouldRemove(
  config: Pick<SyncConfig, "missingAction" | "autoRemove" | "removeAfterDays">,
  missingSince: string | null,
  now: string,
): boolean {
  if (config.missingAction === "delete") return true;
  if (!config.autoRemove) return false;
  if (config.removeAfterDays <= 0) return true;
  if (!missingSince) return false;
  const since = Date.parse(missingSince);
  if (Number.isNaN(since)) return false;
  return Date.parse(now) - since >= config.removeAfterDays * 86_400_000;
}

export interface SyncDeps {
  ctx: PluginContext;
  store: Store;
}

export function createClient(
  ctx: PluginContext,
  config: SyncConfig,
  token: string,
): NetboxClient {
  return new NetboxClient({
    fetch: ctx.fetch,
    baseUrl: config.netboxUrl,
    token,
    caCert: config.caCert || undefined,
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Syncs the acting user's NetBox objects into hosts they own. Runs as
 * ctx.currentActor(): from a route that is the signed-in user, from the
 * scheduler it is the user ctx.asUser runs it for.
 *
 * With dryRun nothing is written and the result lists what would change.
 */
export function createSyncer({ ctx, store }: SyncDeps) {
  const running = new Set<string>();

  async function sync(
    userId: string,
    options: { dryRun?: boolean } = {},
  ): Promise<SyncResult> {
    const dryRun = !!options.dryRun;
    if (running.has(userId)) {
      throw new SyncError("alreadyRunning", "A sync is already running");
    }
    running.add(userId);
    try {
      return await syncLocked(userId, dryRun);
    } finally {
      running.delete(userId);
    }
  }

  async function syncLocked(
    userId: string,
    dryRun: boolean,
  ): Promise<SyncResult> {
    const stored = await store.getConfig(userId);
    if (!stored) throw new SyncError("notConfigured", "NetBox is not set up");
    const token = await ctx.secrets.get(TOKEN_SECRET);
    if (!token) throw new SyncError("noToken", "No NetBox API token is saved");
    const { config } = stored;
    const startedAt = new Date().toISOString();
    const result = emptyResult(dryRun);
    const entries = result.entries!;

    try {
      const items = await createClient(ctx, config, token).listItems(config);
      result.found = items.length;

      const owned = await ctx.hosts.listOwned();
      const ownedById = new Map(owned.map((host) => [host.id, host]));

      const linkByKey = new Map<string, LinkRow>();
      for (const link of await store.listLinks(userId)) {
        if (!ownedById.has(link.hostId)) {
          // The host was deleted in Termix. Forget the link; the object
          // gets a fresh host below if NetBox still has it.
          if (!dryRun) await store.deleteLink(userId, link.id);
          continue;
        }
        linkByKey.set(linkKey(link.kind, link.netboxId), link);
      }
      const linkedHostIds = new Set(
        [...linkByKey.values()].map((link) => link.hostId),
      );
      const unlinkedByAddress = new Map<string, PluginHostRecord>();
      if (config.adoptExisting) {
        for (const host of owned) {
          if (!linkedHostIds.has(host.id) && !unlinkedByAddress.has(host.ip)) {
            unlinkedByAddress.set(host.ip, host);
          }
        }
      }

      // Termix's credentials, read once, and only when a credential tag needs
      // resolving or a new host is about to get a credential.
      let coreCredentials: Promise<CoreCredential[] | null> | null = null;
      const credentialList = () =>
        (coreCredentials ??= listCoreCredentials(ctx, userId).catch((error) => {
          result.errors.push(
            `Credentials: ${errorText(error)}. Credential tags are ignored.`,
          );
          return null;
        }));
      let byTag: Map<string, number> | null = null;
      const credentialFor = async (
        tag: string,
        name: string,
      ): Promise<number | null> => {
        const list = await credentialList();
        if (!list) return null;
        byTag ??= credentialsByTag(list, config.credentialTagPrefix);
        const id = byTag.get(tag.toLowerCase());
        if (id === undefined) {
          result.errors.push(
            `${name}: no Termix credential is tagged "${tag}"`,
          );
          return null;
        }
        return id;
      };
      /**
       * Whether a credential id is missing from Termix. A host that points at
       * one fails with a foreign key error, so it is checked first. Unknown
       * (false) when the list can't be read.
       */
      const credentialGone = async (id: number): Promise<boolean> => {
        const list = await credentialList();
        return !!list && !list.some((credential) => credential.id === id);
      };

      const seen = new Set<string>();
      for (const item of items) {
        const key = linkKey(item.kind, item.object.id);
        if (seen.has(key)) continue;
        seen.add(key);
        const base = {
          kind: item.kind,
          netboxId: item.object.id,
          name: itemName(item),
        };
        try {
          const desired = desiredHost(item, config);
          if ("skip" in desired) {
            result.skipped++;
            entries.push({
              ...base,
              action: "skip",
              ip: null,
              hostId: null,
              reason: desired.skip,
            });
            continue;
          }

          const credentialId = desired.credentialTag
            ? await credentialFor(desired.credentialTag, base.name)
            : null;

          const link = linkByKey.get(key);
          let host = link ? ownedById.get(link.hostId) : undefined;
          let adopting = false;
          if (!host) {
            const candidate = unlinkedByAddress.get(desired.ip);
            if (candidate) {
              host = candidate;
              adopting = true;
              unlinkedByAddress.delete(desired.ip);
            }
          }

          if (!host) {
            const input = planCreate(desired, config, credentialId);
            if (
              input.authType === "credential" &&
              typeof input.credentialId === "number" &&
              (await credentialGone(input.credentialId))
            ) {
              // Only the key picked under New hosts can be stale: tagged ones
              // come from the list itself.
              result.errors.push(
                `${base.name}: the SSH key picked under New hosts doesn't exist any more. Pick another one and sync again.`,
              );
              continue;
            }
            let hostId: number | null = null;
            if (!dryRun) {
              const created = await ctx.hosts.create(input);
              hostId = created.id;
              await store.insertLink({
                userId,
                hostId: created.id,
                kind: item.kind,
                netboxId: item.object.id,
                managedTags: desired.managedTags,
                missingSince: null,
              });
            }
            result.created++;
            entries.push({
              ...base,
              action: "create",
              ip: desired.ip,
              hostId,
            });
            continue;
          }

          const { patch, changes } = planUpdate(
            host,
            desired,
            link?.managedTags ?? [],
            credentialId,
          );
          if (!dryRun) {
            if (changes.length) await ctx.hosts.update(host.id, patch);
            if (adopting) {
              await store.insertLink({
                userId,
                hostId: host.id,
                kind: item.kind,
                netboxId: item.object.id,
                managedTags: desired.managedTags,
                missingSince: null,
              });
            } else if (link) {
              await store.updateLink(userId, link.id, {
                managedTags: desired.managedTags,
                missingSince: null,
              });
            }
          }
          const action: PlanAction = adopting
            ? "adopt"
            : changes.length
              ? "update"
              : "unchanged";
          if (action === "adopt") result.adopted++;
          else if (action === "update") result.updated++;
          else result.unchanged++;
          entries.push({
            ...base,
            action,
            ip: desired.ip,
            hostId: host.id,
            changes,
          });
        } catch (error) {
          result.errors.push(`${base.name}: ${errorText(error)}`);
        }
      }

      for (const [key, link] of linkByKey) {
        if (seen.has(key)) continue;
        const host = ownedById.get(link.hostId)!;
        const base = {
          kind: link.kind,
          netboxId: link.netboxId,
          name: host.name || host.ip,
          ip: host.ip,
          hostId: host.id,
        };
        try {
          if (shouldRemove(config, link.missingSince, startedAt)) {
            if (!dryRun) {
              const deleted = await ctx.hosts.delete(host.id);
              if (!deleted)
                throw new Error("Termix refused to delete the host");
              await store.deleteLink(userId, link.id);
            }
            result.deleted++;
            entries.push({ ...base, action: "delete" });
            continue;
          }
          if (!dryRun) {
            if (
              config.missingAction === "tag" &&
              !splitTags(host.tags).some(
                (tag) => tag.toLowerCase() === MISSING_TAG,
              )
            ) {
              await ctx.hosts.update(host.id, {
                tags: [...splitTags(host.tags), MISSING_TAG],
              });
            }
            if (!link.missingSince) {
              await store.updateLink(userId, link.id, {
                missingSince: startedAt,
              });
            }
          }
          result.missing++;
          entries.push({ ...base, action: "missing" });
        } catch (error) {
          result.errors.push(`${base.name}: ${errorText(error)}`);
        }
      }
    } catch (error) {
      if (error instanceof SyncError) throw error;
      result.errors.push(errorText(error));
      if (!dryRun) {
        await store.persist();
        await store.saveResult(userId, startedAt, withoutEntries(result));
      }
      throw error;
    }

    if (!dryRun) {
      await store.persist();
      await store.saveResult(userId, startedAt, withoutEntries(result));
      ctx.log.info(
        `NetBox sync for ${userId}: ${result.created} created, ${result.updated} updated, ${result.adopted} adopted, ${result.missing} missing, ${result.deleted} deleted, ${result.errors.length} errors`,
      );
    }
    return result;
  }

  return { sync, isRunning: (userId: string) => running.has(userId) };
}

export function withoutEntries(result: SyncResult): SyncResult {
  const { entries: _entries, ...rest } = result;
  return rest;
}

export { NetboxError };
