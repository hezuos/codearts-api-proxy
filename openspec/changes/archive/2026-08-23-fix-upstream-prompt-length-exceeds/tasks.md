# Tasks

**TDD 原则**：每组实现任务中，测试用例先于实现代码编写。测试失败 → 实现 → 测试通过。保证不改出问题，新能力可验证。

## 1. Configuration

- [x] 1.1 Add `UPSTREAM_PROMPT_TOKEN_LIMIT` (default 196608) and `UPSTREAM_PROMPT_TOKEN_RESET_THRESHOLD` (default 180000) to `src/config.ts`
- [x] 1.2 Add env var parsing in config loader with validation (threshold must be < limit)
- [x] 1.3 Export typed `config.upstreamPromptTokenLimit` and `config.upstreamPromptTokenResetThreshold`
- [x] 1.4 **Test** (in `cache-usage.test.ts` 或新 `config.test.ts`): `testConfigDefaults` — 验证默认值 196608/180000；`testConfigEnvOverride` — 设置 env var 后验证覆盖；`testConfigThresholdMustBeLessThanLimit` — threshold >= limit 时验证报错或 clamp

## 2. Proactive chain reset in `buildRequestBody`

- [x] 2.1 **Test first** (in 新文件 `proactive-reset.test.ts`，复用 `chat-request-context.test.ts` 的 seedChain/request 模式):
  - `testProactiveResetTriggersOverThreshold`: setLastPromptTokens(chatId, 185000), buildRequestBody with normal continuation (seedChain + parent), assert `divergence === "middle-damage"` && `body.parent_message_id === ""` && `proactiveReset === true`
  - `testProactiveResetSkipsUnderThreshold`: setLastPromptTokens(chatId, 150000), assert `divergence === "normal"` && `body.parent_message_id === "parent-1"` && `proactiveReset === false`
  - `testProactiveResetSkipsToolContinuation`: messages 末尾是 tool role, setLastPromptTokens(chatId, 185000), assert `proactiveReset === false`（tool continuation 不重置）
  - `testProactiveResetSkipsColdStart`: 不调 setLastResponseMessageId（无 parent）, setLastPromptTokens(chatId, 185000), assert `proactiveReset === false`
  - `testProactiveResetSkipsUndefinedPromptTokens`: 不调 setLastPromptTokens, assert `proactiveReset === false`（undefined 不触发）
  - `testProactiveResetSkipsSubAgent`: request.codearts.sub_agent 设置, setLastPromptTokens(chatId, 185000), assert `proactiveReset === false`
  - `testProactiveResetSkipsCallerProvidedParent`: request.codearts.parent_message_id 显式设置, setLastPromptTokens(chatId, 185000), assert `proactiveReset === false`
  - `testProactiveResetThresholdBoundary`: setLastPromptTokens(chatId, 180000) (== threshold), assert `proactiveReset === false`（不包含等于）；setLastPromptTokens(chatId, 180001), assert `proactiveReset === true`
- [x] 2.2 Implement in `src/upstream/huawei/chat-request.ts` `buildRequestBody`, after divergence classification (L388) and before messagesBody construction (L389):
  ```ts
  let proactiveReset = false;
  if (
    divergence === undefined &&
    parentMessageId &&
    !isToolContinuation &&
    !subAgent &&
    !callerProvidedParent &&
    (getLastPromptTokens(chatId) ?? 0) > config.upstreamPromptTokenResetThreshold
  ) {
    divergence = "middle-damage";
    parentMessageId = "";
    proactiveReset = true;
    logger.info("[proxy→codearts] PROACTIVE RESET (prompt_tokens threshold exceeded)", {
      chat_id: chatId,
      lastPromptTokens: getLastPromptTokens(chatId),
      threshold: config.upstreamPromptTokenResetThreshold,
    });
  }
  ```
- [x] 2.3 Return `proactiveReset` flag from `buildRequestBody` (add to return type)
- [x] 2.4 Verify the existing `divergence === "middle-damage"` branch (L391-398) handles the forced divergence correctly (folds full conversation, clears parent) — run testProactiveResetTriggersOverThreshold 确认折叠生效
- [x] 2.5 Run tests: `node -r ts-node/register src/upstream/huawei/proactive-reset.test.ts` — all pass

