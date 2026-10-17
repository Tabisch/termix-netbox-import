import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import { NetworkIcon } from "./icons";
import { createNetboxSyncTab } from "./NetboxSyncTab";

const TAB_ID = "netbox-sync";

export function activate(app: TermixApp): void {
  app.registerRailItem({
    id: TAB_ID,
    icon: NetworkIcon,
    titleKey: "tab.title",
    kind: "tab",
    permission: "use",
  });
  app.registerTab(TAB_ID, createNetboxSyncTab(app), {
    icon: NetworkIcon,
    titleKey: "tab.title",
    singleton: true,
    hostless: true,
  });
}
