## Why

The current UI has zero `@media` queries. Tables with 6 columns overflow on phones, navigation doesn't collapse, container padding is too large on small screens, and key rows don't wrap. The admin panel is particularly unusable on mobile. All pages need responsive adjustments for phone and tablet viewports.

## What Changes

- Add `@media (max-width: 768px)` breakpoint for phone/tablet layouts
- Container padding shrinks on small screens
- Navigation stacks vertically on mobile
- Admin tables switch to card layout below 768px
- Key rows allow flex-wrap on narrow viewports
- Stats grid adjusts column minimums for mobile
- Buttons and inputs sized for touch targets (min 44px)
- Version badge repositions on mobile

## Capabilities

### New Capabilities
- `mobile-responsive`: Responsive layout with 768px breakpoint, table-to-card conversion, touch-friendly sizing

### Modified Capabilities
- `admin-panel`: Tables become card lists on mobile, key rows wrap

## Impact

- `public/style.css`: Add `@media (max-width: 768px)` rules for all components
- `public/admin.html`: Add CSS class hooks for mobile card layout (table → cards)
- `public/app.js`: Possible JS to toggle table/card rendering or add wrapper elements
- All 5 HTML files: Verify responsive behavior, minor structural adjustments if needed
