/**
 * 统一 notice 机制测试（chat-notice.ts）。
 *
 * 覆盖：写入 SSE chunk、返回 sentRole/sentMetadata 状态、已发送 metadata 时跳过。
 */
import assert from "assert";
import type { ServerResponse } from "http";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { emitNoticeChunk } = require("./chat-notice") as typeof import("./chat-notice");

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
  assert.equal(chunk.codearts.chat_id, "c1");
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

testEmitNoticeChunkWritesChunkToRes();
testEmitNoticeChunkSetsSentRoleAndSentMetadata();
testEmitNoticeChunkSkipsMetadataIfAlreadySent();
testEmitNoticeChunkIncludesRoleWhenNotSent();

console.log("All chat-notice tests passed.");
