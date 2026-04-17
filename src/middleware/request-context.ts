import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";

export function withRequestContext(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const traceId = req.header("x-snap-traceid") ?? randomUUID();
  Reflect.set(req, "traceId", traceId);
  res.setHeader("x-request-id", traceId);
  res.setHeader("x-snap-traceid", traceId);
  next();
}

export function getTraceId(req: Request): string {
  return (Reflect.get(req, "traceId") as string | undefined) ?? "unknown-trace";
}
