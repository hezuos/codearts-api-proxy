## Why

The Huawei OAuth callback URL is hardcoded to `127.0.0.1` by the DevCloud server. When the proxy runs on a remote machine, the browser callback to `127.0.0.1` cannot reach the proxy, breaking the login flow. Users need a way to manually paste the callback URL from the browser address bar and continue authentication.

## What Changes

- Add a "Paste Callback URL" section to the Home page (index.html) with a text input and submit button
- On submit, the frontend parses the pasted URL, replaces the `127.0.0.1:port` host with the current proxy's origin (schema + host + port), and navigates to the rewritten URL
- The existing `GET /callback` endpoint handles the request normally — no backend changes needed

## Capabilities

### New Capabilities
- `callback-paste`: Frontend-only support for rewriting and navigating a pasted Huawei OAuth callback URL

### Modified Capabilities

(none — this is a purely additive feature with no backend changes)

## Impact

- `public/index.html`: New "Paste Callback URL" UI section
- `public/app.js`: New `pasteAndRedirectCallbackUrl()` helper function
- No backend changes — existing `/callback` endpoint handles the rewritten URL
- No breaking changes
