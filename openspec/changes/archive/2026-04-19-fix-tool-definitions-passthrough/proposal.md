## Why

The proxy hardcodes Huawei CodeArts IDE tool definitions in `tools.ts` and sends them to the CodeArts LLM via `task_parameters.tools`. However, the LLM's tool call output is validated by OpenCode's own tool registry, which has different parameter names, required fields, and enum values. This mismatch causes tool calls to fail at the OpenCode validation layer — e.g., `SkillTool.name` vs `SkillTool.skill_name`, `TodoWrite.priority` vs `TodoWrite.activeForm`, missing `Task` agent type descriptions leading to hallucinated types like `general-purpose`, and `subagent_type` case normalization destroying valid values like `"Explore"`.

## What Changes

- **BREAKING**: Remove hardcoded `DEFAULT_TOOLS` and `SUB_AGENT_TOOLS` from `tools.ts`; instead derive tools from the incoming OpenCode request (`request.tools`) when available
- Add a fallback to the current hardcoded definitions only when the caller does not supply tools (backward compatibility for non-OpenCode clients)
- Remove the `subagent_type` toLowerCase normalization in `normalizeToolCallArguments` — OpenCode registers agents with exact casing (`"Explore"`, `"spec-agent"`)
- Add a `subagent_type` mapping/repair step that corrects known case variants (e.g., `"explore"` → `"Explore"`) instead of blindly lowercasing
- Convert OpenAI-format tools (`request.tools`) to CodeArts `task_parameters.tools` format when passthrough is active

## Capabilities

### New Capabilities
- `tool-passthrough`: Proxy forwards caller-provided tool definitions to CodeArts instead of using hardcoded IDE captures, with format conversion and fallback

### Modified Capabilities
- `request-translation`: Tool definitions are now sourced from the caller request when available, changing how `task_parameters.tools` is built

## Impact

- `src/upstream/huawei/tools.ts` — major refactor: DEFAULT_TOOLS becomes fallback, add OpenAI→CodeArts format converter
- `src/upstream/huawei/chat.ts` — `buildRequestBody` and `buildTaskParameters` accept caller tools; `normalizeToolCallArguments` changes normalization strategy
- `src/types/openai.ts` — no structural changes, but `tools` field on the request is now actively used
- OpenCode clients will get correct tool definitions; non-OpenCode clients fall back to current behavior
