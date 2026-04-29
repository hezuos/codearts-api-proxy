## ADDED Requirements

### Requirement: Tool call delta minimal cleaning (streaming)
The system SHALL clean CodeArts SSE tool_call deltas into OpenAI-compatible format by removing null values and redundant top-level fields, NOT by reconstructing the entire object. The cleaning function SHALL preserve the original object structure as much as possible.

#### Scenario: First tool_call chunk preserves id, type, name
- **WHEN** CodeArts sends a tool_call delta with `id: "call_xxx"`, `type: "function"`, `function.name: "tool_name"`, `function.arguments: "{"`, `index: 0`
- **THEN** the output SHALL be `{ index: 0, id: "call_xxx", type: "function", function: { name: "tool_name", arguments: "{" } }`

#### Scenario: Subsequent tool_call chunks omit id, type, name
- **WHEN** CodeArts sends a tool_call delta with `id: null`, `type: "function"`, `function.name: null`, `function.arguments: "fragment"`, `index: 0`
- **THEN** the output SHALL be `{ index: 0, function: { arguments: "fragment" } }` — `id`, `type`, and `function.name` SHALL be omitted

#### Scenario: Last tool_call chunk with type:null
- **WHEN** CodeArts sends a tool_call delta with `type: null`
- **THEN** the `type` field SHALL be omitted from the output

#### Scenario: CodeArts index field used
- **WHEN** CodeArts sends a tool_call delta with `index: 0`
- **THEN** the output SHALL use `index: 0` from CodeArts, NOT a locally computed index

#### Scenario: CodeArts index field missing
- **WHEN** CodeArts sends a tool_call delta without `index`
- **THEN** the output SHALL fall back to the array position as `index`

#### Scenario: Redundant top-level name/arguments removed
- **WHEN** CodeArts sends a tool_call with both `function.name` and top-level `name`, or both `function.arguments` and top-level `arguments`
- **THEN** the output SHALL only include the `function` nested form, omitting the redundant top-level `name` and `arguments`

#### Scenario: Task subagent_type repair preserved
- **WHEN** a tool_call has `function.name: "Task"` and `function.arguments` contains a `subagent_type` value matching a known case variant (e.g., "Explore", "specagent")
- **THEN** the `subagent_type` value SHALL be repaired to the canonical form (e.g., "explore", "spec-agent") in the output arguments

### Requirement: Tool call minimal cleaning (non-streaming)
The system SHALL clean CodeArts non-streaming tool_calls into OpenAI format by the same minimal cleaning approach, with the additional requirement that missing `id` values SHALL be generated (since non-streaming responses require stable IDs).

#### Scenario: Non-streaming tool_call with id
- **WHEN** CodeArts sends a tool_call with `id: "call_xxx"`
- **THEN** the output SHALL preserve `id: "call_xxx"`

#### Scenario: Non-streaming tool_call without id
- **WHEN** CodeArts sends a tool_call with `id: null` or `id: "-"`
- **THEN** the output SHALL generate a unique `id` in the format `call_<24-hex-chars>`

### Requirement: Role chunk merged into first delta
The system SHALL NOT send a separate SSE chunk containing only `{ role: "assistant" }`. The `role` field SHALL be included in the first delta chunk that also contains content or tool_calls.

#### Scenario: First delta has tool_calls
- **WHEN** the first CodeArts delta event has `role: "assistant"` and `tool_calls: [...]`
- **THEN** the proxy SHALL send a single chunk with `delta: { role: "assistant", tool_calls: [...] }`

#### Scenario: First delta has content
- **WHEN** the first CodeArts delta event has `role: "assistant"` and `content: "text"`
- **THEN** the proxy SHALL send a single chunk with `delta: { role: "assistant", content: "text" }`

#### Scenario: First delta has only role
- **WHEN** the first CodeArts delta event has `role: "assistant"` but no content or tool_calls
- **THEN** the proxy SHALL send a chunk with `delta: { role: "assistant" }` (this is the only case where a role-only chunk is sent)

### Requirement: codearts metadata only in first chunk
The `codearts` extension field in streaming responses SHALL only be included in the first chunk, not repeated in every chunk.

#### Scenario: First chunk includes codearts
- **WHEN** the first SSE chunk is sent to the client
- **THEN** it SHALL include the `codearts` field with `chat_id`, `response_message_id`, `request_message_id`

#### Scenario: Subsequent chunks omit codearts
- **WHEN** any subsequent SSE chunk is sent to the client
- **THEN** it SHALL NOT include the `codearts` field

#### Scenario: Final chunk omits codearts
- **WHEN** the final chunk with `finish_reason` is sent
- **THEN** it SHALL NOT include the `codearts` field

### Requirement: Tool definition conversion simplified
The `convertOpenAIToolsToCodeArts()` function SHALL be simplified since the OpenAI and CodeArts tool definition formats are structurally identical (`{ type: "function", function: { name, description, parameters } }`).

#### Scenario: Tool conversion preserves structure
- **WHEN** an OpenAI tool `{ type: "function", function: { name, description, parameters } }` is converted
- **THEN** the output SHALL be structurally identical, only filling `description: ""` and `parameters: {}` as defaults when missing
