import type { Request, Response, NextFunction } from "express";
import { validateApiKey } from "../auth/store";

export interface UiAuthContext {
  apiKeyId: string;
  userId: string;
  providerAccountId?: string;
}

declare global {
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
  // Extract API key from cookie
  const apiKey = req.cookies.auth_key;

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
