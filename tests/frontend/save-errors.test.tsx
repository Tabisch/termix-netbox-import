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

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useToast: () => toast,
}));

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  vi.clearAllMocks();
});

describe("a refused save", () => {
  it("names the field it is about, even one out of view", async () => {
    const put = vi.fn(async () => {
      throw {
        response: {
          data: {
            error: "Invalid settings",
            code: "invalidSettings",
            errors: { credentialId: "credentialMissing" },
          },
        },
      };
    });
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: {
        get: vi.fn(async () => ({
          data: {
            configured: true,
            config: {
              ...DEFAULT_CONFIG,
              netboxUrl: "https://netbox.internal",
              tags: ["ssh"],
              authType: "credential",
              credentialId: 9,
            },
            hasToken: true,
            lastSyncAt: null,
            lastResult: null,
            running: false,
            credentials: [],
          },
        })),
        put,
      } as never,
    });
    rendered.renderTab("netbox-sync", { isVisible: true });
    const url = await screen.findByDisplayValue("https://netbox.internal");
    fireEvent.change(url, { target: { value: "https://netbox.lan" } });
    fireEvent.click(screen.getByText(locales.actions.save));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledWith(
      locales.errors.invalidSettings.replace(
        "{{detail}}",
        `${locales.fields.credentialId.label}: ${locales.errors.credentialMissing}`,
      ),
    );
    expect(toast.error).not.toHaveBeenCalledWith(locales.errors.unknown);
  });
});
