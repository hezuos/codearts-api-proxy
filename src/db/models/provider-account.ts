export interface ProviderAccount {
  id: string;
  userId: string;
  provider: "huawei-codearts";
  providerUserId?: string;
  providerUserName?: string;
  domainId?: string;
  displayName: string;
  isDefault: boolean;
  status: "active" | "invalid" | "pending";
  createdAt: string;
  updatedAt: string;
}
