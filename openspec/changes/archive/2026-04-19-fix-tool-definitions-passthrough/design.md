## Context

The proxy sits between OpenCode (client) and CodeArts (LLM service). Currently, `tools.ts` hardcodes tool definitions captured from the Huawei CodeArts IDE and sends them via `task_parameters.tools` to the CodeArts backend. The CodeArts backend uses these definitions to inform the LLM what tools are available.

The LLM then generates tool calls that are returned to OpenCode, which validates them against its own tool registry (`$r0` map and `Ie1` agent type list). Because the proxy's hardcoded definitions diverge from OpenCode's registry, tool calls fail validation.

Key divergences identified:
- `SkillTool`: proxy uses param `name`, OpenCode expects `skill_name`
- `TodoWrite`: proxy requires `priority`, OpenCode requires `activeForm`; proxy enum includes `cancelled`, OpenCode does not
- `Task`: proxy description omits agent type list, LLM hallucinates invalid types; proxy normalizes `subagent_type` to lowercase but OpenCode registers `"Explore"` with capital E
- `Grep`: proxy has 3 params, OpenCode has 13 with different required fields

## Goals / Non-Goals

**Goals:**
- Proxy forwards caller-provided tool definitions (from `request.tools`) to CodeArts, eliminating the definition mismatch
- Fix `subagent_type` normalization to preserve exact casing that OpenCode expects
- Maintain backward compatibility for callers that don't provide tools

**Non-Goals:**
- Changing OpenCode's tool registry or validation logic (out of scope)
- Adding new tools or modifying tool behavior
- Validating tool definitions on the proxy side (proxy is a passthrough)

## Decisions

### D1: Source tools from `request.tools` when available

**Decision**: When the caller provides `tools` in the OpenAI-format request body, convert and forward them to CodeArts. Fall back to hardcoded `DEFAULT_TOOLS` only when `request.tools` is absent or empty.

**Rationale**: OpenCode already knows its own tool definitions and sends them in the standard OpenAI `tools` field. Using these directly eliminates the mismatch at the source. The fallback preserves compatibility for direct API calls that don't include tools.

**Alternative considered**: Keep hardcoded definitions but sync them with OpenCode's. Rejected — this is fragile and requires updating every time OpenCode changes its tools.

### D2: OpenAI-to-CodeArts tool format conversion

**Decision**: Add a `convertOpenAIToolsToCodeArts()` function that transforms `OpenAITool[]` (the `request.tools` format) into the `ToolDefinition[]` format expected by `task_parameters.tools`.

**Rationale**: The formats are structurally similar but not identical. CodeArts uses `{ type: "function", function: { name, description, parameters } }` which is actually the same as OpenAI's format. The conversion is mostly a type-level adaptation.

### D3: Replace `subagent_type` toLowerCase with case-repair mapping

**Decision**: Replace `normalizeToolCallArguments`'s `toLowerCase` with a mapping that corrects known case variants to the exact casing OpenCode expects:

```ts
const SUBAGENT_CASE_REPAIR: Record<string, string> = {
  "explore": "Explore",
  "specagent": "spec-agent",
  "spec_agent": "spec-agent",
  "general": "Explore",  // common hallucination → best guess
};
```

Values not in the map are passed through unchanged.

**Rationale**: The current `toLowerCase` breaks valid output ("Explore" → "explore" → not found). A repair map fixes known mis-casings while preserving correct output. Unknown values pass through and get a clear error from OpenCode rather than a mysterious one.

**Alternative considered**: No normalization at all. Rejected — LLMs do occasionally produce lowercase variants, and repairing them provides a better experience.

### D4: Sub-agent tool list derivation

**Decision**: When `request.tools` is available, derive `SUB_AGENT_TOOLS` by filtering to the tools that sub-agents should have access to (Bash, Glob, Grep, Read, openBrowserInIDE), matching by name. When falling back, use the current hardcoded `SUB_AGENT_TOOLS`.

**Rationale**: Sub-agents get a restricted tool set. When tools come from the caller, we filter by name to get the same subset.

## Risks / Trade-offs

- **[Caller sends incomplete tools]** → If OpenCode sends a subset of tools (e.g., in a restricted mode), the LLM will only see those tools. This is correct behavior — the caller controls what's available.
- **[CodeArts backend ignores task_parameters.tools]** → If CodeArts has its own tool definitions that override what we send, the passthrough won't help. Mitigation: test with a real request to confirm CodeArts respects the tools field (existing captured requests prove it does).
- **[Tool format incompatibility]** → If OpenCode's tool definitions use OpenAI-specific fields that CodeArts doesn't understand, the conversion may lose information. Mitigation: the formats are nearly identical; any extra fields are ignored by CodeArts.
- **[Case-repair map becomes stale]** → If OpenCode adds new agent types, the repair map won't cover them. Mitigation: unknown values pass through unchanged, producing a clear error that's easy to diagnose and fix.
