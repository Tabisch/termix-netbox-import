import {
  defineTable,
  id,
  integer,
  json,
  refUser,
  timestamp,
  varchar,
} from "@termix-ssh/plugin-sdk/db";

// Stored as p_netbox_sync_configs. One row per user: each user syncs NetBox
// into hosts they own. The API token is not here, it lives in ctx.secrets.
export const configs = defineTable(
  "configs",
  {
    id: id(),
    userId: refUser(),
    config: json().notNull(),
    lastSyncAt: timestamp(),
    lastResult: json(),
    updatedAt: timestamp().notNull().defaultNow(),
  },
  {
    indexes: [
      {
        name: "idx_p_netbox_sync_configs_user_id",
        columns: ["userId"],
        unique: true,
      },
    ],
  },
);

// Which Termix host a NetBox object was synced to. managedTags are the tags
// the last sync wrote, so the next one can replace them without touching tags
// the user added by hand.
export const links = defineTable(
  "links",
  {
    id: id(),
    userId: refUser(),
    hostId: integer().notNull(),
    kind: varchar(16).notNull(),
    netboxId: integer().notNull(),
    managedTags: json(),
    missingSince: timestamp(),
  },
  {
    indexes: [{ name: "idx_p_netbox_sync_links_user_id", columns: ["userId"] }],
  },
);

// termix-plugin migrations reads this list.
export const tables = [configs, links];
