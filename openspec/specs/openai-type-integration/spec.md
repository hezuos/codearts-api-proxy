---
spec: openai-type-integration
status: implemented
priority: high
created: 2026-04-29
updated: 2026-04-29
---

# OpenAI Type Integration

## Overview

The system SHALL source OpenAI API types from the official `openai` package while layering CodeArts-specific extensions in a dedicated, backward-compatible type surface for the proxy.

## Requirements

### Requirement: OpenAI types sourced from official package

The system SHALL derive OpenAI API type definitions from the official `openai` npm package via `import type`, not from hand-written definitions. The `openai` package SHALL be a devDependency only and SHALL NOT be imported at runtime.

#### Scenario: Type import compiles successfully

- **WHEN** `pnpm build` is run
- **THEN** all `import type` statements from `"openai/resources/chat/completions"`, `"openai/resources/models"`, and `"openai/resources/completions"` SHALL resolve and compile without errors

#### Scenario: No runtime import of openai package

- **WHEN** the compiled `dist/index.js` is inspected
- **THEN** it SHALL NOT contain any runtime import of the `openai` package

### Requirement: CodeArts extensions via intersection types

The system SHALL inject CodeArts-specific fields (`codearts`, `reasoning_content`) into official types using TypeScript intersection types (`&`), not declaration merging.

#### Scenario: ChatCompletion includes codearts field

- **WHEN** a `OpenAIChatCompletion` type is used
- **THEN** it SHALL include the `codearts?: OpenAICodeArtsResponseMetadata` field in addition to all standard `ChatCompletion` fields

#### Scenario: ChatCompletionChunk includes codearts field

- **WHEN** a `OpenAIChatCompletionChunk` type is used
- **THEN** it SHALL include the `codearts?: OpenAICodeArtsResponseMetadata` field in addition to all standard `ChatCompletionChunk` fields

#### Scenario: ChatCompletionRequest includes codearts field

- **WHEN** a `OpenAIChatCompletionRequest` type is used
- **THEN** it SHALL include the `codearts?: OpenAICodeArtsRequestOptions | null` field in addition to all standard `ChatCompletionCreateParamsNonStreaming` fields

#### Scenario: Message includes reasoning_content field

- **WHEN** an `OpenAIChatMessage` is used
- **THEN** it SHALL include the `reasoning_content?: string` field for CodeArts/DeepSeek reasoning output

### Requirement: CodeArts types in dedicated file

CodeArts-specific type definitions SHALL reside in `src/types/openai-codearts.ts`, separate from the OpenAI type integration file.

#### Scenario: CodeArts types are importable

- **WHEN** any file imports from `./openai-codearts`
- **THEN** `OpenAICodeArtsRequestOptions`, `OpenAICodeArtsSubAgentOptions`, `OpenAICodeArtsResponseMetadata`, and `CodeArtsToolResult` SHALL be available

### Requirement: Backward-compatible type aliases

The system SHALL export types under the existing `OpenAI*` naming convention so that consuming code requires no import changes.

#### Scenario: Existing imports continue to work

- **WHEN** a file imports `OpenAIChatCompletion`, `OpenAIChatCompletionChunk`, `OpenAIChatCompletionRequest`, `OpenAIChatMessage`, `OpenAIToolCall`, `OpenAIToolCallDelta`, or `OpenAITool` from `../types/openai`
- **THEN** the import SHALL resolve without errors and the types SHALL be structurally compatible with their previous definitions

### Requirement: Dead types removed

The system SHALL NOT export types that are unused by any consuming code.

#### Scenario: Removed types are not importable

- **WHEN** a file attempts to import a dead type from `../types/openai`
- **THEN** the import SHALL fail with a TypeScript error

### Requirement: OpenAIChatMessage as projection interface

The `OpenAIChatMessage` type SHALL be a projection interface containing only the properties the proxy accesses across all message roles, rather than the official `ChatCompletionMessageParam` discriminated union.

#### Scenario: Message role access

- **WHEN** code accesses `.role` on an `OpenAIChatMessage`
- **THEN** the type SHALL be `ChatCompletionRole | "developer"`

#### Scenario: Message content access

- **WHEN** code accesses `.content` on an `OpenAIChatMessage`
- **THEN** the type SHALL be `string | null`

#### Scenario: Tool call access

- **WHEN** code accesses `.tool_calls` on an `OpenAIChatMessage`
- **THEN** the type SHALL be `OpenAIToolCall[] | undefined`

#### Scenario: Tool call ID access

- **WHEN** code accesses `.tool_call_id` on an `OpenAIChatMessage`
- **THEN** the type SHALL be `string | undefined`

### Requirement: Production build excludes openai package

The Docker image SHALL NOT include the `openai` npm package in its production `node_modules`.

#### Scenario: Docker prod deps check

- **WHEN** `pnpm install --frozen-lockfile --prod` is run
- **THEN** the `openai` package SHALL NOT be present in `node_modules`

### Requirement: CodeArtsRawToolCall includes index field

The `CodeArtsRawToolCall` interface SHALL include an `index?: number` field, reflecting the actual CodeArts SSE data which already contains this field.

#### Scenario: index field available on CodeArtsRawToolCall

- **WHEN** a `CodeArtsRawToolCall` object is accessed
- **THEN** the `index` field SHALL be available as `number | undefined`
