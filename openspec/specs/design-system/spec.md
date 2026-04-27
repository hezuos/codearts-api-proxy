# design-system Specification

## Purpose
TBD - created by archiving change ui-redesign-dark-mode. Update Purpose after archive.
## Requirements
### Requirement: CSS variable design tokens

The system SHALL define all visual properties (colors, spacing, radius, shadows) as CSS custom properties in `:root`. No hardcoded color values SHALL remain in any CSS.

#### Scenario: All colors use variables

- **WHEN** a developer inspects style.css
- **THEN** every color value SHALL reference a CSS variable (e.g., `var(--color-primary)`) rather than a hardcoded hex/rgb value

#### Scenario: Design token categories

- **WHEN** the `:root` block is inspected
- **THEN** it SHALL contain at minimum: color tokens (primary, danger, success, warning, bg, surface, text, border), spacing tokens (xs through xl), radius tokens (sm, md, lg), and shadow tokens (sm, md)

### Requirement: Inline style extraction from admin.html

All inline `<style>` content in admin.html SHALL be moved to style.css. The inline `<style>` block SHALL be removed from admin.html.

#### Scenario: No inline styles in admin.html

- **WHEN** a developer inspects admin.html
- **THEN** there SHALL be no `<style>` tag within the `<head>` or `<body>`

#### Scenario: Admin styles still work

- **WHEN** the admin page is loaded after extraction
- **THEN** all admin-specific components (modal, key-row, menu-wrap, action-popover, dropdown, session-badge) SHALL render identically to before extraction

### Requirement: Unified notification mechanism

All pages SHALL use the dynamic `showError()`/`showSuccess()` functions from app.js for user notifications. Static `.error-message` and `.success-message` HTML elements SHALL be removed.

#### Scenario: No static notification elements

- **WHEN** a developer inspects any HTML file
- **THEN** there SHALL be no `<div id="error" class="error-message">` or `<div id="success" class="success-message">` elements

#### Scenario: Notifications still work

- **WHEN** an error or success condition occurs on any page
- **THEN** a notification SHALL appear via the dynamic app.js mechanism

