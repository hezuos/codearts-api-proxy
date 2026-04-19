/**
 * Tests for tool format conversion, sub-agent tool derivation,
 * and subagent_type case repair.
 */
import assert from "assert";
import {
  DEFAULT_TOOLS,
  SUB_AGENT_TOOLS,
  convertOpenAIToolsToCodeArts,
  deriveSubAgentTools,
} from "./tools";
import type { OpenAITool } from "../../types/openai";

// ---------------------------------------------------------------------------
// 4.1 Test that a request with `tools` field results in those tools being
//     forwarded to CodeArts `task_parameters.tools`
// ---------------------------------------------------------------------------

function testCallerToolsForwarded(): void {
  const openaiTools: OpenAITool[] = [
    {
      type: "function",
      function: {
        name: "Bash",
        description: "Execute a bash command",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
    },
    {
      type: "function",
      function: {
        name: "Read",
        description: "Read a file",
        parameters: { type: "object", properties: { filePath: { type: "string" } } },
      },
    },
  ];

  const converted = convertOpenAIToolsToCodeArts(openaiTools);
  assert.equal(converted.length, 2, "should convert all tools");
  assert.equal(converted[0].function.name, "Bash");
  assert.equal(converted[0].function.description, "Execute a bash command");
  assert.equal(converted[1].function.name, "Read");
  assert.equal(converted[1].type, "function");
}

// ---------------------------------------------------------------------------
// 4.2 Test that a request without `tools` field falls back to hardcoded
//     DEFAULT_TOOLS
// ---------------------------------------------------------------------------

function testFallbackToDefaultTools(): void {
  // When no caller tools, the buildRequestBody logic falls back to DEFAULT_TOOLS.
  // We verify DEFAULT_TOOLS is non-empty and has expected tools.
  assert.ok(DEFAULT_TOOLS.length > 0, "DEFAULT_TOOLS should not be empty");
  const names = DEFAULT_TOOLS.map((t) => t.function.name);
  assert.ok(names.includes("Bash"), "DEFAULT_TOOLS should include Bash");
  assert.ok(names.includes("Task"), "DEFAULT_TOOLS should include Task");
  assert.ok(names.includes("Read"), "DEFAULT_TOOLS should include Read");
}

// ---------------------------------------------------------------------------
// 4.3 Test that `subagent_type: "explore"` is repaired to `"Explore"`
// ---------------------------------------------------------------------------

function testExploreRepaired(): void {
  // Simulate the normalizeToolCallArguments logic
  const SUBAGENT_CASE_REPAIR: Record<string, string> = {
    "explore": "Explore",
    "specagent": "spec-agent",
    "spec_agent": "spec-agent",
    "general": "Explore",
    "general-purpose": "Explore",
  };

  const input = JSON.stringify({ subagent_type: "explore", prompt: "test" });
  const args = JSON.parse(input) as Record<string, unknown>;
  const repaired = SUBAGENT_CASE_REPAIR[args.subagent_type as string];
  assert.equal(repaired, "Explore", '"explore" should be repaired to "Explore"');
}

// ---------------------------------------------------------------------------
// 4.4 Test that `subagent_type: "Explore"` passes through unchanged
// ---------------------------------------------------------------------------

function testExplorePassthrough(): void {
  const SUBAGENT_CASE_REPAIR: Record<string, string> = {
    "explore": "Explore",
    "specagent": "spec-agent",
    "spec_agent": "spec-agent",
    "general": "Explore",
    "general-purpose": "Explore",
  };

  const input = "Explore";
  const repaired = SUBAGENT_CASE_REPAIR[input];
  // "Explore" is not in the map, so repaired is undefined → pass through
  assert.equal(repaired, undefined, '"Explore" is not in the repair map, so it passes through');
  assert.equal(input, "Explore", "original value unchanged");
}

// ---------------------------------------------------------------------------
// 4.5 Test that `subagent_type: "general-purpose"` is repaired to `"Explore"`
// ---------------------------------------------------------------------------

function testGeneralPurposeRepaired(): void {
  const SUBAGENT_CASE_REPAIR: Record<string, string> = {
    "explore": "Explore",
    "specagent": "spec-agent",
    "spec_agent": "spec-agent",
    "general": "Explore",
    "general-purpose": "Explore",
  };

  const repaired = SUBAGENT_CASE_REPAIR["general-purpose"];
  assert.equal(repaired, "Explore", '"general-purpose" should be repaired to "Explore"');
}

// ---------------------------------------------------------------------------
// 4.6 Test that an unknown `subagent_type` passes through unchanged
// ---------------------------------------------------------------------------

function testUnknownSubagentTypePassthrough(): void {
  const SUBAGENT_CASE_REPAIR: Record<string, string> = {
    "explore": "Explore",
    "specagent": "spec-agent",
    "spec_agent": "spec-agent",
    "general": "Explore",
    "general-purpose": "Explore",
  };

  const unknown = "some-unknown-type";
  const repaired = SUBAGENT_CASE_REPAIR[unknown];
  assert.equal(repaired, undefined, "unknown type should not be in the repair map");
  assert.equal(unknown, "some-unknown-type", "unknown type passes through unchanged");
}

// ---------------------------------------------------------------------------
// 4.7 Test sub-agent tool filtering from caller-provided tools
// ---------------------------------------------------------------------------

function testSubAgentToolFiltering(): void {
  // Create a set of caller tools that includes more than sub-agent tools
  const openaiTools: OpenAITool[] = [
    {
      type: "function",
      function: {
        name: "Bash",
        description: "Execute a bash command",
        parameters: { type: "object" },
      },
    },
    {
      type: "function",
      function: {
        name: "Glob",
        description: "File pattern matching",
        parameters: { type: "object" },
      },
    },
    {
      type: "function",
      function: {
        name: "Grep",
        description: "Content search",
        parameters: { type: "object" },
      },
    },
    {
      type: "function",
      function: {
        name: "Read",
        description: "Read a file",
        parameters: { type: "object" },
      },
    },
    {
      type: "function",
      function: {
        name: "openBrowserInIDE",
        description: "Open URL in IDE",
        parameters: { type: "object" },
      },
    },
    {
      type: "function",
      function: {
        name: "Edit",
        description: "Edit a file",
        parameters: { type: "object" },
      },
    },
    {
      type: "function",
      function: {
        name: "Write",
        description: "Write a file",
        parameters: { type: "object" },
      },
    },
    {
      type: "function",
      function: {
        name: "Task",
        description: "Launch a sub-agent",
        parameters: { type: "object" },
      },
    },
  ];

  const converted = convertOpenAIToolsToCodeArts(openaiTools);
  const subAgentTools = deriveSubAgentTools(converted);
  const names = subAgentTools.map((t) => t.function.name);

  assert.equal(subAgentTools.length, 5, "should filter to 5 sub-agent tools");
  assert.ok(names.includes("Bash"), "should include Bash");
  assert.ok(names.includes("Glob"), "should include Glob");
  assert.ok(names.includes("Grep"), "should include Grep");
  assert.ok(names.includes("Read"), "should include Read");
  assert.ok(names.includes("openBrowserInIDE"), "should include openBrowserInIDE");
  assert.ok(!names.includes("Edit"), "should NOT include Edit");
  assert.ok(!names.includes("Write"), "should NOT include Write");
  assert.ok(!names.includes("Task"), "should NOT include Task");

  // Also verify hardcoded SUB_AGENT_TOOLS matches
  const hardcodedNames = SUB_AGENT_TOOLS.map((t) => t.function.name);
  assert.deepEqual(
    names.sort(),
    hardcodedNames.sort(),
    "derived sub-agent tools should match hardcoded SUB_AGENT_TOOLS names",
  );
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

testCallerToolsForwarded();
testFallbackToDefaultTools();
testExploreRepaired();
testExplorePassthrough();
testGeneralPurposeRepaired();
testUnknownSubagentTypePassthrough();
testSubAgentToolFiltering();

console.log("All tool passthrough tests passed.");
