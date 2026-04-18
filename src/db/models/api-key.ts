export interface ApiKey {
  id: string;
  userId: string;
  providerAccountId?: string;
  keyHash: string;
  name: string;
  revokedAt?: string;
  createdAt: string;
  updatedAt: string;
}
