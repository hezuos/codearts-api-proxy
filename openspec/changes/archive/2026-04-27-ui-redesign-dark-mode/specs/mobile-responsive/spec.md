## ADDED Requirements

### Requirement: Mobile breakpoint at 768px

The system SHALL provide responsive layout adjustments below 768px viewport width via `@media (max-width: 768px)`.

#### Scenario: Container padding on mobile

- **WHEN** viewport width is below 768px
- **THEN** `.container` padding SHALL be reduced (e.g., 16px instead of 30px)

#### Scenario: Navigation stacks on mobile

- **WHEN** viewport width is below 768px
- **THEN** `.nav` SHALL stack vertically instead of horizontal flex

### Requirement: Admin table card layout on mobile

On viewports below 768px, admin data tables SHALL switch from table layout to card layout for readability.

#### Scenario: Accounts table becomes cards

- **WHEN** viewport width is below 768px on the admin page
- **THEN** the accounts table SHALL render as a vertical card list, with each account as a card showing all fields

#### Scenario: Desktop table unchanged

- **WHEN** viewport width is 768px or above
- **THEN** admin tables SHALL render as normal tables (no card layout)

### Requirement: Key row wrapping on mobile

Key rows in the admin panel SHALL wrap on narrow viewports to prevent horizontal overflow.

#### Scenario: Key row wraps

- **WHEN** viewport width is below 768px
- **THEN** `.key-row` SHALL allow flex-wrap so elements flow to the next line instead of overflowing
