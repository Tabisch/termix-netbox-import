import type { PluginFetch } from "@termix-ssh/plugin-sdk/backend";
import type { SyncConfig } from "./config.js";
import { itemAddress } from "./mapping.js";

export type NetboxKind = "device" | "vm" | "ip";

interface NetboxRef {
  id?: number;
  name?: string;
  slug?: string;
  display?: string;
  /** Choice fields, like an IP address's role, have a label instead of a name. */
  label?: string;
}

interface NetboxIp {
  id?: number;
  address?: string;
}

interface NetboxTag {
  name?: string;
  slug?: string;
}

/** The fields this plugin reads from a NetBox device or virtual machine. */
export interface NetboxObject {
  id: number;
  name?: string | null;
  display?: string;
  url?: string;
  display_url?: string;
  description?: string;
  status?: { value?: string; label?: string } | null;
  primary_ip?: NetboxIp | null;
  primary_ip4?: NetboxIp | null;
  primary_ip6?: NetboxIp | null;
  site?: NetboxRef | null;
  /** NetBox 4 calls a device's role "role", NetBox 3 "device_role". */
  role?: NetboxRef | null;
  device_role?: NetboxRef | null;
  tenant?: NetboxRef | null;
  platform?: NetboxRef | null;
  cluster?: NetboxRef | null;
  tags?: NetboxTag[];
  custom_fields?: Record<string, unknown> | null;
  /** IP addresses only: the address with its prefix length, like 10.0.0.5/24. */
  address?: string;
  dns_name?: string;
  /** IP addresses only: the interface it is on, with its device or VM. */
  assigned_object?: {
    name?: string;
    device?: NetboxRef | null;
    virtual_machine?: NetboxRef | null;
  } | null;
}

export interface NetboxItem {
  kind: NetboxKind;
  object: NetboxObject;
}

const ENDPOINTS: Record<NetboxKind, string> = {
  device: "/api/dcim/devices/",
  vm: "/api/virtualization/virtual-machines/",
  ip: "/api/ipam/ip-addresses/",
};

const PAGE_SIZE = 250;
/** Stops a misbehaving server from paging forever. */
const MAX_PAGES = 400;

/** A NetBox failure with a code the frontend can explain. */
export class NetboxError extends Error {
  constructor(
    readonly code:
      | "unauthorized"
      | "notFound"
      | "badResponse"
      | "unreachable"
      | "httpError"
      | "unknownTag",
    message: string,
    readonly status?: number,
    /** What NetBox said, or the tags it doesn't have, for the frontend. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "NetboxError";
  }
}

/** NetBox 4.5 v2 tokens start with nbt_ and use Bearer, older ones Token. */
export function authorizationHeader(token: string): string {
  return token.startsWith("nbt_") ? `Bearer ${token}` : `Token ${token}`;
}

/**
 * NetBox's own explanation of an error response: {"detail": "..."} or field
 * errors like {"tag": ["Select a valid choice. x is not one of ..."]}.
 */
export function errorDetail(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
  }
  const parts: string[] = [];
  const walk = (value: unknown, key?: string) => {
    if (typeof value === "string") {
      parts.push(key && key !== "detail" ? `${key}: ${value}` : value);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item, key);
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  };
  walk(parsed);
  return parts.join("; ").slice(0, 300);
}

export interface NetboxClientOptions {
  fetch: PluginFetch;
  baseUrl: string;
  token: string;
  caCert?: string;
}

export class NetboxClient {
  private readonly host: string;

  constructor(private readonly options: NetboxClientOptions) {
    this.host = new URL(options.baseUrl).hostname;
  }

