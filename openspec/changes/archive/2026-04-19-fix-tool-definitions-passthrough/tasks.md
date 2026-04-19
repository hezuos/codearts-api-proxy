## 1. Tool Format Conversion

- [x] 1.1 Add `convertOpenAIToolsToCodeArts()` function in `tools.ts` that transforms `OpenAITool[]` to `ToolDefinition[]` format
- [x] 1.2 Add `deriveSubAgentTools()` function that filters a tool list to sub-agent-allowed tool names (Bash, Glob, Grep, Read, openBrowserInIDE)

## 2. Request Integration

- [x] 2.1 Modify `buildRequestBody()` in `chat.ts` to accept caller-provided tools and use them when available, falling back to `DEFAULT_TOOLS`
- [x] 2.2 Modify `buildTaskParameters()` to accept a tools parameter instead of always using the hardcoded list
- [x] 2.3 Update sub-agent tool selection: when caller tools are available, derive sub-agent tools from them; otherwise use hardcoded `SUB_AGENT_TOOLS`

## 3. subagent_type Normalization Fix

- [x] 3.1 Replace `normalizeToolCallArguments()` toLowerCase logic with a case-repair map (`SUBAGENT_CASE_REPAIR`) that maps known variants to exact OpenCode casing
- [x] 3.2 Add repair entries: `explore→Explore`, `specagent→spec-agent`, `spec_agent→spec-agent`, `general→Explore`, `general-purpose→Explore`
- [x] 3.3 Ensure unknown subagent_type values pass through unchanged

## 4. Validation

- [x] 4.1 Test that a request with `tools` field results in those tools being forwarded to CodeArts `task_parameters.tools`
- [x] 4.2 Test that a request without `tools` field falls back to hardcoded `DEFAULT_TOOLS`
- [x] 4.3 Test that `subagent_type: "explore"` is repaired to `"Explore"`
- [x] 4.4 Test that `subagent_type: "Explore"` passes through unchanged
- [x] 4.5 Test that `subagent_type: "general-purpose"` is repaired to `"Explore"`
- [x] 4.6 Test that an unknown `subagent_type` passes through unchanged
- [x] 4.7 Test sub-agent tool filtering from caller-provided tools
