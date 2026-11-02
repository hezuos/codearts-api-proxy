## MODIFIED Requirements

### Requirement: REQ-FWD-002: Forward request variants without flattening semantics

The proxy SHALL build upstream request bodies that preserve the semantic request mode, expressed in the OpenAI-compatible v2 request format.

**Rationale:** Different request types (standard, tool continuation, sub-agent) require different upstream request structures. The upstream v2 channel accepts an OpenAI-compatible body rather than the CodeArts-native body, so the request variants SHALL be expressed as OpenAI `messages` entries.

#### Scenario: Standard user turn with continuity

- **GIVEN** a client sends a normal chat turn with upstream continuity available (caller-provided `parent_message_id` or tracked `lastResponseMessageId` for the resolved `chat_id`)
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL send an upstream request whose `messages` payload represents the current user turn
- **AND** the proxy SHALL include the model identifier and generation parameters required for a standard v2 turn

#### Scenario: Standard user turn without continuity

- **GIVEN** a client sends a normal chat turn with no upstream continuity available
- **AND** the client message history contains more than the current turn
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL send an upstream request whose `messages` payload is a single folded `text` message containing the full history

#### Scenario: Tool continuation turn

- **GIVEN** a client sends tool execution results for a prior upstream tool call
- **AND** the proxy can confirm the `tool_call_id` matches a known CodeArts-issued call (caller-provided linkage or tracked `lastResponseMessageId` present)
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL send the tool execution results as OpenAI `role: "tool"` messages carrying the matching `tool_call_id`
- **AND** the proxy SHALL include the preceding assistant message carrying the corresponding `tool_calls`

#### Scenario: Sub-agent turn

- **GIVEN** a client sends a request that targets a sub-agent workflow
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL express the sub-agent intent in a form the v2 channel accepts, or degrade to a standard turn when the v2 channel does not support sub-agent semantics
- **AND** the proxy SHALL restrict the forwarded tool catalog to the sub-agent tool set

### Requirement: REQ-FWD-003: Use context-appropriate tool catalogs and model routing

The proxy SHALL forward upstream tool definitions and model identifiers that match the selected request mode.

**Rationale:** Different request modes require different tool catalogs and model configurations. Model identifiers SHALL be forwarded as the v2 channel expects them, including models only available on that channel.

#### Scenario: Standard request tool catalog

- **GIVEN** the proxy forwards a standard request
- **WHEN** the request is constructed
- **THEN** the proxy SHALL use the validated default tool catalog for standard turns

#### Scenario: Sub-agent tool catalog

- **GIVEN** the proxy forwards a sub-agent request
- **WHEN** the request is constructed
- **THEN** the proxy SHALL use the validated reduced tool catalog for that sub-agent mode

#### Scenario: Known model routing

- **GIVEN** a client requests a model name that has a validated upstream model mapping
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL forward the corresponding validated upstream `model` identifier

#### Scenario: Model only available on the v2 channel

- **GIVEN** a client requests a model that the CodeArts-native channel does not serve
- **WHEN** the proxy constructs the upstream request
- **THEN** the proxy SHALL forward the request through the v2 channel
- **AND** the proxy SHALL NOT surface a channel-unsupported error to the client

### Requirement: REQ-FWD-004: Surface tool calls and maintain continuation metadata

The proxy SHALL translate upstream tool-call responses into OpenAI-compatible response fields and retain the metadata needed for continuation.

**Rationale:** Tool calls must be properly translated and continuation metadata preserved for subsequent requests. On the v2 channel the upstream does not return a CodeArts-native parent linkage identifier, so continuation SHALL rely on the client's echoed history and the proxy's chain state.

#### Scenario: Upstream returns tool calls

- **GIVEN** the upstream returns one or more tool calls in a response
- **WHEN** the proxy processes the response
- **THEN** the proxy SHALL expose them in the OpenAI-compatible response as tool calls
- **AND** the proxy SHALL retain any upstream linkage metadata required for the next continuation turn

#### Scenario: Process restart after a prior turn

- **GIVEN** the proxy restarts after previously handling a conversation with in-memory upstream linkage metadata
- **WHEN** the proxy processes the next request for that conversation
- **THEN** the proxy SHALL NOT assume the upstream thread can be resumed (in-memory linkage is lost on restart; there is no persisted conversation state for chat linkage)
- **AND** the proxy SHALL treat the request per the full-context injection rules of the `full-context-injection` capability (inject folded history when the restart lost all linkage and the client history contains more than the current turn)
- **AND** when the client provides `codearts.parent_message_id`, the proxy SHALL trust the caller-provided linkage and resume incrementally