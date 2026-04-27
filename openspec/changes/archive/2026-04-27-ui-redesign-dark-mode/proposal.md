## Why

The current UI uses a 2013-era Flat UI color palette with all colors hardcoded. There are zero CSS variables, zero media queries, and 215 lines of inline styles in admin.html that can't be overridden by dark mode. The design feels dated, and adding dark mode or mobile responsiveness is blocked by the lack of a design token system. Two message notification mechanisms coexist (static HTML + dynamic JS), and button variants are duplicated between style.css and admin.html inline styles.

## What Changes

- **CSS design tokens**: Replace all hardcoded colors with CSS custom properties (variables) in `:root`
- **Inline style extraction**: Move 215 lines of inline `<style>` from admin.html into style.css
- **Visual refresh**: Update color palette to modern Tailwind-inspired Slate, improve spacing/radius/shadows, add subtle transitions
- **Interaction improvements**: Better button states, copy feedback animation, modal backdrop animation, nav active state
- **Unify notification mechanism**: Remove static `.error-message`/`.success-message` HTML elements, use only app.js dynamic notifications
- **Dark mode**: Add `[data-theme="dark"]` variable overrides, `prefers-color-scheme` media query, toggle button with localStorage persistence
- **Mobile responsive**: Add `@media (max-width: 768px)` breakpoint, table-to-card layout for admin, nav collapse, container padding adjustment

## Capabilities

### New Capabilities
- `design-system`: CSS variable design tokens, unified component styles, inline style extraction
- `dark-mode`: Dark theme with system preference detection and manual toggle
- `mobile-responsive`: Responsive layout with mobile-first breakpoints

### Modified Capabilities
- `admin-panel`: Inline styles extracted, notification mechanism unified, table-to-card on mobile
- `status-page`: Visual refresh with new design tokens

## Impact

- `public/style.css`: Major rewrite — CSS variables, all admin inline styles moved here, dark mode overrides, media queries
- `public/admin.html`: Remove 215-line inline `<style>` block, remove static error/success elements
- `public/index.html`: Visual refresh, dark mode toggle, responsive adjustments
- `public/success.html`: Visual refresh, dark mode toggle, responsive adjustments
- `public/admin-login.html`: Visual refresh, dark mode toggle, responsive adjustments
- `public/admin-setup.html`: Visual refresh, dark mode toggle, responsive adjustments
- `public/app.js`: Theme toggle logic (loadTheme, toggleTheme), unified notification, copy feedback animation
