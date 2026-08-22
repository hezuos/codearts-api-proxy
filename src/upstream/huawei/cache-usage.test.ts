/**
 * cache token usage 估算测试。
 *
 * 覆盖 computeCacheUsage 的所有分支：
 * cold-start、normal、tail-divergence、middle-damage、duplicate/stale、
 * tool continuation、无记录、clamp 到 0。
 * 以及 lastPromptTokens 存取。
 */
import assert from "assert";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const chatRequest = require("./chat-request") as typeof import("./chat-request");

// ---------------------------------------------------------------------------
// computeCacheUsage
// ---------------------------------------------------------------------------

function testColdStart(): void {
  const r = chatRequest.computeCacheUsage(100, undefined, undefined, false, false);
  assert.equal(r.prompt_cache_hit_tokens, 0);
  assert.equal(r.prompt_cache_miss_tokens, 100);
  assert.equal(r.cache_estimated, true);
  assert.equal(r.prompt_tokens_details.cached_tokens, 0);
  assert.equal(r.prompt_tokens_details.text_tokens, 100);
}

function testNormalContinuation(): void {
  const r = chatRequest.computeCacheUsage(150, 100, "normal", true, false);
  assert.equal(r.prompt_cache_hit_tokens, 100);
  assert.equal(r.prompt_cache_miss_tokens, 50);
  assert.equal(r.prompt_tokens_details.cached_tokens, 100);
  assert.equal(r.prompt_tokens_details.text_tokens, 50);
}

function testTailDivergence(): void {
  const r = chatRequest.computeCacheUsage(150, 100, "tail-divergence", true, false);
  assert.equal(r.prompt_cache_hit_tokens, 100);
  assert.equal(r.prompt_cache_miss_tokens, 50);
  assert.equal(r.prompt_tokens_details.cached_tokens, 100);
  assert.equal(r.prompt_tokens_details.text_tokens, 50);
}

function testDuplicateStale(): void {
  const r = chatRequest.computeCacheUsage(100, 100, "duplicate/stale", true, false);
  assert.equal(r.prompt_cache_hit_tokens, 100);
  assert.equal(r.prompt_cache_miss_tokens, 0);
  assert.equal(r.prompt_tokens_details.cached_tokens, 100);
  assert.equal(r.prompt_tokens_details.text_tokens, 0);
}

function testMiddleDamage(): void {
  const r = chatRequest.computeCacheUsage(150, 100, "middle-damage", true, false);
  assert.equal(r.prompt_cache_hit_tokens, 0);
  assert.equal(r.prompt_cache_miss_tokens, 150);
  assert.equal(r.prompt_tokens_details.cached_tokens, 0);
  assert.equal(r.prompt_tokens_details.text_tokens, 150);
}

function testUndefinedDivergence(): void {
  const r = chatRequest.computeCacheUsage(150, 100, undefined, true, false);
  assert.equal(r.prompt_cache_hit_tokens, 0);
  assert.equal(r.prompt_cache_miss_tokens, 150);
  assert.equal(r.prompt_tokens_details.cached_tokens, 0);
  assert.equal(r.prompt_tokens_details.text_tokens, 150);
}

function testToolContinuationNoParent(): void {
  const r = chatRequest.computeCacheUsage(150, 100, undefined, false, true);
  assert.equal(r.prompt_cache_hit_tokens, 100);
  assert.equal(r.prompt_cache_miss_tokens, 50);
  assert.equal(r.prompt_tokens_details.cached_tokens, 100);
  assert.equal(r.prompt_tokens_details.text_tokens, 50);
}

function testToolContinuationWithParent(): void {
  // 有 parent 时走 divergence 分支，isToolContinuation 不介入
  const r = chatRequest.computeCacheUsage(150, 100, "normal", true, true);
  assert.equal(r.prompt_cache_hit_tokens, 100);
  assert.equal(r.prompt_cache_miss_tokens, 50);
  assert.equal(r.prompt_tokens_details.cached_tokens, 100);
  assert.equal(r.prompt_tokens_details.text_tokens, 50);
}

