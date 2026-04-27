## ADDED Requirements

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
