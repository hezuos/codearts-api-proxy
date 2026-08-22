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
// 调用顺序集成测试：验证「先快照 prev → set 本轮 → compute 用快照」的正确顺序。
// 回归 bug：setLastPromptTokens 在 computeCacheUsage 之前调用，导致 getLastPromptTokens
// 读到本轮刚写入的值，cacheHit 永远等于 promptTokens、cacheMiss 永远为 0。
// ---------------------------------------------------------------------------

function testNonStreamingCallOrder(): void {
  // 模拟 chat.ts 的真实调用顺序：快照 prev → compute → set
  const chatId = "test-order-nonstream";
  // 第 1 轮：无 prev，cold-start
  chatRequest.setLastPromptTokens(chatId, 100); // 第 1 轮结束后记录
  // 第 2 轮：promptTokens=150，prev=100（上一轮）
  const prev = chatRequest.getLastPromptTokens(chatId);
  const cacheUsage = chatRequest.computeCacheUsage(150, prev, "normal", true, false);
  // 修复后：cacheHit=100（上一轮），cacheMiss=50
  assert.equal(cacheUsage.prompt_cache_hit_tokens, 100);
  assert.equal(cacheUsage.prompt_cache_miss_tokens, 50);
  assert.equal(cacheUsage.prompt_tokens_details.cached_tokens, 100);
  assert.equal(cacheUsage.prompt_tokens_details.text_tokens, 50);
  // bug 回归：若 set 在 compute 之前，cacheHit 会等于 150
  assert.notEqual(cacheUsage.prompt_cache_hit_tokens, 150);
}

function testStreamingCallOrder(): void {
  // 模拟 chat-stream.ts 的真实调用顺序：快照 prev → set → compute 用快照
  const chatId = "test-order-stream";
  // 第 1 轮结束后记录
  chatRequest.setLastPromptTokens(chatId, 200);
  // 第 2 轮：先快照 prev，再 set 本轮，再 compute 用快照
  const prevPromptTokens = chatRequest.getLastPromptTokens(chatId);
  chatRequest.setLastPromptTokens(chatId, 300); // 本轮 promptTokens
  const cacheUsage = chatRequest.computeCacheUsage(
    300,
    prevPromptTokens,
    "tail-divergence",
    true,
    false,
  );
  // 修复后：cacheHit=200（上一轮快照），cacheMiss=100
  assert.equal(cacheUsage.prompt_cache_hit_tokens, 200);
  assert.equal(cacheUsage.prompt_cache_miss_tokens, 100);
  assert.equal(cacheUsage.prompt_tokens_details.cached_tokens, 200);
  assert.equal(cacheUsage.prompt_tokens_details.text_tokens, 100);
  // bug 回归：若用 getLastPromptTokens(cid) 而非快照，cacheHit 会等于 300
  assert.notEqual(cacheUsage.prompt_cache_hit_tokens, 300);
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
testNonStreamingCallOrder();
testStreamingCallOrder();

console.log("All cache token usage tests passed.");
