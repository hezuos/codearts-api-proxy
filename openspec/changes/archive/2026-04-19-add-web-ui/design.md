## Context

The CodeArts Agent Proxy currently provides only API endpoints for programmatic access. Users interact via OpenAI SDK or HTTP clients, with no visual interface for account management or status monitoring. The OAuth login flow redirects to Huawei Cloud but provides no feedback after successful authentication. There is no administrative oversight capability for monitoring system health or managing users.

This change introduces a lightweight Web UI layer using static HTML/CSS/JS served directly by Express. The design prioritizes simplicity over feature richness, avoiding frontend build tools and frameworks. Authentication for UI pages uses the same API key mechanism as API calls, stored in an HTTP-only cookie.

## Goals / Non-Goals

**Goals:**

- Provide visual feedback after OAuth login with account information and API key display
- Enable users to view their bound Huawei Cloud accounts and token status
- Allow users to perform account management operations (refresh, unbind, set default) via UI
- Provide administrator authentication and control panel for system oversight
- Support admin password configuration via environment variable or setup page
- Maintain security with HTTP-only, secure cookies and bcrypt password hashing
- Keep implementation simple with no frontend build step or framework dependencies

**Non-Goals:**

- Build a comprehensive dashboard with charts, analytics, or real-time updates
- Implement complex user management workflows (registration, password reset, etc.)
- Support multi-language or internationalization
- Add WebSocket or SSE for real-time status updates
- Create mobile-responsive design beyond basic viewport scaling
- Implement audit logging or detailed activity history

## Decisions

### 1. Use API key as the unified identity token for both API and UI access

The same API key serves as Bearer token for API calls and as cookie value for UI page access. This eliminates the need for a separate session management system and simplifies the authentication model. Users can use their API key interchangeably for programmatic access and UI access.

**Alternative considered**: Separate UI session tokens. Rejected because it adds complexity without clear benefit - the API key already uniquely identifies the user and their bound accounts.

### 2. Store admin password hash in a dedicated JSON file

Admin credentials are stored in `data/admin-config.json` with bcrypt-hashed password. The file is created on first admin setup or when environment variable `ADMIN_PASSWORD` is provided. This follows the existing pattern of JSON file persistence used for `auth-store.json` and `huawei-sessions.json`.

**Alternative considered**: Store in auth-store.json. Rejected to keep admin credentials separate from user data, allowing different backup and access control policies.

### 3. Prioritize environment variable for admin password, with setup page fallback

If `ADMIN_PASSWORD` environment variable is set, it takes precedence and the admin is immediately available. If not set, the system checks for existing `admin-config.json`. If neither exists, accessing `/admin` redirects to `/admin/setup` for initial configuration. This supports both automated deployment (via env var) and interactive setup.

**Alternative considered**: Require setup page on first run. Rejected because it complicates automated deployment scenarios where credentials should be injected via environment.

### 4. Use static HTML files with vanilla JavaScript

UI pages are static HTML files served from `public/` directory. JavaScript uses Fetch API for backend calls. No build tools (webpack, vite) or frameworks (React, Vue). CSS is hand-written with minimal styling. This keeps dependencies minimal and eliminates build complexity.

**Alternative considered**: Use a lightweight framework like Alpine.js or htmx. Rejected because the UI is simple enough that vanilla JS suffices, and adding dependencies contradicts the minimal-overhead goal.

### 5. Implement UI authentication as Express middleware checking cookie

A dedicated middleware `authenticateUiCookie` checks for `auth_key` cookie, validates it against the API key store, and attaches user context to the request. This mirrors the existing `authenticateApiKey` middleware but reads from cookies instead of Authorization header.

**Alternative considered**: Share a single middleware for both API and UI. Rejected because the extraction logic differs (header vs cookie), and keeping them separate improves clarity and allows different error handling (401 for API, redirect for UI).

### 6. Display API keys with masking by default, reveal on click

API keys are shown as `sk-xxxx...xxxx` by default. A "Show" button reveals the full key. This balances usability (users can copy their key) with security (shoulder-surfing protection). The reveal is client-side only; the full key is always in the page source.

**Alternative considered**: Never show full key, only allow copy-to-clipboard. Rejected because users may need to see the key for manual entry in other tools, and the page is already authenticated.

### 7. Calculate account status from token expiration time

Account status (valid, expiring soon, expired) is computed from the `expiresAt` field in the session store. "Expiring soon" is defined as within 2 hours of expiration. This provides visual indication without requiring additional status fields.

**Alternative considered**: Store explicit status field. Rejected because it would require synchronization with token refresh logic and could become stale.

## Risks / Trade-offs

- **Cookie security** → Use `httpOnly`, `secure`, and `sameSite=lax` attributes. In development without HTTPS, `secure` must be disabled via config.
- **XSS via user input** → All user-provided data (account names, etc.) is escaped when rendering HTML. Use text content, not innerHTML.
- **CSRF attacks** → `sameSite=lax` cookie attribute provides baseline protection. Sensitive operations (revoke key, unbind account) could add CSRF tokens in future.
- **Admin password in environment** → Environment variables may be visible in process listings. Mitigation: recommend using secrets management in production, clear from process.env after reading (optional).
- **No audit trail** → Admin operations (revoke key, force refresh) are not logged. Mitigation: add structured logging for admin actions in future iteration.
- **Static file caching** → Browsers may cache HTML files, showing stale content after account changes. Mitigation: add cache-control headers or use query parameters for cache busting.
- **No rate limiting on UI endpoints** → UI pages and admin API have no rate limiting. Mitigation: rely on reverse proxy rate limiting or add in future.
