/**
 * `/api/v1` operation framework (document 04, DEC-010).
 *
 * Every business action is one declared operation. The dispatcher — not individual handlers —
 * enforces, in this order: correlation ID, authentication (cookie session or scoped bearer),
 * same-origin/CSRF for cookie writes, workspace and permission, credential scope and quota,
 * strict input schemas (unknown fields rejected), idempotency replay, `If-Match`, and uniform
 * `application/problem+json` errors with `Cache-Control: private, no-store`.
 *
 * The same registry generates the OpenAPI document and the endpoint-permission map test, and
 * the UI calls these same operations, so screen and API cannot drift apart (API-01).
 */
import { z, type ZodType } from "zod";
import { DomainError, ERROR_CATALOG, isDomainError, toProblem, type ErrorCode } from "@/contracts/errors";
import { MoneyError } from "@/contracts/money";
import { CoreUnavailableError } from "@/server/adapters/core/port";
import { RailUnavailableError } from "@/server/adapters/rails/port";
import { writeSecurityEvent } from "@/server/audit/audit";
import type { AuthContext } from "@/server/auth/context";
import { consumeQuota, parseBearer, resolveCredential } from "@/server/auth/credentials";
import type { ApiScope, Permission } from "@/server/auth/permissions";
import { resolveSession, type SessionInfo } from "@/server/auth/session";
import { getDeps, type Deps } from "@/server/deps";
import { canonicalJson, sha256Hex } from "@/server/hash";
import { logError, resolveCorrelationId } from "@/server/logging";
import { runWithRequest, type RequestStore } from "@/server/request-context";
import { abandonIdempotent, beginIdempotent, completeIdempotent, validateIdempotencyKey } from "./idempotency";

export type HttpMethod = "GET" | "POST" | "PATCH";

/**
 * - `public`: no authentication (health, sign-in).
 * - `session`: a signed-in person; no workspace needed (session info, context selection).
 * - `corporate` / `bank`: a selected workspace of that kind.
 * - `any`: either workspace.
 */
export type OperationScope = "public" | "session" | "corporate" | "bank" | "any";

export type OpRequest<P = unknown, Q = unknown, B = unknown> = {
  deps: Deps;
  /** Present for every scope except `public`/`session` without a selected workspace. */
  ctx: AuthContext;
  session: SessionInfo | null;
  params: P;
  query: Q;
  body: B;
  /** Parsed `If-Match` resource version, when the operation requires one. */
  expectedVersion: number;
  /** Pre-allocated id for the resource a create command will produce. */
  newId: string;
  correlationId: string;
  request: Request;
  form: FormData | null;
};

export type ResultRef = { type: string; id: string };

export type OpResponse = {
  status?: number;
  /** JSON payload placed under `data`. */
  data?: unknown;
  page?: { nextCursor: string | null; hasMore: boolean };
  /** A complete response (file download). Standard security headers are still applied. */
  raw?: Response;
  headers?: Record<string, string>;
};

type OperationBase<P, Q, B> = {
  /** Stable operationId, also used in OpenAPI. */
  id: string;
  method: HttpMethod;
  /** Path below `/api/v1`, e.g. `/payments/{id}/submit`. */
  path: string;
  summary: string;
  tag: string;
  scope: OperationScope;
  /** Any one of these permissions is required (finer checks happen in the domain service). */
  permission?: Permission | readonly Permission[];
  /**
   * Scope a sandbox bearer credential must hold. When omitted the operation is reachable only
   * by a human session: bearer tokens are refused whatever scopes they claim (I-45).
   */
  credentialScope?: ApiScope;
  params?: ZodType<P>;
  query?: ZodType<Q>;
  body?: ZodType<B>;
  multipart?: boolean;
  /** Bytes; applies to JSON and multipart bodies. */
  maxBodyBytes?: number;
  /** Requires `If-Match: "<version>"` (428 if absent, 412 if stale). */
  ifMatch?: boolean;
  /** Documentation-only response schema. */
  responseSchema?: ZodType;
  description?: string;
};

export type QueryOperation<P, Q, B> = OperationBase<P, Q, B> & {
  kind: "query";
  handler: (request: OpRequest<P, Q, B>) => Promise<OpResponse>;
};

