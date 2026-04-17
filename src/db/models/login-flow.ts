export interface LoginFlow {
  id: string;
  userId: string;
  provider: "huawei-codearts";
  ticketId: string;
  state: string;
  loginUrl: string;
  identifier?: string;
  status: "pending" | "completed" | "expired" | "cancelled";
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}
