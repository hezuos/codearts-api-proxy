# mobile-responsive Specification

## Purpose
TBD - created by archiving change ui-redesign-dark-mode. Update Purpose after archive.
## Requirements
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

### Requirement: 768px mobile breakpoint

The system SHALL provide responsive layout adjustments at `@media (max-width: 768px)` for all pages.

#### Scenario: Container padding on mobile

- **WHEN** viewport width is below 768px
- **THEN** `.container` padding SHALL be reduced to 16px or less

#### Scenario: Navigation stacks on mobile

- **WHEN** viewport width is below 768px and a `.nav` element exists
- **THEN** the nav SHALL stack its children vertically instead of horizontal flex

#### Scenario: No horizontal overflow

- **WHEN** viewport width is 320px or above
- **THEN** no page SHALL produce horizontal scrolling

### Requirement: Touch-friendly targets

All interactive elements SHALL have a minimum height of 44px on viewports below 768px.

#### Scenario: Button touch targets

- **WHEN** viewport width is below 768px
- **THEN** all buttons SHALL have minimum height of 44px

#### Scenario: Input touch targets

- **WHEN** viewport width is below 768px
- **THEN** all text/password inputs SHALL have minimum height of 44px

### Requirement: Stats grid mobile adjustment

The stats grid SHALL adjust its column minimum for mobile viewports.

#### Scenario: Stats grid on mobile

- **WHEN** viewport width is below 768px
- **THEN** `.stats` grid SHALL use a smaller minmax (e.g., `minmax(140px, 1fr)`) to allow single-column on narrow screens

### Requirement: Version badge mobile positioning

The version badge SHALL remain visible and not overflow on mobile.

#### Scenario: Version badge on mobile

- **WHEN** viewport width is below 768px
- **THEN** the `.version-badge` SHALL display below or after the nav content without causing overflow

