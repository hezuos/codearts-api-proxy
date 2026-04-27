/**
 * Dynamic model list fetching from CodeArts upstream agent-center API.
 *
 * Flow:
 *   1. GET {gptsUrl}/useragents → get agent list (agent_id is UUID)
 *   2. GET {gptsUrl}/detail?agent_id={UUID} → get agent detail with models
 *   3. Extract model_alias from gpts.models[]
 *
 * Supports both internal and external version API paths:
 *   - Internal: URL includes PromptCenterService, response needs .json() parsing,
 *               models filtered by supported_clients
 *   - External: URL without PromptCenterService, response used directly,
 *               no supported_clients filtering
 */
import https from "https";
import { config, getGptsUrl } from "../../config";
import { getCredentials, signRequest } from "../../auth/huawei/credentials";
import type { StoredHuaweiSession } from "../../auth/huawei/session-store";
import type { OpenAIModel } from "../../types/openai";
import { MODEL_MAP } from "./chat";
import { logger } from "../../utils/logger";

// Re-export MODEL_MAP for any other consumers
export { MODEL_MAP } from "./chat";

// ---------------------------------------------------------------------------
// Per-account TTL cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  models: OpenAIModel[];
  fetchedAt: number;
}

/** accountId → cached model list */
const modelCache = new Map<string, CacheEntry>();

function isCacheFresh(accountId: string): boolean {
  const entry = modelCache.get(accountId);
  if (!entry) return false;
  const ageSeconds = (Date.now() - entry.fetchedAt) / 1000;
  return ageSeconds < config.modelCacheTtl;
}

export function invalidateCache(accountId?: string): void {
  if (accountId) {
    modelCache.delete(accountId);
  } else {
    modelCache.clear();
  }
}

// ---------------------------------------------------------------------------
// Common request helpers
// ---------------------------------------------------------------------------

function buildCommonHeaders(traceId: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "Agent-Type": "AgentCenter",
    "X-Language": "zh-CN",
    "x-snap-traceid": traceId,
    client_version: config.pluginVersion,
    "plugin-name": "codearts-snap_vscode",
    "plugin-version": config.pluginVersion,
    "ide-name": "CodeArts Agent",
    "ide-version": config.ideVersion,
  };
}

function addAuthToken(
  headers: Record<string, string>,
  session: StoredHuaweiSession,
): void {
  if (session.businessToken) {
    headers["x-auth-token"] = session.businessToken;
  }
}

// ---------------------------------------------------------------------------
// Step 1: Fetch agent list from /useragents
// ---------------------------------------------------------------------------

interface UpstreamAgent {
  agent_id: string;
  agent_name: string;
  is_primary_agent: boolean;
  [key: string]: unknown;
}

interface UserAgentsResponse {
  total: number;
  agents: UpstreamAgent[];
}

/**
 * Fetch the list of available agents from /useragents endpoint.
 * Returns the agent_id (UUID) of the first primary agent.
 */
async function fetchPrimaryAgentId(
  session: StoredHuaweiSession,
  traceId: string,
): Promise<string | undefined> {
  const gptsUrl = getGptsUrl();
  const url = new URL(`${gptsUrl}/useragents`);
  url.searchParams.set("offset", "0");
  url.searchParams.set("limit", "100");
  // Don't send supported_client — the field uses IDE codes (IJ, WS, etc.)
  // and "vscode" is not in the supported_clients array.
  // The server returns all agents; we pick the primary one.

  const credentials = getCredentials(session);
  const headers = buildCommonHeaders(traceId);
  addAuthToken(headers, session);

  const signed = signRequest(
    {
      method: "GET",
      url: url.toString(),
      headers: { "Content-Type": "application/json" },
    },
    credentials,
  );

  const response = await httpsGet(url.toString(), { ...headers, ...signed });

  if (response.status !== 200) {
    throw new Error(
      `UserAgents API returned HTTP ${response.status}: ${response.body.substring(0, 200)}`,
    );
  }

  const data = JSON.parse(response.body) as UserAgentsResponse;
  const agents = data.agents ?? [];

  // Find the first primary agent
  const primary = agents.find((a) => a.is_primary_agent);
  if (primary) {
    logger.info(
      `[${traceId}] Found primary agent: ${primary.agent_name} (${primary.agent_id})`,
    );
    return primary.agent_id;
  }

  // Fallback: use the first agent if no primary is marked
  if (agents.length > 0) {
    logger.info(
      `[${traceId}] No primary agent found, using first: ${agents[0].agent_name} (${agents[0].agent_id})`,
    );
    return agents[0].agent_id;
  }

  logger.warn(`[${traceId}] No agents found in /useragents response`);
  return undefined;
}

// ---------------------------------------------------------------------------
// Step 2: Fetch agent detail from /detail?agent_id={UUID}
// ---------------------------------------------------------------------------

