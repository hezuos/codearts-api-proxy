## Context

5 HTML pages share `style.css` and `app.js`. All colors are hardcoded (~30 unique values). admin.html has 215 lines of inline `<style>` that shadow and duplicate style.css definitions. Two notification mechanisms coexist. No CSS variables, no media queries, no dark mode support.

## Goals / Non-Goals

**Goals:**
- Establish CSS variable design token system as the foundation for all styling
- Extract admin.html inline styles to style.css for maintainability and dark mode compatibility
- Modernize visual design (colors, spacing, radius, shadows, transitions)
- Add dark mode with system preference detection and manual toggle
- Add mobile responsive layout (768px breakpoint)
- Unify notification mechanism to app.js dynamic only
- Improve interactions (copy feedback, button states, modal animation)

**Non-Goals:**
- Introducing a CSS framework (Tailwind, Bootstrap, etc.)
- Redesigning the information architecture or page structure
- Adding new pages or features beyond visual/interaction improvements
- Server-side rendering or template engine changes

## Decisions

### 1. CSS variable design tokens

**Decision**: Define all colors, spacing, radius, and shadows as CSS custom properties in `:root`. Every hardcoded value in style.css and admin.html inline styles is replaced with a variable reference.

**Rationale**: Variables enable dark mode by simply overriding values in `[data-theme="dark"]`. They also make future design changes a single-point edit. No external dependencies needed.

**Token categories**:
- Color: primary, danger, success, warning, bg, surface, text, border (light + dark variants)
- Spacing: xs(4), sm(8), md(16), lg(24), xl(32)
- Radius: sm(4), md(8), lg(12)
- Shadow: sm, md

### 2. Inline style extraction

**Decision**: Move all 215 lines of `<style>` from admin.html into style.css. Remove the inline `<style>` block entirely.

**Rationale**: Inline styles have higher specificity and can't be overridden by dark mode variable changes in style.css. They also duplicate button/badge styles already in style.css. Moving them to style.css enables dark mode and reduces maintenance burden.

### 3. Color palette: Tailwind Slate

**Decision**: Adopt Tailwind CSS Slate color palette as the base, with blue-500 as primary.

**Rationale**: Slate is a modern, neutral palette with excellent contrast ratios. It's widely recognized and provides good dark mode variants out of the box. The current Flat UI palette (#3498db, #2c3e50, etc.) feels dated.

**Light mode**: slate-50 bg, white surface, slate-800 text, blue-500 primary
**Dark mode**: slate-900 bg, slate-800 surface, slate-200 text, blue-400 primary

### 4. Dark mode implementation

**Decision**: `[data-theme="dark"]` attribute on `<html>` element overrides CSS variables. `@media (prefers-color-scheme: dark)` sets dark variables when no explicit theme is chosen. Toggle button in nav persists to localStorage.

**Rationale**: `data-theme` attribute is the most common and well-supported pattern. The `prefers-color-scheme` media query respects OS settings on first visit. localStorage persists the user's explicit choice across sessions.

**Priority**: System preference → localStorage → light (default)

### 5. Mobile responsive: 768px breakpoint

**Decision**: Single breakpoint at 768px. Below 768px: container padding shrinks, nav stacks vertically, admin tables become card lists, key-row wraps.

**Rationale**: 768px covers phones and small tablets. A single breakpoint keeps CSS manageable. Card layout for tables is the standard mobile pattern for data-heavy admin UIs.

### 6. Notification mechanism unification

**Decision**: Remove static `.error-message` and `.success-message` HTML elements from all pages. Use only the dynamic `showError()`/`showSuccess()` from app.js.

**Rationale**: Two mechanisms create confusion (static elements don't auto-dismiss, dynamic ones do). The dynamic approach is better UX (auto-dismiss, consistent positioning). Removing static elements simplifies HTML.

## Risks / Trade-offs

- [Large CSS rewrite may introduce visual regressions] → Mitigation: Visual comparison before/after on all 5 pages; changes are primarily variable substitutions, not layout changes
- [admin.html inline style extraction may break specificity] → Mitigation: Test all admin interactions (dropdown, popover, modal, key actions) after extraction
- [Dark mode may not cover all edge cases initially] → Mitigation: Start with main surfaces/text, iterate on specific components as needed
- [Mobile card layout for admin tables is new UI pattern] → Mitigation: Keep table on desktop, only switch to cards below 768px
