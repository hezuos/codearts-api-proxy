/**
 * 统一 notice 机制测试（chat-notice.ts）。
 *
 * 覆盖：
 * - emitNoticeChunk 写入 SSE chunk 到 res
 * - emitNoticeChunk 返回 sentRole/sentMetadata 状态
 * - emitNoticeChunk 携带 extraMetadata
 * - emitNoticeChunk 在 sentMetadata=true 时跳过 metadata
 * - buildNoticeMetadata 返回正确 shape
 * - buildNoticeMetadata 携带 extra 字段
 */
import assert from "assert";
import type { ServerResponse } from "http";
import { randomUUID } from "crypto";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { emitNoticeChunk, buildNoticeMetadata } = require("./chat-notice") as typeof import("./chat-notice");

// ---------------------------------------------------------------------------
// Mock ServerResponse
// ---------------------------------------------------------------------------

function mockRes(): { res: ServerResponse; writes: string[] } {
  const writes: string[] = [];
  const res = {
    write: (data: string) => {
      writes.push(data);
      return true;
    },
  } as unknown as ServerResponse;
  return { res, writes };
}

const baseParams = {
  id: "chatcmpl-test",
  created: 1234567890,
  model: "GLM-5.1",
};

// ---------------------------------------------------------------------------
// emitNoticeChunk
// ---------------------------------------------------------------------------

function testEmitNoticeChunkWritesChunkToRes(): void {
  const { res, writes } = mockRes();
  emitNoticeChunk(res, {
    ...baseParams,
    content: "[test notice]",
    sentRole: false,
    sentMetadata: false,
    responseMetadata: { chat_id: "c1" },
  });
  assert.equal(writes.length, 1, "should write exactly one SSE chunk");
  assert.ok(writes[0].startsWith("data: "), "should be SSE data line");
  const chunk = JSON.parse(writes[0].replace("data: ", "").trim());
  assert.equal(chunk.choices[0].delta.content, "[test notice]");
}

function testEmitNoticeChunkSetsSentRoleAndSentMetadata(): void {
  const { res } = mockRes();
  const result = emitNoticeChunk(res, {
    ...baseParams,
    content: "x",
    sentRole: false,
    sentMetadata: false,
    responseMetadata: {},
  });
  assert.equal(result.sentRole, true);
  assert.equal(result.sentMetadata, true);
}

function testEmitNoticeChunkIncludesExtraMetadata(): void {
  const { res, writes } = mockRes();
  emitNoticeChunk(res, {
    ...baseParams,
    content: "x",
    sentRole: false,
    sentMetadata: false,
    responseMetadata: { chat_id: "c1" },
    extraMetadata: { context_reset: "proactive" },
  });
  const chunk = JSON.parse(writes[0].replace("data: ", "").trim());
  assert.equal(chunk.codearts.context_reset, "proactive");
  assert.equal(chunk.codearts.chat_id, "c1");
}

function testEmitNoticeChunkSkipsMetadataIfAlreadySent(): void {
  const { res, writes } = mockRes();
  emitNoticeChunk(res, {
    ...baseParams,
    content: "x",
    sentRole: true,
    sentMetadata: true,
    responseMetadata: { chat_id: "c1" },
  });
  const chunk = JSON.parse(writes[0].replace("data: ", "").trim());
  assert.ok(!chunk.codearts, "should not include codearts metadata if already sent");
  assert.ok(!chunk.choices[0].delta.role, "should not include role if already sent");
}

function testEmitNoticeChunkIncludesRoleWhenNotSent(): void {
  const { res, writes } = mockRes();
  emitNoticeChunk(res, {
    ...baseParams,
    content: "x",
    sentRole: false,
    sentMetadata: true,
    responseMetadata: {},
  });
  const chunk = JSON.parse(writes[0].replace("data: ", "").trim());
  assert.equal(chunk.choices[0].delta.role, "assistant", "should include role when sentRole=false");
}

// ---------------------------------------------------------------------------
// buildNoticeMetadata
// ---------------------------------------------------------------------------

function testBuildNoticeMetadataReturnsCorrectShape(): void {
  const meta = buildNoticeMetadata({ error_recovery: "ChatAgent.00001216" });
  assert.equal(meta.error_recovery, "ChatAgent.00001216");
  assert.ok(!meta.context_reset, "should not include context_reset when not provided");
}

function testBuildNoticeMetadataWithExtra(): void {
  const meta = buildNoticeMetadata({
    error_recovery: "tail-divergence-resync",
    context_reset: "true",
  });
  assert.equal(meta.error_recovery, "tail-divergence-resync");
  assert.equal(meta.context_reset, "true");
}

function testBuildNoticeMetadataEmpty(): void {
  const meta = buildNoticeMetadata({});
  assert.deepEqual(meta, {});
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

testEmitNoticeChunkWritesChunkToRes();
testEmitNoticeChunkSetsSentRoleAndSentMetadata();
testEmitNoticeChunkIncludesExtraMetadata();
testEmitNoticeChunkSkipsMetadataIfAlreadySent();
testEmitNoticeChunkIncludesRoleWhenNotSent();
testBuildNoticeMetadataReturnsCorrectShape();
testBuildNoticeMetadataWithExtra();
testBuildNoticeMetadataEmpty();

// Suppress unused import warning
void randomUUID;

console.log("All chat-notice tests passed.");