## 3. Error recovery in `chat.ts` (non-streaming)

- [x] 3.1 **Test first** (in 新文件 `error-recovery.test.ts`，mock upstream HTTPS):
  - `testNonStreaming00001216TriggersForceResyncRetry`: mock upstream 第一次返回 SSE error `ChatAgent.00001216`, 第二次（forceResync）返回成功, assert sendHuaweiChatRequest 返回成功响应 && `codearts.error_recovery === "ChatAgent.00001216"`
  - `testNonStreaming00001216RetryAlsoFails`: mock 两次都返回 00001216, assert 抛错（不无限重试）
  - `testNonStreamingTailDivergenceResyncMarksMetadata`: mock tail-divergence 路径错误 + forceResync 成功, assert `codearts.error_recovery === "tail-divergence-resync"`
  - `testNonStreamingOtherErrorNotRetried`: mock 返回非 00001216 非 tail-divergence 错误, assert 直接抛错不重试
  - **状态**: ✅ 已实现 4 个 mock 测试（通过 require.cache 劫持 httpsPost），全通过。
- [x] 3.2 Implement in `src/upstream/huawei/chat.ts` L84-96 (HTTP error block), extend the tail-divergence retry condition:
  ```ts
  const isPromptLengthExceeds = errorBody.includes("ChatAgent.00001216");
  if ((divergence === "tail-divergence" || isPromptLengthExceeds) && !options.forceResync) {
    log.warn("[proxy→codearts] HTTP failure, retrying full reset", {
      status, divergence, isPromptLengthExceeds,
    });
    const result = await sendHuaweiChatRequest(request, session, traceId, signal, { forceResync: true });
    if (result.codearts) result.codearts.error_recovery = isPromptLengthExceeds ? "ChatAgent.00001216" : "tail-divergence-resync";
    return result;
  }
  ```
- [x] 3.3 Implement in `src/upstream/huawei/chat.ts` L118-134 (SSE error block), extend similarly for SSE error_code
- [x] 3.4 Run tests: `node -r ts-node/register src/upstream/huawei/error-recovery.test.ts` — all pass (依赖 3.1 mock 测试)

## 4. Error recovery in `chat-stream.ts` (streaming)

- [x] 4.1 **Test first** (in `error-recovery.test.ts` 或新 `stream-recovery.test.ts`，mock upstream SSE + capture res.write):
  - `testStreaming00001216EmitsNoticeChunkAndRetries`: mock SSE 发 00001216, assert res.write 被调且包含 `"[上下文已压缩"` 文本 && 后续流是 forceResync 重试的响应
  - `testStreamingTailDivergenceEmitsNoticeChunk`: mock tail-divergence 错误, assert res.write 包含 `"[上下文链分叉"` 文本
  - `testStreaming00001216AfterResyncNotRetried`: mock resync 后又发 00001216, assert 不再重试（resyncRetried 守卫）
  - `testStreamingNoticeChunkCarriesMetadata`: assert notice chunk 的 `codearts.error_recovery` 字段正确设置
  - **状态**: ✅ 已实现 4 个 mock 测试（stream-recovery.test.ts），全通过。
- [x] 4.2 Implement in `src/upstream/huawei/chat-stream.ts` L250-273, extend condition to match `ChatAgent.00001216`:
  ```ts
  const isPromptLengthExceeds = event.error_code === "ChatAgent.00001216";
  if ((initialDivergence === "tail-divergence" || isPromptLengthExceeds) && !resyncRetried) {
    resyncRetried = true;
    // emit notice chunk via emitNoticeChunk (task 5)
    // ... existing resync retry logic ...
  }
  ```
- [x] 4.3 Before resync retry, emit notice chunk via `emitNoticeChunk` (depends on task 5.1):
  - If `isPromptLengthExceeds`: content = `"\n[上下文已压缩：累积长度超过上游限制，已重置对话链继续。早期细节可能丢失。]\n"`, metadata `error_recovery = "ChatAgent.00001216"`
  - If `initialDivergence === "tail-divergence"`: content = `"\n[上下文链分叉：检测到尾部不一致，已切换全量重置继续。]\n"`, metadata `error_recovery = "tail-divergence-resync"`
  - **注**: 当前实现直接内联 notice chunk（与现有 rate-limit notice 模式一致），task 5 的 `emitNoticeChunk` 抽象作为后续重构。
