## 1. Configuration

- [x] 1.1 Add `HUAWEI_GPTS_URL`, `HUAWEI_AGENT_ID`, `HUAWEI_IS_INNER_VERSION`, `MODEL_CACHE_TTL` to `AppConfig` interface and `config` object in `src/config.ts`
- [x] 1.2 Add GPTs URL derivation logic (internal vs external path) with defaults based on `HUAWEI_CHAT_HOST` and `HUAWEI_IS_INNER_VERSION`

## 2. Model Fetch Module

- [x] 2.1 Create `src/upstream/huawei/models.ts` with `fetchModelList()` function that calls `{gptsUrl}/detail?agent_id={agentId}` with AK/SK signed headers and `x-auth-token`
- [x] 2.2 Implement internal version response parsing (`.json()` wrapper) vs external version (direct response)
- [x] 2.3 Implement `supported_clients` filtering for internal version models
- [x] 2.4 Extract model IDs from `gpts.models` array and convert to OpenAI-compatible model objects
- [x] 2.5 Implement graceful fallback: on fetch failure, return static models from `MODEL_MAP`

## 3. Model Cache

- [x] 3.1 Implement in-memory TTL cache for model list in `src/upstream/huawei/models.ts`
- [x] 3.2 Add cache invalidation support via `?refresh=true` query parameter
- [x] 3.3 Ensure cache is per-provider-account (different accounts may have different available models)

## 4. Model List Composition

- [x] 4.1 Implement merge logic: dynamic models + static `MODEL_MAP` aliases, with dynamic taking precedence on ID collision
- [x] 4.2 Ensure static aliases (gpt-4, gpt-4o, etc.) always appear even if not in dynamic list
- [x] 4.3 Update `buildModelsResponse()` in `src/translation/openai-mock.ts` to accept dynamic models parameter

## 5. Route Handler Update

- [x] 5.1 Update `listModels()` in `src/routes/openai.ts` to be async, require auth, resolve provider account, and call the dynamic model fetch
- [x] 5.2 Add `?refresh=true` query parameter handling for cache invalidation
- [x] 5.3 Update route registration in `src/index.ts` if needed (async handler)

## 6. Testing

- [x] 6.1 Verify `GET /v1/models` returns dynamic models when upstream is available
- [x] 6.2 Verify fallback to static models when upstream is unavailable
- [x] 6.3 Verify `?refresh=true` bypasses cache
- [x] 6.4 Verify 401 response for unauthenticated requests
