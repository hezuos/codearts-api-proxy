## 1. Conversation State Foundation

- [x] 1.1 Add a persisted conversation-thread state store for upstream `chat_id`, parent/response message IDs, model ID, and account linkage
- [x] 1.2 Define proxy conversation identifiers and state lookup/update helpers used by chat routes and upstream forwarding
- [x] 1.3 Load and save conversation-thread state across process restarts with the existing encrypted persistence approach

## 2. Request Modeling And Forwarding

- [x] 2.1 Extend request types to support proxy-specific continuation metadata, sub-agent directives, and tool-result payloads
- [x] 2.2 Refactor `src/upstream/huawei/chat.ts` to build separate upstream request modes for standard turns, tool continuation turns, and sub-agent turns
- [x] 2.3 Replace prompt flattening with request construction that preserves the current-turn message semantics and forwards stored upstream identifiers
- [x] 2.4 Update model routing and upstream `user_id` forwarding to use validated CodeArts values and safe fallbacks

## 3. Response Translation And Tool Continuation

- [x] 3.1 Capture upstream metadata events in streaming and non-streaming paths and persist the identifiers required for the next turn
- [x] 3.2 Translate upstream `tool_calls` into OpenAI-compatible response fields for both streaming and non-streaming responses
- [x] 3.3 Accept tool execution result input from clients and forward it as upstream-compatible `task_parameters.tool_result`
- [x] 3.4 Add context-specific tool catalogs for standard and sub-agent requests based on validated captures

## 4. Verification And Documentation

- [x] 4.1 Update forwarding documentation in `docs/` to describe supported request variants, model IDs, and persistence behavior
- [x] 4.2 Add regression coverage or replay-style verification for standard chat, continuation chat, tool-result continuation, and sub-agent forwarding
- [ ] 4.3 Run end-to-end manual validation against live CodeArts traffic patterns and record any remaining unsupported request variants
