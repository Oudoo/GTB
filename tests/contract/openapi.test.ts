/**
 * API contract parity (API-01, document 04): the published OpenAPI document is generated from
 * the operations the dispatcher enforces, every operation states who may call it, and no
 * operation is reachable by a bearer token unless it declares a scope.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildOpenApi } from "@/server/api/openapi";
import { API_VERSION } from "@/server/api/operations/health";
import { ALL_OPERATIONS } from "@/server/api/registry";
import { API_SCOPES, PERMISSIONS } from "@/server/auth/permissions";

type Item = { operationId: string; security: Array<Record<string, string[]>>; parameters?: Array<{ name: string; in: string; required: boolean }>; "x-required-permission": string[]; "x-workspace": string };
const document = buildOpenApi(ALL_OPERATIONS, API_VERSION) as { openapi: string; paths: Record<string, Record<string, Item>> };
const items = Object.values(document.paths).flatMap((methods) => Object.values(methods));
const byId = new Map(items.map((item) => [item.operationId, item]));

/**
 * Reviewed list of operations without a single named permission:
 * - the caller's own session and own alerts;
 * - dashboards, which only aggregate what the caller's other permissions already allow;
 * - approvals, where the required permission depends on the proposal class and is enforced per
 *   proposal in the approval service (visibility 404, eligibility 403, own proposal 403).
 * Adding an operation here is a security decision, not a convenience.
 */
const NO_PERMISSION_NEEDED = new Set(["getSession", "selectSessionContext", "getDashboard", "getBankOverview", "listApprovals", "getApproval", "approveProposal", "rejectProposal", "listNotifications", "markNotificationRead"]);

describe("OpenAPI contract", () => {
  it("documents every registered operation exactly once", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(items).toHaveLength(ALL_OPERATIONS.length);
    expect(new Set(items.map((item) => item.operationId)).size).toBe(ALL_OPERATIONS.length);
    for (const operation of ALL_OPERATIONS) expect(byId.has(operation.id), operation.id).toBe(true);
  });

  it("the committed document is what the code generates", () => {
    const committed = readFileSync(new URL("../../docs/api/openapi.json", import.meta.url), "utf8");
    expect(committed, "run `pnpm openapi:generate`").toBe(`${JSON.stringify(document, null, 2)}\n`);
  });

  it("every write documents its idempotency key and, where required, its version precondition", () => {
    for (const operation of ALL_OPERATIONS) {
      const parameters = byId.get(operation.id)?.parameters ?? [];
      const header = (name: string) => parameters.some((parameter) => parameter.in === "header" && parameter.name === name && parameter.required);
      if (operation.kind === "command" && operation.idempotent !== false) expect(header("Idempotency-Key"), operation.id).toBe(true);
      if (operation.ifMatch) expect(header("If-Match"), operation.id).toBe(true);
      // Every path placeholder is a documented path parameter.
      for (const [, name] of operation.path.matchAll(/\{(\w+)\}/g)) expect(parameters.some((parameter) => parameter.in === "path" && parameter.name === name), `${operation.id} {${name}}`).toBe(true);
    }
  });

  it("a bearer token reaches an operation only where a scope is declared — never the bank, approvals, payroll or administration (I-45)", () => {
    const bearer = ALL_OPERATIONS.filter((operation) => operation.credentialScope !== undefined);
    expect(bearer.length).toBeGreaterThan(10);
    for (const operation of bearer) {
      expect(operation.scope, operation.id).toBe("corporate");
      expect(Object.keys(API_SCOPES)).toContain(operation.credentialScope);
      expect(byId.get(operation.id)?.security.some((entry) => "sandboxBearer" in entry), operation.id).toBe(true);
    }
    for (const operation of ALL_OPERATIONS) {
      const offersBearer = byId.get(operation.id)?.security.some((entry) => "sandboxBearer" in entry) ?? false;
      if (operation.credentialScope === undefined) expect(offersBearer, operation.id).toBe(false);
      const sensitive = operation.path.startsWith("/bank/") || operation.path.startsWith("/approvals") || operation.path.startsWith("/payroll") || operation.path.startsWith("/admin") || operation.path.startsWith("/developer/credentials") || operation.path.startsWith("/reports");
      if (sensitive) expect(operation.credentialScope, `${operation.id} must be session-only`).toBeUndefined();
      // A token can never be given a write scope on batches in this release (DEC-023).
      if (operation.kind === "command" && operation.path.startsWith("/batches")) expect(operation.credentialScope, operation.id).toBeUndefined();
    }
  });

  it("every non-public operation names a known permission or is an explicitly listed own-session operation", () => {
    const known = new Set<string>(PERMISSIONS);
    for (const operation of ALL_OPERATIONS) {
      const permissions = operation.permission === undefined ? [] : Array.isArray(operation.permission) ? operation.permission : [operation.permission];
      for (const permission of permissions) expect(known.has(permission as string), `${operation.id}: ${String(permission)}`).toBe(true);
      if (operation.scope === "public") continue;
      if (permissions.length === 0) expect(NO_PERMISSION_NEEDED.has(operation.id), `${operation.id} has no permission and is not in the reviewed list`).toBe(true);
      else expect(NO_PERMISSION_NEEDED.has(operation.id), `${operation.id} is in the reviewed list but declares a permission`).toBe(false);
      // Bank-workspace operations are never offered to the corporate workspace and vice versa.
      if (operation.path.startsWith("/bank/")) expect(operation.scope, operation.id).toBe("bank");
    }
  });
});