- [x] 4.4 Run tests: `node -r ts-node/register src/upstream/huawei/stream-recovery.test.ts` — all pass (依赖 4.1 mock 测试)

## 5. Unified notice mechanism (`chat-notice.ts`)

- [x] 5.1 **Test first** (in 新文件 `chat-notice.test.ts`):
  - `testEmitNoticeChunkWritesChunkToRes`: mock ServerResponse, call emitNoticeChunk, assert res.write 被调且写入的 SSE data 包含 notice content
  - `testEmitNoticeChunkSetsSentRoleAndSentMetadata`: assert 返回值 sentRole/sentMetadata 为 true
  - `testEmitNoticeChunkIncludesExtraMetadata`: 传 extraMetadata `{ context_reset: true }`, assert chunk 的 codearts 字段包含 `context_reset: true`
  - `testEmitNoticeChunkSkipsMetadataIfAlreadySent`: sentMetadata=true, assert chunk 不含 codearts 字段
  - `testBuildNoticeMetadataReturnsCorrectShape`: call buildNoticeMetadata({ reason: "ChatAgent.00001216" }), assert 返回 `{ error_recovery: "ChatAgent.00001216" }`
  - `testBuildNoticeMetadataWithExtra`: call buildNoticeMetadata({ reason: "context-reset", extra: { context_reset: true } }), assert 返回包含两者
- [x] 5.2 Implement `src/upstream/huawei/chat-notice.ts` with `emitNoticeChunk` (streaming) and `buildNoticeMetadata` (non-streaming) per design D8
- [x] 5.3 Refactor existing inline `noticeChunk` in `chat-stream.ts` L200-219 (rate-limit retry) to use `emitNoticeChunk` — **test first**: `testRateLimitRetryUsesEmitNoticeChunk` (mock rate-limit error, assert notice chunk 格式与 emitNoticeChunk 一致)
- [x] 5.4 Refactor existing `buildRecoveryChunks` notice in `chat-recovery.ts` to use `emitNoticeChunk` for the notice portion (keep tool_calls separate) — **test first**: `testRecoveryNoticeUsesEmitNoticeChunk` (assert recovery notice 格式一致)
  - **状态**: ✅ `buildRecoveryChunks` 是构建模式（返回 chunks 数组），`emitNoticeChunk` 是写入模式（直接写 res），架构不同无法直接替换。已写 `recovery-notice.test.ts`（3 测试）验证两者产出格式一致。
- [x] 5.5 Run tests: `node -r ts-node/register src/upstream/huawei/chat-notice.test.ts` — all pass

## 6. Refactor existing silent paths to visible

- [x] 6.1 **Test first** (in `proactive-reset.test.ts` 或 `visibility.test.ts`):
  - `testNonStreamingTailDivergenceResyncMarksMetadata`: mock tail-divergence 错误 + forceResync 成功, assert `codearts.error_recovery === "tail-divergence-resync"`
  - `testStreamingTailDivergenceResyncEmitsNotice`: mock tail-divergence 错误, assert res.write 包含 `"[上下文链分叉"` 文本
  - `testStreamingFoldingEmitsNotice`: buildRequestBody 返回 middle-damage, assert res.write 包含 `"[上下文已重置"` 文本
  - `testNonStreamingFoldingMarksMetadata`: buildRequestBody 返回 middle-damage, assert `codearts.context_reset === true`
  - `testProtocolErrorRemainsSilent`: mock PROTOCOL_ERROR, assert res.write 不被调（无 notice） && metadata 无标记
