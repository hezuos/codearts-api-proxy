/**
 * Validated CodeArts tool definitions captured from the IDE.
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

function buildTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters,
    },
  };
}

export const DEFAULT_TOOLS: ToolDefinition[] = [
  buildTool(
    "Task",
    "Launch a new agent to handle complex, multi-step tasks autonomously.",
    {
      type: "object",
      properties: {
        description: { type: "string" },
        prompt: { type: "string" },
        subagent_type: { type: "string" },
      },
      required: ["description", "prompt", "subagent_type"],
      additionalProperties: false,
    },
  ),
  buildTool(
    "Bash",
    "Executes a given bash command in a persistent shell session with optional timeout.",
    {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "number" },
        description: { type: "string" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  ),
  buildTool(
    "Glob",
    "Fast file pattern matching tool that works with any codebase size.",
    {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  ),
  buildTool("Grep", "Fast content search tool using regular expressions.", {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      include: { type: "string" },
    },
    required: ["pattern"],
    additionalProperties: false,
  }),
  buildTool("Read", "Reads a file from the local filesystem.", {
    type: "object",
    properties: {
      filePath: { type: "string" },
      offset: { type: "number" },
      limit: { type: "number" },
    },
    required: ["filePath"],
    additionalProperties: false,
  }),
  buildTool("Edit", "Performs exact string replacements in files.", {
    type: "object",
    properties: {
      filePath: { type: "string" },
      oldString: { type: "string" },
      newString: { type: "string" },
      replaceAll: { type: "boolean" },
    },
    required: ["filePath", "oldString", "newString"],
    additionalProperties: false,
  }),
  buildTool("Write", "Writes a file to the local filesystem.", {
    type: "object",
    properties: {
      filePath: { type: "string" },
      content: { type: "string" },
    },
    required: ["filePath", "content"],
    additionalProperties: false,
  }),
  buildTool(
    "TodoWrite",
    "Create and manage a structured task list for the current coding session.",
    {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed", "cancelled"],
              },
              priority: {
                type: "string",
                enum: ["high", "medium", "low"],
              },
            },
            required: ["content", "status", "priority"],
            additionalProperties: false,
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
  ),
  buildTool(
    "ask_followup_question",
    "Ask the user a question to gather additional information needed to complete the task.",
    {
      type: "object",
      properties: {
        question: { type: "string" },
        options: { type: "array", items: { type: "string" } },
      },
      required: ["question"],
      additionalProperties: false,
    },
  ),
  buildTool("openBrowserInIDE", "Open a URL in the IDE-integrated browser.", {
    type: "object",
    properties: {
      url: { type: "string" },
    },
    required: ["url"],
    additionalProperties: false,
  }),
  buildTool(
    "SkillTool",
    "Load a specialized skill that provides domain-specific instructions and workflows.",
    {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  ),
  buildTool(
    "analyzeImage",
    "Analyse image or images by ID and extract information.",
    {
      type: "object",
      properties: {
        imageId: { type: "array", items: { type: "string" } },
        task: { type: "string" },
      },
      required: ["imageId", "task"],
      additionalProperties: false,
    },
  ),
];

const SUB_AGENT_TOOL_NAMES = new Set([
  "Bash",
  "Glob",
  "Grep",
  "Read",
  "openBrowserInIDE",
]);

export const SUB_AGENT_TOOLS: ToolDefinition[] = DEFAULT_TOOLS.filter((tool) =>
  SUB_AGENT_TOOL_NAMES.has(tool.function.name),
);

const BUILTIN_TOOL_NAMES = new Set(DEFAULT_TOOLS.map((t) => t.function.name));

/** 判断工具名是否为 CodeArts 内置工具（包括 SubAgent 工具）。 */
export function isCodeArtsBuiltinTool(name: string): boolean {
  return BUILTIN_TOOL_NAMES.has(name) || SUB_AGENT_TOOL_NAMES.has(name);
}

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
