import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Router } from "express";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import { activate } from "../../src/backend/index.js";
import {
  createFakeNetbox,
  device,
  ipAddress,
  NETBOX_URL,
  type FakeNetbox,
} from "./fake-netbox.js";

const pluginDir = fileURLToPath(new URL("../..", import.meta.url));
const manifest = manifestJson as unknown as PluginManifest;

let db: TestDb;
let mock: MockPluginContext;
let netbox: FakeNetbox;
let server: http.Server;
let port: number;
/** What core's GET /credentials answers, standing in for Termix. */
let coreCredentials: { status: number; body: unknown };
/** What ctx.credentials.listSshKeys answers. */
let sshKeys: Array<{ id: number; name: string }>;

const CORE_URL = "http://127.0.0.1:30001";

async function start(permissions = ["netbox-sync.use"]) {
  coreCredentials = { status: 200, body: [] };
  sshKeys = [{ id: 7, name: "deploy" }];
  db = await createTestDb(pluginDir);
  db.sqlite
    .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
    .run("user-1", "user-1");
  netbox = createFakeNetbox({
    devices: [
      device("web-1", "10.0.0.1", ["termix"], { id: 1 }),
      device("web-2", "10.0.0.2", ["termix", "web"], { id: 2 }),
      device("db-1", "10.0.0.3", ["db"], { id: 3 }),
      device("no-ip", null, ["termix"], { id: 4 }),
    ],
    vms: [device("vm-1", "10.0.1.1", ["termix"], { id: 1 })],
  });

  let router: Router | null = null;
  mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    capabilities: manifest.capabilities,
    db: db.database,
    router: () => (router = express.Router()),
    permissions,
    sshKeyCredentials: sshKeys.map((key) => ({
      ...key,
      username: null,
      publicKey: null,
    })),
    fetch: async (url, init) =>
      url.startsWith(CORE_URL)
        ? new Response(JSON.stringify(coreCredentials.body), {
            status: coreCredentials.status,
          })
        : netbox.fetch(url, init),
  });
  await activate(mock.ctx);

  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    mock.setActor("user-1");
    next();
  });
  app.use((req, res, next) => router!(req, res, next));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
}

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

