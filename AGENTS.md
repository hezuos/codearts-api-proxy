# AGENTS.md

## 使用中文
- 文档使用中文
- LLM 输出和think使用中文
- 注释使用中文

## Project overview

OpenAI-compatible proxy that wraps the Huawei CodeArts Agent LLM API.
Clients (e.g. OpenCode) talk standard OpenAI `/v1/chat/completions`; the proxy signs requests with AK/SK and speaks the CodeArts SSE protocol upstream.

## Package manager

**Use `pnpm` for all package operations.**

```bash
pnpm install        # Install dependencies
pnpm run build      # Compile TypeScript
pnpm run dev        # Development mode
pnpm start          # Run compiled code
pnpm test           # Run tests
pnpm run lint       # Lint code
```

Always run `pnpm run build` after changes to verify zero TypeScript errors before committing.

## Key commands

```bash
pnpm run build      # tsc — compile src/ → dist/
pnpm run dev        # run via ts-node (no build needed)
pnpm start          # run compiled dist/index.js
pnpm test           # src/upstream/huawei/chat.test.ts via ts-node
pnpm run lint       # eslint src/**/*.ts
```

## Architecture

```
src/
  index.ts                        # Express app wiring + startup
  config.ts                       # All env vars with defaults
  auth/
    store.ts                      # In-memory API-key store, persisted to data/auth-store.json
    admin.ts                      # Admin password management (bcrypt)
    huawei/
      sign.ts                     # AK/SK HMAC-SHA256 request signing (do not touch)
      session-store.ts            # Persists Huawei sessions → data/huawei-sessions.json
      refresh.ts / refresh-task.ts# Background token refresh
  middleware/
    authenticate-api-key.ts       # Bearer token auth for API routes
    authenticate-ui.ts            # Cookie auth for UI pages
    authenticate-admin.ts         # Admin session auth
  routes/
    openai.ts                     # POST /v1/chat/completions, GET /v1/models
    huawei-auth.ts                # OAuth login flow routes
    provider-accounts.ts          # Account management API
  upstream/huawei/
    chat.ts                       # Core: buildRequestBody → httpsPost → SSE passthrough
    tools.ts                      # DEFAULT_TOOLS / SUB_AGENT_TOOLS schemas
  types/openai.ts                 # Shared request/response types (codearts extension fields here)
public/                           # Static HTML/CSS/JS for Web UI
  index.html                      # Home page
  success.html                    # Post-login success page
  status.html                     # Account status dashboard
  admin.html                      # Admin control panel
  admin-login.html                # Admin login page
  admin-setup.html                # Admin password setup page
  style.css                       # Minimal styling
  app.js                          # Shared JavaScript utilities
```

## Critical design rules (do not violate)

- **Proxy is stateless except one Map**: `lastResponseMessageId: Map<chat_id, response_message_id>` in `chat.ts`. This is intentional — do not add more state.
- **`chat_id` derivation**: SHA-256 of the first user/system message content (first 32 hex chars). Never use `randomUUID()` for `chat_id`.
- **`parent_message_id`**: only update the Map on _successful_ SSE turns (no `error_code`). On error, preserve old value so retries work.
- **`extractToolResults`**: only extracts tool messages when `messages[last].role === "tool"`. If last message is `user`, return `[]` — this is a new user turn, not a tool continuation.
- **`task_parameters.environmentDetails.currentWorkingDirectory`**: must come from caller (`request.codearts.current_working_directory`). Never use `process.cwd()`.
- **`osVersion`**: default `"win32"` (matches captures). Never use `process.platform`.
- **`Task.subagent_type`**: normalize to lowercase via `normalizeToolCallArguments` — CodeArts LLM emits mixed case, OpenCode only accepts lowercase.

## Environment variables

All have defaults safe for local dev (see `src/config.ts`). Notable ones:

| Var               | Default                            | Notes                                   |
| ----------------- | ---------------------------------- | --------------------------------------- |
| `PORT`            | `1455`                             |                                         |
| `ENCRYPTION_KEY`  | `dev-only-32-byte-encryption-key!` | Change in production                    |
| `DEFAULT_API_KEY` | `dev-openai-compatible-key`        | Bearer token clients must send          |
| `IDE_VERSION`     | `26.3.11`                          | Must match CodeArts server expectations |
| `PLUGIN_VERSION`  | `26.3.5`                           | Must match CodeArts server expectations |
| `ADMIN_PASSWORD`  | (none)                             | Admin password (env takes precedence)   |

## Data files (not in git)

`data/` is gitignored. Contains:

- `auth-store.json` — API keys
- `huawei-sessions.json` — AK/SK + tokens (sensitive)
- `admin-config.json` — Admin password hash (bcrypt)
- `conversation-store.json` — legacy, no longer used

## Web UI

The proxy serves static HTML pages from `public/` directory:

- `/` — Home page with login links
- `/success` — Post-login page showing account info and API key (requires `auth_key` cookie)
- `/status` — Account status dashboard (requires `auth_key` cookie)
- `/admin` — Admin control panel (requires `admin_session` cookie)
- `/admin/login` — Admin login page
- `/admin/setup` — Admin password setup (shown if no admin configured)

Authentication:

- User pages use `auth_key` cookie (same value as API key)
- Admin pages use `admin_session` cookie
- Cookie attributes: `httpOnly`, `secure` (production), `sameSite`

## Reference material

- `docs/codearts-api-spec.md` — CodeArts chat API field reference
- `docs/request-and-api.md` — field sourcing rules (PASSTHROUGH / PROTOCOL / CALLER_OR_DEFAULT)
- `scripts/captured-request-*.json` — real IDE request captures (ground truth for request shape)
- `simple-example/proxy.js` — minimal proxy style reference
