## Why

The `/v1/models` endpoint currently returns a hardcoded single model (`codearts-chat`). Clients (OpenCode, Continue, etc.) need the actual available model list to present model selection UI. CodeArts upstream provides model information via the agent-center detail API, but the proxy never queries it — resulting in a static, uninformative model list that doesn't reflect what models are actually available to the authenticated user.

## What Changes

- Replace the hardcoded `buildModelsResponse()` with a dynamic implementation that fetches available models from the CodeArts upstream agent-center API
- Add a model list fetcher module (`src/upstream/huawei/models.ts`) that calls `{gptsUrl}/detail?agent_id={agentId}` and extracts the `gpts.models` array
- Support both internal version and external version API paths (different URL structures and response parsing)
- Cache fetched models in-memory with TTL to avoid hammering upstream on every `/v1/models` call
- Merge dynamically fetched models with the existing `MODEL_MAP` static entries so well-known aliases (gpt-4, etc.) remain available
- Add `HUAWEI_GPTS_URL` and `HUAWEI_AGENT_ID` config options (with sensible defaults derived from existing hosts)
- The `listModels` route handler becomes async and requires a valid session (same auth flow as chat completions)

## Capabilities

### New Capabilities
- `dynamic-model-list`: Fetching and serving available model list from CodeArts upstream, with internal/external version support, in-memory caching, and merge with static model aliases

### Modified Capabilities
- `openai-api`: The `GET /v1/models` endpoint changes from static to dynamic (requires auth, returns real models)

## Impact

- **API**: `GET /v1/models` now requires a valid Bearer token (same as chat completions) and returns dynamically fetched models
- **Code**: New module `src/upstream/huawei/models.ts`; modifications to `src/routes/openai.ts`, `src/translation/openai-mock.ts`, `src/config.ts`
- **Config**: New env vars `HUAWEI_GPTS_URL`, `HUAWEI_AGENT_ID`, `MODEL_CACHE_TTL`
- **Dependencies**: No new external dependencies (uses existing axios + AK/SK signing)
