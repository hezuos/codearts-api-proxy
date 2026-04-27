## Why

All 5 HTML pages lack any version information. Users and operators cannot tell which version of the proxy they are interacting with. The `/health` endpoint also omits version, making it harder to identify deployed versions via infrastructure probes.

## What Changes

- Add `version`, `gitCommit`, `buildTime` fields to `/health` and `/ready` endpoints, sourced from `package.json` + git + build timestamp
- Display version badge on all HTML pages: in nav right-side for pages with nav, next to h1 for pages without nav
- Badge shows "v{version} · {commit} · {buildTime}", version info fetched from `/health` at page load

## Capabilities

### New Capabilities
- `version-display`: Show proxy version on all pages and in `/health` API response

### Modified Capabilities
- `health-probes`: Add `version` field to `/health` response

## Impact

- `src/version.ts`: Auto-generated from `package.json` + git + timestamp by `generate-version` script
- `package.json`: New `generate-version` script, `build`/`dev` scripts updated
- `src/index.ts`: `/health` and `/ready` endpoints return version info via `APP_VERSION`, `GIT_COMMIT`, `BUILD_TIME`
- `public/app.js`: New `loadAndShowVersion()` function
- `public/style.css`: `.nav` flex layout + `.version-badge` style
- All 5 HTML files: Add version placeholder element
