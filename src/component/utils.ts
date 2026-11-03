import type { Stream } from "./shared.js";

const PERMANENT_STATUSES = new Set([
  400, 401, 403, 404, 405, 410, 413, 414, 415, 422,
]);

const ERROR_BODY_LIMIT = 4096;

const SEND_HOSTS = {
  transactional: "https://send.api.mailtrap.io",
  bulk: "https://bulk.api.mailtrap.io",
  sandbox: "https://sandbox.api.mailtrap.io",
} as const;

const INBOUND_BASE = "https://mailtrap.io/api/inbound";

export class MailtrapApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    public permanent: boolean,
  ) {
    super(`Mailtrap API error ${status}`);
    this.name = "MailtrapApiError";
  }
}

function apiToken(): string {
  const token = process.env.MAILTRAP_API_TOKEN;
  if (!token) {
    throw new Error(
      "MAILTRAP_API_TOKEN is not set on this Convex deployment. Run " +
        "`npx convex env set MAILTRAP_API_TOKEN <token>`.",
    );
  }
  return token;
}

export function stripUndefined<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map(stripUndefined) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = stripUndefined(v);
  }
  return out as T;
}

type FetchOptions = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
};

async function request(url: string, opts: FetchOptions): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiToken()}`,
    "Api-Token": apiToken(),
  };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(stripUndefined(opts.body));
  }

  const u = new URL(url);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === undefined || v === null) continue;
      u.searchParams.set(k, String(v));
    }
  }

  const response = await fetch(u, {
    method: opts.method,
    headers,
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    const truncated =
      text.length > ERROR_BODY_LIMIT
        ? text.slice(0, ERROR_BODY_LIMIT) + "... [truncated]"
        : text;
    throw new MailtrapApiError(
      response.status,
      truncated,
      PERMANENT_STATUSES.has(response.status),
    );
  }

  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return null;
  return await response.json();
}

export function sendBaseUrl(args: {
  stream: Stream;
  sandbox: boolean;
}): string {
  if (args.sandbox) return SEND_HOSTS.sandbox;
  return args.stream === "bulk" ? SEND_HOSTS.bulk : SEND_HOSTS.transactional;
}

/** POST /api/send or /api/send/{inbox_id} for sandbox. */
export async function sendEmailApi(args: {
  stream: Stream;
  sandbox: boolean;
  testInboxId?: number;
  payload: unknown;
}): Promise<unknown> {
  const base = sendBaseUrl(args);
  const path =
    args.sandbox && args.testInboxId != null
      ? `/api/send/${args.testInboxId}`
      : "/api/send";
  return await request(`${base}${path}`, {
    method: "POST",
    body: args.payload,
  });
}

/** POST /api/batch or /api/batch/{inbox_id} for sandbox. */
export async function sendBatchApi(args: {
  stream: Stream;
  sandbox: boolean;
  testInboxId?: number;
  base: unknown;
  requests: unknown[];
}): Promise<unknown> {
  const host = sendBaseUrl(args);
  const path =
    args.sandbox && args.testInboxId != null
      ? `/api/batch/${args.testInboxId}`
      : "/api/batch";
  return await request(`${host}${path}`, {
    method: "POST",
    body: { base: args.base, requests: args.requests },
  });
}

export async function inboundFetch(
  path: string,
  opts: FetchOptions,
): Promise<unknown> {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return await request(`${INBOUND_BASE}${clean}`, opts);
}

export function parseTimestamp(input: string | number | undefined): number {
  if (typeof input === "number" && Number.isFinite(input)) {
    // Mailtrap inbound webhooks use unix seconds; sending events too.
    return input > 1e12 ? input : input * 1000;
  }
  if (typeof input === "string") {
    const parsed = Date.parse(input);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }
  return Date.now();
}

/** Extract message UUID(s) from Mailtrap send / batch responses. */
export function extractMessageIds(response: unknown): string[] {
  if (!response || typeof response !== "object") return [];
  const r = response as Record<string, unknown>;

  if (typeof r.message_ids === "object" && Array.isArray(r.message_ids)) {
    return r.message_ids.filter((id): id is string => typeof id === "string");
  }
  if (typeof r.message_id === "string") return [r.message_id];

  // Batch: { success: boolean, responses?: [...], errors?: [...] } or results[]
  if (Array.isArray(r.responses)) {
    const ids: string[] = [];
    for (const item of r.responses) {
      ids.push(...extractMessageIds(item));
    }
    return ids;
  }
  if (Array.isArray(r.results)) {
    const ids: string[] = [];
    for (const item of r.results) {
      ids.push(...extractMessageIds(item));
    }
    return ids;
  }
  return [];
}
