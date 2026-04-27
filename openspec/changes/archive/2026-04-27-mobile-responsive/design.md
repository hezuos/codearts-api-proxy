## Context

5 HTML pages share style.css. All have viewport meta tag but zero media queries. The only responsive element is `.stats` grid with `repeat(auto-fit, minmax(200px, 1fr))`. Admin page has 6-column accounts table and multi-field key rows that overflow on narrow screens. Container uses `max-width: 1800px` with `padding: 30px`.

## Goals / Non-Goals

**Goals:**
- All pages usable on 320px-768px viewports (phones and small tablets)
- Admin panel functional on mobile (card layout instead of tables)
- Touch-friendly interactive elements (min 44px tap targets)
- No horizontal scrolling on any page

**Non-Goals:**
- Desktop layout changes (≥768px stays as-is)
- Separate mobile page/routes
- PWA/installation support
- Multiple breakpoints (tablet vs phone) — single 768px breakpoint is sufficient

## Decisions

### 1. Single breakpoint: 768px

**Decision**: One breakpoint at 768px. Below = mobile, above = desktop (current layout).

**Rationale**: 768px is the standard tablet/phone boundary. A single breakpoint keeps CSS simple and maintainable. The current desktop layout works fine above 768px.

**Alternatives considered**:
- Multiple breakpoints (480px, 768px, 1024px): over-engineering for this app's complexity
- Container queries: not needed, no component reuse across contexts

### 2. Table-to-card: CSS-only with data attributes

**Decision**: Use CSS to hide `<table>` below 768px and show a card layout generated from the same data. The admin.html JS already builds table rows dynamically — add a parallel card container that's hidden on desktop and shown on mobile.

**Rationale**: Pure CSS table-to-card transforms (using `display: block` on td/tr) are fragile and produce poor results with 6+ columns. A dedicated card container gives full control over mobile layout. The JS already has the data, so generating cards is straightforward.

**Alternatives considered**:
- CSS-only table transform (`display: block` on all cells): breaks with complex headers, poor visual result
- Separate mobile page: unnecessary duplication

### 3. Touch targets: min 44px

**Decision**: All interactive elements (buttons, links, inputs) SHALL have minimum 44px height on mobile.

**Rationale**: 44px is the Apple HIG and WCAG recommended minimum touch target size. Current buttons have `padding: 10px 20px` (~34px height) which is too small for touch.

## Risks / Trade-offs

- [Card layout duplicates some rendering logic in JS] → Mitigation: Share the data, just different HTML templates; card HTML is simpler than table HTML
- [Single breakpoint may not be perfect for all devices] → Mitigation: 768px covers 95%+ of phone/tablet scenarios; edge cases can be addressed later
- [Admin page is the most complex mobile adaptation] → Mitigation: Focus testing on admin; other pages are simpler (forms, text content)
