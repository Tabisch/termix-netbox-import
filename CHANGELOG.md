# Changelog

## 1.2.0

### Added

- Remove old entries automatically: a host that has been gone from NetBox, or out of the filter, for a set number of days is deleted by the next sync. Until then it is kept or tagged `netbox-missing`

## 1.1.0

### Added

- Sync IPAM IP addresses as hosts, filtered by the same tags and statuses. A host is named after the address's DNS name, then the device or VM it is assigned to, then the address. Addresses that are already a synced device's or VM's primary IP are skipped

### Fixed

- Tags can be given by their NetBox name as well as their slug
- A tag NetBox doesn't have is named in the error instead of "NetBox answered with an error"
- NetBox's own error message is shown when it refuses a request

## 1.0.0

### Added

- Sync NetBox devices and virtual machines into Termix hosts
- Filter by tags (any or all), excluded tags and status
- Preview a sync before running it
- Sync by hand or automatically on a schedule
- Keep, tag or delete hosts that leave NetBox
- Folders from site, role, tenant, platform or cluster
- SSH port and username from NetBox custom fields
- Link existing hosts with the same address
