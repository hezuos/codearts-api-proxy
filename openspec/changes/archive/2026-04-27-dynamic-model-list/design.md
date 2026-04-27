## Context

The proxy currently serves a hardcoded model list (`codearts-chat`) at `GET /v1/models`. The CodeArts upstream exposes model information through the agent-center detail API (`{gptsUrl}/detail?agent_id=...`), which returns a `gpts.models` array with model metadata including `model_parameters.supported_clients`.

From reverse-engineering the CodeArts VS Code extension, two distinct API patterns exist:

**Internal version (isInnerVersion = true)**:
- GPTs URL: `{policyCenterDomain}/PromptCenterService/v1/agent-center/agents`
- Response needs `.json()` parsing (wrapped response)
- Models filtered by `supported_clients` (must include `"all"` or match IDE type)

**External version (isInnerVersion = false)**:
- GPTs URL: `{policyCenterDomain}/v1/agent-center/agents`
- Response used directly
- No `supported_clients` filtering

The proxy already has AK/SK signing infrastructure and session management. The model list fetch can reuse the same auth flow as chat completions.

## Goals / Non-Goals

**Goals:**
- Dynamically fetch available models from CodeArts upstream agent-center API
- Support both internal and external version API paths
- Cache model list with TTL to reduce upstream calls
- Merge dynamic models with static `MODEL_MAP` aliases for backward compatibility
- Return proper OpenAI-compatible model list response

**Non-Goals:**
- Supporting OCA/Oracle model list fetching (separate provider, out of scope)
- Supporting Ollama/LM Studio/Groq/etc. model lists (those are direct provider integrations, not CodeArts)
- Model capability metadata beyond what OpenAI `/v1/models` requires (no context_window, pricing, etc. in the list response)
- Real-time model list updates via WebSocket/SSE subscription
- Per-user model filtering based on entitlements

## Decisions

### 1. Model fetch endpoint: `{gptsUrl}/detail?agent_id={agentId}`

**Rationale**: This is the same endpoint the CodeArts extension uses. It returns both task list and model list in a single call. The `agent_id` parameter determines which agent's models to return (default: `Pangu_Doer_in_CodeArts`).

**Alternative considered**: A dedicated model list API — but no such dedicated endpoint was found in the extension code. The agent detail endpoint is the canonical source.

### 2. Internal vs External version: configurable via `HUAWEI_IS_INNER_VERSION` env var

**Rationale**: The proxy doesn't have the CodeArts IDE's `isInnerVersion` flag. We expose it as a config option. Default: `false` (external), since the proxy is typically deployed outside the internal network.

**Alternative considered**: Auto-detect by trying internal URL first, then falling back to external — rejected because it adds latency and complexity for a one-time config choice.

### 3. Caching strategy: In-memory with TTL (default 5 minutes)

**Rationale**: Model lists change infrequently. A simple TTL cache avoids upstream calls on every `/v1/models` request. In-memory (not persisted to disk) because stale data on restart is acceptable — the cache will repopulate on first request.

**Alternative considered**: ETag/If-None-Match conditional requests — rejected because the upstream may not support standard HTTP caching headers.

### 4. Model list composition: Dynamic models + static MODEL_MAP aliases

**Rationale**: The static `MODEL_MAP` provides well-known aliases (gpt-4, gpt-4o, etc.) that clients expect. Dynamic models provide the actual available models. Both should appear in the list. Dedup by model ID — if a dynamic model has the same ID as a static entry, the dynamic one wins (it has real metadata).

### 5. Auth requirement for `/v1/models`: Same Bearer token as chat completions

**Rationale**: The upstream API requires `x-auth-token`. We need a valid session to sign requests. Making `/v1/models` require auth is consistent and necessary. Unauthenticated requests get a 401, same as chat completions.

**Alternative considered**: Allow unauthenticated requests with a cached/stale model list — rejected because it leaks model information to unauthenticated users.

### 6. GPTs URL construction: Derived from existing config hosts

**Rationale**: The `policyCenterDomain` is part of the chat host infrastructure. We derive the GPTs URL from `HUAWEI_CHAT_HOST` by default, with an override via `HUAWEI_GPTS_URL` env var.

**Internal default**: `{chatHost}/PromptCenterService/v1/agent-center/agents`
**External default**: `{chatHost}/v1/agent-center/agents`

## Risks / Trade-offs

- **[Upstream API instability]** The agent-center detail API is not officially documented. If it changes, the model fetch breaks. → Mitigation: Graceful fallback to static MODEL_MAP models on fetch failure. The `/v1/models` endpoint always returns at least the static models.

- **[Internal/External version mismatch]** If `HUAWEI_IS_INNER_VERSION` is set incorrectly, the URL path and response parsing will be wrong. → Mitigation: Clear error logging on fetch failure. The fallback to static models ensures the proxy remains functional.

- **[Cache staleness]** New models won't appear until the cache expires. → Mitigation: Short TTL (5 min default) + manual cache invalidation via `DELETE /v1/models/cache` or a model refresh query param.

- **[Agent ID dependency]** The default agent ID (`Pangu_Doer_in_CodeArts`) may not be available in all deployments. → Mitigation: Configurable via `HUAWEI_AGENT_ID` env var. If the agent doesn't exist, fallback to static models.