export type CommandOperation<P, Q, B> = OperationBase<P, Q, B> & {
  kind: "command";
  successStatus?: number;
  /**
   * The resource the response points at. Default: a new resource with `request.newId`.
   * It is known BEFORE execution so the idempotency record can be completed in the same
   * transaction as the business change.
   */
  target?: (request: OpRequest<P, Q, B>) => ResultRef;
  execute: (request: OpRequest<P, Q, B>) => Promise<void>;
  /** Projection for the response and for every idempotent replay (current permissions). */
  render: (request: OpRequest<P, Q, B>, ref: ResultRef) => Promise<unknown>;
  /** Commands without idempotency (session sign-in/out) set this to false. */
  idempotent?: boolean;
};

export type Operation<P = unknown, Q = unknown, B = unknown> = QueryOperation<P, Q, B> | CommandOperation<P, Q, B>;
// Registry storage type: handlers are contravariant in their request, so erase to `never`.
export type AnyOperation = Operation<never, never, never>;

export function query<P = Record<string, never>, Q = Record<string, never>, B = undefined>(
  definition: Omit<QueryOperation<P, Q, B>, "kind">,
): AnyOperation {
  return { ...definition, kind: "query" } as unknown as AnyOperation;
}

export function command<P = Record<string, never>, Q = Record<string, never>, B = undefined>(
  definition: Omit<CommandOperation<P, Q, B>, "kind">,
): AnyOperation {
  return { ...definition, kind: "command" } as unknown as AnyOperation;
}

// ---------------------------------------------------------------------------------------------

type CompiledOperation = { operation: AnyOperation; pattern: RegExp; paramNames: string[] };

export class OperationRegistry {
  private readonly compiled: CompiledOperation[] = [];
  private readonly ids = new Set<string>();

  register(operations: readonly AnyOperation[]): void {
    for (const operation of operations) {
      if (this.ids.has(operation.id)) throw new Error(`Duplicate operation id: ${operation.id}`);
      if (this.compiled.some((entry) => entry.operation.method === operation.method && entry.operation.path === operation.path)) {
        throw new Error(`Duplicate operation route: ${operation.method} ${operation.path}`);
      }
      this.ids.add(operation.id);
      const paramNames: string[] = [];
      const source = operation.path.replace(/\{(\w+)\}/g, (_match, name: string) => {
        paramNames.push(name);
        return "([^/]+)";
      });
      this.compiled.push({ operation, pattern: new RegExp(`^${source}$`), paramNames });
    }
  }

  list(): AnyOperation[] {
    return this.compiled.map((entry) => entry.operation);
  }

  match(method: string, path: string): { operation: AnyOperation; rawParams: Record<string, string> } | "method" | null {
    let pathMatched = false;
    for (const entry of this.compiled) {
      const match = entry.pattern.exec(path);
      if (!match) continue;
      pathMatched = true;
      if (entry.operation.method !== method) continue;
      const rawParams: Record<string, string> = {};
      entry.paramNames.forEach((name, index) => {
        rawParams[name] = decodeURIComponent(match[index + 1] as string);
      });
      return { operation: entry.operation, rawParams };
    }
    return pathMatched ? "method" : null;
  }
}

// ---------------------------------------------------------------------------------------------

export const API_PREFIX = "/api/v1";
const DEFAULT_JSON_LIMIT = 256 * 1024;
const CSRF_HEADER = "x-alqarib-request";

function baseHeaders(correlationId: string): Headers {
  return new Headers({
    "Cache-Control": "private, no-store",
    Pragma: "no-cache",
    Vary: "Cookie, Authorization",
    "X-Correlation-ID": correlationId,
    "X-Content-Type-Options": "nosniff",
  });
}

function jsonResponse(status: number, payload: unknown, correlationId: string, extra?: Record<string, string>): Response {
  const headers = baseHeaders(correlationId);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(extra ?? {})) headers.set(name, value);
  return new Response(JSON.stringify(payload, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value)), {
    status,
    headers,
  });
}

export function problemResponse(error: DomainError, correlationId: string): Response {
  const headers = baseHeaders(correlationId);
  headers.set("Content-Type", "application/problem+json; charset=utf-8");
  if (error.retryAfterSeconds !== undefined) headers.set("Retry-After", String(error.retryAfterSeconds));
  if (error.status === 401) headers.set("WWW-Authenticate", 'Bearer realm="alqarib-sandbox"');
  return new Response(JSON.stringify(toProblem(error, correlationId)), { status: error.status, headers });
}

