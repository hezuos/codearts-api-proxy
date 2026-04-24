import type {
  OpenAIModel,
  OpenAIModelsResponse,
} from "../types/openai";

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
