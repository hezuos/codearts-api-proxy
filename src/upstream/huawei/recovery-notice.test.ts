/**
 * buildRecoveryChunks notice 格式一致性测试（task 5.4）。
 *
 * 验证 buildRecoveryChunks 产出的 notice chunk 与 emitNoticeChunk 产出的
 * notice chunk 在格式上一致（role/metadata 处理逻辑相同）。
 */
import assert from "assert";
import type { Response } from "express";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildRecoveryChunks, buildSyntheticRecoveryToolCalls } = require("./chat-recovery") as typeof import("./chat-recovery");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { emitNoticeChunk } = require("./chat-notice") as typeof import("./chat-notice");
import type { OpenAIChatCompletionRequest, OpenAIChatMessage } from "../../types/openai";

// ---------------------------------------------------------------------------
// Mock res to capture emitNoticeChunk output
// ---------------------------------------------------------------------------

function mockRes(): { res: Response; writes: string[] } {
  const writes: string[] = [];
  const res = { write: (d: string) => { writes.push(d); return true; } } as unknown as Response;
  return { res, writes };
}

function parseChunk(sseData: string): { id: string; object: string; created: number; model: string; codearts?: Record<string, unknown>; choices: Array<{ delta: { role?: string; content?: string } }> } {
  return JSON.parse(sseData.replace("data: ", "").trim());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function testRecoveryNoticeFormatMatchesEmitNoticeChunk(): void {
  // 构造一个带 tool_calls 的 request（recovery 场景）
  const lastAssistant: OpenAIChatMessage = {
    role: "assistant",
    content: null,
    refusal: null,
    tool_calls: [{ id: "call-1", type: "function", function: { name: "find_path", arguments: "{}" } }],
  };
  const request: OpenAIChatCompletionRequest = {
    model: "GLM-5.1",
    messages: [{ role: "user", content: "test", refusal: null }, lastAssistant, { role: "tool", content: "result", refusal: null, tool_call_id: "call-1" }],
    stream: true,
  };

  const recoveryToolCalls = buildSyntheticRecoveryToolCalls(request);
  assert.ok(recoveryToolCalls.length > 0, "should have recovery tool calls");

  // buildRecoveryChunks 产出
  const recovery = buildRecoveryChunks({
    completionId: "chatcmpl-1",
    created: 1234567890,
    model: "GLM-5.1",
    responseMetadata: { chat_id: "c1" },
    sentRole: false,
    sentMetadata: false,
    errorCode: "SOME_ERROR",
    errorMsg: "test error",
    recoveryToolCalls,
  });

  // emitNoticeChunk 产出（相同参数）
  const { res, writes } = mockRes();
  emitNoticeChunk(res, {
    id: "chatcmpl-1",
    created: 1234567890,
    model: "GLM-5.1",
    content: `\n[上游错误: SOME_ERROR - test error；正在尝试其他方式继续]\n`,
    sentRole: false,
    sentMetadata: false,
    responseMetadata: { chat_id: "c1" },
  });

  const recoveryNoticeChunk = recovery.chunks[0];
  const emitNoticeChunkResult = parseChunk(writes[0]);

  // 比较格式一致性
  assert.equal(recoveryNoticeChunk.id, emitNoticeChunkResult.id, "id should match");
  assert.equal(recoveryNoticeChunk.object, emitNoticeChunkResult.object, "object should match");
  assert.equal(recoveryNoticeChunk.created, emitNoticeChunkResult.created, "created should match");
  assert.equal(recoveryNoticeChunk.model, emitNoticeChunkResult.model, "model should match");
  assert.equal(
    recoveryNoticeChunk.choices[0].delta.role,
    emitNoticeChunkResult.choices[0].delta.role,
    "role should match (both assistant when sentRole=false)",
  );
  assert.equal(
    recoveryNoticeChunk.choices[0].delta.content,
    emitNoticeChunkResult.choices[0].delta.content,
    "content should match",
  );
  // metadata 处理一致（sentMetadata=false 时都包含 codearts）
  assert.deepEqual(recoveryNoticeChunk.codearts, emitNoticeChunkResult.codearts, "codearts metadata should match");
}

function testRecoveryNoticeSkipsMetadataWhenAlreadySent(): void {
  const lastAssistant: OpenAIChatMessage = {
    role: "assistant",
    content: null,
    refusal: null,
    tool_calls: [{ id: "call-1", type: "function", function: { name: "find_path", arguments: "{}" } }],
  };
  const request: OpenAIChatCompletionRequest = {
    model: "GLM-5.1",
    messages: [{ role: "user", content: "test", refusal: null }, lastAssistant, { role: "tool", content: "result", refusal: null, tool_call_id: "call-1" }],
    stream: true,
  };
  const recoveryToolCalls = buildSyntheticRecoveryToolCalls(request);

  // sentMetadata=true → 不应含 codearts
  const recovery = buildRecoveryChunks({
    completionId: "chatcmpl-1",
    created: 1234567890,
    model: "GLM-5.1",
    responseMetadata: { chat_id: "c1" },
    sentRole: true,
    sentMetadata: true,
    errorCode: "SOME_ERROR",
    errorMsg: "test",
    recoveryToolCalls,
  });

  const noticeChunk = recovery.chunks[0];
  assert.ok(!noticeChunk.codearts, "should skip codearts when sentMetadata=true");
  assert.ok(!noticeChunk.choices[0].delta.role, "should skip role when sentRole=true");
}

function testRecoveryChunksIncludeToolCalls(): void {
  const lastAssistant: OpenAIChatMessage = {
    role: "assistant",
    content: null,
    refusal: null,
    tool_calls: [{ id: "call-1", type: "function", function: { name: "find_path", arguments: "{}" } }],
  };
  const request: OpenAIChatCompletionRequest = {
    model: "GLM-5.1",
    messages: [{ role: "user", content: "test", refusal: null }, lastAssistant, { role: "tool", content: "result", refusal: null, tool_call_id: "call-1" }],
    stream: true,
  };
  const recoveryToolCalls = buildSyntheticRecoveryToolCalls(request);

  const recovery = buildRecoveryChunks({
    completionId: "chatcmpl-1",
    created: 1234567890,
    model: "GLM-5.1",
    responseMetadata: {},
    sentRole: false,
    sentMetadata: false,
    errorCode: "SOME_ERROR",
    errorMsg: "test",
    recoveryToolCalls,
  });

  // 应有 2 个 chunk：notice + recovery(tool_calls)
  assert.equal(recovery.chunks.length, 2, "should have notice + recovery chunks");
  const recoveryChunk = recovery.chunks[1];
  assert.ok(recoveryChunk.choices[0].delta.tool_calls, "recovery chunk should contain tool_calls");
  assert.equal(recovery.sentRole, true);
  assert.equal(recovery.sentMetadata, true);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

testRecoveryNoticeFormatMatchesEmitNoticeChunk();
testRecoveryNoticeSkipsMetadataWhenAlreadySent();
testRecoveryChunksIncludeToolCalls();

console.log("All recovery-notice tests passed.");
