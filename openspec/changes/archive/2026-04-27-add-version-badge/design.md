## Context

5 HTML pages (index, admin, success, admin-login, admin-setup) share `app.js` and `style.css`. None display version info. The `/health` endpoint returns only `{ status: "ok" }`. `package.json` has `version: "1.4.1"` but it is never read at runtime.

Pages with nav: index, admin, success. Pages without nav: admin-login, admin-setup.

## Goals / Non-Goals

**Goals:**
- Show proxy version, git commit hash, and build time on all 5 pages with minimal visual footprint
- Expose version info in `/health` and `/ready` for infrastructure probes
- Single source of truth: `package.json` version + git commit + build timestamp

**Non-Goals:**
- Showing upstream protocol versions (pluginVersion, ideVersion) in the UI
- Version auto-update or check-for-update functionality

## Decisions

### 1. Version placement: nav right-side / h1 right-side

**Decision**: Pages with `.nav` display version at nav right end. Pages without nav display version next to `<h1>`.

**Rationale**: Reuses existing nav space — no extra vertical space. For nav-less pages, h1 right-side is the lightest option that doesn't require adding a nav bar.

**Alternatives considered**:
- Footer on all pages: adds vertical space, container-bound
- Only on admin page: users need version on login pages too for support

### 2. Version source: `/health` endpoint + `src/version.ts`

**Decision**: Frontend fetches `/health` to get version info. Server exposes version via `src/version.ts` which is auto-generated from `package.json` by the `generate-version` script (runs before `build` and `dev`). The script reads `package.json` version, runs `git rev-parse --short HEAD` for commit hash, and captures build timestamp. Exports: `APP_VERSION`, `GIT_COMMIT`, `BUILD_TIME`.

**Rationale**: Reuses existing endpoint — no new route needed. `/health` is unauthenticated so works on all pages including login. Also benefits ops teams who already probe `/health`. Auto-generated `version.ts` avoids runtime `package.json` reads (which break in `dist/` builds since `package.json` isn't copied). Git commit and build time provide precise deployment identification beyond just version number.

**Alternatives considered**:
- Server-side HTML injection: zero-latency but requires template processing for static files
- Separate `/version` endpoint: unnecessary route proliferation
- Runtime `require('../../package.json')`: breaks when running from `dist/` (no `package.json` there)

### 3. Graceful degradation

**Decision**: If `/health` fetch fails, version placeholder is silently hidden — no error shown.

**Rationale**: Version display is non-critical. A failed fetch (e.g., server down during login) should not break the page.

## Risks / Trade-offs

- [Version fetch adds one HTTP request per page load] → Mitigation: `/health` is lightweight and unauthenticated; browser may cache via service worker in future
- [`package.json` version + git commit + build time baked into `version.ts` at build time] → Mitigation: `generate-version` script runs before both `build` and `dev`; info always in sync. If not in a git repo, `GIT_COMMIT` falls back to "unknown" and the UI omits it.
