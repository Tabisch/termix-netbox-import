// The per-user sync configuration, its defaults and its validation. Pure, so
// the frontend's form and the tests can rely on one shape.

export const FOLDER_SOURCES = [
  "fixed",
  "site",
  "role",
  "tenant",
  "platform",
  "cluster",
] as const;
export type FolderSource = (typeof FOLDER_SOURCES)[number];

export const MISSING_ACTIONS = ["keep", "tag", "delete"] as const;
export type MissingAction = (typeof MISSING_ACTIONS)[number];

export const TAG_MATCHES = ["any", "all"] as const;
export type TagMatch = (typeof TAG_MATCHES)[number];

export const AUTH_TYPES = ["none", "credential"] as const;
export type ImportAuthType = (typeof AUTH_TYPES)[number];

export interface SyncConfig {
  netboxUrl: string;
  /** A PEM bundle to trust for a NetBox behind a private CA. */
  caCert: string;
  devices: boolean;
  virtualMachines: boolean;
  /** IPAM IP addresses, each one its own host. */
  ipAddresses: boolean;
  /** NetBox tag slugs an object must carry. Empty syncs everything. */
  tags: string[];
  tagMatch: TagMatch;
  excludeTags: string[];
  /** NetBox status values, like "active". Empty allows every status. */
  statuses: string[];
  username: string;
  port: number;
  authType: ImportAuthType;
  credentialId: number | null;
  folderSource: FolderSource;
  folder: string;
  /** Custom fields that override the port and username per object. */
  portCustomField: string;
  usernameCustomField: string;
  copyNetboxTags: boolean;
  /** Added to every synced host, so they are easy to find. Empty for none. */
  syncTag: string;
  syncNotes: boolean;
  /** Link an unlinked host with the same address instead of adding another. */
  adoptExisting: boolean;
  missingAction: MissingAction;
  /**
   * Delete a host once it has been missing from NetBox (or the filter) for
   * removeAfterDays. Until then missingAction applies. 0 deletes right away.
   */
  autoRemove: boolean;
  removeAfterDays: number;
  autoSync: boolean;
  intervalMinutes: number;
}

export const MISSING_TAG = "netbox-missing";
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
export const MAX_REMOVE_AFTER_DAYS = 365;

export const DEFAULT_CONFIG: SyncConfig = {
  netboxUrl: "",
  caCert: "",
  devices: true,
  virtualMachines: true,
  ipAddresses: false,
  tags: [],
  tagMatch: "any",
  excludeTags: [],
  statuses: ["active"],
  username: "root",
  port: 22,
  authType: "none",
  credentialId: null,
  folderSource: "site",
  folder: "NetBox",
  portCustomField: "",
  usernameCustomField: "",
  copyNetboxTags: true,
  syncTag: "netbox",
  syncNotes: true,
  adoptExisting: true,
  missingAction: "tag",
  autoRemove: false,
  removeAfterDays: 7,
  autoSync: false,
  intervalMinutes: 60,
};

export type ConfigErrors = Partial<Record<keyof SyncConfig, string>>;

function cleanList(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function str(value: unknown, fallback: string, max = 255): string {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function oneOf<T extends string>(
  value: unknown,
  options: readonly T[],
  fallback: T,
): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

/**
 * Reads a stored or submitted config, filling defaults for anything missing
 * or of the wrong type. Never throws: validateConfig reports what is wrong.
 */
export function normalizeConfig(input: unknown): SyncConfig {
  const raw =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const d = DEFAULT_CONFIG;
  const port = Number(raw.port);
  const interval = Number(raw.intervalMinutes);
  const credentialId = Number(raw.credentialId);
  return {
    netboxUrl: str(raw.netboxUrl, d.netboxUrl, 2048).replace(/\/+$/, ""),
    caCert: str(raw.caCert, d.caCert, 65536),
    devices: bool(raw.devices, d.devices),
    virtualMachines: bool(raw.virtualMachines, d.virtualMachines),
    ipAddresses: bool(raw.ipAddresses, d.ipAddresses),
    tags: raw.tags === undefined ? d.tags : cleanList(raw.tags),
    tagMatch: oneOf(raw.tagMatch, TAG_MATCHES, d.tagMatch),
    excludeTags:
      raw.excludeTags === undefined
        ? d.excludeTags
        : cleanList(raw.excludeTags),
    statuses: raw.statuses === undefined ? d.statuses : cleanList(raw.statuses),
    username: str(raw.username, d.username),
    port: Number.isFinite(port) ? Math.trunc(port) : d.port,
    authType: oneOf(raw.authType, AUTH_TYPES, d.authType),
    credentialId:
      Number.isInteger(credentialId) && credentialId > 0 ? credentialId : null,
    folderSource: oneOf(raw.folderSource, FOLDER_SOURCES, d.folderSource),
    folder: str(raw.folder, d.folder),
    portCustomField: str(raw.portCustomField, d.portCustomField),
    usernameCustomField: str(raw.usernameCustomField, d.usernameCustomField),
    copyNetboxTags: bool(raw.copyNetboxTags, d.copyNetboxTags),
    syncTag: str(raw.syncTag, d.syncTag).replace(/,/g, ""),
    syncNotes: bool(raw.syncNotes, d.syncNotes),
    adoptExisting: bool(raw.adoptExisting, d.adoptExisting),
    missingAction: oneOf(raw.missingAction, MISSING_ACTIONS, d.missingAction),
    autoRemove: bool(raw.autoRemove, d.autoRemove),
    removeAfterDays: Number.isFinite(Number(raw.removeAfterDays))
      ? Math.trunc(Number(raw.removeAfterDays))
      : d.removeAfterDays,
    autoSync: bool(raw.autoSync, d.autoSync),
    intervalMinutes: Number.isFinite(interval)
      ? Math.trunc(interval)
      : d.intervalMinutes,
  };
}

/** Field to error code. The frontend turns codes into text. */
export function validateConfig(config: SyncConfig): ConfigErrors {
  const errors: ConfigErrors = {};
  let url: URL | null = null;
  try {
    url = new URL(config.netboxUrl);
  } catch {
    url = null;
  }
  if (
    !url ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    errors.netboxUrl = "invalidUrl";
  }
  if (!config.devices && !config.virtualMachines && !config.ipAddresses) {
    errors.devices = "noObjectTypes";
  }
  if (config.port < 1 || config.port > 65535) errors.port = "invalidPort";
  if (config.authType === "credential" && !config.credentialId) {
    errors.credentialId = "credentialRequired";
  }
  if (config.folderSource === "fixed" && !config.folder) {
    errors.folder = "folderRequired";
  }
  if (
    config.intervalMinutes < MIN_INTERVAL_MINUTES ||
    config.intervalMinutes > MAX_INTERVAL_MINUTES
  ) {
    errors.intervalMinutes = "invalidInterval";
  }
  if (
    config.removeAfterDays < 0 ||
    config.removeAfterDays > MAX_REMOVE_AFTER_DAYS
  ) {
    errors.removeAfterDays = "invalidRemoveAfter";
  }
  if (config.caCert && !config.caCert.includes("-----BEGIN CERTIFICATE-----")) {
    errors.caCert = "invalidCertificate";
  }
  return errors;
}
