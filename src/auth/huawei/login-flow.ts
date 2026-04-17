import { randomBytes } from "crypto";
import { config } from "../../config";

export interface HuaweiLoginFlow {
  ticketId: string;
  loginUrl: string;
  state: string;
  expiresAt: Date;
}

export function createHuaweiLoginFlow(callbackPort: number): HuaweiLoginFlow {
  const ticketId = randomBytes(32).toString("hex");
  const state = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  const redirectUrl = `${config.huaweiRedirectHost}/redirect1?ticket_id=${ticketId}&theme=1&locale=zh-cn&version=3&uri_scheme=http&port=${callbackPort}&is_redirect=true`;

  return {
    ticketId,
    loginUrl: redirectUrl,
    state,
    expiresAt,
  };
}
