## 1. Frontend Implementation

- [x] 1.1 Add `pasteAndRedirectCallbackUrl()` function to `public/app.js` that parses the pasted URL, validates it has `/callback` path and `identifier` param, rewrites the origin to `window.location.origin`, and navigates via `window.location.href`
- [x] 1.2 Add "Paste Callback URL" card to `public/index.html` with a text input, submit button, and error display area

## 2. Validation

- [x] 2.1 Test that pasting a valid callback URL rewrites the host and navigates to the proxy's `/callback` endpoint
- [x] 2.2 Test that pasting an invalid URL (no `/callback` path or no `identifier`) shows an error and does not navigate
