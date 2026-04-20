## ADDED Requirements

### Requirement: Paste and redirect callback URL
The system SHALL provide a UI on the home page where users can paste a Huawei OAuth callback URL. The frontend SHALL rewrite the URL's origin to the current proxy origin and navigate to it, allowing the existing `/callback` endpoint to process the request.

#### Scenario: User pastes callback URL and submits
- **WHEN** the user pastes `http://127.0.0.1:1455/callback?identifier=abc&redirect=yyy` into the input field and clicks submit
- **THEN** the frontend SHALL rewrite the URL to `{window.location.origin}/callback?identifier=abc&redirect=yyy` and navigate to it

#### Scenario: Pasted URL is not a valid callback URL
- **WHEN** the user pastes a URL that does not have a `/callback` path or does not contain an `identifier` query parameter
- **THEN** the frontend SHALL display an error message and not navigate

#### Scenario: Navigation triggers existing callback handler
- **WHEN** the browser navigates to the rewritten callback URL
- **THEN** the existing `GET /callback` handler SHALL process the request normally, correlating the login flow and completing authentication
