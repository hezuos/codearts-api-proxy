/**
 * 双提交（double-submit）CSRF 防护。
 *
 * 服务端确保每个浏览器会话持有可被 JS 读取的 `csrf_token` cookie，
 * 前端在状态变更请求中将其回传至 `x-csrf-token` 请求头，
 * 服务端用 timingSafeEqual 校验两者一致。
 *
 * 校验仅作用于依赖 cookie 认证的状态变更路由（Web UI / Admin，见 index.ts 挂载点）。
 * 携带 `Authorization: Bearer` 的 API Key 客户端不依赖 cookie 凭据，
 * 天然免疫 CSRF，予以豁免。
 */

import { randomBytes, timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { isProduction } from "../config";
import { createOpenAIError } from "../utils/openai-error";

export const CSRF_COOKIE_NAME = "csrf_token";
export const CSRF_HEADER_NAME = "x-csrf-token";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * 确保浏览器会话持有 CSRF 令牌 cookie。
 * 该 cookie 必须可被前端 JS 读取（httpOnly: false），以便在请求头中回传。
 */
export function issueCsrfCookie(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (typeof req.cookies?.csrf_token !== "string") {
    const token = randomBytes(32).toString("hex");
    res.cookie("csrf_token", token, {
      httpOnly: false,
      secure: isProduction,
      sameSite: "strict",
      path: "/",
    });
  }
  next();
}

/**
 * 校验双提交 CSRF 令牌。仅作用于状态变更方法。
 * Bearer 认证（API Key 客户端）不依赖 cookie，天然免疫 CSRF，予以豁免。
 */
export function verifyCsrfToken(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!UNSAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  const authorization = req.get("authorization");
  if (authorization && /^Bearer\s+/i.test(authorization)) {
    next();
    return;
  }

  const cookieToken = req.cookies?.csrf_token;
  const headerToken = req.get("x-csrf-token");
  if (
    typeof cookieToken !== "string" ||
    typeof headerToken !== "string" ||
    !csrfTokensEqual(cookieToken, headerToken)
  ) {
    res
      .status(403)
      .json(
        createOpenAIError(
          "Missing or invalid CSRF token",
          "invalid_request_error",
          "csrf_token_invalid",
        ),
      );
    return;
  }
  next();
}

function csrfTokensEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
