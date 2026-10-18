import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  normalizeConfig,
  validateConfig,
} from "../../src/backend/config.js";
import { credentialsByTag } from "../../src/backend/core-credentials.js";
import {
  credentialTagOf,
  desiredHost,
  mergeTags,
  primaryAddress,
  stripPrefix,
  webUrl,
} from "../../src/backend/mapping.js";
import {
  planCreate,
  planUpdate,
  shouldRemove,
} from "../../src/backend/sync.js";
import { device, ipAddress } from "./fake-netbox.js";

const config = normalizeConfig({ netboxUrl: "https://netbox.internal" });

describe("config", () => {
  it("fills defaults and trims the URL", () => {
    const parsed = normalizeConfig({
      netboxUrl: " https://netbox.internal/ ",
      tags: " a, b ,a",
      port: "2222",
    });
    expect(parsed.netboxUrl).toBe("https://netbox.internal");
    expect(parsed.tags).toEqual(["a", "b"]);
    expect(parsed.port).toBe(2222);
    expect(parsed.statuses).toEqual(DEFAULT_CONFIG.statuses);
  });

  it("refuses a bad URL, port and missing credential", () => {
    const errors = validateConfig(
      normalizeConfig({
        netboxUrl: "ftp://x",
        port: 0,
        authType: "credential",
        devices: false,
        virtualMachines: false,
      }),
    );
    expect(errors).toMatchObject({
      netboxUrl: "invalidUrl",
      port: "invalidPort",
      credentialId: "credentialRequired",
      devices: "noObjectTypes",
    });
  });

  it("refuses a URL with a password in it", () => {
    expect(
      validateConfig(normalizeConfig({ netboxUrl: "https://a:b@netbox" }))
        .netboxUrl,
    ).toBe("invalidUrl");
  });

  it("accepts the defaults with a URL", () => {
    expect(validateConfig(config)).toEqual({});
  });
});

describe("mapping", () => {
  it("strips the prefix length from addresses", () => {
    expect(stripPrefix("10.0.0.5/24")).toBe("10.0.0.5");
    expect(stripPrefix("2001:db8::1/64")).toBe("2001:db8::1");
  });

  it("falls back to the v4 then v6 address", () => {
    expect(
      primaryAddress(
        device("a", null, [], {
          primary_ip6: { address: "2001:db8::2/64" },
        }),
      ),
    ).toBe("2001:db8::2");
  });

  it("links to the web UI, not the API", () => {
    expect(webUrl(device("a", null, [], { id: 7 }))).toBe(
      "https://netbox.internal/dcim/devices/7/",
    );
  });

  it("builds a host with tags, site folder and notes", () => {
    const desired = desiredHost(
      {
        kind: "device",
        object: device("web-1", "10.0.0.5", ["linux"], {
          id: 3,
          description: "Front end",
        }),
      },
      config,
    );
    expect(desired).toEqual({
      name: "web-1",
      ip: "10.0.0.5",
      port: null,
      username: null,
      folder: "Berlin",
      managedTags: ["netbox", "LINUX"],
      credentialTag: null,
      notes: "NetBox: https://netbox.internal/dcim/devices/3/\nFront end",
    });
  });

  it("names an IP address by DNS name, then its device, then itself", () => {
    const desired = (object: ReturnType<typeof ipAddress>) =>
      desiredHost({ kind: "ip", object }, config);
    expect(
      desired(ipAddress("10.0.2.1/24", [], { dns_name: "router.lan" })),
    ).toMatchObject({ name: "router.lan", ip: "10.0.2.1" });
    expect(
      desired(
        ipAddress("10.0.2.2/24", [], {
          assigned_object: { name: "eth0", device: { name: "sw-1" } },
        }),
      ),
    ).toMatchObject({ name: "sw-1", ip: "10.0.2.2" });
    expect(desired(ipAddress("2001:db8::9/64", []))).toMatchObject({
      name: "2001:db8::9",
      ip: "2001:db8::9",
    });
  });

  it("uses an IP address's role label as its folder", () => {
    expect(
      desiredHost(
        {
          kind: "ip",
          object: ipAddress("10.0.2.3/24", [], { role: { label: "VIP" } }),
        },
        { ...config, folderSource: "role" },
      ),
    ).toMatchObject({ folder: "VIP" });
  });

  it("skips an object without a primary IP", () => {
    expect(
      desiredHost({ kind: "device", object: device("x", null, []) }, config),
    ).toEqual({ skip: "noAddress" });
  });

  it("reads the port and username from custom fields", () => {
    const desired = desiredHost(
      {
        kind: "vm",
        object: device("vm-1", "10.0.0.9", [], {
          custom_fields: { ssh_port: 2200, ssh_user: "admin" },
        }),
      },
      {
        ...config,
        portCustomField: "ssh_port",
        usernameCustomField: "ssh_user",
      },
    );
    expect(desired).toMatchObject({ port: 2200, username: "admin" });
  });

  it("uses the fixed folder when the object has no value", () => {
    const desired = desiredHost(
      { kind: "device", object: device("a", "10.0.0.1", [], { tenant: null }) },
      { ...config, folderSource: "tenant", folder: "Imported" },
    );
    expect(desired).toMatchObject({ folder: "Imported" });
  });

  it("replaces managed tags and keeps the user's own", () => {
    expect(
      mergeTags(
        "mine,netbox,OLD,netbox-missing",
        ["netbox", "OLD"],
        ["netbox", "NEW"],
        ["netbox-missing"],
      ),
    ).toEqual(["mine", "netbox", "NEW"]);
  });
});

