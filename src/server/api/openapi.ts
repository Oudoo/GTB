/**
 * OpenAPI 3.1 document generated from the operation registry — the same declarations the
 * dispatcher enforces, so the published contract cannot drift from the code silently
 * (`pnpm openapi:check` and the contract tests fail on drift).
 *
 * This describes a SANDBOX with simulated bank and rail adapters. The bearer scheme is an
 * opaque sandbox token, not OAuth2/OIDC/FAPI.
 */
import { z, type ZodType } from "zod";
import { ERROR_CATALOG } from "@/contracts/errors";
import type { AnyOperation } from "./framework";

type Json = Record<string, unknown>;

function jsonSchema(schema: ZodType | undefined): Json {
  if (!schema) return {};
  try {
    const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Json;
    return rest;
  } catch {
    return {};
  }
}

function objectParameters(schema: ZodType | undefined, location: "path" | "query"): Json[] {
  const converted = jsonSchema(schema);
  const properties = (converted["properties"] ?? {}) as Record<string, Json>;
  const required = new Set((converted["required"] as string[] | undefined) ?? []);
  return Object.entries(properties).map(([name, property]) => ({ name, in: location, required: location === "path" || required.has(name), schema: property }));
}

const SUCCESS_TEXT: Record<number, string> = { 200: "OK", 201: "Created", 202: "Accepted — the work continues in the background" };

export function buildOpenApi(operations: readonly AnyOperation[], version: string): Json {
  const paths: Record<string, Json> = {};
  const tags = new Set<string>();
  for (const operation of operations) {
    tags.add(operation.tag);
    const isCommand = operation.kind === "command";
    const idempotent = isCommand && operation.idempotent !== false;
    const permissions = operation.permission === undefined ? [] : Array.isArray(operation.permission) ? [...operation.permission] : [operation.permission];
    const parameters: Json[] = [...objectParameters(operation.params, "path"), ...objectParameters(operation.query, "query")];
    if (idempotent) parameters.push({ name: "Idempotency-Key", in: "header", required: true, description: "One key per logical action; reuse it when retrying after a lost response.", schema: { type: "string", minLength: 8, maxLength: 128 } });
    if (operation.ifMatch) parameters.push({ name: "If-Match", in: "header", required: true, description: 'Resource version as a quoted string, e.g. "3". 428 if absent, 412 if stale.', schema: { type: "string" } });
    const security: Json[] = operation.scope === "public" ? [] : [{ sessionCookie: [] }];
    if (operation.scope === "corporate" && operation.credentialScope) security.push({ sandboxBearer: [operation.credentialScope] });
    const status = isCommand ? (operation.successStatus ?? 200) : 200;
    const item: Json = {
      operationId: operation.id,
      summary: operation.summary,
      ...(operation.description ? { description: operation.description } : {}),
      tags: [operation.tag],
      ...(parameters.length > 0 ? { parameters } : {}),
      security,
      "x-workspace": operation.scope,
      "x-required-permission": permissions,
      ...(operation.credentialScope ? { "x-credential-scope": operation.credentialScope } : { "x-session-only": operation.scope !== "public" }),
      responses: {
        [String(status)]: {
          description: SUCCESS_TEXT[status] ?? "Success",
          content: { "application/json": { schema: { type: "object", properties: { data: operation.responseSchema ? jsonSchema(operation.responseSchema) : {}, page: { $ref: "#/components/schemas/Page" }, correlationId: { type: "string" } }, required: ["correlationId"] } } },
        },
        default: { description: "Problem details (RFC 9457) with a stable `code`.", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } },
      },
    };
    if (operation.multipart) item["requestBody"] = { required: true, content: { "multipart/form-data": { schema: { type: "object", properties: { file: { type: "string", format: "binary" } }, additionalProperties: { type: "string" } } } } };
    else if (operation.body) item["requestBody"] = { required: true, content: { "application/json": { schema: jsonSchema(operation.body) } } };
    const key = operation.path;
    paths[key] = { ...(paths[key] ?? {}), [operation.method.toLowerCase()]: item };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Al Qarib Corporate Banking — Sandbox API",
      version,
      description:
        "Sandbox API of the Al Qarib corporate banking MVP. Bank core and payment rails are deterministic SIMULATIONS with synthetic data; nothing here reaches a real bank, rail or card system. Every write needs an Idempotency-Key. Money is exchanged as `{ currency, minor }` with `minor` an integer string.",
    },
    servers: [{ url: "/api/v1" }],
    tags: [...tags].sort().map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        sessionCookie: { type: "apiKey", in: "cookie", name: "alqarib.session_token", description: "Browser session. Writes also need the same-origin header `X-AlQarib-Request: 1`." },
        sandboxBearer: { type: "http", scheme: "bearer", description: "Opaque sandbox token created under /developer/credentials. Not OAuth2/OIDC/FAPI. It can never approve, administer access or reach bank operations." },
      },
      schemas: {
        Page: { type: "object", properties: { nextCursor: { type: ["string", "null"] }, hasMore: { type: "boolean" } } },
        Problem: {
          type: "object",
          required: ["type", "title", "status", "code", "correlationId"],
          properties: {
            type: { type: "string" },
            title: { type: "string" },
            status: { type: "integer" },
            code: { type: "string", enum: Object.keys(ERROR_CATALOG) },
            detail: { type: "string" },
            correlationId: { type: "string" },
            violations: { type: "array", items: { type: "object", additionalProperties: { type: "string" } } },
          },
        },
      },
    },
  };
}
