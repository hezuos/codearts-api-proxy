## Why

The current browser-oriented Huawei login flow is modeled as a one-shot redirect and assumes IDE-style callback behavior. In practice, the browser flow can land on uncontrolled callback targets such as `http://extension/`, making completion unreliable and difficult to observe from the Web UI.

## What Changes

- Add a ticket-driven web login flow that treats Huawei authentication as a tracked async transaction instead of a blind redirect.
- Add browser-facing endpoints for creating a login ticket, querying ticket status, and completing the callback against a specific ticket.
- Support controlled login containers such as iframe or popup without depending on cross-origin iframe inspection.
- Record explicit login states such as pending, callback-received, exchanging, completed, failed, and expired.
- Ensure successful browser login returns control to this proxy's Web UI instead of relying on `extension://` or other uncontrolled redirect targets.

## Capabilities

### New Capabilities
- `ticketed-web-login`: Browser login orchestration driven by `ticket_id`, including status polling, callback completion, and controlled success/failure handling.

### Modified Capabilities
(None)

## Impact

- `src/routes/huawei-auth.ts` login initiation and callback routing
- Login flow state tracking in the in-memory flow store
- Web UI pages or shared JS that launch Huawei browser login and poll status
- Potentially new web endpoints under `/auth/huawei/*` or `/api/ui/*`
- No new external dependencies required