interface UpstreamModel {
  model_alias?: string;
  model_name?: string;
  model_id?: string; // kept for backward compat with internal version
  model_parameters?: {
    supported_clients?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface AgentDetailResponse {
  gpts?: {
    models?: UpstreamModel[];
    [key: string]: unknown;
  };
  sub_agents?: unknown;
  [key: string]: unknown;
}

/**
 * Fetch model list from CodeArts agent-center detail API.
 * Returns an array of model IDs extracted from gpts.models.
 */
async function fetchUpstreamModels(
  session: StoredHuaweiSession,
  traceId: string,
): Promise<string[]> {
  const gptsUrl = getGptsUrl();

  // Step 1: Get agent_id from /useragents
  const agentId = await fetchPrimaryAgentId(session, traceId);
  if (!agentId) {
    logger.warn(
      `[${traceId}] No agent_id available, falling back to config default`,
    );
    // Fallback to config default (may not work in external version)
    const { getAgentId } = await import("../../config");
    const fallbackId = getAgentId();
    if (!fallbackId) return [];
    return fetchModelsForAgent(session, traceId, gptsUrl, fallbackId);
  }

  // Step 2: Get models from /detail
  return fetchModelsForAgent(session, traceId, gptsUrl, agentId);
}

async function fetchModelsForAgent(
  session: StoredHuaweiSession,
  traceId: string,
  gptsUrl: string,
  agentId: string,
): Promise<string[]> {
  const detailUrl = `${gptsUrl}/detail`;
  const credentials = getCredentials(session);

  // Build query params
  const url = new URL(detailUrl);
  url.searchParams.set("agent_id", agentId);

  const headers = buildCommonHeaders(traceId);
  addAuthToken(headers, session);

  // Sign the request (GET, no body)
  const signed = signRequest(
    {
      method: "GET",
      url: url.toString(),
      headers: { "Content-Type": "application/json" },
    },
    credentials,
  );

  const allHeaders = { ...headers, ...signed };

  // Make the request
  const response = await httpsGet(url.toString(), allHeaders);

  if (response.status !== 200) {
    throw new Error(
      `Agent detail API returned HTTP ${response.status}: ${response.body.substring(0, 200)}`,
    );
  }

  // Parse response — internal version wraps in an extra layer
  let data: AgentDetailResponse;
  if (config.isInnerVersion) {
    // Internal version: response may be wrapped, try .json() parsing
    const outer = JSON.parse(response.body) as
      | { data?: AgentDetailResponse }
      | AgentDetailResponse;
    data =
      (outer as { data?: AgentDetailResponse }).data ??
      (outer as AgentDetailResponse);
  } else {
    data = JSON.parse(response.body) as AgentDetailResponse;
  }

  // Extract models from gpts.models
  const rawModels = data.gpts?.models ?? [];
  if (!Array.isArray(rawModels) || rawModels.length === 0) {
    return [];
  }

  // Filter by supported_clients for internal version
  const filtered = config.isInnerVersion
    ? rawModels.filter((m) => {
        const clients = m.model_parameters?.supported_clients;
        if (!clients || !Array.isArray(clients)) return true;
        return clients.includes("all") || clients.includes("vscode");
      })
    : rawModels;

  // Extract model IDs — use model_alias (external) or model_id (internal)
  return filtered
    .map((m) => m.model_alias ?? m.model_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

// ---------------------------------------------------------------------------
// HTTP GET helper
// ---------------------------------------------------------------------------

function httpsGet(
  urlStr: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.get(
      url,
      { headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(10_000, () => {
      const err = new Error("Model list fetch timed out (10s)");
      req.destroy(err);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Model list composition: dynamic + static aliases
// ---------------------------------------------------------------------------

/**
 * Build the final model list by merging dynamic models with static MODEL_MAP aliases.
 * - Dynamic models take precedence on ID collision
 * - Static aliases (gpt-4, gpt-4o, etc.) always appear
 */
function composeModelList(dynamicModelIds: string[]): OpenAIModel[] {
  const now = Math.floor(Date.now() / 1000);
  const seen = new Set<string>();
  const result: OpenAIModel[] = [];

  // 1. Add dynamic models first (they take precedence)
  for (const id of dynamicModelIds) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push({
        id,
        object: "model",
        created: now,
        owned_by: "codearts",
      });
    }
  }

  // 2. Add static MODEL_MAP entries (both aliases and their resolved targets)
  for (const [alias, target] of Object.entries(MODEL_MAP)) {
    // Add the alias itself (e.g., "gpt-4")
    if (!seen.has(alias)) {
      seen.add(alias);
      result.push({
        id: alias,
        object: "model",
        created: now,
        owned_by: "codearts-agent-proxy",
      });
    }
    // Add the target if not already present (e.g., "Glm-4.7-internal")
    if (!seen.has(target)) {
      seen.add(target);
      result.push({
        id: target,
        object: "model",
        created: now,
        owned_by: "codearts",
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Static fallback
// ---------------------------------------------------------------------------

function getStaticModels(): OpenAIModel[] {
  return composeModelList([]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the model list for a given provider account.
 * Uses per-account TTL cache. Falls back to static models on fetch failure.
 */
export async function getModelList(
  accountId: string,
  session: StoredHuaweiSession,
  traceId: string,
  forceRefresh = false,
): Promise<OpenAIModel[]> {
  // Check cache
  if (!forceRefresh && isCacheFresh(accountId)) {
    const cached = modelCache.get(accountId)!;
    logger.info(`[${traceId}] Model list cache hit for account ${accountId}`);
    return cached.models;
  }

  // Fetch from upstream
  try {
    logger.info(
      `[${traceId}] Fetching model list from upstream for account ${accountId} (innerVersion=${config.isInnerVersion})`,
    );
    const dynamicIds = await fetchUpstreamModels(session, traceId);
    logger.info(
      `[${traceId}] Fetched ${dynamicIds.length} model(s) from upstream`,
    );

    const models = composeModelList(dynamicIds);

    // Update cache
    modelCache.set(accountId, { models, fetchedAt: Date.now() });

    return models;
  } catch (error) {
    logger.error(
      `[${traceId}] Failed to fetch model list from upstream`,
      { error: error instanceof Error ? error.message : String(error) },
    );
    logger.info(`[${traceId}] Falling back to static model list`);

    // Return static models as fallback (don't cache the fallback)
    return getStaticModels();
  }
}
