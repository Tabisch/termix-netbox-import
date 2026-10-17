# Changelog

## 1.0.1

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
