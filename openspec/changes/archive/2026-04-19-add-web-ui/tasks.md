## 1. Dependencies and Infrastructure

- [x] 1.1 Add `bcryptjs` dependency to package.json for password hashing
- [x] 1.2 Add `cookie-parser` dependency to package.json for cookie handling
- [x] 1.3 Create `public/` directory for static HTML/CSS/JS files
- [x] 1.4 Add cookie-parser middleware to Express app in src/index.ts
- [x] 1.5 Configure Express to serve static files from `public/` directory

## 2. Admin Authentication System

- [x] 2.1 Create src/auth/admin.ts module for admin password management
- [x] 2.2 Implement loadAdminConfig() to read admin-config.json on startup
- [x] 2.3 Implement saveAdminConfig() to persist admin password hash
- [x] 2.4 Implement checkAdminPassword() using bcrypt comparison
- [x] 2.5 Implement isAdminConfigured() to check if admin password is set
- [x] 2.6 Add ADMIN_PASSWORD environment variable support with precedence over file
- [x] 2.7 Create src/middleware/authenticate-admin.ts middleware for admin routes
- [x] 2.8 Implement admin session cookie validation in middleware

## 3. UI Authentication Middleware

- [x] 3.1 Create src/middleware/authenticate-ui.ts middleware for UI pages
- [x] 3.2 Implement cookie extraction and validation using existing validateApiKey()
- [x] 3.3 Implement redirect to home page for unauthenticated UI access
- [x] 3.4 Attach user context to request for authenticated UI access

## 4. OAuth Callback Enhancement

- [x] 4.1 Modify src/routes/huawei-auth.ts handleHuaweiCallback to set auth_key cookie
- [x] 4.2 Implement cookie security attributes (httpOnly, secure, sameSite)
- [x] 4.3 Add conditional secure attribute based on environment (dev vs prod)
- [x] 4.4 Set cookie maxAge to 30 days (2592000000 ms)
- [x] 4.5 Redirect to /success page after setting cookie

## 5. Success Page Implementation

- [x] 5.1 Create public/success.html with page structure and styling
- [x] 5.2 Implement API key display with masking (sk-xxxx...xxxx)
- [x] 5.3 Add "Show" button to reveal full API key
- [x] 5.4 Add "Copy" button with clipboard API integration
- [x] 5.5 Display Huawei Cloud account information (user name, domain ID, account ID)
- [x] 5.6 Display usage examples with OPENAI_API_KEY and OPENAI_BASE_URL
- [x] 5.7 Add navigation links (View Status, Bind Another Account, Return Home)
- [x] 5.8 Create src/routes/web-ui.ts with /success route handler
- [x] 5.9 Implement server-side data injection or client-side fetch for account data

## 6. Status Page Implementation

- [x] 6.1 Create public/status.html with page structure and styling
- [x] 6.2 Display user's API key with masking, show, copy, and regenerate buttons
- [x] 6.3 Display list of all bound Huawei Cloud accounts
- [x] 6.4 Implement account status calculation (valid, expiring soon, expired)
- [x] 6.5 Display token expiration time and last refresh time for each account
- [x] 6.6 Add "Refresh" button for manual token refresh with API call
- [x] 6.7 Add "Unbind" button with confirmation dialog
- [x] 6.8 Add "Set as Default" button with visual indicator for current default
- [x] 6.9 Implement API key regeneration with cookie update
- [x] 6.10 Add src/routes/web-ui.ts /status route handler
- [x] 6.11 Create /api/ui/status endpoint to return account data as JSON

## 7. Admin Login and Setup Pages

- [x] 7.1 Create public/admin-login.html with login form
- [x] 7.2 Create public/admin-setup.html with password setup form
- [x] 7.3 Implement password strength validation on setup form (client-side)
- [x] 7.4 Create src/routes/admin.ts with /admin/login GET and POST handlers
- [x] 7.5 Create /admin/setup GET and POST handlers
- [x] 7.6 Implement bcrypt password hashing on setup (cost factor 12)
- [x] 7.7 Set admin_session cookie on successful login
- [x] 7.8 Implement /admin/logout POST handler to clear cookie

## 8. Admin Panel Implementation

- [x] 8.1 Create public/admin.html with admin panel structure
- [x] 8.2 Display system statistics (total users, accounts, API keys)
- [x] 8.3 Display user list with associated accounts and API keys
- [x] 8.4 Show masked API keys with revoke buttons
- [x] 8.5 Show account list with status indicators and force refresh buttons
- [x] 8.6 Create /admin route handler with admin authentication middleware
- [x] 8.7 Create /admin/api/users endpoint to return all users data
- [x] 8.8 Create /admin/api/accounts endpoint to return all accounts data
- [x] 8.9 Create /admin/api/keys/:id/revoke POST endpoint
- [x] 8.10 Create /admin/api/accounts/:id/refresh POST endpoint
- [x] 8.11 Implement redirect logic: /admin → /admin/setup if not configured, /admin/login if not authenticated

## 9. Shared UI Components

- [x] 9.1 Create public/style.css with minimal styling for all pages
- [x] 9.2 Create public/app.js with shared JavaScript utilities
- [x] 9.3 Implement API key masking/unmasking function
- [x] 9.4 Implement clipboard copy function with success feedback
- [x] 9.5 Implement fetch wrapper with error handling
- [x] 9.6 Implement confirmation dialog utility

## 10. Home Page Update

- [x] 10.1 Update src/index.ts root route to serve public/index.html instead of inline HTML
- [x] 10.2 Create public/index.html with links to login and admin panel
- [x] 10.3 Add link to /auth/huawei/authorize for user login
- [x] 10.4 Add link to /admin for admin panel access

## 11. Route Integration

- [x] 11.1 Import and register web-ui routes in src/index.ts
- [x] 11.2 Import and register admin routes in src/index.ts
- [x] 11.3 Apply authenticate-ui middleware to /success and /status routes
- [x] 11.4 Apply authenticate-admin middleware to /admin and /admin/api/\* routes

## 12. Error Handling and Edge Cases

- [x] 12.1 Add error handling for missing or corrupted admin-config.json
- [x] 12.2 Add user-friendly error messages on UI pages
- [x] 12.3 Handle case where user has no bound accounts on status page
- [x] 12.4 Handle case where user has no API key (should not happen, but defensive)
- [x] 12.5 Add loading states for async operations (refresh, unbind, etc.)
- [x] 12.6 Validate cookie security in production (warn if secure=false on HTTPS)

## 13. Testing and Verification

- [x] 13.1 Test OAuth login flow sets cookie and redirects to success page
- [x] 13.2 Test success page displays correct account info and API key
- [x] 13.3 Test status page displays all accounts with correct status
- [x] 13.4 Test account operations (refresh, unbind, set default) on status page
- [x] 13.5 Test admin setup flow when no admin configured
- [x] 13.6 Test admin login with correct and incorrect password
- [x] 13.7 Test admin panel displays all users and accounts
- [x] 13.8 Test admin operations (revoke key, force refresh)
- [x] 13.9 Test unauthenticated access redirects correctly for all protected pages
- [x] 13.10 Test cookie security attributes in different environments
