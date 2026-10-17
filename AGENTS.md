# AGENTS.md

This repo is a [Termix](https://github.com/Termix-SSH/Termix) plugin. These notes are for AI coding tools.

## Read first

Before changing anything, read `node_modules/@termix-ssh/plugin-sdk/PLUGIN-GUIDE.md`. It covers the
manifest, backend, database, frontend, UI, testing, releasing and submitting to the community registry,
and it matches the SDK version installed here. If it is missing, run `npm install`. If it is still missing,
the SDK is older than 1.0.6: run `npm install -D @termix-ssh/plugin-sdk@latest` or read
https://docs.termix.site/develop instead.

If the guide and the SDK's TypeScript types disagree, the types are right.

## Commands

```bash
npm run build        # bundle into dist/
npm test             # run the tests
npm run typecheck    # type check
npm run validate     # check manifest.json, migrations, changelog and docs
npm run migrations   # write migrations after changing src/backend/tables.ts
npm run pack         # write <id>-<version>.tmxplug
npm run format       # format with Prettier
```

`npx termix-plugin dev --server <url> --key <tmx_...>` installs the plugin on a Termix server with
developer mode on and reinstalls it on every save. Don't start it unless the user asks.

## Done means

- `npm test`, `npm run typecheck`, `npm run validate`, `npm run build` and `npm run format:check` pass
- `npx termix-plugin migrations --check` passes
- New UI text is in `locales/en.json`, new routes have an `@openapi` block and a test
- `docs/` and the section below still match what the plugin does
- User facing changes are in `CHANGELOG.md` under the version they ship in

## About this plugin

Keep this section current when the plugin changes: what it does, how it is put together, decisions that
aren't obvious from the code, and anything that has bitten you before.

- What it does: syncs NetBox devices and virtual machines, filtered by tags, statuses and excluded tags,
  into hosts owned by the user who set it up. One config and one token per user.
- Settings live in our own `configs` table (one row per user), not `contributes.settings`, because each
  user has their own NetBox setup and Termix's admin/user settings forms can't express the tag lists and
  per-user token flow. The token is in `ctx.secrets` under `token`, never in the table.
- `links` maps a NetBox object (`kind` + `netboxId`) to a host id. `hostId` is a plain integer, not
  `refHost()`: a link whose host is gone is dropped at the start of the next sync, and the object gets a
  new host.
- `links.managedTags` are the tags the last sync wrote. The next sync replaces them and keeps every other
  tag, so tags users add by hand survive.
- NetBox ANDs repeated `tag` filters, so "any" runs one query per tag and merges by id.
- NetBox is almost always private: `ctx.fetch` gets `allowPrivateHosts` with only the configured host.
  That is why the `use` permission is admin only by default.
- NetBox failures answer 424 with a `code`, never a 5xx, so a down NetBox can't use up the error budget.
- Auto sync: `ctx.schedule.every(60s)` looks for due users and runs them one by one with `ctx.asUser`
  (`users:impersonate`). A failed sync still records `lastSyncAt`, so it retries after the interval.
- Only name, ip, folder, notes and tags are updated on existing hosts (plus port/username when a custom
  field names them). Auth is set once on create so users can change it.
- Install from GitHub: the repo is its own custom registry. `.github/workflows/registry.yml` runs
  `scripts/build-registry.mjs` after each Release run and pushes `index.json` to the `registry` branch.
  It lists only releases whose `.tmxplug.sig` verifies against the key in `TERMIX_PLUGIN_SIGNING_KEY`, and
  derives the index's `publicKey` from that same secret. Changing the secret breaks every install.
  The shared release workflow skipped signing on the first release (`HAS_SIGNING_KEY: false`), so the
  Registry workflow runs the script with `--sign-missing`: it signs a release without a `.sig` and attaches it.
