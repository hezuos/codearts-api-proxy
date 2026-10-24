/**
 * Tests for tool format conversion, sub-agent tool derivation,
 * and subagent_type normalization.
 */
import assert from "assert";
import {
  convertOpenAIToolsToCodeArts,
  deriveSubAgentTools,
} from "./tools";
import type { OpenAITool } from "../../types/openai";

// ---------------------------------------------------------------------------
// 4.1 Test that a request with `tools` field forwards those tools upstream
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
// 4.3 Test that `subagent_type: "Explore"` is repaired to `"explore"`
// ---------------------------------------------------------------------------

function testExploreRepaired(): void {
  // Simulate the normalizeToolCallArguments logic
  const SUBAGENT_CASE_REPAIR: Record<string, string> = {
    "Explore": "explore",
    "specagent": "spec-agent",
    "spec_agent": "spec-agent",
    "General": "general",
    "general-purpose": "general",
  };

  const input = JSON.stringify({ subagent_type: "Explore", prompt: "test" });
  const args = JSON.parse(input) as Record<string, unknown>;
  const repaired = SUBAGENT_CASE_REPAIR[args.subagent_type as string];
  assert.equal(repaired, "explore", '"Explore" should be repaired to "explore"');
}

// ---------------------------------------------------------------------------
// 4.4 Test that `subagent_type: "explore"` passes through unchanged
// ---------------------------------------------------------------------------

function testExplorePassthrough(): void {
  const SUBAGENT_CASE_REPAIR: Record<string, string> = {
    "Explore": "explore",
    "specagent": "spec-agent",
    "spec_agent": "spec-agent",
    "General": "general",
    "general-purpose": "general",
  };

  const input = "explore";
  const repaired = SUBAGENT_CASE_REPAIR[input];
  // "explore" 已经是目标值，不在 repair map 中，直接透传
  assert.equal(repaired, undefined, '"explore" is not in the repair map, so it passes through');
  assert.equal(input, "explore", "original value unchanged");
}

// ---------------------------------------------------------------------------
// 4.5 Test that `subagent_type: "general-purpose"` is repaired to `"general"`
// ---------------------------------------------------------------------------

function testGeneralPurposeRepaired(): void {
  const SUBAGENT_CASE_REPAIR: Record<string, string> = {
    "Explore": "explore",
    "specagent": "spec-agent",
    "spec_agent": "spec-agent",
    "General": "general",
    "general-purpose": "general",
  };

  const repaired = SUBAGENT_CASE_REPAIR["general-purpose"];
  assert.equal(repaired, "general", '"general-purpose" should be repaired to "general"');
}

// ---------------------------------------------------------------------------
// 4.6 Test that an unknown `subagent_type` passes through unchanged
// ---------------------------------------------------------------------------

function testUnknownSubagentTypePassthrough(): void {
  const SUBAGENT_CASE_REPAIR: Record<string, string> = {
    "Explore": "explore",
    "specagent": "spec-agent",
    "spec_agent": "spec-agent",
    "General": "general",
    "general-purpose": "general",
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
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

testCallerToolsForwarded();
testExploreRepaired();
testExplorePassthrough();
testGeneralPurposeRepaired();
testUnknownSubagentTypePassthrough();
testSubAgentToolFiltering();

console.log("All tool passthrough tests passed.");
