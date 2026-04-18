## Why

The proxy currently forwards only the simplest CodeArts chat shape: a single text prompt with fixed task parameters and a fresh conversation identity on every request. Real IDE traffic carries richer request semantics including persistent `chat_id` and `parent_message_id`, tool continuation via `tool_result`, sub-agent requests, dynamic tool sets, and model-specific routing. Without these behaviors, the proxy can return answers for simple chat but cannot faithfully proxy real CodeArts Agent workflows.

## What Changes

- Add full request-shape forwarding for CodeArts chat requests instead of flattening all OpenAI messages into one prompt.
- Preserve conversation continuity by tracking and forwarding upstream `chat_id`, `parent_message_id`, and related message identifiers across turns.
- Support tool continuation requests by forwarding upstream-compatible `tool_result` payloads and mapping upstream `tool_calls` back into OpenAI-compatible responses.
- Support sub-agent request mode with dynamic task parameters and tool lists based on request context.
- Expand model routing and upstream user/account identity forwarding to match observed IDE request formats.
- Persist any additional conversation metadata required to resume requests across process restarts.

## Capabilities

### New Capabilities

- `codearts-request-forwarding`: Build and forward CodeArts chat requests that preserve conversation state, tool continuation, sub-agent mode, and dynamic request metadata.

### Modified Capabilities

- None.

## Impact

- `src/upstream/huawei/chat.ts` request construction and response translation logic
- Session and persisted state handling under `src/auth/` to retain conversation metadata
- OpenAI request/response types in `src/types/openai.ts`
- Possible new storage for chat-thread state alongside existing auth/session persistence
- Documentation in `docs/` describing validated CodeArts request variants and forwarding behavior
