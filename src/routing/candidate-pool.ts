/**
 * 候选账号池：按"可用"三条件合取求值。
 *
 * 候选集在**每次请求**时重新求值——账号状态、Key 吊销状态与会话有效性
 * 都可能在上一次请求之后发生变化，缓存候选集会让已失效的账号继续被选中。
 */

import type { ApiKey } from "../db/models/api-key";
import type { StoredHuaweiSession } from "../auth/huawei/session-store";
import { listProviderAccounts } from "../store/account-store";
import { listApiKeysByUser } from "../store/api-key-store";
import {
  getSession,
  resolveBoundAccountIds,
  resolveKeyScope,
} from "../store/hierarchical-store";
import { hasFreeSlot } from "./account-selector";

/** 一个可用账号及其可借用的会话。 */
export interface UsableAccount {
  accountId: string;
  /** 用于借用会话的账号级 Key ID。 */
  keyId: string;
  session: StoredHuaweiSession;
  /** 该账号当前是否有空闲并发槽位。 */
  hasFreeSlot: boolean;
}

/** 会话是否可用于发起上游请求——需同时具备 AK 与密文 SK。 */
function isUsableSession(
  session: StoredHuaweiSession | undefined,
): session is StoredHuaweiSession {
  return !!session && !!session.accessKey && !!session.secretKeyCiphertext;
}

/**
 * 该用户的可用账号。
 *
 * 三条件合取：
 * 1. 账号状态为 active；
 * 2. 存在未吊销的账号级 Key；
 * 3. 该 Key 在该账号下持有可用会话。
 *
 * 每个账号只取一个可用 Key——同一账号的多个 Key 持有等价凭据，取第一个即可。
 */
export function listUsableAccounts(userId: string): UsableAccount[] {
  const result: UsableAccount[] = [];
  const accounts = listProviderAccounts(userId);
  const keys = listApiKeysByUser(userId);

  for (const account of accounts) {
    if (account.status !== "active") continue;
    for (const key of keys) {
      if (key.revokedAt) continue;
      if (resolveKeyScope(key) !== "account") continue;
      if (!resolveBoundAccountIds(key).includes(account.id)) continue;
      const session = getSession(key.id, account.id);
      if (!isUsableSession(session)) continue;
      result.push({
        accountId: account.id,
        keyId: key.id,
        session,
        hasFreeSlot: hasFreeSlot(account.id),
      });
      break;
    }
  }
  return result;
}

/**
 * 账号级 Key 的候选账号：其显式绑定的账号与可用账号的交集。
 */
export function listBoundUsableAccounts(key: ApiKey): UsableAccount[] {
  const bound = resolveBoundAccountIds(key);
  return listUsableAccounts(key.userId).filter((u) => bound.includes(u.accountId));
}
