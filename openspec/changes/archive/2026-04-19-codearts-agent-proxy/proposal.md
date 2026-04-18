## Why

Currently, teams using CodeArts Agent must interact through the IDE UI, which limits integration possibilities. There is no way to use CodeArts Agent's AI capabilities from other tools (like custom applications, CLI tools, or other IDEs) that already speak OpenAI protocol. This change creates a multi-tenant proxy server that: (1) enables each user to bind multiple Huawei Cloud accounts, (2) manages authentication and token lifecycle automatically, and (3) exposes an OpenAI-compatible API for seamless integration with existing tooling.

## What Changes

- **New proxy service** exposing OpenAI-compatible REST endpoints (chat/completions, models, etc.)
- **Multi-tenant user system** with API key authentication (Bearer tokens)
- **Per-user multi-account binding** - each user can link multiple Huawei Cloud accounts
- **Automatic token lifecycle management** - login via browser redirect, session refresh, expiration handling
- **Request translation layer** - convert OpenAI format requests to CodeArts/snap-access format
- **SSE streaming support** - proper Server-Sent Events handling for real-time responses
- **Account selection API** - allow clients to specify which bound account to use per request

## Capabilities

### New Capabilities

- `user-auth`: User registration, login, API key management, and session handling for the proxy itself
- `account-binding`: Binding/unbinding Huawei Cloud accounts to users, account listing, default account selection
- `huawei-auth`: Browser-based login flow for Huawei Cloud (ticket exchange), token storage, automatic refresh, session expiration handling
- `openai-api`: OpenAI-compatible REST endpoints (models, chat/completions with streaming), request validation, response formatting
- `request-translation`: OpenAI request format to CodeArts/snap-access format conversion, message role mapping, streaming delta transformation
- `sse-streaming`: Server-Sent Events handling for streaming responses, proper event formatting, connection management

### Modified Capabilities

(None - this is a greenfield project)

## Impact

- **New codebase** under `src/` - TypeScript/Node.js service
- **Database schema** for users, API keys, provider_accounts, sessions
- **External dependencies**: Express/fastify for HTTP, SSE libraries, encryption utilities, database ORM
- **Configuration**: Environment-based config for Huawei Cloud endpoints, database connection, session secrets
- **Reference implementations** from `code-base/` will be adapted (authentication flow, request signing, SSE parsing)
