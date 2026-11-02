/**
 * Auth store facade — re-exports from domain-specific store modules.
 *
 * New code should import directly from the specific store module:
 *   - `store/user-store`     for User CRUD
 *   - `store/account-store`  for ProviderAccount CRUD
 *   - `store/api-key-store`  for ApiKey CRUD + validation + AuthContext
 *   - `store/session-store`  for Session operations
 *
 * This facade exists for backward compatibility with existing imports.
 */

// User operations
export {
  loadPersistedAuthStore,
  createUser,
  getUser,
  getDefaultUser,
  listAllUsers,
  INVITE_TOKEN_TTL_MS,
} from "../store/user-store";

// ProviderAccount operations
export {
  upsertProviderAccount,
  listProviderAccounts,
  getProviderAccount,
  setDefaultProviderAccount,
  deleteProviderAccount,
} from "../store/account-store";

// ApiKey operations + AuthContext
export {
  AuthContext,
  AccountAuthContext,
  AggregateAuthContext,
  issueApiKey,
  validateApiKey,
  getUserApiKey,
  revokeApiKey,
  listApiKeysByUser,
  listBoundAccountIds,
  resolveBalancingPolicy,
  getApiKey,
  getKeyLocation,
  getSessionByKeyId,
} from "../store/api-key-store";

// Session operations
export {
  setSession,
  getSession,
  deleteSession,
  listSessionEntries,
  persistApiKey,
  type SessionEntry,
} from "../store/hierarchical-store";

// Hierarchical store direct access (used by admin, web-ui)
export {
  deleteKey,
  listAccounts,
  listKeys,
  getAllApiKeys,
  resolveKeyScope,
  resolveBoundAccountIds,
} from "../store/hierarchical-store";
