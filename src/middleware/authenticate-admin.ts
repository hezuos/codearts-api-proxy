import { randomBytes } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { isAdminConfigured } from "../auth/admin";
import { isProduction } from "../config";

// Cryptographically random session token generated at startup.
// Different across process restarts — prevents cookie forgery.
const ADMIN_SESSION_TOKEN = randomBytes(32).toString("hex");

export function requireAdminAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const isApiRoute =
    req.path.startsWith("/admin/api/") || req.path === "/admin/api";

  // Check if admin is configured
  if (!isAdminConfigured()) {
    if (isApiRoute) {
      res.status(401).json({ error: "Admin not configured" });
    } else {
      res.redirect("/admin/setup");
    }
    return;
  }

  // Check for admin session cookie
  const sessionToken = req.cookies.admin_session;

  if (!sessionToken || sessionToken !== ADMIN_SESSION_TOKEN) {
    if (isApiRoute) {
      res.status(401).json({ error: "Unauthorized" });
    } else {
      res.redirect("/admin/login");
    }
    return;
  }

  next();
}

export function setAdminSession(res: Response): void {
  res.cookie("admin_session", ADMIN_SESSION_TOKEN, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "strict",
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  });
}

export function clearAdminSession(res: Response): void {
  res.clearCookie("admin_session");
}
