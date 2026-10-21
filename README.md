<div align="center">

<h1>NetBox Sync for Termix</h1>

<p>Keep Termix hosts in sync with the devices and virtual machines in NetBox, filtered by tags.</p>

</div>

<br />

## Overview

A [Termix](https://github.com/Termix-SSH/Termix) plugin that imports devices and virtual machines from [NetBox](https://netboxlabs.com/oss/netbox/) as SSH hosts and keeps them up to date. You choose what to sync with NetBox tags, and every sync adds, updates and tags or removes hosts so Termix matches NetBox.

<br />

## Features

- Sync NetBox devices, virtual machines and IPAM IP addresses into Termix hosts
- Filter by tags, matching any or all of them, skip objects with excluded tags, and filter by status
- Preview what a sync would change before running it
- Sync by hand or on a schedule
- Updates name, address, folder, notes and tags, and keeps tags you add in Termix
- Hosts that leave NetBox are kept, tagged `netbox-missing` or deleted, right away or after a grace period
- Folders from the site, role, tenant, platform or cluster
- SSH port and username from NetBox custom fields
- Credentials from NetBox tags: tag a device `dashlane:<id>` or `termix:localsshkey` and the host connects with the matching Termix credential
- Links hosts you already have instead of adding them twice
- Works with NetBox on a private network and with a private CA

How to use it is in [docs/index.md](docs/index.md).

<br />

## Credentials from NetBox tags

Pick the credential a host connects with in NetBox. Put a tag on the device, VM or IP address whose name starts with one of the credential tag prefixes, and the sync gives the host the Termix credential that carries exactly the same tag. It works for new and existing hosts, on every sync.

| NetBox tag               | Credential the host gets                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dashlane:<Dashlane id>` | A login the [Dashlane plugin](https://github.com/Tabisch/termix-dashlane-secrets) imported. Its tab shows each credential's tag, and the id never changes |
| `termix:localsshkey`     | Each user's own credential tagged `termix:localsshkey` in their Termix, so one NetBox tag gives everyone their own key. Any name after `termix:` works    |

- If none of the user's credentials has a `termix:` tag, the sync makes one: a password credential named after the rest of the tag, with an empty username and password and the tag, so the user fills it in once for every host with that tag. Turn off Create credentials for termix: tags to skip that.
- Otherwise, if none of the user's credentials has the tag, the host gets password authentication with an empty username and password to fill in. Turn off Password login when no credential matches to report it as an error and keep the host's authentication instead.
- Removing the tag in NetBox leaves the host's authentication as it is.
- The prefixes are a list in the tab, `dashlane:` and `termix:` to start with. Remove them all to turn the feature off.
- Looking credentials up needs Termix's View credentials permission.

More in [docs/index.md](docs/index.md#credentials-from-netbox-tags).

<br />

## Install from GitHub

This plugin is published in [Tabisch/termix-registry](https://github.com/Tabisch/termix-registry), one Termix plugin registry for all of Tabisch's plugins. Add it once and Termix installs the plugin straight from the GitHub releases and offers every new version under Updates.

1. In Termix, open Plugins, Registries and press Add registry.
2. Paste this URL and press Check:

   ```
   https://raw.githubusercontent.com/Tabisch/termix-registry/registry/index.json
   ```

3. Check that the key id Termix shows matches the one in the latest [Registry workflow run](https://github.com/Tabisch/termix-registry/actions/workflows/registry.yml) summary, then press Trust and add.
4. Open Browse, find NetBox Sync and press Install. Approve the capabilities it asks for.

You can also download `netbox-sync-<version>.tmxplug` from [Releases](https://github.com/Tabisch/termix-netbox-import/releases) and install it from Plugins, Install from file, with Plugin developer mode on under Settings, General. A plugin installed that way doesn't update on its own.

If you added this repo's own registry (`https://raw.githubusercontent.com/Tabisch/termix-netbox-import/registry/index.json`) before, add the one above, check that NetBox Sync shows up from it, then remove the old one. The old registry no longer gets new versions.

### Releasing (maintainers)

Make a `dev-X.Y.Z` branch from `main`, then run the Release workflow from it in Actions. It builds the `.tmxplug`, publishes the GitHub release and merges into `main`. [Tabisch/termix-registry](https://github.com/Tabisch/termix-registry) picks up the release within the hour, signs it with its own key and lists it.

<br />

## Development

You need Node 22 or newer and a Termix server (26.10 or newer) you are an admin on.

```bash
npm install
npm test             # backend and frontend tests
npm run typecheck
npm run validate     # manifest, migrations, changelog and docs
npm run build        # bundle into dist/
npm run pack         # write netbox-sync-<version>.tmxplug
```

To install it on a server and reinstall on every save, make an API key under Settings, API keys and run:

```bash
npx termix-plugin dev --server http://localhost:30001 --key tmx_your_key
```

### How it is put together

| File                              | What it does                                                         |
| --------------------------------- | -------------------------------------------------------------------- |
| `src/backend/netbox.ts`           | NetBox REST client: auth, paging, tag and status filters             |
| `src/backend/mapping.ts`          | Turns a NetBox object into host fields, merges tags                  |
| `src/backend/sync.ts`             | The sync: create, update, link, tag or delete, and the dry run       |
| `src/backend/core-credentials.ts` | Reads the user's Termix credentials and their tags, makes empty ones |
| `src/backend/store.ts`            | The settings and link tables                                         |
| `src/backend/routes.ts`           | `/plugin-api/netbox-sync/` routes                                    |
| `src/backend/index.ts`            | Activation and the auto sync scheduler                               |
| `src/frontend/NetboxSyncTab.tsx`  | The NetBox Sync tab                                                  |

<br />

## License

Apache License 2.0. See [LICENSE](LICENSE).
