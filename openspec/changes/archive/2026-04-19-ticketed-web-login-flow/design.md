## Context

The proxy already has Huawei login flow machinery based on `ticketId`, but the browser entrypoint currently behaves like a redirect helper rather than a tracked web transaction. The callback handler resolves the pending browser flow heuristically, and browser success relies on redirect behavior that originally matched IDE extension flows. This is fragile for Web UI usage because the browser cannot inspect cross-origin Huawei pages, and Huawei login cookies may be blocked in third-party iframe contexts.

The most reliable control point is the proxy itself. It creates the Huawei login ticket, receives the callback, exchanges the identifier, and can expose the current state to the Web UI. That suggests a design centered on a server-side ticket state machine, with the browser acting as an observer via polling.

## Goals / Non-Goals

**Goals:**
- Make browser-based Huawei login explicitly tracked by `ticket_id`
- Allow Web UI to launch Huawei login with popup as the default browser container, without needing cross-origin access
- Let the parent page observe completion by polling ticket status from the proxy
- Ensure callback completion is tied to the correct ticket instead of whichever pending browser flow is latest
- Keep the solution in-process and aligned with the proxy's current lightweight architecture

**Non-Goals:**
- Rework the upstream Huawei authentication protocol
- Introduce Redis, databases, WebSocket infrastructure, or background job systems
- Guarantee iframe compatibility if Huawei sends anti-framing headers or blocks third-party cookies
- Replace the existing API-oriented initiate flow used by non-browser clients

## Decisions

### 1. Model browser login as a ticket state machine

Each browser login attempt will have an explicit server-side state keyed by `ticket_id`, such as `pending`, `callback_received`, `exchanging`, `completed`, `failed`, and `expired`. The Web UI only reasons about this state and never about iframe URL contents.

**Alternative considered**: Infer completion from iframe redirects or front-end browser events. Rejected because Huawei pages are cross-origin and the callback target may vary in ways the page cannot inspect safely.

### 2. Separate ticket creation from browser navigation

The browser should first request a local endpoint that returns a `ticket_id` and Huawei `login_url`, then open a popup by default. This gives the parent page the identifier it needs for polling from the start and avoids iframe third-party-cookie failures during Huawei login.

**Alternative considered**: Point iframe directly at `/auth/huawei/authorize`. Rejected because the page then lacks a stable handle for polling, the server remains responsible for selecting a flow heuristically, and Huawei login cookies may be blocked inside iframe contexts.

### 3. Bind callback handling to a specific ticket

The callback path should resolve the target flow using explicit ticket correlation rather than `latestBrowserFlowTicketId` or any other global heuristic. If the Huawei callback does not natively include enough correlation, the browser flow should establish one through the locally issued redirect path.

**Alternative considered**: Keep using the latest pending browser flow. Rejected because concurrent browser logins or stale flows make it ambiguous and error-prone.

### 4. Treat callback as a terminal local handoff for browser flows

For browser-initiated login, the local callback should update ticket state, perform ticket exchange, set cookie on success, and end on a local success/failure page or local redirect under proxy control. The browser flow should not depend on forwarding to `extension://`-style destinations.

**Alternative considered**: Preserve IDE-style redirect forwarding in browser mode. Rejected because that is the behavior currently producing uncontrolled targets such as `http://extension/`.

### 5. Use polling as the synchronization primitive

The parent page should poll ticket status until completion, failure, or expiration, then close the popup and refresh local account data. Polling is sufficient because login is short-lived and the state already resides in the proxy process.

**Alternative considered**: SSE or postMessage as the primary mechanism. Rejected for the initial version because polling is simpler and does not require keeping a long-lived push channel; postMessage can still be layered on top later for smoother UX.

## Risks / Trade-offs

- **Huawei login cookies are blocked in third-party iframe context** → Use popup as the default container and keep iframe as an optional experimental path only.
- **Callback correlation data is insufficient** → Introduce an explicit local browser callback path that preserves ticket identity end-to-end.
- **Polling adds repeated requests** → Keep polling intervals modest and expire finished tickets quickly.
- **In-memory flow state is process-local** → Accept this because current Huawei login flow state is already in-memory and the proxy is intentionally lightweight.
- **Concurrent login attempts per user may overlap** → Define clear state ownership per `ticket_id` and require polling/status APIs to be ticket-specific.

## Migration Plan

1. Add the ticket-oriented browser endpoints alongside the existing login flow.
2. Update Web UI to use ticket creation + popup polling for browser login.
3. Keep the existing non-browser initiate flow unchanged.
4. After validation, simplify browser-specific heuristic paths that are no longer needed.

## Open Questions

- Is there any user-visible scenario where iframe should remain available as an experimental fallback, or should popup be the only supported browser container?
- What callback fields are guaranteed to be returned by Huawei, and which of them can be used for strict ticket correlation?
- Should completed ticket status include account summary data for immediate UI refresh, or should the page reload status from existing APIs after completion?
