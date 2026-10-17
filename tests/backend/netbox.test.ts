import { describe, expect, it } from "vitest";
import {
  authorizationHeader,
  NetboxClient,
  NetboxError,
} from "../../src/backend/netbox.js";
import { createFakeNetbox, device, NETBOX_URL } from "./fake-netbox.js";

function client(fake: ReturnType<typeof createFakeNetbox>, token = fake.token) {
  return new NetboxClient({
    fetch: fake.fetch,
    baseUrl: NETBOX_URL,
    token,
  });
}

const filters = {
  tags: [] as string[],
  tagMatch: "any" as const,
  excludeTags: [] as string[],
  statuses: [] as string[],
};

describe("NetboxClient", () => {
  it("uses Bearer for v2 tokens and Token for v1", () => {
    expect(authorizationHeader("nbt_abc.def")).toBe("Bearer nbt_abc.def");
    expect(authorizationHeader("0123abcd")).toBe("Token 0123abcd");
  });

  it("reads the version and only allows the configured private host", async () => {
    const fake = createFakeNetbox();
    expect(await client(fake).status()).toEqual({ version: "4.2.1" });
    expect(fake.inits[0]?.allowPrivateHosts).toEqual(["netbox.internal"]);
  });

  it("reports a refused token", async () => {
    const fake = createFakeNetbox();
    await expect(client(fake, "wrong").status()).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("reports an unreachable server", async () => {
    const fake = createFakeNetbox();
    const broken = new NetboxClient({
      fetch: fake.fetch,
      baseUrl: "https://elsewhere.internal",
      token: fake.token,
    });
    await expect(broken.status()).rejects.toBeInstanceOf(NetboxError);
  });

  it("pages through every result", async () => {
    const devices = Array.from({ length: 600 }, (_, i) =>
      device(`d${i}`, `10.1.${Math.floor(i / 250)}.${i % 250}`, ["x"]),
    );
    const fake = createFakeNetbox({ devices });
    const found = await client(fake).listObjects("device", filters);
    expect(found).toHaveLength(600);
    expect(fake.requests).toHaveLength(3);
  });

  it("matches any tag with one query per tag, merged", async () => {
    const fake = createFakeNetbox({
      devices: [
        device("a", "10.0.0.1", ["web"]),
        device("b", "10.0.0.2", ["db"]),
        device("c", "10.0.0.3", ["web", "db"]),
        device("d", "10.0.0.4", ["other"]),
      ],
    });
    const found = await client(fake).listObjects("device", {
      ...filters,
      tags: ["web", "db"],
    });
    expect(found.map((o) => o.name).sort()).toEqual(["a", "b", "c"]);
    expect(fake.requests).toHaveLength(2);
  });

  it("matches all tags in one query", async () => {
    const fake = createFakeNetbox({
      devices: [
        device("a", "10.0.0.1", ["web"]),
        device("c", "10.0.0.3", ["web", "db"]),
      ],
    });
    const found = await client(fake).listObjects("device", {
      ...filters,
      tags: ["web", "db"],
      tagMatch: "all",
    });
    expect(found.map((o) => o.name)).toEqual(["c"]);
    expect(new URL(fake.requests[0]!).searchParams.getAll("tag")).toEqual([
      "web",
      "db",
    ]);
  });

  it("drops excluded tags and filters by status", async () => {
    const fake = createFakeNetbox({
      devices: [
        device("a", "10.0.0.1", ["web"]),
        device("b", "10.0.0.2", ["web", "decom"]),
        device("c", "10.0.0.3", ["web"], {
          status: { value: "offline" },
        }),
      ],
    });
    const found = await client(fake).listObjects("device", {
      ...filters,
      tags: ["web"],
      excludeTags: ["decom"],
      statuses: ["active"],
    });
    expect(found.map((o) => o.name)).toEqual(["a"]);
  });
});