describe("planning", () => {
  const desired = {
    name: "web-1",
    ip: "10.0.0.5",
    port: null,
    username: null,
    folder: "Berlin",
    managedTags: ["netbox"],
    credentialTag: null,
    notes: null,
  };

  it("creates with the config's connection defaults", () => {
    expect(planCreate(desired, config)).toMatchObject({
      port: 22,
      username: "root",
      authType: "none",
      credentialId: null,
      enableSsh: true,
      tags: ["netbox"],
    });
  });

  it("leaves the username to a credential", () => {
    expect(
      planCreate(desired, {
        ...config,
        authType: "credential",
        credentialId: 4,
      }),
    ).toMatchObject({
      username: "",
      authType: "credential",
      credentialId: 4,
      overrideCredentialUsername: false,
    });
  });

  it("only lists fields that change", () => {
    const host = {
      name: "web-1",
      ip: "10.0.0.4",
      folder: "Berlin",
      tags: "netbox",
      notes: "kept",
      port: 22,
      username: "root",
    } as never;
    expect(planUpdate(host, desired, ["netbox"])).toEqual({
      patch: { ip: "10.0.0.5" },
      changes: ["ip"],
    });
  });
});

describe("credential tags", () => {
  const DASHLANE = "dashlane:11111111-AAAA-4AAA-8AAA-111111111111";
  const tagged = (...names: string[]) =>
    device("web-1", "10.0.0.5", [], {
      tags: names.map((name) => ({ name, slug: name.replace(/:/g, "") })),
    });

  const PREFIXES = ["dashlane:", "termix:"];

  it("takes the first NetBox tag that starts with a prefix, any case", () => {
    expect(
      credentialTagOf(tagged("linux", DASHLANE.toUpperCase()), PREFIXES),
    ).toBe(DASHLANE.toUpperCase());
    expect(
      credentialTagOf(tagged("linux", "termix:localsshkey"), PREFIXES),
    ).toBe("termix:localsshkey");
    expect(credentialTagOf(tagged("linux"), PREFIXES)).toBeNull();
    // A tag that only picks the object for the sync is not a credential tag.
    expect(credentialTagOf(tagged("ssh"), PREFIXES)).toBeNull();
    expect(credentialTagOf(tagged("dashlane:"), PREFIXES)).toBeNull();
    expect(credentialTagOf(tagged(DASHLANE), [])).toBeNull();
    expect(credentialTagOf(tagged(DASHLANE), [""])).toBeNull();
  });

  it("reads settings saved with a single prefix", () => {
    expect(
      normalizeConfig({ credentialTagPrefix: "dashlane:" })
        .credentialTagPrefixes,
    ).toEqual(["dashlane:", "termix:"]);
    expect(
      normalizeConfig({ credentialTagPrefix: "vault:" }).credentialTagPrefixes,
    ).toEqual(["vault:"]);
    expect(
      normalizeConfig({ credentialTagPrefix: "" }).credentialTagPrefixes,
    ).toEqual([]);
    expect(normalizeConfig({}).credentialTagPrefixes).toEqual([
      "dashlane:",
      "termix:",
    ]);
    expect(
      normalizeConfig({ credentialTagPrefixes: [] }).credentialTagPrefixes,
    ).toEqual([]);
  });

  it("maps credential tags to ids, own credentials before shared ones", () => {
    const byTag = credentialsByTag(
      [
        { id: 9, name: "shared", tags: [DASHLANE], shared: true },
        { id: 5, name: "web", tags: ["dashlane", DASHLANE], shared: false },
        { id: 2, name: "other", tags: ["linux"], shared: false },
        { id: 3, name: "local", tags: ["Termix:LocalSshKey"], shared: false },
      ],
      PREFIXES,
    );
    expect([...byTag]).toEqual([
      ["termix:localsshkey", 3],
      [DASHLANE.toLowerCase(), 5],
    ]);
  });

  it("creates with the tagged credential over the default", () => {
    expect(
      planCreate(
        {
          name: "web-1",
          ip: "10.0.0.5",
          port: null,
          username: null,
          folder: "",
          managedTags: [],
          credentialTag: DASHLANE,
          notes: null,
        },
        config,
        { authType: "credential", credentialId: 7 },
      ),
    ).toMatchObject({
      username: "",
      authType: "credential",
      credentialId: 7,
      overrideCredentialUsername: false,
    });
  });

  it("creates with an empty username and password when no credential has the tag", () => {
    expect(
      planCreate(
        {
          name: "web-1",
          ip: "10.0.0.5",
          port: null,
          username: null,
          folder: "",
          managedTags: [],
          credentialTag: "termix:localsshkey",
          notes: null,
        },
        { ...config, authType: "credential", credentialId: 4 },
        { authType: "password" },
      ),
    ).toMatchObject({
      username: "",
      authType: "password",
      credentialId: null,
      overrideCredentialUsername: false,
    });
  });

  it("switches an existing host to the tagged credential", () => {
    const desired = {
      name: "web-1",
      ip: "10.0.0.5",
      port: null,
      username: null,
      folder: "",
      managedTags: [],
      credentialTag: DASHLANE,
      notes: null,
    };
    const host = {
      name: "web-1",
      ip: "10.0.0.5",
      folder: "",
      tags: "",
      port: 22,
      username: "root",
      authType: "password",
      credentialId: null,
      overrideCredentialUsername: false,
    } as never;
    const tagged = { authType: "credential", credentialId: 7 } as const;
    expect(planUpdate(host, desired, [], tagged)).toEqual({
      patch: {
        authType: "credential",
        credentialId: 7,
        overrideCredentialUsername: false,
      },
      changes: ["auth"],
    });
    const already = Object.assign({}, host, {
      authType: "credential",
      credentialId: 7,
    });
    expect(planUpdate(already, desired, [], tagged).changes).toEqual([]);
    // Without a tag the host's auth is left alone.
    expect(planUpdate(host, desired, [], null).changes).toEqual([]);

    // The tagged credential is gone: back to an empty username and password.
    expect(planUpdate(already, desired, [], { authType: "password" })).toEqual({
      patch: {
        authType: "password",
        credentialId: null,
        overrideCredentialUsername: false,
        username: "",
      },
      changes: ["auth"],
    });
    // A host already on password auth keeps what the user typed in.
    expect(
      planUpdate(host, desired, [], { authType: "password" }).changes,
    ).toEqual([]);
  });
});

