## 1. CRITICAL Bug Fixes

- [x] 1.1 Fix `refreshStoredSession` to use shallow copy before mutation — update `src/auth/huawei/session-store.ts:refreshStoredSession` to `{ ...stored }` then modify copy, call `setSession` only on success
- [x] 1.2 Remove runtime `apiKeysByValue` population in `setApiKey` — remove `apiKeysByValue.set(rawKeyValue, apiKey)` from `src/store/hierarchical-store.ts:setApiKey`
- [x] 1.3 Remove `apiKeysByValue` fallback in `findApiKeyByValue` — remove `return apiKeysByValue.get(rawKey)` from `src/store/hierarchical-store.ts:findApiKeyByValue`
- [x] 1.4 Fix `httpsPost` error propagation — add `streamError` variable in iterator, set in `res.on("error")`, throw in `next()` when `done && streamError`
- [x] 1.5 Fix `deleteKey` apiKeysByValue cleanup — iterate `apiKeysByValue` entries to find and delete matching apiKey, instead of using `apiKey.keyHash` as key

## 2. HIGH Priority Fixes

- [x] 2.1 Change `buildRequestBody` return type to `{ body: Record<string, unknown>, json: string }` — update `src/upstream/huawei/chat-request.ts:buildRequestBody`
- [x] 2.2 Adapt `chat-stream.ts` to new `buildRequestBody` return type — use `body` for log fields, `json` for headers and POST
- [x] 2.3 Adapt `chat.ts` to new `buildRequestBody` return type — use `body` for log fields, `json` for headers and POST
- [x] 2.4 Fix `deriveConversationId` collision — add `session.providerAccountId + ":"` prefix to hash input
- [x] 2.5 Fix Admin password timing attack — replace `password === adminPasswordFromEnv` with `crypto.timingSafeEqual` in `src/auth/admin.ts:checkAdminPassword`
- [x] 2.6 Fix `refresh-task.ts` setTimeout leak — add `clearTimeout` in finally block after `Promise.race`
- [x] 2.7 Fix `models.ts` httpsGet timeout — add explicit `reject` call in `setTimeout` callback alongside `req.destroy`

## 3. MEDIUM Priority Fixes

- [x] 3.1 Fix `getAllSessions()` to return copy — change to `return new Map(sessions)` in `src/store/hierarchical-store.ts`
- [x] 3.2 Add `UPSTREAM_TIMEOUT_MS` env var — add to `src/config.ts`, use in `chat-request.ts:httpsPost` and `models.ts:httpsGet`
- [x] 3.3 Add startup warning for dev encryption key — in `src/config.ts` or `src/index.ts`, warn if using hardcoded key and data dir has files
- [x] 3.4 Fix PROTOCOL_ERROR handling in `chat.ts` — skip events with `error_code === "PROTOCOL_ERROR"` instead of throwing
- [x] 3.5 Fix PROTOCOL_ERROR handling in `chat-stream.ts` — skip events with `error_code === "PROTOCOL_ERROR"` instead of break
- [x] 3.6 Add `IS_MASTER_NODE` env var — add to `src/config.ts`, use in `src/auth/huawei/refresh-task.ts` instead of hardcoded `true`
- [x] 3.7 Fix non-streaming `tool_calls` merge — change `toolCalls = mapped` to merge logic in `src/upstream/huawei/chat.ts`
- [x] 3.8 Fix `logger.ts` invalid LOG_LEVEL — validate at startup, fallback to default with warning
- [x] 3.9 Fix `readEncryptedFile` decryption failure tolerance — catch decrypt/parse errors in `loadAllEntities`, log warning, skip entity

## 4. Request Cancellation

- [x] 4.1 Add `AbortController` to `handleStreamingRequest` — create AC, `res.on("close", () => ac.abort())`, pass signal to `httpsPost`
- [x] 4.2 Add `AbortController` to `handleNonStreamingRequest` — same pattern
- [x] 4.3 Add `signal` option to `httpsPost` — pass to `https.request`, handle abort in req error handler
- [x] 4.4 Log cancellation events — log info when request is cancelled due to client disconnect

## 5. Unauthenticated Rate Limiting

- [x] 5.1 Create IP-based rate limiter for admin endpoints — `express-rate-limit` with `max: 10, windowMs: 60_000`
- [x] 5.2 Apply limiter to `/admin/login` POST route
- [x] 5.3 Apply limiter to `/admin/setup` POST route

## 6. Dead Code & Cleanup

- [x] 6.1 Remove `res.req as Request` from `handleStreamingRequest` — remove unused `auth` variable
- [x] 6.2 Remove `res.req as Request` from `handleNonStreamingRequest` — remove unused `auth` variable
- [x] 6.3 Fix `index.ts` indentation — fix `bootstrapDefaultAuth()` line alignment
- [x] 6.4 Clear `apiKeysByValue` after migration completes — at end of `loadAllEntities`, if all keys are hashed, clear the legacy map

## 7. Verification

- [x] 7.1 Run `npx tsc --noEmit` — zero errors
- [x] 7.2 Run `npx eslint src/ --ext .ts` — zero errors
- [x] 7.3 Run `pnpm test` — all tests pass
- [x] 7.4 Run `pnpm run dev` — server starts without errors
