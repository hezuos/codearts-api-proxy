import axios, { type AxiosInstance } from "axios";
import type { AppConfig } from "../../config";
import { config } from "../../config";

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

function maskValue(value: string | undefined): string {
  if (!value) {
    return "missing";
  }

  if (value.length <= 8) {
    return `${value.slice(0, 2)}***`;
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createHuaweiHttpClient(appConfig: AppConfig = config): AxiosInstance {
  return axios.create({
    baseURL: appConfig.huaweiApiHost,
    timeout: 60000,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
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
  const client = createHuaweiHttpClient();
  const response = await client.post("/v2/login/ticket", {
    ticket_id: request.ticketId,
    identifier: request.identifier,
  });

  const envelope = response.data as Record<string, unknown>;
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

export function isHuaweiTicketPendingError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    return false;
  }

  const status = error.response?.status;
  const data = error.response?.data;
  const bodyText = typeof data === "string" ? data : JSON.stringify(data);
  return status === 406 && bodyText.includes("IDE.00000020");
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
      if (!isHuaweiTicketPendingError(error)) {
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          const data = error.response?.data;
          const bodyText =
            typeof data === "string" ? data : JSON.stringify(data);
          console.error(
            `[huawei-ticket] exchange failed terminal status=${status} attempt=${attempt + 1} body=${bodyText}`,
          );
        }
        throw error;
      }

      const data = axios.isAxiosError(error) ? error.response?.data : undefined;
      const bodyText = typeof data === "string" ? data : JSON.stringify(data);
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
