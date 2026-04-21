import { randomUUID } from "crypto";
import type {
  OpenAIChatCompletion,
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionRequest,
  OpenAIChatMessage,
  OpenAIModel,
  OpenAIModelsResponse,
} from "../types/openai";

function getPromptText(messages: OpenAIChatMessage[]): string {
  return messages
    .map((message) => `${message.role}: ${message.content ?? ""}`.trim())
    .join("\n");
}

export function buildModelsResponse(
  models: OpenAIModel[] = [],
): OpenAIModelsResponse {
  // If dynamic models are provided, use them; otherwise fall back to static single model
  const data =
    models.length > 0
      ? models
      : [
          {
            id: "codearts-chat",
            object: "model" as const,
            created: Math.floor(Date.now() / 1000),
            owned_by: "codearts-agent-proxy",
          },
        ];
  return { object: "list", data };
}

export function buildCompletionResponse(
  request: OpenAIChatCompletionRequest,
): OpenAIChatCompletion {
  const content = `echo: ${getPromptText(request.messages)}`;
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: request.messages.length,
      completion_tokens: content.length,
      total_tokens: request.messages.length + content.length,
    },
  };
}

export function buildStreamingChunks(
  request: OpenAIChatCompletionRequest,
): OpenAIChatCompletionChunk[] {
  const content = `echo: ${getPromptText(request.messages)}`;
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  return [
    {
      id,
      object: "chat.completion.chunk",
      created,
      model: request.model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant" },
          finish_reason: null,
        },
      ],
    },
    {
      id,
      object: "chat.completion.chunk",
      created,
      model: request.model,
      choices: [
        {
          index: 0,
          delta: { content },
          finish_reason: null,
        },
      ],
    },
    {
      id,
      object: "chat.completion.chunk",
      created,
      model: request.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
    },
  ];
}
