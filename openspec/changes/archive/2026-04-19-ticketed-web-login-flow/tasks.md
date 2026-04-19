## 1. Ticket Flow Model

- [x] 1.1 Define browser login ticket states and response shape for pending, completed, failed, and expired flows
- [x] 1.2 Refactor browser login flow storage so each flow is addressed by `ticket_id` without relying on latest-flow heuristics
- [x] 1.3 Define ticket expiration and cleanup behavior for unfinished browser login flows

## 2. Browser Login Endpoints

- [x] 2.1 Add a browser login start endpoint that returns `ticket_id`, `login_url`, and expiration metadata
- [x] 2.2 Add a ticket status endpoint for Web UI polling
- [x] 2.3 Update callback handling so browser flows are completed against the intended `ticket_id`
- [x] 2.4 Ensure successful browser login sets cookie and lands on a proxy-controlled completion target

## 3. Web UI Integration

- [x] 3.1 Update the Web UI launcher to request a ticket before opening a popup login window by default
- [x] 3.2 Add client-side polling logic keyed by `ticket_id`
- [x] 3.3 Show user-visible progress, success, failure, and expiration states while the login container is open
- [x] 3.4 Close the popup and refresh local account data when polling observes completion

## 4. Validation

- [x] 4.1 Test a normal browser login flow from ticket creation through callback completion
- [x] 4.2 Test concurrent browser login tickets to confirm they do not overwrite each other
- [x] 4.3 Test expired or unknown ticket callbacks to confirm they are rejected safely
- [x] 4.4 Test popup-oriented launch flow against the ticket APIs and confirm popup completion is detected correctly
