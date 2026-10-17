import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { configs, links } from "./tables.js";
import { registerRoutes } from "./routes.js";
import { Store } from "./store.js";
import { createSyncer, SyncError } from "./sync.js";

const SCHEDULER_TICK_MS = 60_000;

export async function activate(ctx: PluginContext) {
  const configsTable = await ctx.db.define(configs);
  const linksTable = await ctx.db.define(links);
  const store = new Store(ctx, configsTable, linksTable);
  const syncer = createSyncer({ ctx, store });

  registerRoutes(ctx.http.router<Router>(), ctx, store, syncer);

  // Once a minute, sync every user whose auto sync is due. ctx.schedule never
  // overlaps runs, and users are synced one after another.
  ctx.schedule.every(SCHEDULER_TICK_MS, () => runDueSyncs(ctx, store, syncer), {
    jitterMs: 10_000,
  });
}

export async function runDueSyncs(
  ctx: PluginContext,
  store: Store,
  syncer: ReturnType<typeof createSyncer>,
  now = Date.now(),
): Promise<void> {
  let due;
  try {
    due = (await store.listConfigs()).filter(({ config, lastSyncAt }) => {
      if (!config.autoSync) return false;
      const last = lastSyncAt ? Date.parse(lastSyncAt) : 0;
      return !last || now - last >= config.intervalMinutes * 60_000;
    });
  } catch (error) {
    ctx.log.error("Could not read NetBox sync settings", error as Error);
    return;
  }
  for (const { userId } of due) {
    if (syncer.isRunning(userId)) continue;
    try {
      await ctx.asUser(userId, () => syncer.sync(userId));
    } catch (error) {
      // NetBox being down or a missing token is the user's to fix and shows
      // in the tab; it is not this plugin failing.
      if (error instanceof SyncError) {
        ctx.log.debug(`Scheduled NetBox sync skipped: ${error.message}`);
      } else {
        ctx.log.warn(
          `Scheduled NetBox sync failed: ${(error as Error).message}`,
        );
      }
    }
  }
}

export async function deactivate() {
  // Routes, the scheduler and everything else made through ctx are disposed
  // by core.
}
