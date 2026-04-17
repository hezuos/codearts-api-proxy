export interface ProviderSession {
  id: string;
  providerAccountId: string;
  businessToken?: string;
  accessKey?: string;
  secretKeyCiphertext?: string;
  securityToken?: string;
  expiresAt?: string;
  refreshAfterAt?: string;
  rawPayloadCiphertext?: string;
  createdAt: string;
  updatedAt: string;
}
