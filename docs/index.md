NetBox Sync keeps your Termix hosts in sync with the devices and virtual machines in [NetBox](https://netboxlabs.com/oss/netbox/). You pick which objects to sync by their NetBox tags, and every sync adds new hosts, updates changed ones and handles the ones that left NetBox.

## Turn it on

1. Install NetBox Sync. In Plugins, Registries, press Add registry, paste `https://raw.githubusercontent.com/Tabisch/termix-netbox-import/registry/index.json` and press Trust and add. Then find NetBox Sync under Browse and press Install. New versions show up under Updates.
2. Open the NetBox Sync tab from the sidebar. It needs the Use NetBox Sync permission, which only admins get by default. Give it to other roles under Roles if they should sync too.
3. In NetBox, make an API token under your user, API Tokens. A read only token is enough.
4. In the Connection section, enter the NetBox URL and paste the token. Press Test connection to check them, then Save.

Each user syncs into hosts they own, with their own settings and token. The token is stored encrypted and is never shown again.

## Pick what to sync

In What to sync:

- Turn Devices, Virtual machines and IP addresses on or off.
- Add the tags to sync under Tags, by their NetBox name or slug. With Any tag, an object with at least one of them is synced. With All tags, only objects with every one of them are. Leave Tags empty to sync every object.
- Objects with a tag under Skip objects with these tags are never synced.
- Statuses limits the sync to objects with that NetBox status. It is `active` to start with. Leave it empty for every status.

Devices and virtual machines without a primary IP in NetBox are skipped.

IP addresses are IPAM's IP Addresses, each synced as its own host, for addresses you tag directly rather than through a device. A host is named after the address's DNS name, then the device or VM the address is assigned to, then the address itself. An address that is already the primary IP of a device or VM being synced is skipped, so the same machine isn't added twice. The folder can come from the address's tenant or role.

## New hosts

New hosts get the username, SSH port and authentication set under New hosts. Pick Saved SSH key to connect with one of your SSH key credentials, or Ask when connecting. If that key is deleted later, new hosts are skipped and the sync result asks you to pick another one.

Folder puts each host in a folder named after its site, role, tenant, platform or cluster, or in one folder for all of them. Folder name is used when the object has no value for the folder you picked.

### Credentials from NetBox tags

A NetBox tag can pick the credential a host connects with. Tag the device, VM or IP address in NetBox with a tag whose name starts with Credential tag prefix (`dashlane:` to start with), and the host gets the Termix credential that carries a tag with exactly that name. Case doesn't matter. This works for any kind of credential, password ones included.

The [Dashlane plugin](https://github.com/Tabisch/termix-dashlane-secrets) tags every login it imports as `dashlane:<Dashlane id>`, like `dashlane:8A1B2C3D-0000-4000-8000-1234567890AB`, and shows the tag in its tab. That id never changes, so the link holds when the login is edited or imported again. Make a NetBox tag with that name and put it on the devices that use the login.

- The tagged credential wins over the one under New hosts, and is also set on hosts that already exist, every sync. Changing the host's authentication in Termix only lasts until the next sync while the tag is on the object.
- Removing the tag in NetBox leaves the host's authentication as it is.
- An object with several such tags uses the first one.
- A tag that matches no credential is listed in the sync result, and the host keeps its authentication.
- Your own credentials are picked before ones shared with you. Looking them up needs Termix's View credentials permission.

Leave Credential tag prefix empty to turn this off.

If your NetBox has custom fields with the SSH port or username, enter their names under Port custom field and Username custom field. A value there wins over the defaults and is kept in sync.

## Keeping hosts in sync

Every sync updates the name, address, folder, notes and tags of the hosts it made. Authentication (unless a [credential tag](#credentials-from-netbox-tags) sets it), and the port and username unless they come from a custom field, are only set when a host is added, so you can change them in Termix.

- Copy NetBox tags gives each host its NetBox tags. Tags you add in Termix are kept. A tag removed in NetBox is removed from the host.
- Extra tag is added to every synced host, `netbox` to start with.
- Write notes puts the NetBox link and description in the host's notes.
- Link existing hosts updates a host you already have with the same address instead of adding a second one.

When an object leaves NetBox or no longer matches the filter, the host is kept, tagged `netbox-missing`, or deleted, as set under When an object leaves NetBox or the filter. A tagged host loses the tag when the object comes back.

Turn on Remove old entries automatically to clean up after a grace period. A host is then kept or tagged as above at first, and deleted by the first sync, scheduled or by hand, once it has been missing for Remove after (days). The days count from the first sync that found it missing, and start over if the object comes back. With 0 it is deleted on that first sync. Before a sync that deletes hosts, Termix asks you to confirm.

If you delete a synced host in Termix, the next sync adds it again while it is still in NetBox. Remove its tag in NetBox, or add a tag under Skip objects with these tags, to stop that.

## Sync

- Preview lists what a sync would change without changing anything.
- Sync now runs a sync and lists what changed.
- Turn on Sync automatically under Schedule to sync in the background, every 5 minutes to every 7 days.

The last result shows at the bottom of the tab. Disconnect removes your settings and token. Synced hosts stay in Termix but are no longer updated.

## NetBox on a private network

Termix only lets the plugin reach the host in your NetBox URL, nothing else on your network. If NetBox uses a certificate from your own CA, paste the CA certificate as PEM under CA certificate. Tokens from NetBox 4.5 and newer, which start with `nbt_`, and older tokens both work.