async function request(method: string, path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

async function configure(config: Record<string, unknown> = {}) {
  const saved = await request("PUT", "/config", {
    config: { netboxUrl: NETBOX_URL, tags: ["termix"], ...config },
    token: netbox.token,
  });
  expect(saved.status).toBe(200);
}

const owned = () => mock.ctx.asUser("user-1", () => mock.ctx.hosts.listOwned());

describe("without the permission", () => {
  beforeEach(() => start([]));

  it("refuses every route", async () => {
    expect((await request("GET", "/config")).status).toBe(403);
    expect((await request("POST", "/sync")).status).toBe(403);
  });
});

describe("netbox-sync routes", () => {
  beforeEach(() => start());

  it("starts unconfigured with the defaults", async () => {
    const { status, body } = await request("GET", "/config");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      configured: false,
      hasToken: false,
      lastResult: null,
      config: { tags: [], missingAction: "tag" },
    });
  });

  it("refuses invalid settings with a code per field", async () => {
    const { status, body } = await request("PUT", "/config", {
      config: { netboxUrl: "not a url", port: 99999 },
    });
    expect(status).toBe(400);
    expect(body.errors).toEqual({
      netboxUrl: "invalidUrl",
      port: "invalidPort",
      token: "tokenRequired",
    });
  });

  it("saves the token as a secret, not in the settings", async () => {
    await configure();
    const { body } = await request("GET", "/config");
    expect(body.hasToken).toBe(true);
    expect(JSON.stringify(body)).not.toContain(netbox.token);
    const rows = db.sqlite
      .prepare("SELECT config FROM p_netbox_sync_configs")
      .all() as Array<{ config: string }>;
    expect(rows[0]!.config).not.toContain(netbox.token);
  });

  it("tests the connection", async () => {
    const ok = await request("POST", "/test", {
      config: { netboxUrl: NETBOX_URL },
      token: netbox.token,
    });
    expect(ok.body).toEqual({ ok: true, version: "4.2.1" });

    const refused = await request("POST", "/test", {
      config: { netboxUrl: NETBOX_URL },
      token: "wrong",
    });
    expect(refused.status).toBe(424);
    expect(refused.body.code).toBe("unauthorized");
  });

  it("asks for settings before a sync", async () => {
    const { status, body } = await request("POST", "/sync");
    expect(status).toBe(400);
    expect(body.code).toBe("notConfigured");
  });

  it("previews without writing anything", async () => {
    await configure();
    const { status, body } = await request("POST", "/preview");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      dryRun: true,
      found: 4,
      created: 3,
      skipped: 1,
    });
    expect(await owned()).toHaveLength(0);
  });

  it("creates tagged hosts, then leaves them unchanged", async () => {
    await configure();
    const first = await request("POST", "/sync");
    expect(first.body).toMatchObject({ created: 3, skipped: 1, errors: [] });

    const hosts = await owned();
    expect(hosts.map((h) => h.name).sort()).toEqual(["vm-1", "web-1", "web-2"]);
    const web2 = hosts.find((h) => h.name === "web-2")!;
    expect(web2).toMatchObject({
      ip: "10.0.0.2",
      port: 22,
      username: "root",
      folder: "Berlin",
      authType: "none",
    });
    expect(web2.tags?.split(",").sort()).toEqual(["TERMIX", "WEB", "netbox"]);

    const second = await request("POST", "/sync");
    expect(second.body).toMatchObject({ created: 0, updated: 0, unchanged: 3 });

    const { body } = await request("GET", "/config");
    expect(body.lastResult).toMatchObject({ created: 0, unchanged: 3 });
    expect(body.lastResult.entries).toBeUndefined();
    expect(body.lastSyncAt).toEqual(expect.any(String));
  });

  it("gives hosts the credential their dashlane: tag names", async () => {
    const WEB = "dashlane:11111111-AAAA-4AAA-8AAA-111111111111";
    coreCredentials.body = [
      { id: 40, name: "other", tags: ["dashlane"] },
      { id: 41, name: "web", tags: ["dashlane", WEB] },
    ];
    const credentialTags = (...names: string[]) => [
      { name: "termix", slug: "termix" },
      ...names.map((name) => ({ name, slug: name.replace(/:/g, "") })),
    ];
    netbox.devices[0] = device("web-1", "10.0.0.1", [], {
      id: 1,
      tags: credentialTags(WEB.toUpperCase()),
    });
    netbox.devices[1] = device("web-2", "10.0.0.2", [], {
      id: 2,
      tags: credentialTags("dashlane:99999999-0000-4000-8000-000000000000"),
    });
    await configure();
    const first = await request("POST", "/sync");
    expect(first.body).toMatchObject({ created: 3, errors: [] });
    const tokens = mock.auth.userTokens;
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ userId: "user-1" });

    const hosts = await owned();
    expect(hosts.find((h) => h.name === "web-1")).toMatchObject({
      authType: "credential",
      credentialId: 41,
      username: "",
    });
    // A tag no credential has gives an empty username and password.
    expect(hosts.find((h) => h.name === "web-2")).toMatchObject({
      authType: "password",
      credentialId: null,
      username: "",
    });

    // Tagging an existing host in NetBox switches it to the credential.
    const web2 = hosts.find((h) => h.name === "web-2")!;
    netbox.devices[1] = device("web-2", "10.0.0.2", [], {
      id: 2,
      tags: credentialTags(WEB),
    });
    const second = await request("POST", "/sync");
    expect(second.body).toMatchObject({ updated: 1, errors: [] });
    expect(second.body.entries).toContainEqual(
      expect.objectContaining({
        hostId: web2.id,
        changes: ["tags", "auth"],
      }),
    );
    expect((await owned()).find((h) => h.id === web2.id)).toMatchObject({
      authType: "credential",
      credentialId: 41,
    });
  });

  it("refuses to save an SSH key that doesn't exist", async () => {
    const { status, body } = await request("PUT", "/config", {
      config: {
        netboxUrl: NETBOX_URL,
        authType: "credential",
        credentialId: 99,
      },
      token: netbox.token,
    });
    expect(status).toBe(400);
    expect(body.errors).toEqual({ credentialId: "credentialMissing" });

    await configure({ authType: "credential", credentialId: 7 });
  });

  it("skips new hosts whose saved SSH key was deleted, instead of a foreign key error", async () => {
    coreCredentials.body = [{ id: 7, name: "deploy", tags: [] }];
    await configure({ authType: "credential", credentialId: 7 });
    // The key is deleted after the settings were saved.
    coreCredentials.body = [];
    const { body } = await request("POST", "/sync");
    expect(body.created).toBe(0);
    expect(body.errors).toEqual([
      "web-1: the SSH key picked under New hosts doesn't exist any more. Pick another one and sync again.",
      "web-2: the SSH key picked under New hosts doesn't exist any more. Pick another one and sync again.",
      "vm-1: the SSH key picked under New hosts doesn't exist any more. Pick another one and sync again.",
    ]);
    expect(await owned()).toHaveLength(0);
    expect(mock.auth.userTokens).toHaveLength(1);

    coreCredentials.body = [{ id: 7, name: "deploy", tags: [] }];
    const again = await request("POST", "/sync");
    expect(again.body).toMatchObject({ created: 3, errors: [] });
  });

  it("gives hosts the user's own credential tagged termix:localsshkey", async () => {
    coreCredentials.body = [
      {
        id: 50,
        name: "someone else's",
        tags: ["termix:localsshkey"],
        isShared: true,
      },
      { id: 51, name: "my key", tags: ["Termix:LocalSshKey"] },
    ];
    netbox.devices[0] = device("web-1", "10.0.0.1", [], {
      id: 1,
      tags: [
        { name: "termix", slug: "termix" },
        { name: "termix:localsshkey", slug: "termixlocalsshkey" },
      ],
    });
    await configure();
    const { body } = await request("POST", "/sync");
    expect(body).toMatchObject({ created: 3, errors: [] });
    expect((await owned()).find((h) => h.name === "web-1")).toMatchObject({
      authType: "credential",
      credentialId: 51,
    });
  });

  it("does not ask Termix for credentials when no object has a credential tag", async () => {
    await configure();
    await request("POST", "/sync");
    expect(mock.auth.userTokens).toHaveLength(0);
  });

  it("reports Termix refusing the credential list and keeps syncing", async () => {
    coreCredentials = { status: 403, body: { error: "Permission denied" } };
    netbox.devices[0] = device("web-1", "10.0.0.1", [], {
      id: 1,
      tags: [
        { name: "termix", slug: "termix" },
        { name: "dashlane:abc", slug: "dashlaneabc" },
      ],
    });
    await configure();
    const { body } = await request("POST", "/sync");
    expect(body.created).toBe(3);
    expect(body.errors).toEqual([
      "Credentials: Termix refused to list credentials (403: Permission denied). Credential tags are ignored.",
    ]);
  });

  it("updates changed objects and keeps tags the user added", async () => {
    await configure();
    await request("POST", "/sync");
    const web1 = (await owned()).find((h) => h.name === "web-1")!;
    await mock.ctx.asUser("user-1", () =>
      mock.ctx.hosts.update(web1.id, { tags: `${web1.tags},mine` }),
    );

    netbox.devices[0] = device("web-1-renamed", "10.0.0.11", ["termix"], {
      id: 1,
    });
    const { body } = await request("POST", "/sync");
    expect(body).toMatchObject({ updated: 1, created: 0 });
    expect(body.entries).toContainEqual(
      expect.objectContaining({
        action: "update",
        changes: ["name", "ip"],
      }),
    );

    const updated = (await owned()).find((h) => h.id === web1.id)!;
    expect(updated).toMatchObject({ name: "web-1-renamed", ip: "10.0.0.11" });
    expect(updated.tags?.split(",")).toContain("mine");
  });

  it("tags hosts that left the filter and untags them when they come back", async () => {
    await configure();
    await request("POST", "/sync");
    const removed = netbox.devices.shift()!;

    const missing = await request("POST", "/sync");
    expect(missing.body).toMatchObject({ missing: 1 });
    const host = (await owned()).find((h) => h.name === "web-1")!;
    expect(host.tags?.split(",")).toContain("netbox-missing");

    netbox.devices.unshift(removed);
    const back = await request("POST", "/sync");
    expect(back.body).toMatchObject({ updated: 1, missing: 0 });
    const restored = (await owned()).find((h) => h.name === "web-1")!;
    expect(restored.tags?.split(",")).not.toContain("netbox-missing");
  });

  it("deletes hosts that left NetBox when asked to", async () => {
    await configure({ missingAction: "delete" });
    await request("POST", "/sync");
    netbox.vms = [];

    const preview = await request("POST", "/preview");
    expect(preview.body).toMatchObject({ deleted: 1 });
    expect(await owned()).toHaveLength(3);

    const { body } = await request("POST", "/sync");
    expect(body).toMatchObject({ deleted: 1 });
    expect((await owned()).map((h) => h.name)).not.toContain("vm-1");
  });

  it("auto removes a host once it has been missing long enough", async () => {
    await configure({ autoRemove: true, removeAfterDays: 7 });
    await request("POST", "/sync");
    netbox.vms = [];

    const first = await request("POST", "/sync");
    expect(first.body).toMatchObject({ missing: 1, deleted: 0 });
    expect((await owned()).map((h) => h.name)).toContain("vm-1");

    // Still within the grace period.
    const second = await request("POST", "/sync");
    expect(second.body).toMatchObject({ missing: 1, deleted: 0 });

    // Eight days later.
    db.sqlite
      .prepare("UPDATE p_netbox_sync_links SET missing_since = ?")
      .run(new Date(Date.now() - 8 * 86_400_000).toISOString());
    const preview = await request("POST", "/preview");
    expect(preview.body).toMatchObject({ deleted: 1 });
    const third = await request("POST", "/sync");
    expect(third.body).toMatchObject({ missing: 0, deleted: 1 });
    expect((await owned()).map((h) => h.name)).not.toContain("vm-1");
  });

  it("auto removes right away with 0 days", async () => {
    await configure({ autoRemove: true, removeAfterDays: 0 });
    await request("POST", "/sync");
    netbox.vms = [];
    const { body } = await request("POST", "/sync");
    expect(body).toMatchObject({ deleted: 1 });
  });

  it("forgets the missing date when an object comes back", async () => {
    await configure({ autoRemove: true, removeAfterDays: 7 });
    await request("POST", "/sync");
    const vms = netbox.vms;
    netbox.vms = [];
    await request("POST", "/sync");
    netbox.vms = vms;
    await request("POST", "/sync");
    const rows = db.sqlite
      .prepare("SELECT missing_since FROM p_netbox_sync_links")
      .all() as Array<{ missing_since: string | null }>;
    expect(rows.every((row) => row.missing_since === null)).toBe(true);
  });

  it("links an existing host with the same address", async () => {
    const existing = await mock.ctx.asUser("user-1", () =>
      mock.ctx.hosts.create({
        name: "my web",
        ip: "10.0.0.1",
        port: 2222,
        username: "me",
        authType: "password",
        tags: ["mine"],
      }),
    );
    await configure();
    const { body } = await request("POST", "/sync");
    expect(body).toMatchObject({ adopted: 1, created: 2 });

    const hosts = await owned();
    expect(hosts).toHaveLength(3);
    const adopted = hosts.find((h) => h.id === existing.id)!;
    expect(adopted).toMatchObject({
      name: "web-1",
      port: 2222,
      username: "me",
      authType: "password",
    });
    expect(adopted.tags?.split(",")).toEqual(["mine", "netbox", "TERMIX"]);
  });

  it("makes a new host when the user deleted the synced one", async () => {
    await configure();
    await request("POST", "/sync");
    const vm = (await owned()).find((h) => h.name === "vm-1")!;
    await mock.ctx.asUser("user-1", () => mock.ctx.hosts.delete(vm.id));

    const { body } = await request("POST", "/sync");
    expect(body).toMatchObject({ created: 1, unchanged: 2 });
  });

  it("accepts tag names as well as slugs", async () => {
    // The fake names each tag after its slug in upper case.
    await configure({ tags: ["TERMIX"] });
    const { body } = await request("POST", "/sync");
    expect(body).toMatchObject({ created: 3, errors: [] });
  });

  it("names a tag NetBox doesn't have", async () => {
    await configure({ tags: ["termix", "Prod Servers"] });
    const { status, body } = await request("POST", "/sync");
    expect(status).toBe(424);
    expect(body).toMatchObject({ code: "unknownTag", detail: "Prod Servers" });
    expect(await owned()).toHaveLength(0);
  });

  it("syncs tagged IP addresses, skipping ones a device already has", async () => {
    netbox.ips = [
      ipAddress("10.0.5.1/24", ["termix"], { id: 1, dns_name: "printer.lan" }),
      // Same address as web-1's primary IP: web-1 is already synced.
      ipAddress("10.0.0.1/24", ["termix"], { id: 2 }),
      ipAddress("10.0.5.2/24", ["other"], { id: 3 }),
    ];
    await configure({ ipAddresses: true });
    const { body } = await request("POST", "/sync");
    expect(body).toMatchObject({ created: 4, errors: [] });
    const printer = (await owned()).find((h) => h.name === "printer.lan")!;
    expect(printer).toMatchObject({ ip: "10.0.5.1", port: 22 });
    expect(printer.notes).toContain(
      "https://netbox.internal/ipam/ip-addresses/1/",
    );

    // Leaving the filter is handled like any other object.
    netbox.ips[0]!.tags = [];
    const again = await request("POST", "/sync");
    expect(again.body).toMatchObject({ missing: 1 });
  });

  it("syncs only IP addresses when devices and VMs are off", async () => {
    netbox.ips = [ipAddress("10.0.5.1/24", ["termix"], { id: 1 })];
    await configure({
      devices: false,
      virtualMachines: false,
      ipAddresses: true,
    });
    const { body } = await request("POST", "/sync");
    expect(body).toMatchObject({ found: 1, created: 1 });
    expect((await owned()).map((h) => h.name)).toEqual(["10.0.5.1"]);
  });

  it("matches all tags when asked", async () => {
    await configure({ tags: ["termix", "web"], tagMatch: "all" });
    const { body } = await request("POST", "/sync");
    expect(body).toMatchObject({ created: 1 });
    expect((await owned()).map((h) => h.name)).toEqual(["web-2"]);
  });

  it("reports NetBox refusing the token without failing the plugin", async () => {
    await configure();
    netbox.token = "rotated";
    const { status, body } = await request("POST", "/sync");
    expect(status).toBe(424);
    expect(body.code).toBe("unauthorized");
    const config = await request("GET", "/config");
    expect(config.body.lastResult.errors).toEqual([
      "NetBox refused the API token",
    ]);
  });

  it("forgets the settings, token and links but keeps the hosts", async () => {
    await configure();
    await request("POST", "/sync");
    expect((await request("DELETE", "/config")).status).toBe(200);

    const { body } = await request("GET", "/config");
    expect(body).toMatchObject({ configured: false, hasToken: false });
    expect(await owned()).toHaveLength(3);
    const links = db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM p_netbox_sync_links")
      .get() as { n: number };
    expect(links.n).toBe(0);
  });

  it("syncs in the background when auto sync is due", async () => {
    await configure({ autoSync: true, intervalMinutes: 30 });
    const job = mock.scheduled.find((entry) => entry.kind === "every")!;
    expect(job.ms).toBe(60_000);

    mock.setActor(undefined as never);
    await job.fn();
    expect(await owned()).toHaveLength(3);

    // Not due again until the interval has passed.
    netbox.requests.length = 0;
    await job.fn();
    expect(netbox.requests).toHaveLength(0);
  });

  it("leaves users without auto sync alone", async () => {
    await configure();
    const job = mock.scheduled.find((entry) => entry.kind === "every")!;
    await job.fn();
    expect(await owned()).toHaveLength(0);
  });
});
