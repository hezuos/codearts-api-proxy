import type { Request, Response, NextFunction } from "express";
import { validateApiKey } from "../auth/store";
import { tryDecryptString } from "../auth/crypto/encryption";

export interface UiAuthContext {
  apiKeyId: string;
  userId: string;
  providerAccountId?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      uiAuth?: UiAuthContext;
    }
  }
}

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

  if (!authContext) {
    res.redirect("/");
    return;
  }

  // Attach auth context to request
  req.uiAuth = authContext;
  next();
}
