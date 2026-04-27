## ADDED Requirements

### Requirement: Admin panel mobile layout

The admin panel SHALL provide a card-based layout for data tables on viewports below 768px, and allow key rows to wrap.

#### Scenario: Accounts table becomes cards on mobile

- **WHEN** viewport width is below 768px on the admin page
- **THEN** the accounts table SHALL be hidden and a card list SHALL be shown, with each account rendered as a card containing all fields (username, domain, provider, status, keys, actions)

#### Scenario: Users table becomes cards on mobile

- **WHEN** viewport width is below 768px on the admin page
- **THEN** the users table SHALL be hidden and a card list SHALL be shown

#### Scenario: Desktop tables unchanged

- **WHEN** viewport width is 768px or above
- **THEN** admin tables SHALL render as normal tables and card lists SHALL be hidden

#### Scenario: Key rows wrap on mobile

- **WHEN** viewport width is below 768px
- **THEN** `.key-row` SHALL allow `flex-wrap: wrap` so elements flow to the next line instead of overflowing
