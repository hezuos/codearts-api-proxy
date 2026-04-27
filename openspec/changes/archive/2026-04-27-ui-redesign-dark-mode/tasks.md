## 1. CSS Design Tokens

- [x] 1.1 Define `:root` CSS variables: colors (primary, danger, success, warning, bg, surface, text, border, and variants)
- [x] 1.2 Define `:root` CSS variables: spacing (xs/sm/md/lg/xl), radius (sm/md/lg), shadow (sm/md)
- [x] 1.3 Replace all hardcoded colors in style.css with `var()` references

## 2. Inline Style Extraction

- [x] 2.1 Move admin.html inline `<style>` (modal, key-row, menu-wrap, action-popover, dropdown, session-badge, button variants) to style.css
- [x] 2.2 Replace hardcoded colors in extracted styles with `var()` references
- [x] 2.3 Remove `<style>` block from admin.html
- [x] 2.4 Verify all admin components render correctly after extraction

## 3. Visual Refresh

- [x] 3.1 Update color palette to Tailwind Slate (light mode defaults in `:root`)
- [x] 3.2 Update spacing/radius/shadow to use design tokens
- [x] 3.3 Add subtle transitions (buttons, cards, inputs)
- [x] 3.4 Improve button styles (padding, hover/focus states)
- [x] 3.5 Improve table styles (borders, hover, header)

## 4. Notification Unification

- [x] 4.1 Remove static `.error-message` and `.success-message` elements from all HTML files
- [x] 4.2 Ensure all pages use dynamic `showError()`/`showSuccess()` from app.js
- [x] 4.3 Update app.js notification styles to use design tokens

## 5. Dark Mode

- [x] 5.1 Define `[data-theme="dark"]` variable overrides in style.css
- [x] 5.2 Add `@media (prefers-color-scheme: dark)` fallback for OS preference
- [x] 5.3 Add theme toggle button to nav pages (index, admin, success)
- [x] 5.4 Add theme toggle button to non-nav pages (admin-login, admin-setup)
- [x] 5.5 Implement `loadTheme()` and `toggleTheme()` in app.js with localStorage persistence

## 6. Mobile Responsive

- [x] 6.1 Add `@media (max-width: 768px)` breakpoint: container padding, nav stacking
- [x] 6.2 Admin tables: card layout below 768px (CSS classes ready, JS card generation in mobile-responsive change)
- [x] 6.3 Key rows: flex-wrap on narrow viewports
- [x] 6.4 Stats grid: adjust minmax for mobile
- [x] 6.5 Buttons and inputs: adjust sizing for touch targets

## 7. Interaction Improvements

- [x] 7.1 Copy button: add ✓ success feedback animation (`.key-copy-btn.copied` class added)
- [x] 7.2 Modal: add backdrop fade animation
- [x] 7.3 Nav: add active state highlighting

## 8. Verification

- [x] 8.1 `npx tsc --noEmit` passes
- [x] 8.2 `pnpm test` passes
- [x] 8.3 Visual: all 5 pages render correctly in light mode
- [x] 8.4 Visual: all 5 pages render correctly in dark mode
- [x] 8.5 Visual: admin page all interactions work (dropdown, popover, modal, key actions)
- [x] 8.6 Visual: mobile layout works at 375px viewport