/** Translate anything thrown into a safe DomainError. Internals never reach the client. */
export function toDomainError(error: unknown, service = "api"): DomainError {
  if (isDomainError(error)) return error;
  if (error instanceof z.ZodError) {
    return new DomainError("VALIDATION_FAILED", {
      violations: error.issues.slice(0, 25).map((issue) => ({
        field: issue.path.join("."),
        rule: issue.code,
        message: issue.message,
      })),
    });
  }
  if (error instanceof MoneyError) {
    return new DomainError("VALIDATION_FAILED", { violations: [{ field: "amount", rule: error.code, message: error.message }] });
  }
  if (error instanceof CoreUnavailableError || error instanceof RailUnavailableError) {
    return new DomainError("ADAPTER_UNAVAILABLE");
  }
  logError(service, "unhandled error", error);
  return new DomainError("INTERNAL_ERROR");
}

function sameOrigin(request: Request, appOrigin: string): boolean {
  const origin = request.headers.get("origin");
  if (origin) return origin === appOrigin;
  // No Origin header: accept only an explicit same-origin fetch-metadata signal.
  return request.headers.get("sec-fetch-site") === "same-origin";
}

function parseIfMatch(value: string | null): number | null {
  if (!value) return null;
  const match = /^(?:W\/)?"?(\d{1,9})"?$/.exec(value.trim());
  return match ? Number.parseInt(match[1] as string, 10) : null;
}

async function readJsonBody(request: Request, limit: number): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new DomainError("UNSUPPORTED_FILE", { detail: "Content-Type must be application/json." });
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limit) throw new DomainError("IMPORT_TOO_LARGE");
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > limit) throw new DomainError("IMPORT_TOO_LARGE");
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "body", rule: "json", message: "Body is not valid JSON" }] });
  }
}

async function formFingerprint(form: FormData): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") {
      out[name] = value;
    } else {
      out[name] = `file:${value.size}:${sha256Hex(new Uint8Array(await value.arrayBuffer()))}`;
    }
  }
  return out;
}

type Authenticated = { ctx: AuthContext | null; session: SessionInfo | null; via: "session" | "credential" | "none" };

async function authenticate(deps: Deps, request: Request, operation: AnyOperation, correlationId: string): Promise<Authenticated> {
  if (operation.scope === "public") return { ctx: null, session: null, via: "none" };

  const bearer = parseBearer(request.headers.get("authorization"));
  if (request.headers.has("authorization")) {
    if (!bearer) throw new DomainError("UNAUTHENTICATED");
    const resolved = await resolveCredential(deps, bearer, correlationId);
    if (!resolved) {
      await writeSecurityEvent(deps.db, { kind: "TOKEN_REJECTED", correlationId });
      throw new DomainError("UNAUTHENTICATED");
    }
    // A bearer token may only reach operations that explicitly opt in with a scope it holds.
    // Session-only, administration and every bank operation refuse it regardless of the scope
    // names the token carries.
    if (!operation.credentialScope || operation.scope !== "corporate") {
      await writeSecurityEvent(deps.db, {
        kind: "PERMISSION_DENIED",
        bankId: resolved.context.bankId,
        corporateId: resolved.context.corporateId,
        correlationId,
        detail: { operation: operation.id, via: "credential" },
      });
      throw new DomainError("PERMISSION_DENIED", { detail: "This operation is not available to API credentials." });
    }
    const scopes = resolved.context.principal.kind === "credential" ? resolved.context.principal.scopes : [];
    if (!scopes.includes(operation.credentialScope)) {
      throw new DomainError("PERMISSION_DENIED", { detail: `Missing scope ${operation.credentialScope}.` });
    }
    await consumeQuota(deps, resolved.credentialId, resolved.quota);
    return { ctx: resolved.context, session: null, via: "credential" };
  }

  const session = await resolveSession(deps, request.headers, correlationId);
  if (!session) throw new DomainError("UNAUTHENTICATED");
  return { ctx: session.context, session, via: "session" };
}

