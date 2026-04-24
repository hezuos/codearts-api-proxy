import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";
import type { AuthContext } from "./authenticate-api-key";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      traceId?: string;
    }
  }
}

export function withRequestContext(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const traceId = req.header("x-snap-traceid") ?? randomUUID();
  req.traceId = traceId;
  res.setHeader("x-request-id", traceId);
  res.setHeader("x-snap-traceid", traceId);
  next();
}

export function getTraceId(req: Request): string {
  return req.traceId ?? "unknown-trace";
}
