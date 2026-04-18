## Why

Currently, users must use API clients (like curl or OpenAI SDK) to interact with the proxy. There is no visual interface for users to view their account status, manage API keys, or understand their bound Huawei Cloud accounts. Additionally, there is no administrative interface for monitoring system health or managing users and accounts. This change adds a lightweight Web UI to improve user experience and provide administrative oversight.

## What Changes

- **New Web UI pages** for user account management and status viewing
- **Success page** displayed after OAuth login, showing account info and API key
- **Status page** showing all bound Huawei Cloud accounts with their token status
- **Admin authentication system** with environment variable or setup page configuration
- **Admin control panel** for viewing all users, accounts, and performing management operations
- **Cookie-based UI authentication** using the same API key for both API and UI access
- **Static HTML/CSS/JS pages** served by Express with minimal styling

## Capabilities

### New Capabilities

- `user-auth-ui`: Cookie-based authentication for Web UI pages, using API key as the identity token
- `admin-auth`: Administrator authentication with environment variable priority and setup page fallback, password hashing with bcrypt
- `success-page`: Post-login success page displaying Huawei Cloud account information and assigned API key with usage examples
- `status-page`: Account status dashboard showing all bound Huawei Cloud accounts, token expiration status, and management operations (refresh, unbind, set default)
- `admin-panel`: Administrative control panel for viewing all users, accounts, and performing management operations (revoke API keys, force refresh tokens)

### Modified Capabilities

(None - this is additive functionality)

## Impact

- **New routes** in `src/routes/` for UI pages and admin endpoints
- **New middleware** for UI cookie authentication and admin authentication
- **New static files** in `public/` directory (HTML, CSS, JS)
- **New data file** `data/admin-config.json` for storing admin password hash
- **New dependencies**: `bcryptjs` for password hashing, `cookie-parser` for cookie handling
- **Modified OAuth callback** to set cookie and redirect to success page
- **No breaking changes** to existing API endpoints
