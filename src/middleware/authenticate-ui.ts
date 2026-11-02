import type { Request, Response, NextFunction } from "express";
import { validateApiKey } from "../auth/store";
import { tryDecryptString } from "../auth/crypto/encryption";
import type { UiAuthContext } from "../types/express";

export type { UiAuthContext };

export function requireUiAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // cookie 中的 API Key 为 AES-256-GCM 密文（见 huawei-auth.ts setAuthKeyCookie），需先解开再校验。
  const apiKey = tryDecryptString(
    typeof req.cookies.auth_key === "string" ? req.cookies.auth_key : undefined,
  );

  if (!apiKey) {
    res.redirect("/");
    return;
  }

  // Validate API key
  const authContext = validateApiKey(apiKey);

  // UI Cookie 认证只接受**账号级** Key。
  //
  // 用户级 Key 既不绑定账号也不持有会话，放行会让"重新生成密钥"签发出一个
  // 没有会话、因而永远无法通过校验的新密钥，使操作者被立即踢出。
  if (!authContext || authContext.kind !== "account") {
    res.redirect("/");
    return;
  }

  // Attach auth context to request
  req.uiAuth = {
    apiKeyId: authContext.apiKeyId,
    userId: authContext.userId,
    providerAccountId: authContext.providerAccountId,
  };
  next();
}
