# ticketed-web-login Specification

## Purpose
TBD - created by archiving change ticketed-web-login-flow. Update Purpose after archive.
## Requirements
### Requirement: Browser login ticket creation
The system SHALL provide a browser-oriented Huawei login start endpoint that creates a unique `ticket_id`, records a pending browser login flow, and returns enough information for the Web UI to launch the upstream Huawei login while tracking that specific ticket.

#### Scenario: Create browser login ticket
- **WHEN** an authenticated Web UI requests a new Huawei browser login flow
- **THEN** the system returns a unique `ticket_id`, a Huawei `login_url`, and an expiration timestamp for that ticket

#### Scenario: Track multiple browser login tickets independently
- **WHEN** multiple browser login flows are created before earlier ones complete
- **THEN** the system tracks each flow independently by `ticket_id` without overwriting the others

### Requirement: Ticket status polling
The system SHALL expose ticket status for browser login flows so the Web UI can observe progress without reading popup or iframe navigation state.

#### Scenario: Poll pending ticket
- **WHEN** the Web UI polls a newly created ticket before callback completion
- **THEN** the system returns a non-terminal status indicating that login is still in progress

#### Scenario: Poll completed ticket
- **WHEN** the Web UI polls a ticket after successful callback handling and credential exchange
- **THEN** the system returns a terminal completed status for that exact `ticket_id`

#### Scenario: Poll failed or expired ticket
- **WHEN** the Web UI polls a ticket that has failed or expired
- **THEN** the system returns a terminal failed or expired status and a user-displayable reason

### Requirement: Ticket-bound callback completion
The system SHALL complete browser login callbacks against the intended `ticket_id` instead of resolving browser flows by latest-flow heuristics.

#### Scenario: Callback updates matching ticket
- **WHEN** Huawei redirects the browser back for a specific browser login flow
- **THEN** the system updates the matching ticket state to reflect callback receipt and continues credential exchange for that ticket only

#### Scenario: Callback for unknown or expired ticket
- **WHEN** the callback arrives for a ticket that does not exist or has expired
- **THEN** the system rejects the callback and does not attach the response to another pending browser flow

### Requirement: Controlled local browser completion
The system SHALL finish browser login on a local proxy-controlled destination so that success or failure remains within the current service's address space.

#### Scenario: Successful browser login stays under proxy control
- **WHEN** a browser login flow completes successfully
- **THEN** the proxy sets the browser authentication cookie and redirects or renders a local completion target under the proxy's own host

#### Scenario: Browser login does not rely on extension redirect
- **WHEN** the browser login flow is initiated from the Web UI
- **THEN** the flow does not require redirecting the browser to `extension://` or `http://extension/` to complete

### Requirement: Popup-first browser orchestration
The system SHALL support popup as the default browser container for Huawei login, while allowing the same ticket lifecycle to be reused by other containers if needed.

#### Scenario: Popup launcher uses ticket polling
- **WHEN** the Web UI launches Huawei login in a popup
- **THEN** the parent page can detect completion solely by polling ticket status and close the popup when the ticket reaches a terminal state

#### Scenario: Popup remains the supported default
- **WHEN** Huawei login depends on top-level cookie behavior
- **THEN** the Web UI uses popup as the supported default container instead of requiring iframe-based login

