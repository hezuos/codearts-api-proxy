# Spec Delta

## MODIFIED Requirements

### Requirement: Browser login ticket creation

The system SHALL provide a browser-oriented Huawei login start endpoint that creates a unique `ticket_id`, records a pending browser login flow bound to an explicit user, and returns enough information for the Web UI to launch the upstream Huawei login while tracking that specific ticket.

#### Scenario: Create browser login ticket

- **WHEN** a Web UI holding an authenticated session or a valid binding token requests a new Huawei browser login flow
- **THEN** the system returns a unique `ticket_id`, a Huawei `login_url`, and an expiration timestamp for that ticket

#### Scenario: Track multiple browser login tickets independently

- **WHEN** multiple browser login flows are created before earlier ones complete
- **THEN** the system tracks each flow independently by `ticket_id` without overwriting the others

### Requirement: Ticket-bound callback completion

The system SHALL complete browser login callbacks against the intended `ticket_id` and its bound explicit user instead of resolving browser flows by latest-flow heuristics. The OAuth2 `code + state` callback SHALL follow the same ticket correlation.

#### Scenario: Callback updates matching ticket

- **WHEN** Huawei redirects the browser back for a specific browser login flow
- **THEN** the system updates the matching ticket state to reflect callback receipt and continues credential exchange for that ticket only

#### Scenario: Callback for unknown or expired ticket

- **WHEN** the callback arrives for a ticket that does not exist or has expired
- **THEN** the system rejects the callback and does not attach the response to another pending browser flow
