## 1. Warning banner

- [x] 1.1 Add warning banner HTML to `success.html` above the API key section
- [x] 1.2 Add `.key-warning` CSS styles to `style.css`

## 2. Confirmation button and flow

- [x] 2.1 Add "I've saved my key" button to `success.html`
- [x] 2.2 Implement confirmation logic: mask key, remove Show button, hide warning, update Usage Examples
- [x] 2.3 Use `sessionStorage` to persist confirmation state within tab session
- [x] 2.4 On page load, check `sessionStorage` and auto-mask if already confirmed

## 3. Usage Examples key consistency

- [x] 3.1 After confirmation, replace full key in Usage Examples with masked version
- [x] 3.2 Before confirmation, ensure Usage Examples show full key (current behavior, verify)

## 4. Verification

- [x] 4.1 `npx tsc --noEmit` passes
- [x] 4.2 `pnpm test` passes
- [x] 4.3 Manual: first view shows full key + warning + confirm button
- [x] 4.4 Manual: after confirm, key masked everywhere, Show button removed
- [x] 4.5 Manual: page refresh auto-masks (same tab)
