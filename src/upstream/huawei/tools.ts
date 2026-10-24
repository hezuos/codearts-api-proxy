/**
 * Tool format helpers: OpenAI tools → upstream tool definitions,
 * plus sub-agent tool filtering.
 */

import type { OpenAITool } from "../../types/openai";

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const SUB_AGENT_TOOL_NAMES = new Set([
  "Bash",
  "Glob",
  "Grep",
  "Read",
  "openBrowserInIDE",
]);

/**
 * Convert OpenAI-format tools to CodeArts ToolDefinition format.
 * The formats are structurally identical (both use
 * { type: "function", function: { name, description, parameters } }),
 * so this is primarily a type-level adaptation.
 */
export function convertOpenAIToolsToCodeArts(tools: OpenAITool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.function.name,
      description: tool.function.description ?? "",
      parameters: tool.function.parameters ?? {},
    },
  }));
}

/**
 * Derive the sub-agent tool list by filtering a tool list
 * to only include tools with sub-agent-allowed names.
 */
export function deriveSubAgentTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.filter((tool) => SUB_AGENT_TOOL_NAMES.has(tool.function.name));
}
