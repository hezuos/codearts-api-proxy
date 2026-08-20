## MODIFIED Requirements

### Requirement: Preserve upstream conversation continuity

The proxy SHALL preserve CodeArts conversation continuity across turns by reusing the correct upstream conversation identifiers.

**Rationale:** Creating a new upstream conversation for every request would lose context and break multi-turn interactions.

#### Scenario: Continue an existing upstream thread

- **GIVEN** a client sends a follow-up request for a previously established proxy conversation
- **WHEN** the proxy processes the request
- **THEN** the proxy SHALL reuse the stored upstream `chat_id`
- **AND** the proxy SHALL forward the latest stored upstream parent linkage identifier required by CodeArts

#### Scenario: Continue a thread after verifying the chain is intact

- **GIVEN** a client sends a follow-up request for a previously established proxy conversation
- **AND** the client does NOT provide `codearts.parent_message_id`
- **AND** the proxy has tracked chain state for the resolved `chat_id`
- **AND** divergence detection classifies the history as a normal continuation (prefix chain matches and the message at the tracked chain boundary matches the proxy's last returned reply)
- **WHEN** the proxy processes the request
- **THEN** the proxy SHALL reuse the stored upstream `chat_id`
- **AND** the proxy SHALL forward the latest stored upstream parent linkage identifier
- **AND** the proxy SHALL forward only the latest user turn in `messages` (no context repair)

#### Scenario: Continue a thread after a tail divergence

- **GIVEN** a client sends a follow-up request for a previously established proxy conversation
- **AND** the client does NOT provide `codearts.parent_message_id`
- **AND** divergence detection classifies the history as a tail divergence (prefix chain matches but the suffix after the tracked chain boundary is not a valid single continuation turn — e.g. it contains external provider turns)
- **WHEN** the proxy processes the request
- **THEN** the proxy SHALL reuse the stored upstream `chat_id` and parent linkage identifier
- **AND** the proxy SHALL forward a `messages` payload containing the appended missing-tail text per the `full-context-injection` capability
- **AND** the proxy SHALL NOT forward a full-history fold

#### Scenario: Continue a thread after middle damage

- **GIVEN** a client sends a follow-up request for a previously established proxy conversation
- **AND** the client does NOT provide `codearts.parent_message_id`
- **AND** divergence detection classifies the history as middle damage (the tracked prefix chain fails to match)
- **WHEN** the proxy processes the request
- **THEN** the proxy SHALL treat the request as a fresh thread (reset upstream continuity, start with an empty `parent_message_id`)
- **AND** the proxy SHALL forward the folded full client history in `messages` per the `full-context-injection` capability

#### Scenario: Start a new upstream thread

- **GIVEN** a client sends a request with no existing proxy conversation state
- **WHEN** the proxy processes the request
- **THEN** the proxy SHALL create a new upstream conversation state entry
- **AND** the proxy SHALL persist the upstream conversation identifiers returned by CodeArts for future turns

#### Scenario: Start a new upstream thread with full history

- **GIVEN** a client sends a request with no existing proxy conversation state (no caller-provided `parent_message_id` and no tracked `lastResponseMessageId` for the resolved `chat_id`)
- **AND** the client message history contains more than the current turn
- **WHEN** the proxy processes the request
- **THEN** the proxy SHALL create a new upstream conversation state entry
- **AND** the proxy SHALL inject the folded full message history into the upstream `messages` payload instead of forwarding only the latest user message
- **AND** the proxy SHALL persist the upstream conversation identifiers returned by CodeArts for future turns