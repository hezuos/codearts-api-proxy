import https from "https";
import { config } from "../../config";
import { maskValue } from "../../utils/mask";

export interface HuaweiTicketExchangeRequest {
  ticketId: string;
  identifier: string;
}

export interface HuaweiSessionCredentials {
  accessKey?: string;
  secretKey?: string;
  securityToken?: string;
  expiresAt?: string;
}

export interface HuaweiTicketExchangeResponse {
  userId?: string;
  userName?: string;
  domainId?: string;
  businessToken?: string;
  credentials: HuaweiSessionCredentials;
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Native HTTPS helper
// ---------------------------------------------------------------------------

interface HttpJsonResponse {
  status: number;
  data: unknown;
}

function httpsPostJson(
  urlStr: string,
  body: unknown,
  timeoutMs = 60_000,
): Promise<HttpJsonResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { data += chunk; });
        res.on("end", () => {
          let parsed: unknown;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode ?? 0, data: parsed });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`HTTP request timeout: ${urlStr} (${timeoutMs}ms)`));
    });
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Ticket exchange
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function extractCredentials(
  payload: Record<string, unknown>,
): HuaweiSessionCredentials {
  const credential = (payload.credential ??
    payload.credentials ??
    {}) as Record<string, unknown>;
  return {
    accessKey:
      typeof credential.access === "string" ? credential.access : undefined,
    secretKey:
      typeof credential.secret === "string" ? credential.secret : undefined,
    securityToken:
      typeof credential.securitytoken === "string"
        ? credential.securitytoken
        : undefined,
    expiresAt:
      typeof credential.expires_at === "string"
        ? credential.expires_at
        : undefined,
  };
}

function extractBusinessToken(
  payload: Record<string, unknown>,
): string | undefined {
  const candidates = [
    payload.cloudDragonToken,
    payload.token,
    payload.authToken,
    payload.accessToken,
  ];
  return candidates.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

export async function exchangeHuaweiTicket(
  request: HuaweiTicketExchangeRequest,
): Promise<HuaweiTicketExchangeResponse> {
  const url = `${config.huaweiApiHost}/v2/login/ticket`;
  const { status, data } = await httpsPostJson(url, {
    ticket_id: request.ticketId,
    identifier: request.identifier,
  });

  if (status === 406) {
    const bodyText = typeof data === "string" ? data : JSON.stringify(data);
    if (bodyText.includes("IDE.00000020")) {
      throw Object.assign(new Error("ticket pending"), { isTicketPending: true, status, bodyText });
    }
  }

  const envelope = data as Record<string, unknown>;
  if (typeof envelope.status === "string" && envelope.status !== "success") {
    throw new Error(
      `ticket exchange rejected: status=${envelope.status} body=${JSON.stringify(envelope)}`,
    );
  }

  const payload =
    envelope.result && typeof envelope.result === "object"
      ? (envelope.result as Record<string, unknown>)
      : envelope;

  return {
    userId: typeof payload.user_id === "string" ? payload.user_id : undefined,
    userName:
      typeof payload.user_name === "string" ? payload.user_name : undefined,
    domainId:
      typeof payload.domain_id === "string" ? payload.domain_id : undefined,
    businessToken: extractBusinessToken(payload),
    credentials: extractCredentials(payload),
    raw: payload,
  };
}

function isTicketPendingError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "isTicketPending" in error &&
    (error as Error & { isTicketPending: boolean }).isTicketPending === true
  );
}

export function isHuaweiTicketPendingError(error: unknown): boolean {
  return isTicketPendingError(error);
}

export async function waitForHuaweiTicketExchange(
  request: HuaweiTicketExchangeRequest,
): Promise<HuaweiTicketExchangeResponse> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= 60; attempt += 1) {
    try {
      console.log(
        `[huawei-ticket] polling /v2/login/ticket attempt=${attempt + 1} ticketId=${maskValue(request.ticketId)} identifier=${maskValue(request.identifier)}`,
      );
      const result = await exchangeHuaweiTicket(request);
      console.log(
        `[huawei-ticket] exchange success attempt=${attempt + 1} userId=${result.userId ?? "missing"} userName=${result.userName ?? "missing"} domainId=${result.domainId ?? "missing"} businessToken=${maskValue(result.businessToken)} accessKey=${maskValue(result.credentials.accessKey)} securityToken=${maskValue(result.credentials.securityToken)} expiresAt=${result.credentials.expiresAt ?? "missing"}`,
      );
      return result;
    } catch (error) {
      if (!isTicketPendingError(error)) {
        if (error instanceof Error && "status" in error) {
          const err = error as Error & { status?: number; bodyText?: string };
          const status = err.status;
          const bodyText = err.bodyText ?? "unknown";
          console.error(
            `[huawei-ticket] exchange failed terminal status=${status} attempt=${attempt + 1} body=${bodyText}`,
          );
        }
        throw error;
      }

      const err = error as Error & { bodyText?: string };
      const bodyText = err.bodyText ?? "unknown";
      console.log(
        `[huawei-ticket] exchange pending attempt=${attempt + 1} body=${bodyText}`,
      );
      lastError = new Error(
        `status=406 body=${bodyText ?? "unknown"} attempt=${attempt + 1}`,
      );

      if (attempt >= 60) {
        break;
      }

      await sleep(2000);
    }
  }

  throw lastError ?? new Error("ticket exchange timed out");
}
