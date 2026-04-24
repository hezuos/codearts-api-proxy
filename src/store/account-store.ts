import type { ProviderAccount } from "../db/models/provider-account";
import {
  getProviderAccount,
  setProviderAccount,
  deleteAccount,
  getAllProviderAccounts,
} from "../store/hierarchical-store";

// ---------------------------------------------------------------------------
// ProviderAccount operations
// ---------------------------------------------------------------------------

export function upsertProviderAccount(
  input: Omit<ProviderAccount, "createdAt" | "updatedAt">,
): ProviderAccount {
  const existing = getProviderAccount(input.id);
  const now = new Date().toISOString();
  const providerAccount: ProviderAccount = {
    ...input,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  setProviderAccount(providerAccount);
  return providerAccount;
}

export function listProviderAccounts(userId: string): ProviderAccount[] {
  return getAllProviderAccounts().filter(
    (providerAccount) => providerAccount.userId === userId,
  );
}

export { getProviderAccount };

export function setDefaultProviderAccount(
  userId: string,
  providerAccountId: string,
): ProviderAccount | null {
  const accounts = listProviderAccounts(userId);
  let selected: ProviderAccount | null = null;

  for (const account of accounts) {
    const updated = upsertProviderAccount({
      ...account,
      isDefault: account.id === providerAccountId,
    });
    if (updated.id === providerAccountId) {
      selected = updated;
    }
  }

  return selected;
}

export function deleteProviderAccount(
  userId: string,
  providerAccountId: string,
): boolean {
  const providerAccount = getProviderAccount(providerAccountId);
  if (!providerAccount || providerAccount.userId !== userId) {
    return false;
  }

  deleteAccount(userId, providerAccountId);
  return true;
}
