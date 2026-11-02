import { createHash, randomUUID } from "crypto";
import { getUser } from "./hierarchical-store";
import { INVITE_TOKEN_TTL_MS } from "./user-store";

// ---------------------------------------------------------------------------
// 一次性绑定口令（内存存储，重启失效）
// ---------------------------------------------------------------------------

interface InviteTokenRecord {
  userId: string;
  expiresAt: number;
  consumed: boolean;
}

/** token 明文哈希 → 记录。明文只在签发时返回一次。 */
const inviteTokens = new Map<string, string>();

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function recordKey(userId: string, tokenHash: string): string {
  return `${userId}:${tokenHash}`;
}

/** 为指定用户签发一次性绑定口令，返回明文与过期时间。 */
export function issueInviteToken(userId: string): {
  token: string;
  expiresAt: string;
} {
  const user = getUser(userId);
  if (!user) {
    throw new Error(`User not found: ${userId}`);
  }
  const token = `sk-invite-${randomUUID().replace(/-/g, "")}`;
  const expiresAt = Date.now() + INVITE_TOKEN_TTL_MS;
  inviteTokens.set(recordKey(userId, hashToken(token)), JSON.stringify({
    userId,
    expiresAt,
    consumed: false,
  } satisfies InviteTokenRecord));
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

export type ConsumeInviteResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "missing" | "invalid" | "expired" };

/**
 * 原子消费一次性绑定口令。
 *
 * Node 单线程内同步执行，同一 tick 内两次调用必有一先一后，
 * 先到者标记 consumed，后到者判 invalid。
 */
export function consumeInviteToken(raw: string | undefined): ConsumeInviteResult {
  if (!raw) {
    return { ok: false, reason: "missing" };
  }
  const tokenHash = hashToken(raw);
  for (const [key, payload] of inviteTokens) {
    if (!key.endsWith(`:${tokenHash}`)) continue;
    const record = JSON.parse(payload) as InviteTokenRecord;
    if (record.consumed) {
      return { ok: false, reason: "invalid" };
    }
    if (Date.now() > record.expiresAt) {
      inviteTokens.delete(key);
      return { ok: false, reason: "expired" };
    }
    if (!getUser(record.userId)) {
      inviteTokens.delete(key);
      return { ok: false, reason: "invalid" };
    }
    inviteTokens.set(
      key,
      JSON.stringify({ ...record, consumed: true } satisfies InviteTokenRecord),
    );
    return { ok: true, userId: record.userId };
  }
  return { ok: false, reason: "invalid" };
}

/** 删除用户时作废其全部未消费口令。 */
export function invalidateInviteTokensForUser(userId: string): void {
  for (const [key, payload] of inviteTokens) {
    if (!key.startsWith(`${userId}:`)) continue;
    try {
      const record = JSON.parse(payload) as InviteTokenRecord;
      if (record.userId === userId) {
        inviteTokens.delete(key);
      }
    } catch {
      inviteTokens.delete(key);
    }
  }
}

export const __testHooks = {
  reset(): void {
    inviteTokens.clear();
  },
  size(): number {
    return inviteTokens.size;
  },
  /** 测试用：强制过期指定明文口令。 */
  expireForTest(raw: string): void {
    const tokenHash = hashToken(raw);
    for (const [key, payload] of inviteTokens) {
      if (!key.endsWith(`:${tokenHash}`)) continue;
      try {
        const record = JSON.parse(payload) as InviteTokenRecord;
        inviteTokens.set(
          key,
          JSON.stringify({ ...record, expiresAt: Date.now() - 1 }),
        );
      } catch {
        inviteTokens.delete(key);
      }
    }
  },
};
