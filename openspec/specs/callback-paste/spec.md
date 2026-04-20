---
spec: callback-paste
status: implemented
priority: medium
created: 2026-04-20
updated: 2026-04-20
---

# Callback URL Paste

## Overview

The system provides a UI for manually pasting a Huawei OAuth callback URL when the automatic callback to 127.0.0.1 cannot reach the proxy (e.g. remote proxy). The frontend rewrites the URL's origin to the current proxy and opens it in the login window.

## Requirements

### Requirement: Paste and redirect callback URL
The system SHALL provide a UI on the home page where users can paste a Huawei OAuth callback URL. The frontend SHALL rewrite the URL's origin to the current proxy origin and open it in the login popup window, allowing the existing `/callback` endpoint to process the request.

#### Scenario: User pastes callback URL and submits
- **WHEN** the user pastes `http://127.0.0.1:1455/callback?identifier=abc&redirect=yyy` into the input field and clicks submit
- **THEN** the frontend SHALL rewrite the URL to `{window.location.origin}/callback?identifier=abc&redirect=yyy` and open it in the login popup window

#### Scenario: Pasted URL is not a valid callback URL
- **WHEN** the user pastes a URL that does not have a `/callback` path or does not contain an `identifier` query parameter
- **THEN** the frontend SHALL display an error message and not navigate

#### Scenario: Navigation triggers existing callback handler
- **WHEN** the browser navigates to the rewritten callback URL
- **THEN** the existing `GET /callback` handler SHALL process the request normally, correlating the login flow and completing authentication

### Requirement: Paste UI visibility
The paste callback URL section SHALL only be visible when the proxy is not accessed via localhost or 127.0.0.1, since the automatic callback works correctly in that case.

#### Scenario: Proxy accessed via localhost
- **WHEN** the proxy is accessed at `http://localhost:3000` or `http://127.0.0.1:3000`
- **THEN** the paste callback URL section SHALL be hidden

#### Scenario: Proxy accessed via remote host
- **WHEN** the proxy is accessed at a hostname other than localhost or 127.0.0.1
- **THEN** the paste callback URL section SHALL be visible