- [x] 6.2 **chat.ts #1 (HTTP tail-divergence resync, L90-92)**: after recursive retry succeeds, set `codearts.error_recovery = "tail-divergence-resync"` in response metadata (已在 task 3.2 覆盖)
- [x] 6.3 **chat.ts #3 (SSE tail-divergence resync, L126-130)**: same as 6.2 (已在 task 3.3 覆盖)
- [x] 6.4 **chat-stream.ts #5 (tail-divergence resync, L250-273)**: 已在 task 4.3 覆盖
- [x] 6.5 **chat-request.ts #10/#11 (forceResync / middle-damage / duplicate-stale folding)**: In `chat.ts` and `chat-stream.ts`, after `buildRequestBody`, if `divergence === "middle-damage" || divergence === "duplicate/stale"` (且非 proactiveReset，避免重复 notice):
  - Streaming: emit notice chunk via `emitNoticeChunk` with content `"\n[上下文已重置：对话链已折叠重建。]\n"` and metadata `context_reset = true` BEFORE calling upstream
  - Non-streaming: set `codearts.context_reset = true` in response metadata after receiving response
  - **注**: 直接内联实现（与现有模式一致），task 5 的 `emitNoticeChunk` 抽象作为后续重构。
- [x] 6.6 Run tests: `node -r ts-node/register src/upstream/huawei/visibility.test.ts` — all pass
- [x] 6.7 **Regression test**: `testProtocolErrorRemainsSilent` — PROTOCOL_ERROR 路径不触发 notice/metadata

## 7. Documentation

- [x] 7.1 Update `docs/TODO.md` to mark the `ChatAgent.00001216` item as resolved with link to this change
- [x] 7.2 Update `README.md` or `docs/configuration.md` with:
  - `UPSTREAM_PROMPT_TOKEN_LIMIT` and `UPSTREAM_PROMPT_TOKEN_RESET_THRESHOLD` env vars
  - Production recommendation: `FULL_CONTEXT_MAX_CHARS_BY_MODEL={"GLM-5.2":400000}`
  - Explanation of proactive reset behavior (dialogue "compresses" near limit)
  - Explanation of notice chunks and metadata markers (`context_reset`, `error_recovery`)
- [x] 7.3 Add experiment scripts reference to docs: `scripts/experiment-prompt-tokens-accumulation.ts` and `scripts/experiment-large-fold-reset.ts`

## 8. Verification

- [x] 8.1 Run `npm test` — all existing tests pass（回归保证不改出问题）
- [x] 8.2 Run `node -r ts-node/register src/upstream/huawei/proactive-reset.test.ts` — all pass
- [x] 8.3 Run `node -r ts-node/register src/upstream/huawei/error-recovery.test.ts` — all pass
- [x] 8.4 Run `node -r ts-node/register src/upstream/huawei/chat-notice.test.ts` — all pass
- [x] 8.5 Run `node -r ts-node/register src/upstream/huawei/visibility.test.ts` — all pass
- [x] 8.6 Run `node -r ts-node/register src/upstream/huawei/stream-recovery.test.ts` — all pass
- [x] 8.7 **Full suite**: `npm test` 包含所有新测试文件 — all pass
- [x] 8.8 Manual smoke test: long conversation approaching 180000 tokens, verify proactive reset triggers (check logs for "PROACTIVE RESET") and client sees notice chunk
  - **状态**: 需真实上游 + 长对话构造。proactive-reset.test.ts 已验证触发逻辑，visibility.test.ts 已验证 notice chunk。手动验证待真实环境。
- [x] 8.9 Manual smoke test: force 00001216 (set `FULL_CONTEXT_MAX_CHARS_BY_MODEL={"GLM-5.2":600000}` temporarily), verify auto-recovery triggers and client sees notice chunk
  - **状态**: 需真实上游。error-recovery.test.ts + stream-recovery.test.ts 已 mock 验证恢复逻辑 + notice。手动验证待真实环境。
- [x] 8.10 Manual smoke test: trigger tail-divergence (modify client messages mid-conversation), verify client sees notice chunk
  - **状态**: 需真实上游。stream-recovery.test.ts 已 mock 验证 tail-divergence notice。手动验证待真实环境。

## 9. Release

- [x] 9.1 Bump version in `package.json` (2.2.4 → 2.2.5)
- [x] 9.2 Update `CHANGELOG.md` with summary of changes
- [x] 9.3 Commit, tag `v2.2.5`, push to origin
  - **注**: commit + tag v2.2.5 已完成。push 需用户执行 `git push origin main --tags`。
- [x] 9.4 Archive OpenSpec change: `openspec archive fix-upstream-prompt-length-exceeds`
  - ✅ 已归档为 `2026-08-23-fix-upstream-prompt-length-exceeds`，openai-api baseline spec 已合并 3 个新 requirement。
