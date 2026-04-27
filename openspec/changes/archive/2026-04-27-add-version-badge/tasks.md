## 1. Backend: Version in /health and /ready

- [x] 1.1 Generate `src/version.ts` from `package.json` at build/dev time via `generate-version` script
- [x] 1.2 Add `version` field to `/health` endpoint response (import `APP_VERSION` from `./version`)
- [x] 1.3 Add `version` field to `/ready` endpoint response (both ok and degraded states)

## 2. Frontend: Shared version logic

- [x] 2.1 Add `loadAndShowVersion()` function to `app.js` that fetches `/health` and populates version placeholders
- [x] 2.2 Add `.version-badge` CSS styles to `style.css`
- [x] 2.3 Make `.nav` use flex layout with space-between for right-side version alignment

## 3. Frontend: HTML placeholders

- [x] 3.1 Add version placeholder to `index.html` nav
- [x] 3.2 Add version placeholder to `admin.html` nav
- [x] 3.3 Add version placeholder to `success.html` nav
- [x] 3.4 Add version placeholder to `admin-login.html` (next to h1)
- [x] 3.5 Add version placeholder to `admin-setup.html` (next to h1)

## 4. Verification

- [x] 4.1 `npx tsc --noEmit` passes
- [x] 4.2 `pnpm test` passes
- [x] 4.3 `/health` and `/ready` return version field
