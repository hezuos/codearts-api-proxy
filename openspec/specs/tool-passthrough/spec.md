---
spec: tool-passthrough
status: implemented
priority: high
created: 2026-04-19
updated: 2026-04-19
---

# Tool Passthrough

## Overview

The system SHALL pass caller-provided tool definitions through to the upstream CodeArts service, converting formats as needed, and derive sub-agent tool lists from the caller's tools.

## Requirements

### Requirement: Caller-provided tool definitions take precedence
The proxy SHALL use tool definitions from the incoming request's `tools` field when present and non-empty, converting them to CodeArts format for `task_parameters.tools`.

#### Scenario: OpenCode sends tools in request
- **WHEN** a caller sends a chat completion request with a non-empty `tools` array
- **THEN** the proxy converts those tools to CodeArts format and uses them as `task_parameters.tools` instead of the hardcoded `DEFAULT_TOOLS`

#### Scenario: Caller omits tools
- **WHEN** a caller sends a chat completion request without `tools` or with an empty `tools` array
- **THEN** the proxy falls back to the hardcoded `DEFAULT_TOOLS` for `task_parameters.tools`

### Requirement: OpenAI-to-CodeArts tool format conversion
The proxy SHALL convert OpenAI-format tool definitions (`OpenAITool[]`) to the CodeArts `task_parameters.tools` format, preserving tool names, descriptions, and parameter schemas.

#### Scenario: Standard tool conversion
- **WHEN** the proxy receives OpenAI-format tools with standard function definitions
- **THEN** each tool is converted to the `{ type: "function", function: { name, description, parameters } }` format expected by CodeArts, preserving all fields

#### Scenario: Tool with extra OpenAI-specific fields
- **WHEN** an OpenAI-format tool contains fields not recognized by CodeArts (e.g., `strict`)
- **THEN** the proxy passes the tool through without error; CodeArts ignores unrecognized fields

### Requirement: Sub-agent tool list derived from caller tools
The proxy SHALL derive the sub-agent tool list by filtering caller-provided tools to the known sub-agent tool names (Bash, Glob, Grep, Read, openBrowserInIDE) when caller tools are available.

#### Scenario: Sub-agent request with caller tools
- **WHEN** a sub-agent request is made and the caller provided tools
- **THEN** the proxy filters the caller tools to only include Bash, Glob, Grep, Read, and openBrowserInIDE

#### Scenario: Sub-agent request without caller tools
- **WHEN** a sub-agent request is made and the caller did not provide tools
- **THEN** the proxy falls back to the hardcoded `SUB_AGENT_TOOLS`

### Requirement: subagent_type case repair instead of normalization
The proxy SHALL repair known case variants of `subagent_type` to the exact casing registered by OpenCode, rather than normalizing to lowercase.

#### Scenario: Lowercase explore repaired to Explore
- **WHEN** the LLM returns a Task tool call with `subagent_type: "explore"`
- **THEN** the proxy repairs it to `"Explore"` before returning to the caller

#### Scenario: Correct casing preserved
- **WHEN** the LLM returns a Task tool call with `subagent_type: "Explore"`
- **THEN** the proxy passes it through unchanged

#### Scenario: Unknown subagent_type passed through
- **WHEN** the LLM returns a Task tool call with a `subagent_type` not in the repair map
- **THEN** the proxy passes it through unchanged, allowing OpenCode to produce a clear error

#### Scenario: Common hallucination repaired
- **WHEN** the LLM returns a Task tool call with `subagent_type: "general-purpose"` or `subagent_type: "general"`
- **THEN** the proxy repairs it to `"Explore"` as the closest valid agent type