describe("auto remove", () => {
  const now = "2026-10-20T12:00:00.000Z";
  const base = { missingAction: "tag" as const, autoRemove: true };

  it("waits the set number of days from when the host went missing", () => {
    const opts = { ...base, removeAfterDays: 7 };
    expect(shouldRemove(opts, null, now)).toBe(false);
    expect(shouldRemove(opts, "2026-10-14T12:00:00.000Z", now)).toBe(false);
    expect(shouldRemove(opts, "2026-10-13T12:00:00.000Z", now)).toBe(true);
  });

  it("removes right away with 0 days or the delete action", () => {
    expect(shouldRemove({ ...base, removeAfterDays: 0 }, null, now)).toBe(true);
    expect(
      shouldRemove(
        { missingAction: "delete", autoRemove: false, removeAfterDays: 7 },
        null,
        now,
      ),
    ).toBe(true);
  });

  it("never removes with the toggle off", () => {
    expect(
      shouldRemove(
        { ...base, autoRemove: false, removeAfterDays: 0 },
        "2020-01-01T00:00:00.000Z",
        now,
      ),
    ).toBe(false);
  });

  it("refuses an out of range number of days", () => {
    expect(
      validateConfig(
        normalizeConfig({ ...config, autoRemove: true, removeAfterDays: 400 }),
      ).removeAfterDays,
    ).toBe("invalidRemoveAfter");
  });
});