  private async getJson(
    path: string,
    params?: URLSearchParams,
  ): Promise<unknown> {
    const search = params?.toString() ?? "";
    const query = search ? `?${search}` : "";
    const url = `${this.options.baseUrl}${path}${query}`;
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: authorizationHeader(this.options.token),
        },
        // NetBox nearly always runs on an internal network. Only the host the
        // user configured is let through, nothing else private.
        allowPrivateHosts: [this.host],
        tls: this.options.caCert ? { ca: this.options.caCert } : undefined,
        timeoutMs: 30_000,
      });
    } catch (error) {
      throw new NetboxError(
        "unreachable",
        `Could not reach NetBox: ${(error as Error).message}`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new NetboxError(
        "unauthorized",
        "NetBox refused the API token",
        response.status,
      );
    }
    if (response.status === 404) {
      throw new NetboxError(
        "notFound",
        `NetBox has no ${path}. Check the URL.`,
        404,
      );
    }
    if (!response.ok) {
      const detail = errorDetail(await response.text().catch(() => ""));
      throw new NetboxError(
        "httpError",
        `NetBox answered ${response.status} for ${path}${detail ? `: ${detail}` : ""}`,
        response.status,
        detail || `HTTP ${response.status}`,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new NetboxError(
        "badResponse",
        `NetBox sent something that is not JSON for ${path}`,
      );
    }
  }

  /** The server's version, which also proves the URL and token work. */
  async status(): Promise<{ version: string | null }> {
    const body = (await this.getJson("/api/status/")) as Record<
      string,
      unknown
    > | null;
    const version = body?.["netbox-version"];
    return { version: typeof version === "string" ? version : null };
  }

  /**
   * The slugs for tags given by slug or by name, any case. NetBox only
   * filters by slug and answers 400 for one it doesn't know, so unknown tags
   * are reported by name here instead.
   */
  async resolveTags(tags: string[]): Promise<string[]> {
    if (tags.length === 0) return [];
    const bySlugOrName = new Map<string, string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      const body = (await this.getJson("/api/extras/tags/", params)) as {
        count?: number;
        results?: unknown;
      } | null;
      if (!body || !Array.isArray(body.results)) {
        throw new NetboxError(
          "badResponse",
          "NetBox sent an unexpected list for /api/extras/tags/",
        );
      }
      for (const tag of body.results as NetboxTag[]) {
        if (!tag?.slug) continue;
        bySlugOrName.set(tag.slug.toLowerCase(), tag.slug);
        if (tag.name && !bySlugOrName.has(tag.name.toLowerCase())) {
          bySlugOrName.set(tag.name.toLowerCase(), tag.slug);
        }
      }
      const total = typeof body.count === "number" ? body.count : 0;
      if (
        body.results.length < PAGE_SIZE ||
        page * PAGE_SIZE + body.results.length >= total
      ) {
        break;
      }
    }
    const missing = tags.filter((tag) => !bySlugOrName.has(tag.toLowerCase()));
    if (missing.length) {
      throw new NetboxError(
        "unknownTag",
        `NetBox has no tag ${missing.join(", ")}`,
        undefined,
        missing.join(", "),
      );
    }
    return [
      ...new Set(tags.map((tag) => bySlugOrName.get(tag.toLowerCase())!)),
    ];
  }

  private async listAll(
    kind: NetboxKind,
    filters: Array<[string, string]>,
  ): Promise<NetboxObject[]> {
    const out: NetboxObject[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams(filters);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(page * PAGE_SIZE));
      const body = (await this.getJson(ENDPOINTS[kind], params)) as {
        count?: number;
        results?: unknown;
      } | null;
      if (!body || !Array.isArray(body.results)) {
        throw new NetboxError(
          "badResponse",
          `NetBox sent an unexpected list for ${ENDPOINTS[kind]}`,
        );
      }
      for (const result of body.results) {
        if (result && typeof (result as NetboxObject).id === "number") {
          out.push(result as NetboxObject);
        }
      }
      const total = typeof body.count === "number" ? body.count : 0;
      if (body.results.length < PAGE_SIZE || out.length >= total) break;
    }
    return out;
  }

  /**
   * Every object of a kind that matches the config's tag and status filters.
   *
   * NetBox ANDs repeated tag filters, so "all" is one query and "any" is one
   * query per tag, merged by id. Excluded tags are dropped afterwards.
   */
  async listObjects(
    kind: NetboxKind,
    config: Pick<SyncConfig, "tags" | "tagMatch" | "excludeTags" | "statuses">,
  ): Promise<NetboxObject[]> {
    const base: Array<[string, string]> = config.statuses.map((status) => [
      "status",
      status,
    ]);
    let objects: NetboxObject[];
    if (config.tags.length === 0) {
      objects = await this.listAll(kind, base);
    } else if (config.tagMatch === "all") {
      objects = await this.listAll(kind, [
        ...base,
        ...config.tags.map((tag): [string, string] => ["tag", tag]),
      ]);
    } else {
      const byId = new Map<number, NetboxObject>();
      for (const tag of config.tags) {
        for (const object of await this.listAll(kind, [
          ...base,
          ["tag", tag],
        ])) {
          byId.set(object.id, object);
        }
      }
      objects = [...byId.values()];
    }
    if (config.excludeTags.length === 0) return objects;
    const excluded = new Set(config.excludeTags.map((t) => t.toLowerCase()));
    return objects.filter(
      (object) =>
        !(object.tags ?? []).some(
          (tag) =>
            excluded.has((tag.slug ?? "").toLowerCase()) ||
            excluded.has((tag.name ?? "").toLowerCase()),
        ),
    );
  }

  async listItems(config: SyncConfig): Promise<NetboxItem[]> {
    config = { ...config, tags: await this.resolveTags(config.tags) };
    const items: NetboxItem[] = [];
    if (config.devices) {
      for (const object of await this.listObjects("device", config)) {
        items.push({ kind: "device", object });
      }
    }
    if (config.virtualMachines) {
      for (const object of await this.listObjects("vm", config)) {
        items.push({ kind: "vm", object });
      }
    }
    if (config.ipAddresses) {
      // An address that is already a synced device's or VM's primary IP, or
      // that another IP object (in another VRF) has, would be a second host
      // for the same machine.
      const taken = new Set(
        items.map((item) => itemAddress(item)).filter(Boolean),
      );
      for (const object of await this.listObjects("ip", config)) {
        const item: NetboxItem = { kind: "ip", object };
        const address = itemAddress(item);
        if (address && taken.has(address)) continue;
        if (address) taken.add(address);
        items.push(item);
      }
    }
    return items;
  }
}
