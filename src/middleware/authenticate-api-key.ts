import type { NextFunction, Request, Response } from "express";
import { validateApiKey } from "../auth/store";
import { createOpenAIError } from "../utils/openai-error";

export function authenticateApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authorization = req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    res
      .status(401)
      .json(createOpenAIError("Missing Bearer API key", "auth_error"));
    return;
  }

  const apiKey = authorization.slice("Bearer ".length).trim();
  const auth = validateApiKey(apiKey);
  if (!auth) {
    res.status(401).json(createOpenAIError("Invalid API key", "auth_error"));
    return;
  }

  Reflect.set(req, "auth", auth);
  next();
}

export function getRequestAuth(req: Request): {
  apiKeyId: string;
  userId: string;
  providerAccountId?: string;
} {
  return Reflect.get(req, "auth") as {
    apiKeyId: string;
    userId: string;
    providerAccountId?: string;
  };
}
