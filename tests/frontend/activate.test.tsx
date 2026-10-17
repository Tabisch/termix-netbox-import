import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import { DEFAULT_CONFIG } from "../../src/backend/config";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

function configResponse(overrides: Record<string, unknown> = {}) {
  return {
    configured: true,
    config: { ...DEFAULT_CONFIG, netboxUrl: "https://netbox.internal" },
    hasToken: true,
    lastSyncAt: null,
    lastResult: null,
    running: false,
    credentials: [],
    ...overrides,
  };
}

describe(`${manifest.id} activate`, () => {
  it("registers the rail item and tab", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.tabs()).toEqual(["netbox-sync"]);
    expect(rendered.registered.railItems()).toEqual([
      expect.objectContaining({
        id: "netbox-sync",
        permission: "netbox-sync.use",
      }),
    ]);
  });

  it("asks to connect NetBox when nothing is set up", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: {
        get: vi.fn(async () => ({
          data: configResponse({
            configured: false,
            hasToken: false,
            config: DEFAULT_CONFIG,
          }),
        })),
      } as never,
    });
    rendered.renderTab("netbox-sync", { isVisible: true });
    expect(await screen.findByText(locales.tab.notConfigured)).toBeTruthy();
    expect(screen.getByText(locales.result.never)).toBeTruthy();
  });

  it("shows a load error", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: {
        get: vi.fn(async () => {
          throw new Error("offline");
        }),
      } as never,
    });
    rendered.renderTab("netbox-sync", { isVisible: true });
    expect(await screen.findByText(locales.tab.loadError)).toBeTruthy();
  });

  it("runs a preview and lists the planned changes", async () => {
    const post = vi.fn(async (path: string) => {
      expect(path).toBe("/preview");
      return {
        data: {
          dryRun: true,
          found: 2,
          created: 1,
          updated: 0,
          adopted: 0,
          unchanged: 0,
          skipped: 1,
          missing: 0,
          deleted: 0,
          errors: [],
          entries: [
            {
              action: "create",
              kind: "device",
              netboxId: 1,
              name: "web-1",
              ip: "10.0.0.1",
              hostId: null,
            },
            {
              action: "skip",
              kind: "vm",
              netboxId: 2,
              name: "vm-no-ip",
              ip: null,
              hostId: null,
              reason: "noAddress",
            },
          ],
        },
      };
    });
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: {
        get: vi.fn(async () => ({ data: configResponse() })),
        post,
      } as never,
    });
    rendered.renderTab("netbox-sync", { isVisible: true });
    fireEvent.click(await screen.findByText(locales.actions.preview));
    expect(await screen.findByText("web-1")).toBeTruthy();
    expect(screen.getByText(locales.result.preview)).toBeTruthy();
    expect(screen.getByText(locales.result.reason.noAddress)).toBeTruthy();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("shows field errors from a refused save", async () => {
    const put = vi.fn(async () => {
      throw {
        response: {
          data: {
            error: "Invalid settings",
            errors: { netboxUrl: "invalidUrl" },
          },
        },
      };
    });
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: {
        get: vi.fn(async () => ({ data: configResponse() })),
        put,
      } as never,
    });
    rendered.renderTab("netbox-sync", { isVisible: true });
    const url = await screen.findByDisplayValue("https://netbox.internal");
    fireEvent.change(url, { target: { value: "nope" } });
    fireEvent.click(screen.getByText(locales.actions.save));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(await screen.findByText(locales.errors.invalidUrl)).toBeTruthy();
  });
});
