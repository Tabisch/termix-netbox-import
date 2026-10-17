import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  DEFAULT_CONFIG,
  normalizeConfig,
  validateConfig,
  type SyncConfig,
} from "./config.js";
import { NetboxError } from "./netbox.js";
import type { Store } from "./store.js";
import {
  createClient,
  SyncError,
  TOKEN_SECRET,
  type createSyncer,
} from "./sync.js";

type Syncer = ReturnType<typeof createSyncer>;

const MAX_TOKEN_LENGTH = 512;

/**
 * Answers a known failure with a 4xx, so it does not count against the
 * plugin's error budget. NetBox being down is not this plugin failing:
 * that is a 424 with a code the frontend explains.
 */
function sendFailure(res: Response, error: unknown): boolean {
  if (error instanceof SyncError) {
    res
      .status(error.code === "alreadyRunning" ? 409 : 400)
      .json({ error: error.message, code: error.code });
    return true;
  }
  if (error instanceof NetboxError) {
    res
      .status(424)
      .json({ error: error.message, code: error.code, detail: error.detail });
    return true;
  }
  return false;
}

function readToken(value: unknown): string | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return "invalid";
  const token = value.trim();
  if (!token || token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) {
    return "invalid";
  }
  return token;
}

export function registerRoutes(
  router: Router,
  ctx: PluginContext,
  store: Store,
  syncer: Syncer,
): void {
  router.use(ctx.rbac.require("use") as never);

  const actor = () => ctx.currentActor() as string;

  async function listCredentials(): Promise<
    Array<{ id: number; name: string }>
  > {
    try {
      const keys = await ctx.credentials.listSshKeys();
      return keys.map((key) => ({ id: key.id, name: key.name }));
    } catch {
      // Without the core credentials.view permission there is nothing to
      // pick from, which is fine: the form falls back to no credential.
      return [];
    }
  }

  /**
   * @openapi
   * /plugin-api/netbox-sync/config:
   *   get:
   *     summary: The signed-in user's NetBox sync settings and last sync
   *     tags:
   *       - NetBox Sync
   *     responses:
   *       200:
   *         description: Settings (without the token), whether a token is saved, the last sync and the SSH key credentials to pick from
   */
  router.get("/config", async (_req: Request, res: Response) => {
    const stored = await store.getConfig(actor());
    const hasToken = !!(await ctx.secrets.get(TOKEN_SECRET));
    res.json({
      configured: !!stored,
      config: stored?.config ?? DEFAULT_CONFIG,
      hasToken,
      lastSyncAt: stored?.lastSyncAt ?? null,
      lastResult: stored?.lastResult ?? null,
      running: syncer.isRunning(actor()),
      credentials: await listCredentials(),
    });
  });

  /**
   * @openapi
   * /plugin-api/netbox-sync/config:
   *   put:
   *     summary: Save the signed-in user's NetBox sync settings
   *     tags:
   *       - NetBox Sync
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               config:
   *                 type: object
   *                 description: The sync settings. Missing fields take their defaults.
   *               token:
   *                 type: string
   *                 description: A new NetBox API token. Leave out to keep the saved one.
   *               clearToken:
   *                 type: boolean
   *     responses:
   *       200:
   *         description: Saved
   *       400:
   *         description: Invalid settings, with an error code per field
   */
  router.put("/config", async (req: Request, res: Response) => {
    const config = normalizeConfig(req.body?.config);
    const errors: Record<string, string> = { ...validateConfig(config) };
    const token = readToken(req.body?.token);
    if (token === "invalid") errors.token = "invalidToken";
    const hasToken =
      token !== null ||
      (!req.body?.clearToken && !!(await ctx.secrets.get(TOKEN_SECRET)));
    if (!hasToken) errors.token = errors.token ?? "tokenRequired";
    if (Object.keys(errors).length) {
      return res.status(400).json({ error: "Invalid settings", errors });
    }
    if (req.body?.clearToken) await ctx.secrets.delete(TOKEN_SECRET);
    if (typeof token === "string") await ctx.secrets.set(TOKEN_SECRET, token);
    await store.saveConfig(actor(), config);
    res.json({ success: true, config });
  });

  /**
   * @openapi
   * /plugin-api/netbox-sync/config:
   *   delete:
   *     summary: Forget the signed-in user's NetBox settings, token and links
   *     description: Synced hosts stay in Termix but are no longer updated.
   *     tags:
   *       - NetBox Sync
   *     responses:
   *       200:
   *         description: Removed
   */
  router.delete("/config", async (_req: Request, res: Response) => {
    await store.deleteConfig(actor());
    await ctx.secrets.delete(TOKEN_SECRET);
    res.json({ success: true });
  });

  /**
   * @openapi
   * /plugin-api/netbox-sync/test:
   *   post:
   *     summary: Check that NetBox answers with the given or saved URL and token
   *     tags:
   *       - NetBox Sync
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               config:
   *                 type: object
   *                 description: Unsaved settings to test. Leave out to test the saved ones.
   *               token:
   *                 type: string
   *                 description: An unsaved token. Leave out to use the saved one.
   *     responses:
   *       200:
   *         description: NetBox answered, with its version
   *       400:
   *         description: Invalid URL or no token
   *       424:
   *         description: NetBox could not be reached or refused the token
   */
  router.post("/test", async (req: Request, res: Response) => {
    let config: SyncConfig;
    if (req.body?.config) {
      config = normalizeConfig(req.body.config);
    } else {
      const stored = await store.getConfig(actor());
      if (!stored) {
        return res
          .status(400)
          .json({ error: "NetBox is not set up", code: "notConfigured" });
      }
      config = stored.config;
    }
    const urlError = validateConfig(config).netboxUrl;
    if (urlError) {
      return res.status(400).json({ error: "Invalid URL", code: urlError });
    }
    const submitted = readToken(req.body?.token);
    if (submitted === "invalid") {
      return res
        .status(400)
        .json({ error: "Invalid token", code: "invalidToken" });
    }
    const token = submitted ?? (await ctx.secrets.get(TOKEN_SECRET));
    if (!token) {
      return res.status(400).json({ error: "No token", code: "noToken" });
    }
    try {
      const { version } = await createClient(ctx, config, token).status();
      res.json({ ok: true, version });
    } catch (error) {
      if (!sendFailure(res, error)) throw error;
    }
  });

  /**
   * @openapi
   * /plugin-api/netbox-sync/preview:
   *   post:
   *     summary: List what a sync would change, without changing anything
   *     tags:
   *       - NetBox Sync
   *     responses:
   *       200:
   *         description: Counts and one entry per NetBox object and missing host
   *       400:
   *         description: NetBox is not set up or no token is saved
   *       409:
   *         description: A sync is already running
   *       424:
   *         description: NetBox could not be reached or refused the token
   */
  router.post("/preview", async (_req: Request, res: Response) => {
    try {
      res.json(await syncer.sync(actor(), { dryRun: true }));
    } catch (error) {
      if (!sendFailure(res, error)) throw error;
    }
  });

  /**
   * @openapi
   * /plugin-api/netbox-sync/sync:
   *   post:
   *     summary: Sync NetBox into the signed-in user's hosts now
   *     tags:
   *       - NetBox Sync
   *     responses:
   *       200:
   *         description: Counts and one entry per change
   *       400:
   *         description: NetBox is not set up or no token is saved
   *       409:
   *         description: A sync is already running
   *       424:
   *         description: NetBox could not be reached or refused the token
   */
  router.post("/sync", async (_req: Request, res: Response) => {
    try {
      res.json(await syncer.sync(actor()));
    } catch (error) {
      if (!sendFailure(res, error)) throw error;
    }
  });
}