function authorize(operation: AnyOperation, auth: Authenticated): void {
  if (operation.scope === "public" || operation.scope === "session") return;
  const ctx = auth.ctx;
  if (!ctx) {
    throw new DomainError("PERMISSION_DENIED", { detail: "Select a workspace first." });
  }
  // A caller in the other workspace is told nothing about what exists here (SEC-01).
  if (operation.scope === "corporate" && ctx.workspace !== "CORPORATE") throw new DomainError("RESOURCE_NOT_FOUND");
  if (operation.scope === "bank" && ctx.workspace !== "BANK") throw new DomainError("RESOURCE_NOT_FOUND");
  if (operation.permission) {
    const required = typeof operation.permission === "string" ? [operation.permission] : operation.permission;
    if (!required.some((permission) => ctx.permissions.has(permission))) throw new DomainError("PERMISSION_DENIED");
  }
}

/** Placeholder context for `public`/`session` operations that run before a workspace exists. */
const NO_CONTEXT = Object.freeze({}) as unknown as AuthContext;

export async function dispatch(registry: OperationRegistry, request: Request, injected?: Deps): Promise<Response> {
  const correlationId = resolveCorrelationId(request.headers.get("x-correlation-id"));
  const store: RequestStore = { correlationId };
  return runWithRequest(store, async () => {
    let deps: Deps | undefined = injected;
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(`${API_PREFIX}/`)) throw new DomainError("RESOURCE_NOT_FOUND");
      const matched = registry.match(request.method, url.pathname.slice(API_PREFIX.length));
      if (matched === null) throw new DomainError("RESOURCE_NOT_FOUND");
      if (matched === "method") {
        throw new DomainError("VALIDATION_FAILED", { status: 405, detail: "Method not allowed for this resource." });
      }
      const { operation, rawParams } = matched;
      deps ??= await getDeps();

      const auth = await authenticate(deps, request, operation, correlationId);

      // Cookie-authenticated writes (and sign-in) must come from our own origin and carry the
      // custom header that a cross-site form cannot set (SEC-03, I-52).
      const isWrite = request.method !== "GET";
      if (isWrite && auth.via !== "credential") {
        if (!sameOrigin(request, deps.appOrigin) || request.headers.get(CSRF_HEADER) !== "1") {
          await writeSecurityEvent(deps.db, {
            kind: "CSRF_REJECTED",
            correlationId,
            ...(auth.ctx ? { bankId: auth.ctx.bankId, corporateId: auth.ctx.corporateId } : {}),
            detail: { operation: operation.id },
          });
          throw new DomainError("CSRF_REJECTED");
        }
      }

      try {
        authorize(operation, auth);
      } catch (error) {
        if (isDomainError(error) && error.code === "PERMISSION_DENIED" && auth.ctx) {
          await writeSecurityEvent(deps.db, {
            kind: "PERMISSION_DENIED",
            bankId: auth.ctx.bankId,
            corporateId: auth.ctx.corporateId,
            personId: auth.ctx.principal.kind === "person" ? auth.ctx.principal.personId : null,
            correlationId,
            detail: { operation: operation.id },
          });
        }
        throw error;
      }

      const params = operation.params ? operation.params.parse(rawParams) : rawParams;
      const queryInput = Object.fromEntries(url.searchParams.entries());
      const parsedQuery = operation.query ? operation.query.parse(queryInput) : queryInput;

      let body: unknown = undefined;
      let form: FormData | null = null;
      let bodyFingerprint: unknown = null;
      if (isWrite) {
        const limit = operation.maxBodyBytes ?? DEFAULT_JSON_LIMIT;
        if (operation.multipart) {
          const declared = Number(request.headers.get("content-length") ?? "0");
          if (declared > limit) throw new DomainError("IMPORT_TOO_LARGE");
          if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
            throw new DomainError("UNSUPPORTED_FILE", { detail: "Content-Type must be multipart/form-data." });
          }
          try {
            form = await request.formData();
          } catch {
            throw new DomainError("VALIDATION_FAILED", { violations: [{ field: "body", rule: "multipart", message: "Malformed upload" }] });
          }
          bodyFingerprint = await formFingerprint(form);
        } else {
          const raw = await readJsonBody(request, limit);
          body = operation.body ? operation.body.parse(raw) : raw;
          bodyFingerprint = body ?? null;
        }
      }

      const ifMatch = parseIfMatch(request.headers.get("if-match"));
      const opRequest: OpRequest<unknown, unknown, unknown> = {
        deps,
        ctx: auth.ctx ?? NO_CONTEXT,
        session: auth.session,
        params,
        query: parsedQuery,
        body,
        expectedVersion: ifMatch ?? 0,
        newId: crypto.randomUUID(),
        correlationId,
        request,
        form,
      };
      const run = operation as unknown as Operation<unknown, unknown, unknown>;

      if (run.kind === "query") {
        const result = await run.handler(opRequest);
        if (result.raw) {
          const headers = new Headers(result.raw.headers);
          for (const [name, value] of baseHeaders(correlationId)) headers.set(name, value);
          return new Response(result.raw.body, { status: result.raw.status, headers });
        }
        return jsonResponse(
          result.status ?? 200,
          { data: result.data ?? null, ...(result.page ? { page: result.page } : {}), correlationId },
          correlationId,
          result.headers,
        );
      }

      // ----- command -----
      const successStatus = run.successStatus ?? 200;
      const defaultRef = (): ResultRef => (run.target ? run.target(opRequest) : { type: run.id, id: opRequest.newId });

      if (run.idempotent === false) {
        if (run.ifMatch && ifMatch === null) throw new DomainError("PRECONDITION_REQUIRED");
        await run.execute(opRequest);
        const data = await run.render(opRequest, defaultRef());
        return jsonResponse(successStatus, { data, correlationId }, correlationId);
      }

      const key = validateIdempotencyKey(request.headers.get("idempotency-key"));
      const ctx = auth.ctx;
      const principalKey =
        ctx?.principal.kind === "person"
          ? `person:${ctx.principal.personId}`
          : ctx?.principal.kind === "credential"
            ? `credential:${ctx.principal.credentialId}`
            : `session:${auth.session?.person.id ?? "none"}`;
      const scopeKey = sha256Hex(
        canonicalJson({
          bank: ctx?.bankId ?? null,
          corporate: ctx?.corporateId ?? null,
          principal: principalKey,
          method: run.method,
          route: run.path,
          params,
        }),
      );
      // Semantic payload + target version; the volatile correlation header is excluded.
      const requestHash = sha256Hex(canonicalJson({ body: bodyFingerprint, query: parsedQuery, ifMatch }));
      const ref = defaultRef();

      // Replay is checked BEFORE the If-Match precondition so a retried, already-completed
      // request with a now-stale version returns its original result instead of a 412.
      const begin = await beginIdempotent(deps.db, {
        scopeKey,
        key,
        requestHash,
        resultType: ref.type,
        resultId: ref.id,
        now: deps.clock.now(),
      });
      if (begin.kind === "replay") {
        const data = await run.render(opRequest, { type: begin.resultType, id: begin.resultId });
        return jsonResponse(begin.status, { data, correlationId }, correlationId, { "Idempotent-Replay": "true" });
      }

      // A stale claim keeps the id that was pre-allocated for the original attempt.
      opRequest.newId = run.target ? opRequest.newId : begin.resultId;
      const liveRef: ResultRef = run.target ? ref : { type: ref.type, id: begin.resultId };
      store.idempotency = { recordId: begin.recordId, responseStatus: successStatus, completed: false };
      try {
        if (run.ifMatch && ifMatch === null) throw new DomainError("PRECONDITION_REQUIRED");
        await run.execute(opRequest);
      } catch (error) {
        if (!store.idempotency.completed) await abandonIdempotent(deps.db, begin.recordId).catch(() => undefined);
        throw error;
      }
      if (!store.idempotency.completed) await completeIdempotent(deps.db, begin.recordId, successStatus);
      const data = await run.render(opRequest, liveRef);
      return jsonResponse(successStatus, { data, correlationId }, correlationId);
    } catch (error) {
      return problemResponse(toDomainError(error), correlationId);
    }
  });
}

/** Error codes with their HTTP status, for documentation and contract tests. */
export function errorStatusTable(): Array<{ code: ErrorCode; status: number; title: string }> {
  return (Object.keys(ERROR_CATALOG) as ErrorCode[]).map((code) => ({
    code,
    status: ERROR_CATALOG[code].status,
    title: ERROR_CATALOG[code].title,
  }));
}
