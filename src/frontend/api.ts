import type { SyncConfig } from "../backend/config";
import type { PlanEntry, SyncResult } from "../backend/sync";

export type { PlanEntry, SyncConfig, SyncResult };

export interface ConfigResponse {
  configured: boolean;
  config: SyncConfig;
  hasToken: boolean;
  lastSyncAt: string | null;
  lastResult: SyncResult | null;
  running: boolean;
  credentials: Array<{ id: number; name: string }>;
}

export interface ApiFailure {
  code: string;
  message: string | null;
  fieldErrors: Record<string, string>;
}

/** The code, message and field errors out of an axios style error. */
export function readFailure(error: unknown): ApiFailure {
  const data = (error as { response?: { data?: unknown } })?.response?.data as
    { code?: unknown; error?: unknown; errors?: unknown } | undefined;
  const fieldErrors =
    data?.errors && typeof data.errors === "object"
      ? (data.errors as Record<string, string>)
      : {};
  return {
    code: typeof data?.code === "string" ? data.code : "unknown",
    message: typeof data?.error === "string" ? data.error : null,
    fieldErrors,
  };
}
