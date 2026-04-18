## Context

The proxy already has working AK/SK signing, session refresh, OpenAI-compatible chat routes, and SSE translation. However, the current upstream request builder intentionally simplifies CodeArts traffic: it flattens all OpenAI messages into one text payload, always creates a new `chat_id`, always generates a synthetic `parent_message_id`, sends a fixed non-sub-agent task shape, and ignores tool continuation flows. CDP captures show that the real IDE uses multiple request variants with conversation-linked identifiers, `tool_result` payloads, sub-agent mode, and context-specific tool lists.

This change spans the OpenAI translation layer, Huawei upstream request builder, persisted state, and response mapping. The main constraint is preserving the existing working simple-chat path while introducing enough state and request-shape fidelity to support real CodeArts workflows.

## Goals / Non-Goals

**Goals:**

- Preserve upstream conversation continuity by reusing `chat_id` and forwarding the latest upstream parent/response message identifiers.
- Represent distinct upstream request variants: normal user turn, tool continuation turn, and sub-agent turn.
- Forward dynamic task parameters and tool lists based on request context instead of always sending one fixed shape.
- Translate upstream `tool_calls` into OpenAI-compatible responses and accept enough client-side metadata to continue those tool chains.
- Persist any conversation thread state required to resume forwarding after process restart.

**Non-Goals:**

- Reproducing every private CodeArts IDE feature or every possible hidden task parameter from the extension.
- Implementing arbitrary IDE-only tools locally.
- Building a full general-purpose conversation database beyond the metadata needed for request forwarding.

## Decisions

### 1. Introduce an explicit CodeArts conversation state store

The proxy will maintain a persisted per-thread state object keyed by a proxy conversation identifier. The state will store at minimum the current upstream `chat_id`, latest upstream `response_message_id`/`parent_message_id`, selected model ID, account ID, and any required sub-agent metadata. This avoids regenerating identifiers every request and keeps the implementation minimal by persisting only forwarding metadata rather than whole transcripts.

Alternative considered: derive all state from OpenAI messages on each request. Rejected because tool continuation requests and parent-message linkage depend on opaque upstream identifiers that are not recoverable from plain OpenAI chat history.

### 2. Split request construction into request modes

The upstream builder will support three request modes:

- standard user turn with `messages`
- tool continuation turn with `task_parameters.tool_result` and empty `messages`
- sub-agent turn with `isSubAgent`, `subAgent_type`, reduced tool set, and sub-agent prompt fields

This keeps the current implementation small while aligning with the captured traffic families. The route layer or request parser will choose the mode from OpenAI-compatible request metadata.

Alternative considered: keep one generic builder with many optional fields. Rejected because it obscures invariants and makes it easier to send invalid field combinations.

### 3. Extend OpenAI-compatible request types with proxy-specific metadata

The proxy will continue to accept standard OpenAI fields, but it will also accept optional proxy extensions for conversation state and tool continuation such as a conversation/thread ID, prior tool results, sub-agent directives, and explicit model routing overrides. These fields will be documented as proxy extensions rather than treated as standard OpenAI behavior.

Alternative considered: infer continuation state entirely from assistant/tool messages. Rejected because upstream tool continuation requires structured tool execution result objects, not just textual tool messages.

### 4. Separate tool catalogs by request context

The proxy will maintain at least two validated tool catalogs based on captures:

- full/default CodeArts tool set for standard turns
- reduced tool set for sub-agent turns

This is preferred over a single superset because the captures show materially different tool exposure depending on mode, and the backend may route or validate requests differently.

### 5. Promote upstream response metadata into persisted thread state

The streaming and non-streaming response handlers will capture upstream metadata events such as `chat_id`, `response_message_id`, and request/response linkage fields, then update the conversation state store before completing the request. This ensures the next turn can continue the same upstream thread.

Alternative considered: only parse deltas and ignore metadata. Rejected because metadata is exactly what is needed to continue conversations faithfully.

## Risks / Trade-offs

- [Risk] Incomplete understanding of upstream request variants may still miss hidden required fields. → Mitigation: implement only captured variants first and keep the request builder mode-specific and documented.
- [Risk] Persisted thread state can become stale or mismatched with the client conversation. → Mitigation: scope state by explicit proxy conversation ID and allow safe fallback to a new thread when no state exists.
- [Risk] Proxy-specific OpenAI extensions reduce portability. → Mitigation: keep extensions optional and preserve simple standard chat for clients that only need basic completions.
- [Risk] Mapping upstream tool calls to OpenAI tool calls may be lossy if upstream shape differs. → Mitigation: preserve raw arguments and IDs where possible and document unsupported edge cases.

## Migration Plan

1. Add persisted conversation-thread state storage alongside existing auth/session persistence.
2. Refactor `chat.ts` into request parsing, state lookup/update, request-mode-specific body builders, and response metadata extraction.
3. Extend request/response types and route handling for proxy-specific continuation metadata.
4. Update model/tool catalogs and forwarding docs based on validated captures.
5. Verify with captured request replay and live IDE-driven proxy tests across normal chat, tool continuation, and sub-agent flows.

## Open Questions

- Which proxy request shape is best for exposing continuation state to external OpenAI-compatible clients: explicit `conversation_id`, reuse of `user`, or a dedicated extension field?
- Do we need to persist complete tool-call history, or is the latest upstream linkage plus provided tool results sufficient?
- Should model routing fall back to raw passthrough for unknown model names once the validated map is exhausted?
