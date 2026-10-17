// Pure: how a NetBox object becomes the fields of a Termix host.

import type { SyncConfig } from "./config.js";
import type { NetboxItem, NetboxObject } from "./netbox.js";

export interface DesiredHost {
  name: string;
  ip: string;
  /** Set only when the config names a custom field and the object fills it. */
  port: number | null;
  username: string | null;
  folder: string;
  /** Tags this plugin owns on the host. */
  managedTags: string[];
  notes: string | null;
}

export function linkKey(kind: string, netboxId: number): string {
  return `${kind}:${netboxId}`;
}

/** "10.0.0.5/24" to "10.0.0.5", "2001:db8::1/64" to "2001:db8::1". */
export function stripPrefix(address: string): string {
  const slash = address.indexOf("/");
  return (slash >= 0 ? address.slice(0, slash) : address).trim();
}

export function primaryAddress(object: NetboxObject): string | null {
  for (const ip of [
    object.primary_ip,
    object.primary_ip4,
    object.primary_ip6,
  ]) {
    if (ip?.address) {
      const address = stripPrefix(ip.address);
      if (address) return address;
    }
  }
  return null;
}

export function splitTags(
  tags: string | string[] | null | undefined,
): string[] {
  const list = Array.isArray(tags) ? tags : (tags ?? "").split(",");
  return list.map((tag) => tag.trim()).filter(Boolean);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * The host's tags after a sync: whatever the user added themselves, plus the
 * tags this sync owns. Tags the last sync wrote are replaced, not kept, so a
 * tag removed in NetBox goes away in Termix too.
 */
export function mergeTags(
  current: string | string[] | null | undefined,
  previousManaged: string[],
  nextManaged: string[],
  remove: string[] = [],
): string[] {
  const drop = new Set(
    [...previousManaged, ...remove].map((tag) => tag.toLowerCase()),
  );
  const kept = splitTags(current).filter((tag) => !drop.has(tag.toLowerCase()));
  return unique([...kept, ...nextManaged]);
}

/** The address a host connects to: an IP object's own, else the primary IP. */
export function itemAddress(item: NetboxItem): string | null {
  if (item.kind === "ip") {
    const address = item.object.address ? stripPrefix(item.object.address) : "";
    return address || null;
  }
  return primaryAddress(item.object);
}

/**
 * A host name for the object. An IP address has no name of its own, so it
 * takes its DNS name, then the device or VM it is assigned to, then itself.
 */
export function itemName(item: NetboxItem): string {
  const { object } = item;
  if (item.kind === "ip") {
    const assigned = object.assigned_object;
    return (
      object.dns_name ||
      assigned?.device?.name ||
      assigned?.virtual_machine?.name ||
      itemAddress(item) ||
      `ip-${object.id}`
    );
  }
  return object.name || object.display || `${item.kind}-${object.id}`;
}

function folderFor(object: NetboxObject, config: SyncConfig): string {
  const ref =
    config.folderSource === "site"
      ? object.site
      : config.folderSource === "role"
        ? (object.role ?? object.device_role)
        : config.folderSource === "tenant"
          ? object.tenant
          : config.folderSource === "platform"
            ? object.platform
            : config.folderSource === "cluster"
              ? object.cluster
              : null;
  const name = ref?.name || ref?.label || ref?.display;
  return (name || config.folder || "").slice(0, 255);
}

function customField(object: NetboxObject, field: string): unknown {
  if (!field) return undefined;
  return object.custom_fields?.[field] ?? undefined;
}

function portFrom(value: unknown): number | null {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** The address of the object in NetBox's web UI, not its API. */
export function webUrl(object: NetboxObject): string | null {
  if (object.display_url) return object.display_url;
  if (!object.url) return null;
  return object.url.replace("/api/", "/");
}

function notesFor(object: NetboxObject): string {
  const lines: string[] = [];
  const url = webUrl(object);
  if (url) lines.push(`NetBox: ${url}`);
  if (object.description) lines.push(object.description);
  return lines.join("\n");
}

/**
 * The host a NetBox object should become, or the reason it cannot become one.
 */
export function desiredHost(
  item: NetboxItem,
  config: SyncConfig,
): DesiredHost | { skip: "noAddress" } {
  const { object } = item;
  const ip = itemAddress(item);
  if (!ip) return { skip: "noAddress" };

  const managedTags: string[] = [];
  if (config.syncTag) managedTags.push(config.syncTag);
  if (config.copyNetboxTags) {
    for (const tag of object.tags ?? []) {
      const name = (tag.name || tag.slug || "").replace(/,/g, "").trim();
      if (name) managedTags.push(name);
    }
  }

  const username = customField(object, config.usernameCustomField);
  return {
    name: itemName(item).slice(0, 255),
    ip,
    port: portFrom(customField(object, config.portCustomField)),
    username:
      typeof username === "string" && username.trim()
        ? username.trim().slice(0, 255)
        : null,
    folder: folderFor(object, config),
    managedTags: unique(managedTags),
    notes: config.syncNotes ? notesFor(object) : null,
  };
}
