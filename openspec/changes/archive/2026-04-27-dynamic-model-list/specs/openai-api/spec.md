## MODIFIED Requirements

### REQ-API-001: Models endpoint

The system SHALL provide an OpenAI-compatible models endpoint that dynamically fetches available models from the CodeArts upstream agent-center API. The endpoint SHALL require valid Bearer token authentication. The response SHALL contain both dynamically fetched models and static alias models from `MODEL_MAP`.

**Rationale:** Clients need real available model information for model selection UI. A hardcoded single model is insufficient.

#### Scenario: Client requests models

- **GIVEN** a client has valid authentication and a bound provider account
- **WHEN** the client calls the models endpoint
- **THEN** the system SHALL return an OpenAI-compatible models response containing dynamically fetched models merged with static alias models

#### Scenario: Client requests models without authentication

- **GIVEN** a client has no valid authentication
- **WHEN** the client calls the models endpoint
- **THEN** the system SHALL return HTTP 401 with an OpenAI-style error response
