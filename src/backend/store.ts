import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { normalizeConfig, type SyncConfig } from "./config.js";
import type { SyncResult } from "./sync.js";

// The table objects ctx.db.define hands back. Drizzle's own types are per
// dialect, so this file treats them loosely.
type Table = any;

export interface StoredConfig {
  config: SyncConfig;
  lastSyncAt: string | null;
  lastResult: SyncResult | null;
}

export interface LinkRow {
  id: number;
  userId: string;
  hostId: number;
  kind: string;
  netboxId: number;
  managedTags: string[];
  missingSince: string | null;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** The plugin's two tables, behind small typed helpers. */
export class Store {
  constructor(
    private readonly ctx: PluginContext,
    private readonly configsTable: Table,
    private readonly linksTable: Table,
  ) {}

  private client() {
    return this.ctx.db.client<BetterSQLite3Database>();
  }

  async getConfig(userId: string): Promise<StoredConfig | null> {
    const db = await this.client();
    const [row] = await db
      .select()
      .from(this.configsTable)
      .where(eq(this.configsTable.userId, userId));
    if (!row) return null;
    return {
      config: normalizeConfig(parseJson(row.config, {})),
      lastSyncAt: row.lastSyncAt ?? null,
      lastResult: parseJson<SyncResult | null>(row.lastResult, null),
    };
  }

  /** Every user with a saved config, for the scheduler. */
  async listConfigs(): Promise<Array<StoredConfig & { userId: string }>> {
    const db = await this.client();
    const rows = await db.select().from(this.configsTable);
    return rows.map((row: Record<string, unknown>) => ({
      userId: row.userId as string,
      config: normalizeConfig(parseJson(row.config, {})),
      lastSyncAt: (row.lastSyncAt as string | null) ?? null,
      lastResult: parseJson<SyncResult | null>(row.lastResult, null),
    }));
  }

  async saveConfig(userId: string, config: SyncConfig): Promise<void> {
    const db = await this.client();
    const now = new Date().toISOString();
    const existing = await this.getConfig(userId);
    if (existing) {
      await db
        .update(this.configsTable)
        .set({ config: JSON.stringify(config), updatedAt: now })
        .where(eq(this.configsTable.userId, userId));
    } else {
      await db.insert(this.configsTable).values({
        userId,
        config: JSON.stringify(config),
        updatedAt: now,
      });
    }
    await this.ctx.db.persist();
  }

  async saveResult(
    userId: string,
    at: string,
    result: SyncResult,
  ): Promise<void> {
    const db = await this.client();
    await db
      .update(this.configsTable)
      .set({ lastSyncAt: at, lastResult: JSON.stringify(result) })
      .where(eq(this.configsTable.userId, userId));
    await this.ctx.db.persist();
  }

  async deleteConfig(userId: string): Promise<void> {
    const db = await this.client();
    await db
      .delete(this.configsTable)
      .where(eq(this.configsTable.userId, userId));
    await db.delete(this.linksTable).where(eq(this.linksTable.userId, userId));
    await this.ctx.db.persist();
  }

  async listLinks(userId: string): Promise<LinkRow[]> {
    const db = await this.client();
    const rows = await db
      .select()
      .from(this.linksTable)
      .where(eq(this.linksTable.userId, userId));
    return rows.map((row: Record<string, unknown>) => ({
      id: row.id as number,
      userId: row.userId as string,
      hostId: Number(row.hostId),
      kind: row.kind as string,
      netboxId: Number(row.netboxId),
      managedTags: parseJson<string[]>(row.managedTags, []),
      missingSince: (row.missingSince as string | null) ?? null,
    }));
  }

  async insertLink(link: Omit<LinkRow, "id">): Promise<void> {
    const db = await this.client();
    await db.insert(this.linksTable).values({
      userId: link.userId,
      hostId: link.hostId,
      kind: link.kind,
      netboxId: link.netboxId,
      managedTags: JSON.stringify(link.managedTags),
      missingSince: link.missingSince,
    });
  }

  async updateLink(
    userId: string,
    id: number,
    patch: Partial<Pick<LinkRow, "managedTags" | "missingSince">>,
  ): Promise<void> {
    const db = await this.client();
    const set: Record<string, unknown> = {};
    if (patch.managedTags) set.managedTags = JSON.stringify(patch.managedTags);
    if (patch.missingSince !== undefined) set.missingSince = patch.missingSince;
    if (Object.keys(set).length === 0) return;
    await db
      .update(this.linksTable)
      .set(set)
      .where(
        and(eq(this.linksTable.userId, userId), eq(this.linksTable.id, id)),
      );
  }

  async deleteLink(userId: string, id: number): Promise<void> {
    const db = await this.client();
    await db
      .delete(this.linksTable)
      .where(
        and(eq(this.linksTable.userId, userId), eq(this.linksTable.id, id)),
      );
  }

  persist(): Promise<void> {
    return this.ctx.db.persist();
  }
}
