## ADDED Requirements

### Requirement: Admin panel styling

The admin panel SHALL use shared CSS from style.css only. All component styles (modal, key-row, menu-wrap, action-popover, dropdown, session-badge, button variants) SHALL be defined in style.css using CSS variable design tokens. No inline `<style>` block SHALL exist in admin.html.

#### Scenario: Admin uses design tokens

- **WHEN** the admin page is rendered
- **THEN** all visual properties SHALL reference CSS variables from the design system, enabling dark mode and consistent theming
