## ADDED Requirements

### Requirement: Dark mode variable overrides

The system SHALL provide dark mode color overrides via `[data-theme="dark"]` on the `<html>` element, overriding all color CSS variables defined in `:root`.

#### Scenario: Dark mode activated

- **WHEN** `<html>` has `data-theme="dark"`
- **THEN** all color CSS variables SHALL resolve to dark-appropriate values (dark backgrounds, light text, adjusted primary/border colors)

#### Scenario: Dark mode deactivated

- **WHEN** `<html>` does not have `data-theme="dark"` (or has `data-theme="light"`)
- **THEN** all color CSS variables SHALL resolve to light-mode default values

### Requirement: System preference detection

The system SHALL respect the user's OS color scheme preference via `prefers-color-scheme: dark` media query when no explicit theme is set in localStorage.

#### Scenario: OS prefers dark, no stored preference

- **WHEN** the user's OS is set to dark mode and localStorage has no theme value
- **THEN** the page SHALL render in dark mode

#### Scenario: OS prefers dark, user chose light

- **WHEN** the user's OS is set to dark mode but localStorage has `theme=light`
- **THEN** the page SHALL render in light mode (explicit choice overrides OS)

### Requirement: Theme toggle button

All pages with a `.nav` element SHALL display a theme toggle button. Pages without nav SHALL display the toggle next to the `<h1>` heading.

#### Scenario: Toggle switches theme

- **WHEN** the user clicks the theme toggle button
- **THEN** the page SHALL switch between light and dark mode
- **AND** the choice SHALL be persisted to localStorage

#### Scenario: Theme persists across pages

- **WHEN** the user sets dark mode on one page and navigates to another
- **THEN** the new page SHALL also render in dark mode
