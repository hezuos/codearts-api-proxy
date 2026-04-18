## 1. Project Bootstrap

- [x] 1.1 Initialize TypeScript project with package.json and tsconfig
- [x] 1.2 Configure linting and formatting (ESLint + Prettier)
- [x] 1.3 Add runtime dependencies (HTTP framework, DB client, crypto/SSE utilities)
- [x] 1.4 Set up environment config and secrets management
- [x] 1.5 Create base directory layout (src/routes, src/auth, src/db, src/translation, src/upstream)

## 2. Database Schema and Core Models

- [x] 2.1 Define user table schema and model
- [x] 2.2 Define api_keys table schema and model with provider_account binding
- [x] 2.3 Define provider_accounts table schema and model
- [x] 2.4 Define sessions table schema (business_token and base_session columns, encryption)
- [x] 2.5 Define login_flows table schema
- [x] 2.6 Implement encryption-at-rest helper for sensitive columns

## 3. Proxy User Authentication (user-auth)

- [x] 3.1 Implement user creation and lookup
- [x] 3.2 Implement API key issuance and storage
- [x] 3.3 Implement API key validation middleware
- [x] 3.4 Add user isolation checks to request context

## 4. Huawei Account Binding (account-binding)

- [x] 4.1 Implement provider_accounts CRUD per user
- [x] 4.2 Implement account listing endpoint with status
- [x] 4.3 Implement default account selection logic
- [x] 4.4 Implement account unbinding and session cleanup

## 5. Huawei Login and Session Management (huawei-auth)

### 5.1 Login flow (reference: new-api/service/codex_oauth.go)

- [x] 5.1.1 Define HuaweiLoginFlow struct with ticket_id, login_url, state, expires_at
- [x] 5.1.2 Implement CreateHuaweiLoginFlow to generate ticket_id and build redirect1 URL
- [x] 5.1.3 Implement callback handler to receive identifier and correlate with pending flow
- [x] 5.1.4 Implement ExchangeTicket to call upstream /v2/login/ticket with ticket_id and identifier
- [x] 5.1.5 Parse upstream session result and extract AK/SK/ST/expires_at plus business token
- [ ] 5.1.6 Add proxy support for login upstream requests (optional but recommended)

### 5.2 Session persistence after login (reference: new-api/service/codex_credential_refresh.go)

- [x] 5.2.1 Implement session encrypt and decrypt helpers
- [x] 5.2.2 Persist session to sessions table with provider_account association
- [ ] 5.2.3 Store derived fields such as user_id, user_name, domain_id if present

### 5.3 Credential refresh service (reference: new-api/service/codex_credential_refresh.go)

- [x] 5.3.1 Implement RefreshHuaweiSession to read session, decrypt, and call refresh endpoint
- [x] 5.3.2 Adapt signing logic from huaweicloud.authentication plugin for refresh requests
- [x] 5.3.3 Update session in storage after successful refresh
- [x] 5.3.4 Reset relevant in-memory caches after refresh

### 5.4 Automatic refresh task (reference: new-api/service/codex_credential_refresh_task.go)

- [x] 5.4.1 Implement master-node guard to run task on single instance
- [ ] 5.4.2 Use sync.Once and atomic.Bool to guarantee single task startup and reentry protection
- [x] 5.4.3 Implement paged scanning of provider_accounts with near-expiry sessions
- [x] 5.4.4 Add per-item refresh timeout and error logging
- [x] 5.4.5 Reset caches after batch refresh completes
- [x] 5.4.6 Use the Huawei refresh threshold rule derived from auth extension behavior

### 5.5 Expiration and failure handling

- [ ] 5.5.1 Mark provider_account status as invalid when refresh fails and session is expired
- [ ] 5.5.2 Emit structured logs and metrics for refresh failures
- [x] 5.5.3 Provide admin endpoint to manually trigger refresh for a specific account

## 6. OpenAI-Compatible API (openai-api)

- [x] 6.1 Implement GET /v1/models endpoint
- [x] 6.2 Implement POST /v1/chat/completions (non-streaming)
- [x] 6.3 Implement POST /v1/chat/completions (streaming SSE)
- [x] 6.4 Add request validation and OpenAI schema checks
- [x] 6.5 Integrate provider account routing per API key

## 7. Request and Response Translation (request-translation)

- [x] 7.1 Implement OpenAI messages to upstream message format converter
- [x] 7.2 Implement upstream non-streaming response to OpenAI response converter
- [ ] 7.3 Implement error mapping from upstream to OpenAI-style error bodies
- [ ] 7.4 Add unit tests for translation edge cases

## 8. SSE Streaming (sse-streaming)

- [x] 8.1 Implement upstream SSE client with robust line/heartbeat handling
- [x] 8.2 Implement OpenAI delta event emitter for downstream clients
- [x] 8.3 Add stream termination and completion markers
- [ ] 8.4 Add error handling and client disconnect cleanup

## 9. Observability and Operations

- [ ] 9.1 Add structured logging for auth, routing, and upstream calls
- [x] 9.2 Add request tracing IDs matching upstream expectations
- [x] 9.3 Add health and readiness endpoints
- [ ] 9.4 Document configuration and deployment steps
