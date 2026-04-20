## Context

The Huawei DevCloud OAuth flow redirects the browser to `http://127.0.0.1:{port}/callback?identifier=...&redirect=...` after authentication. When the proxy runs remotely, this callback cannot reach the proxy. However, the browser address bar still contains the full callback URL. The existing `GET /callback` endpoint already handles callbacks correctly — the only problem is that the browser navigates to the wrong host.

## Goals / Non-Goals

**Goals:**
- Allow users to paste the callback URL from the browser address bar
- Rewrite the host portion to point to the current proxy
- Navigate to the rewritten URL so the existing `/callback` endpoint processes it normally

**Non-Goals:**
- Any backend changes (no new API endpoints)
- Changing Huawei DevCloud server behavior
- Supporting `uri_scheme=https` or custom callback hosts

## Decisions

### 1. Frontend-only solution: URL rewrite + navigation

**Decision:** Parse the pasted URL in JavaScript, replace the origin (`http://127.0.0.1:1455`) with `window.location.origin`, and navigate via `window.location.href`.

**Rationale:** The existing `GET /callback` endpoint already does everything needed — correlates the flow via cookie, extracts `identifier`, triggers `startBrowserFlowExchange()`, and redirects to the completion page. We just need to get the browser to hit that endpoint with the right host.

**Alternatives considered:**
- New `POST /auth/huawei/callback/paste` backend endpoint — rejected: unnecessary complexity when the existing endpoint works
- `fetch()` the rewritten URL instead of navigating — rejected: the `/callback` handler may return a 307 redirect to the DevCloud continue page, which `fetch` doesn't follow as a browser navigation

### 2. UI placement: Home page (index.html)

**Decision:** Add a "Paste Callback URL" card on the home page, below the existing "User Login" card.

**Rationale:** The home page is the entry point. Users who can't use the automatic popup login need an alternative right on the landing page.

### 3. URL rewrite strategy

**Decision:** Use the URL constructor to parse, then replace `url.origin` with `window.location.origin`.

**Rationale:** The `URL` API handles all edge cases (ports, query params, fragments). Replacing only the origin preserves the path (`/callback`) and all query parameters (`identifier`, `redirect`).

## Risks / Trade-offs

- **[Pasted URL may not be a valid callback URL]** → Mitigation: Validate that the URL path starts with `/callback` and contains an `identifier` query param; show clear error if not
- **[Cookie may not be set if user is on a different browser/session]** → Mitigation: The `huawei_login_ticket` cookie is set when the login flow is initiated. If the user pastes the URL in the same browser where they initiated login, the cookie is present. If not, the `/callback` endpoint falls back to matching by `ticket_id` in the query or pending API flows.
