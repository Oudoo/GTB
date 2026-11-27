/**
 * Browser client for `/api/v1`. The UI calls exactly the operations published in OpenAPI.
 *
 * - Every write carries the same-origin marker header and an Idempotency-Key.
 * - Responses are never cached (`cache: "no-store"`); nothing is written to browser storage.
 * - A lost connection is reported as `network: true`, which the UI must treat as "the request
 *   MAY have reached the bank": it checks the server before allowing another attempt and, if a
 *   retry is appropriate, reuses the SAME key (PWA-05, P-06).
 */
import type { ErrorCode, ProblemDetails } from "@/contracts/errors";

export type ApiSuccess<T> = { ok: true; status: number; data: T; page?: { nextCursor: string | null; hasMore: boolean }; correlationId: string | null };
export type ApiFailure = {
  ok: false;
  status: number;
  /** True when no response was received at all. */
  network: boolean;
  code: ErrorCode | "NETWORK";
  problem: ProblemDetails | null;
  correlationId: string | null;
};
export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export type ApiRequest = {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  form?: FormData;
  /** Required for POST commands; keep it stable across retries of one logical action. */
  idempotencyKey?: string;
  /** Resource version for edits and decisions. */
  ifMatch?: number;
  signal?: AbortSignal;
};

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export async function api<T = unknown>(path: string, request: ApiRequest = {}): Promise<ApiResult<T>> {
  const method = request.method ?? "GET";
  const headers = new Headers({ Accept: "application/json" });
  if (method !== "GET") headers.set("X-AlQarib-Request", "1");
  if (request.idempotencyKey) headers.set("Idempotency-Key", request.idempotencyKey);
  if (request.ifMatch !== undefined) headers.set("If-Match", `"${request.ifMatch}"`);
  let body: BodyInit | undefined;
  if (request.form) {
    body = request.form;
  } else if (method !== "GET") {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(request.body ?? {});
  }

  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch {
    return { ok: false, status: 0, network: true, code: "NETWORK", problem: null, correlationId: null };
  }

  const correlationId = response.headers.get("X-Correlation-ID");
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (response.ok) {
    const envelope = (payload ?? {}) as { data?: T; page?: ApiSuccess<T>["page"] };
    return {
      ok: true,
      status: response.status,
      data: envelope.data as T,
      ...(envelope.page ? { page: envelope.page } : {}),
      correlationId,
    };
  }
  const problem = payload && typeof payload === "object" && "code" in payload ? (payload as ProblemDetails) : null;
  return {
    ok: false,
    status: response.status,
    network: false,
    code: problem?.code ?? (response.status === 401 ? "UNAUTHENTICATED" : "INTERNAL_ERROR"),
    problem,
    correlationId: problem?.correlationId ?? correlationId,
  };
}
