# AGENTS.md

## Project overview

OpenAI-compatible proxy that wraps the Huawei CodeArts Agent LLM API.
Clients (e.g. OpenCode) talk standard OpenAI `/v1/chat/completions`; the proxy signs requests with AK/SK and speaks the CodeArts SSE protocol upstream.

## Key commands

```bash
npm run build      # tsc — compile src/ → dist/
npm run dev        # run via ts-node (no build needed)
npm start          # run compiled dist/index.js
npm test           # src/upstream/huawei/chat.test.ts via ts-node
npm run lint       # eslint src/**/*.ts
```

Always run `npm run build` after changes to verify zero TypeScript errors before committing.

## Architecture

```
src/
  index.ts                        # Express app wiring + startup
  config.ts                       # All env vars with defaults
  auth/
    store.ts                      # In-memory API-key store, persisted to data/auth-store.json
    huawei/
      sign.ts                     # AK/SK HMAC-SHA256 request signing (do not touch)
      session-store.ts            # Persists Huawei sessions → data/huawei-sessions.json
      refresh.ts / refresh-task.ts# Background token refresh
  routes/
    openai.ts                     # POST /v1/chat/completions, GET /v1/models
    huawei-auth.ts                # OAuth login flow routes
  upstream/huawei/
    chat.ts                       # Core: buildRequestBody → httpsPost → SSE passthrough
    tools.ts                      # DEFAULT_TOOLS / SUB_AGENT_TOOLS schemas
  types/openai.ts                 # Shared request/response types (codearts extension fields here)
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

## Data files (not in git)

`data/` is gitignored. Contains:

- `auth-store.json` — API keys
- `huawei-sessions.json` — AK/SK + tokens (sensitive)
- `conversation-store.json` — legacy, no longer used

## Reference material

- `docs/codearts-api-spec.md` — CodeArts chat API field reference
- `docs/request-and-api.md` — field sourcing rules (PASSTHROUGH / PROTOCOL / CALLER_OR_DEFAULT)
- `scripts/captured-request-*.json` — real IDE request captures (ground truth for request shape)
- `simple-example/proxy.js` — minimal proxy style reference
