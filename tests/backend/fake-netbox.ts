import type { PluginFetchInit } from "@termix-ssh/plugin-sdk/backend";
import type { NetboxObject } from "../../src/backend/netbox.js";

export interface FakeNetbox {
  devices: NetboxObject[];
  vms: NetboxObject[];
  token: string;
  /** Every URL requested, in order. */
  requests: string[];
  inits: Array<PluginFetchInit | undefined>;
  fetch: (url: string, init?: PluginFetchInit) => Promise<Response>;
}

export const NETBOX_URL = "https://netbox.internal";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Answers the NetBox REST API the way NetBox does for the parts the plugin
 * uses: token auth, status, and paged device and VM lists where repeated tag
 * filters are ANDed and repeated status filters are ORed.
 */
export function createFakeNetbox(
  seed: Partial<Pick<FakeNetbox, "devices" | "vms" | "token">> = {},
): FakeNetbox {
  const fake: FakeNetbox = {
    devices: seed.devices ?? [],
    vms: seed.vms ?? [],
    token: seed.token ?? "secret-token",
    requests: [],
    inits: [],
    fetch: async (url, init) => {
      fake.requests.push(url);
      fake.inits.push(init);
      const parsed = new URL(url);
      if (parsed.origin !== NETBOX_URL) throw new Error("ECONNREFUSED");
      const auth = init?.headers?.Authorization;
      if (auth !== `Token ${fake.token}` && auth !== `Bearer ${fake.token}`) {
        return json(403, { detail: "Invalid token" });
      }
      if (parsed.pathname === "/api/status/") {
        return json(200, { "netbox-version": "4.2.1" });
      }
      const list =
        parsed.pathname === "/api/dcim/devices/"
          ? fake.devices
          : parsed.pathname === "/api/virtualization/virtual-machines/"
            ? fake.vms
            : null;
      if (!list) return json(404, { detail: "Not found." });
      const tags = parsed.searchParams.getAll("tag");
      const statuses = parsed.searchParams.getAll("status");
      const matching = list.filter(
        (object) =>
          tags.every((tag) =>
            (object.tags ?? []).some((objectTag) => objectTag.slug === tag),
          ) &&
          (statuses.length === 0 ||
            statuses.includes(object.status?.value ?? "")),
      );
      const limit = Number(parsed.searchParams.get("limit") ?? 50);
      const offset = Number(parsed.searchParams.get("offset") ?? 0);
      return json(200, {
        count: matching.length,
        next: null,
        previous: null,
        results: matching.slice(offset, offset + limit),
      });
    },
  };
  return fake;
}

let nextId = 1;

export function device(
  name: string,
  ip: string | null,
  tags: string[],
  extra: Partial<NetboxObject> = {},
): NetboxObject {
  const id = extra.id ?? nextId++;
  return {
    id,
    name,
    url: `${NETBOX_URL}/api/dcim/devices/${id}/`,
    status: { value: "active", label: "Active" },
    primary_ip: ip ? { id, address: `${ip}/24` } : null,
    site: { id: 1, name: "Berlin", slug: "berlin" },
    role: { id: 1, name: "Server", slug: "server" },
    tags: tags.map((slug) => ({ name: slug.toUpperCase(), slug })),
    custom_fields: {},
    ...extra,
  };
}
