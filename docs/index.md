NetBox Sync keeps your Termix hosts in sync with the devices and virtual machines in [NetBox](https://netboxlabs.com/oss/netbox/). You pick which objects to sync by their NetBox tags, and every sync adds new hosts, updates changed ones and handles the ones that left NetBox.

## Turn it on

1. Install NetBox Sync. In Plugins, Registries, press Add registry, paste `https://raw.githubusercontent.com/Tabisch/termix-netbox-import/registry/index.json` and press Trust and add. Then find NetBox Sync under Browse and press Install. New versions show up under Updates.
2. Open the NetBox Sync tab from the sidebar. It needs the Use NetBox Sync permission, which only admins get by default. Give it to other roles under Roles if they should sync too.
3. In NetBox, make an API token under your user, API Tokens. A read only token is enough.
4. In the Connection section, enter the NetBox URL and paste the token. Press Test connection to check them, then Save.

Each user syncs into hosts they own, with their own settings and token. The token is stored encrypted and is never shown again.

## Pick what to sync

In What to sync:

- Turn Devices and Virtual machines on or off.
- Add the tags to sync under Tags, by their NetBox name or slug. With Any tag, an object with at least one of them is synced. With All tags, only objects with every one of them are. Leave Tags empty to sync every object.
- Objects with a tag under Skip objects with these tags are never synced.
- Statuses limits the sync to objects with that NetBox status. It is `active` to start with. Leave it empty for every status.

Objects without a primary IP in NetBox are skipped.

## New hosts

New hosts get the username, SSH port and authentication set under New hosts. Pick Saved SSH key to connect with one of your SSH key credentials, or Ask when connecting.

Folder puts each host in a folder named after its site, role, tenant, platform or cluster, or in one folder for all of them. Folder name is used when the object has no value for the folder you picked.

If your NetBox has custom fields with the SSH port or username, enter their names under Port custom field and Username custom field. A value there wins over the defaults and is kept in sync.

## Keeping hosts in sync

Every sync updates the name, address, folder, notes and tags of the hosts it made. Authentication, and the port and username unless they come from a custom field, are only set when a host is added, so you can change them in Termix.

- Copy NetBox tags gives each host its NetBox tags. Tags you add in Termix are kept. A tag removed in NetBox is removed from the host.
- Extra tag is added to every synced host, `netbox` to start with.
- Write notes puts the NetBox link and description in the host's notes.
- Link existing hosts updates a host you already have with the same address instead of adding a second one.

When an object leaves NetBox or no longer matches the filter, the host is kept, tagged `netbox-missing`, or deleted, as set under When an object leaves NetBox or the filter. A tagged host loses the tag when the object comes back. Before a sync that deletes hosts, Termix asks you to confirm.

If you delete a synced host in Termix, the next sync adds it again while it is still in NetBox. Remove its tag in NetBox, or add a tag under Skip objects with these tags, to stop that.

## Sync

- Preview lists what a sync would change without changing anything.
- Sync now runs a sync and lists what changed.
- Turn on Sync automatically under Schedule to sync in the background, every 5 minutes to every 7 days.

The last result shows at the bottom of the tab. Disconnect removes your settings and token. Synced hosts stay in Termix but are no longer updated.

## NetBox on a private network

Termix only lets the plugin reach the host in your NetBox URL, nothing else on your network. If NetBox uses a certificate from your own CA, paste the CA certificate as PEM under CA certificate. Tokens from NetBox 4.5 and newer, which start with `nbt_`, and older tokens both work.
