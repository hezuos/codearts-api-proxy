## MODIFIED Requirements

### Requirement: Caller-provided tool definitions take precedence

The proxy SHALL use tool definitions from the incoming request's `tools` field when present and non-empty, forwarding them to the upstream v2 channel in OpenAI-compatible tool format.

#### Scenario: OpenCode sends tools in request

- **WHEN** a caller sends a chat completion request with a non-empty `tools` array
- **THEN** the proxy SHALL forward those tools to the upstream v2 request instead of the hardcoded `DEFAULT_TOOLS`

#### Scenario: Caller omits tools

- **WHEN** a caller sends a chat completion request without `tools` or with an empty `tools` array
- **THEN** the proxy SHALL NOT forward a tool catalog to the upstream v2 request

### Requirement: Tool execution results are forwarded as OpenAI tool messages

The proxy SHALL forward tool execution results to the upstream v2 channel as OpenAI `role: "tool"` messages carrying the matching `tool_call_id`, together with the preceding assistant message that carries the corresponding `tool_calls`.

#### Scenario: Tool continuation with matching call id

- **GIVEN** a client sends tool execution results for a prior upstream tool call
- **AND** the proxy can confirm the `tool_call_id` matches a known upstream-issued call
- **WHEN** the proxy constructs the upstream v2 request
- **THEN** the proxy SHALL include the tool results as `role: "tool"` messages with the matching `tool_call_id`
- **AND** the proxy SHALL include the assistant message carrying the corresponding `tool_calls`

#### Scenario: Non-builtin tool result

- **GIVEN** a client sends a tool result whose tool name is not a known upstream builtin tool
- **WHEN** the proxy constructs the upstream v2 request
- **THEN** the proxy SHALL forward the tool result content in a form the upstream can consume without erroring on an unknown tool

### Requirement: Sub-agent tool list derived from caller tools

The proxy SHALL derive the sub-agent tool list by filtering caller-provided tools to the known sub-agent tool names (Bash, Glob, Grep, Read, openBrowserInIDE) when caller tools are available, and SHALL forward the sub-agent fields (`isSubAgent`, `subAgent_type`, `subAgent_prompt`) to the upstream v2 request.

#### Scenario: Sub-agent request with caller tools

- **WHEN** a sub-agent request is made and the caller provided tools
- **THEN** the proxy filters the caller tools to only include Bash, Glob, Grep, Read, and openBrowserInIDE
- **AND** the proxy forwards `isSubAgent: true` with `subAgent_type` and `subAgent_prompt` to the upstream v2 request

#### Scenario: Sub-agent request without caller tools

- **WHEN** a sub-agent request is made and the caller did not provide tools
- **THEN** the proxy SHALL NOT forward a tool catalog to the upstream v2 request
- **AND** the proxy SHALL still forward `isSubAgent: true` with `subAgent_type` and `subAgent_prompt`