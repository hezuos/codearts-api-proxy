## Why

The success page currently shows the full API key with a Show/Hide toggle, but the Usage Examples section always displays the key in plaintext. Users may not realize the key should be saved immediately. After leaving the page, the key can still be retrieved (cookie persists), giving a false sense of security. The UX should make it clear that the key is shown only once and encourage immediate saving.

## What Changes

- Add a prominent warning banner on the success page telling users to save their API key immediately
- Show the full key on first view, with a "I've saved it" confirmation button
- After confirmation, mask the key everywhere (including Usage Examples) and remove the Show button
- Use `sessionStorage` to remember the confirmation state within the browser session
- On page refresh within the same session, auto-mask the key; new tab/window allows one more view

## Capabilities

### New Capabilities
- `success-key-once`: One-time API key display with confirmation flow on the success page

### Modified Capabilities

## Impact

- `public/success.html`: Warning banner, confirmation button, sessionStorage logic, Usage Examples key masking
- `public/app.js`: No changes needed (logic is page-specific, stays in inline script)
- `public/style.css`: Warning banner styles
