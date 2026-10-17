<div align="center">

<h1>NetBox Sync for Termix</h1>

<p>Keep Termix hosts in sync with the devices and virtual machines in NetBox, filtered by tags.</p>

</div>

<br />

## Overview

A [Termix](https://github.com/Termix-SSH/Termix) plugin that imports devices and virtual machines from [NetBox](https://netboxlabs.com/oss/netbox/) as SSH hosts and keeps them up to date. You choose what to sync with NetBox tags, and every sync adds, updates and tags or removes hosts so Termix matches NetBox.

<br />

## Features

- Sync NetBox devices and virtual machines into Termix hosts
- Filter by tags, matching any or all of them, skip objects with excluded tags, and filter by status
- Preview what a sync would change before running it
- Sync by hand or on a schedule
- Updates name, address, folder, notes and tags, and keeps tags you add in Termix
- Hosts that leave NetBox are kept, tagged `netbox-missing` or deleted
- Folders from the site, role, tenant, platform or cluster
- SSH port and username from NetBox custom fields
- Links hosts you already have instead of adding them twice
- Works with NetBox on a private network and with a private CA

How to use it is in [docs/index.md](docs/index.md).

<br />

## Install

Releases are built by the Release workflow as `netbox-sync-<version>.tmxplug`. In Termix, turn on Plugin developer mode under Settings, General, then install the file from Plugins, Install from file.

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

| File                             | What it does                                                   |
| -------------------------------- | -------------------------------------------------------------- |
| `src/backend/netbox.ts`          | NetBox REST client: auth, paging, tag and status filters       |
| `src/backend/mapping.ts`         | Turns a NetBox object into host fields, merges tags            |
| `src/backend/sync.ts`            | The sync: create, update, link, tag or delete, and the dry run |
| `src/backend/store.ts`           | The settings and link tables                                   |
| `src/backend/routes.ts`          | `/plugin-api/netbox-sync/` routes                              |
| `src/backend/index.ts`           | Activation and the auto sync scheduler                         |
| `src/frontend/NetboxSyncTab.tsx` | The NetBox Sync tab                                            |

<br />

## License

Apache License 2.0. See [LICENSE](LICENSE).
