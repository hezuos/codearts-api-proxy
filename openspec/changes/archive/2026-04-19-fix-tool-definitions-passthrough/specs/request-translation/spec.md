## MODIFIED Requirements

### REQ-TRANS-001: Request message translation

The system SHALL translate OpenAI chat request messages into the upstream CodeArts-compatible request format. When the caller provides `tools` in the request, the system SHALL use those tool definitions (converted to CodeArts format) for `task_parameters.tools` instead of hardcoded definitions. When the caller does not provide `tools`, the system SHALL fall back to hardcoded tool definitions.

**Rationale:** OpenCode sends its own tool definitions that match its validation rules. Using caller-provided tools eliminates the mismatch between what the LLM sees and what the client validates.

#### Scenario: Roles and content are translated

- **GIVEN** a client submits OpenAI-format messages
- **WHEN** the system processes the request
- **THEN** the system SHALL map supported roles and content into an upstream request body
- **AND** the upstream request SHALL be accepted by CodeArts services

#### Scenario: Caller tools are forwarded to CodeArts

- **GIVEN** a client submits a request with a non-empty `tools` array
- **WHEN** the system builds the CodeArts request body
- **THEN** the system SHALL convert the caller's tools to CodeArts format and use them as `task_parameters.tools`

#### Scenario: Fallback to hardcoded tools when caller omits them

- **GIVEN** a client submits a request without `tools` or with an empty `tools` array
- **WHEN** the system builds the CodeArts request body
- **THEN** the system SHALL use the hardcoded `DEFAULT_TOOLS` as `task_parameters.tools`
