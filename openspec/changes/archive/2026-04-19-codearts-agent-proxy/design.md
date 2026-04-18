## Context

This repository aims to provide a standalone proxy service that adapts Huawei Cloud CodeArts Agent into an OpenAI-compatible API. The reference implementation exists only inside packaged IDE extensions under code-base/. Those extensions reveal two credential layers: a lower-level temporary credential set (accessKey, secretKey, securitytoken, expires_at) used for signed refresh requests, and a higher-level business token used as x-auth-token for chat, SSE, review, and knowledge APIs. The target system must support multiple application users, and each user must be able to bind multiple Huawei Cloud accounts independently.

The implementation is cross-cutting: it requires HTTP API design, authentication/session persistence, browser-based login flow handling, request translation, SSE stream adaptation, secure secret storage, and account isolation. It also needs to reuse proven logic from the reference extensions where possible while avoiding IDE-coupled assumptions.

## Goals / Non-Goals

**Goals:**
- Provide OpenAI-compatible endpoints for model listing and chat completions, including streaming responses.
- Support multi-tenant users authenticated to the proxy with API keys.
- Allow each proxy user to bind and manage multiple Huawei Cloud accounts.
- Implement Huawei Cloud login initiation, callback completion, session persistence, and automatic refresh.
- Translate OpenAI request and response formats to and from CodeArts Agent upstream formats.
- Isolate credentials, caches, and refresh workflows per bound provider account.
- Reuse reference behavior from code-base/ for ticket exchange, signing, refresh timing, and SSE handling.

**Non-Goals:**
- Re-implement the entire CodeArts IDE experience or webview behavior.
- Support every OpenAI endpoint on day one beyond the minimal proxy surface needed to start.
- Build Huawei account creation or IAM administration features.
- Guarantee support for every hidden/private upstream feature exposed in the desktop extensions.

## Decisions

### 1. Use provider-account as the core isolation boundary
All Huawei Cloud credentials, business tokens, refresh locks, login flows, and upstream request routing will be keyed by provider_account_id rather than only user_id. This prevents cross-account token leakage for users with multiple bound Huawei Cloud accounts. The alternative of a user-global Huawei session was rejected because it cannot safely represent multiple concurrent accounts.

### 2. Split credential storage into business-token and base-session layers
The design stores both:
- business token material used for x-auth-token style requests
- base session material used for signed refresh operations (accessKey, secretKey, securitytoken, expires_at)

This follows the observed reference behavior where chat/review/rag calls use x-auth-token while refresh uses signed AK/SK/ST requests. The alternative of storing only business token data was rejected because it would not support automatic refresh. The alternative of storing only AK/SK/ST was rejected because current upstream business APIs appear to expect x-auth-token.

### 3. Use API-key-to-provider-account binding as the default client contract
Each proxy API key should map to one provider account by default. This keeps OpenAI SDK compatibility simple because most OpenAI clients only send a single Bearer token. A more flexible design where one API key maps to a user and requires extra headers for account selection was considered, but deferred because it complicates client usage and increases accidental cross-account routing risk.

### 4. Model login as an explicit asynchronous flow
Huawei login will be represented as a login_flow record with ticket_id, callback correlation data, status, expiration, and resulting provider_account association. The proxy initiates login, receives callback completion, exchanges ticket plus identifier for a session, and persists credentials. This mirrors the reference extension flow and avoids overloading user/session tables with in-flight login state.

### 5. Implement a translator boundary between OpenAI API and upstream CodeArts API
A dedicated translation layer will convert:
- OpenAI messages to upstream message structures and task parameters
- upstream streaming frames to OpenAI Chat Completions delta frames
- upstream errors to OpenAI-style HTTP and JSON error responses

This isolates protocol adaptation from HTTP routing and from credential management. Embedding translation directly in route handlers was rejected because it would make upstream evolution harder to manage.

### 6. Use secure secret storage with encryption-at-rest for provider sessions
secretKey and other upstream-sensitive values must be encrypted before persistence. The design assumes an application-level encryption key from environment/config and keeps plaintext only in process memory during active operations. Plaintext database storage was rejected due to direct credential compromise risk.

### 7. Use per-provider-account refresh coordination
Only one refresh operation should execute for a provider account at a time. Other requests encountering near-expiry credentials should wait on the same refresh promise/lock. This avoids thundering herds and inconsistent token replacement.

### 8. Reuse the new-api Codex architecture as the implementation pattern
The repository contains a useful reference implementation under code-base/new-api for Codex OAuth, credential refresh, refresh scheduling, and provider relay adaptation. The Huawei CodeArts proxy will reuse the same architectural pattern even though the upstream protocol differs.

The reuse mapping is:
- service/codex_oauth.go -> huawei-auth login flow module
  - Create a Huawei login flow object similar to the Codex authorization flow object.
  - Replace PKCE authorization-code exchange with ticket_id plus identifier exchange.
  - Keep the same separation between login initiation, callback completion, and refresh entrypoints.
- service/codex_credential_refresh.go -> provider-account session refresh service
  - Replace channel key parsing with session decrypt and unmarshal from the sessions table.
  - Replace refresh_token exchange with signed refresh using accessKey, secretKey, and securitytoken.
  - Persist refreshed session state back to storage and optionally reset relevant caches.
- service/codex_credential_refresh_task.go -> automatic Huawei credential refresh task
  - Reuse the task structure: one-time startup, master-node guard, atomic reentry protection, paged scanning, per-item timeout, and cache reset after successful refreshes.
  - Replace the Codex threshold rule with the Huawei refresh rule derived from the reference extension, including early refresh and jitter behavior.
- relay/channel/codex/ -> Huawei upstream adaptor module
  - Reuse the provider adaptor pattern to translate normalized proxy requests into Huawei upstream requests.
  - Add a dedicated adaptor for OpenAI-compatible request translation and streaming response conversion.

This decision reduces design risk by aligning with a proven gateway structure already present in the reference project. The alternative of inventing a new service shape from scratch was rejected because it would duplicate solved concerns around auth flow separation, scheduled refresh, and provider-specific adaptation.

## Risks / Trade-offs

- Upstream token ambiguity -> The exact relationship between cloudDragonToken and the token returned by ticket/session exchange is not fully proven. Mitigation: isolate token acquisition in one auth module and validate against real upstream behavior during implementation.
- Secret storage risk -> Persisting secretKey increases blast radius if storage is compromised. Mitigation: encryption-at-rest, narrow access paths, secret redaction in logs, and least-privilege operational practices.
- Protocol mismatch risk -> OpenAI and CodeArts request/stream formats do not align exactly. Mitigation: define translator tests around message mapping, finish reasons, streaming frames, and error conversion.
- Hidden upstream changes -> CodeArts upstream APIs may be private and subject to change. Mitigation: centralize endpoint/config definitions and wrap upstream handling with observability and fallback parsing.
- Browser login UX complexity -> Login initiation and callback handling may vary by deployment environment. Mitigation: define callback host/redirect config explicitly and store login flow state durably.
- Multi-account complexity -> Supporting multiple Huawei accounts per user increases routing and cache complexity. Mitigation: require explicit provider_account binding in API keys by default and enforce provider_account-scoped caches.