function testNoRecordedPreviousTokens(): void {
  const r = chatRequest.computeCacheUsage(150, undefined, "normal", true, false);
  assert.equal(r.prompt_cache_hit_tokens, 0);
  assert.equal(r.prompt_cache_miss_tokens, 150);
  assert.equal(r.prompt_tokens_details.cached_tokens, 0);
  assert.equal(r.prompt_tokens_details.text_tokens, 150);
}

function testClampToZero(): void {
  // prevPromptTokens > promptTokens 时 cache_miss clamp 到 0
  const r = chatRequest.computeCacheUsage(50, 100, "normal", true, false);
  assert.equal(r.prompt_cache_hit_tokens, 100);
  assert.equal(r.prompt_cache_miss_tokens, 0);
  assert.equal(r.prompt_tokens_details.cached_tokens, 100);
  assert.equal(r.prompt_tokens_details.text_tokens, 0);
}

// ---------------------------------------------------------------------------
// lastPromptTokens 存取
// ---------------------------------------------------------------------------

function testLastPromptTokensRoundTrip(): void {
  const chatId = "test-cache-round-trip";
  chatRequest.setLastPromptTokens(chatId, 3784);
  assert.equal(chatRequest.getLastPromptTokens(chatId), 3784);
}

function testLastPromptTokensOverwrite(): void {
  const chatId = "test-cache-overwrite";
  chatRequest.setLastPromptTokens(chatId, 100);
  chatRequest.setLastPromptTokens(chatId, 200);
  assert.equal(chatRequest.getLastPromptTokens(chatId), 200);
}

function testLastPromptTokensMissing(): void {
  assert.equal(chatRequest.getLastPromptTokens("nonexistent-cache-id"), undefined);
}

// ---------------------------------------------------------------------------
// 集成测试：验证 ...cacheUsage 展开后 prompt_tokens_details 注入 usage 顶层
// 模拟 chat.ts / chat-stream.ts 的 usage 构造方式
// ---------------------------------------------------------------------------

function testNonStreamingUsageSpread(): void {
  // 模拟 chat.ts L226-231 的 usage 构造
  const promptTokens = 150;
  const completionTokens = 50;
  const cacheUsage = chatRequest.computeCacheUsage(150, 100, "normal", true, false);
  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    ...cacheUsage,
  };
  // prompt_tokens_details 应该出现在 usage 顶层
  assert.equal(usage.prompt_tokens_details.cached_tokens, 100);
  assert.equal(usage.prompt_tokens_details.text_tokens, 50);
  // 顶层缓存字段仍在
  assert.equal(usage.prompt_cache_hit_tokens, 100);
  assert.equal(usage.prompt_cache_miss_tokens, 50);
  assert.equal(usage.cache_estimated, true);
}

function testStreamingUsageSpread(): void {
  // 模拟 chat-stream.ts L481-486 的 usage chunk 构造（include_usage=true 时）
  const promptTokens = 150;
  const completionTokens = 50;
  const cacheUsage = chatRequest.computeCacheUsage(150, 100, "tail-divergence", true, false);
  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    ...cacheUsage,
  };
  // 流式 usage chunk 同样包含 prompt_tokens_details
  assert.equal(usage.prompt_tokens_details.cached_tokens, 100);
  assert.equal(usage.prompt_tokens_details.text_tokens, 50);
  assert.equal(usage.prompt_cache_hit_tokens, 100);
  assert.equal(usage.prompt_cache_miss_tokens, 50);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

testColdStart();
testNormalContinuation();
testTailDivergence();
testDuplicateStale();
testMiddleDamage();
testUndefinedDivergence();
testToolContinuationNoParent();
testToolContinuationWithParent();
testNoRecordedPreviousTokens();
testClampToZero();
testLastPromptTokensRoundTrip();
testLastPromptTokensOverwrite();
testLastPromptTokensMissing();
testNonStreamingUsageSpread();
testStreamingUsageSpread();

console.log("All cache token usage tests passed.");
