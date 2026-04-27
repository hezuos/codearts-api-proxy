## 1. Core responsive CSS

- [x] 1.1 Add `@media (max-width: 768px)` to style.css: container padding, body padding
- [x] 1.2 Nav: stack vertically on mobile
- [x] 1.3 Stats grid: adjust minmax for mobile
- [x] 1.4 Version badge: mobile positioning
- [x] 1.5 Buttons: min-height 44px on mobile
- [x] 1.6 Inputs: min-height 44px on mobile
- [x] 1.7 Headings: reduce font-size on mobile

## 2. Admin mobile card layout

- [x] 2.1 Add mobile card container HTML to admin.html (accounts-cards, users-cards)
- [x] 2.2 Add JS to build account cards alongside table rows in `loadAdminData()`
- [x] 2.3 Add JS to build user cards alongside table rows
- [x] 2.4 CSS: hide tables / show cards below 768px; hide cards / show tables above
- [x] 2.5 Style account cards (field labels, key rows, actions)
- [x] 2.6 Style user cards

## 3. Key row and popover mobile

- [x] 3.1 `.key-row`: `flex-wrap: wrap` below 768px
- [x] 3.2 `.action-popover`: reposition for mobile (below instead of left)
- [x] 3.3 `.dropdown-menu`: ensure no overflow off-screen on mobile

## 4. Other pages mobile

- [x] 4.1 index.html: login panel and API endpoints sections stack properly
- [x] 4.2 success.html: API key display and usage examples stack properly
- [x] 4.3 admin-login.html / admin-setup.html: form full-width on mobile

## 5. Verification

- [x] 5.1 `npx tsc --noEmit` passes
- [x] 5.2 `pnpm test` passes
- [x] 5.3 Visual: all pages at 375px viewport (iPhone SE) — no horizontal scroll
- [x] 5.4 Visual: admin page at 375px — cards render, actions work
- [x] 5.5 Visual: all pages at 768px viewport — desktop layout intact
