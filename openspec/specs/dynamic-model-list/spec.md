---
spec: dynamic-model-list
status: implemented
priority: high
created: 2026-04-21
updated: 2026-04-28
---

# Dynamic Model List

## Overview

The system SHALL dynamically fetch available models from the CodeArts upstream agent-center API, cache them with TTL, and merge with static alias models.

## Requirements

### Requirement: Dynamic model list fetching from CodeArts upstream
The system SHALL fetch available models from the CodeArts agent-center detail API (`{gptsUrl}/detail?agent_id={agentId}`) and return them in the OpenAI-compatible `GET /v1/models` response format.

#### Scenario: Successful model list fetch (external version)
- **WHEN** a client sends `GET /v1/models` with a valid Bearer token, and `HUAWEI_IS_INNER_VERSION` is `false`
- **THEN** the system SHALL call `{chatHost}/v1/agent-center/agents/detail?agent_id={agentId}` with AK/SK signed headers and `x-auth-token`, parse the response directly, extract `gpts.models`, and return an OpenAI-compatible model list

#### Scenario: Successful model list fetch (internal version)
- **WHEN** a client sends `GET /v1/models` with a valid Bearer token, and `HUAWEI_IS_INNER_VERSION` is `true`
- **THEN** the system SHALL call `{chatHost}/PromptCenterService/v1/agent-center/agents/detail?agent_id={agentId}` with AK/SK signed headers and `x-auth-token`, parse the response via `.json()`, extract `gpts.models`, filter by `supported_clients` (include models where `supported_clients` contains `"all"` or the IDE type), and return an OpenAI-compatible model list

#### Scenario: Model list fetch failure falls back to static models
- **WHEN** the upstream agent-center API returns an error, times out, or is unreachable
- **THEN** the system SHALL return the static model list derived from `MODEL_MAP` entries, and log a warning about the fetch failure

### Requirement: Model list caching with TTL
The system SHALL cache the fetched model list in memory with a configurable TTL (default: 300 seconds / 5 minutes). Subsequent `GET /v1/models` requests within the TTL SHALL return the cached list without calling upstream.

#### Scenario: Cache hit within TTL
- **WHEN** a `GET /v1/models` request arrives and the cache is populated and not expired
- **THEN** the system SHALL return the cached model list without making an upstream API call

#### Scenario: Cache miss or expired
- **WHEN** a `GET /v1/models` request arrives and the cache is empty or expired
- **THEN** the system SHALL fetch models from upstream, update the cache, and return the result

#### Scenario: Cache invalidation
- **WHEN** a client sends `GET /v1/models?refresh=true`
- **THEN** the system SHALL invalidate the cache and fetch fresh models from upstream

### Requirement: Static and dynamic model merge
The system SHALL merge dynamically fetched models with static `MODEL_MAP` alias entries. If a dynamic model has the same ID as a static entry, the dynamic model SHALL take precedence. Static-only models (aliases like `gpt-4`, `gpt-4o`) SHALL always be included.

#### Scenario: Dynamic models include a model also in MODEL_MAP
- **WHEN** the upstream returns a model with ID `Glm-4.7-internal` which also exists in `MODEL_MAP`
- **THEN** the model SHALL appear once in the response, using the dynamic model's metadata

#### Scenario: Static alias not in dynamic list
- **WHEN** a static alias like `gpt-4` maps to `Glm-4.7-internal` but `gpt-4` itself is not in the dynamic list
- **THEN** `gpt-4` SHALL still appear in the model list as an alias, with `owned_by: "codearts-agent-proxy"`

### Requirement: Model list requires authentication
The `GET /v1/models` endpoint SHALL require a valid Bearer token, consistent with the `POST /v1/chat/completions` endpoint.

#### Scenario: Unauthenticated request
- **WHEN** a client sends `GET /v1/models` without a valid Bearer token
- **THEN** the system SHALL return HTTP 401 with an OpenAI-style error response

#### Scenario: Authenticated request with no provider account
- **WHEN** a client sends `GET /v1/models` with a valid API key but no bound provider account
- **THEN** the system SHALL return HTTP 400 with an error indicating no provider account is configured

### Requirement: Configurable GPTs URL and agent ID
The system SHALL support `HUAWEI_GPTS_URL` and `HUAWEI_AGENT_ID` environment variables with defaults derived from existing configuration.

#### Scenario: Custom GPTs URL
- **WHEN** `HUAWEI_GPTS_URL` is set to a custom URL
- **THEN** the system SHALL use that URL as the base for the agent detail API call

#### Scenario: Default GPTs URL (external)
- **WHEN** `HUAWEI_GPTS_URL` is not set and `HUAWEI_IS_INNER_VERSION` is `false`
- **THEN** the system SHALL use `{HUAWEI_CHAT_HOST}/v1/agent-center/agents` as the GPTs URL

#### Scenario: Default GPTs URL (internal)
- **WHEN** `HUAWEI_GPTS_URL` is not set and `HUAWEI_IS_INNER_VERSION` is `true`
- **THEN** the system SHALL use `{HUAWEI_CHAT_HOST}/PromptCenterService/v1/agent-center/agents` as the GPTs URL

#### Scenario: Default agent ID
- **WHEN** `HUAWEI_AGENT_ID` is not set
- **THEN** the system SHALL use `Pangu_Doer_in_CodeArts` as the default agent ID
