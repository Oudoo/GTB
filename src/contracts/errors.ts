/**
 * Stable error codes (document 04). Every API error is `application/problem+json` with one
 * of these codes; HTTP status is derived here and nowhere else.
 */
export const ERROR_CATALOG = {
  UNAUTHENTICATED: { status: 401, title: "Authentication required" },
  PERMISSION_DENIED: { status: 403, title: "You are not allowed to perform this action" },
  CSRF_REJECTED: { status: 403, title: "Request origin could not be verified" },
  RESOURCE_NOT_FOUND: { status: 404, title: "Resource not found" },
  VALIDATION_FAILED: { status: 400, title: "The request is not valid" },
  IDEMPOTENCY_KEY_REQUIRED: { status: 400, title: "An Idempotency-Key header is required" },
  PRECONDITION_REQUIRED: { status: 428, title: "An If-Match header with the resource version is required" },
  VERSION_CONFLICT: { status: 412, title: "The resource changed since it was read" },
  STATE_CONFLICT: { status: 409, title: "The action is not available in the current state" },
  DUPLICATE_RESOURCE: { status: 409, title: "A matching resource already exists" },
  IDEMPOTENCY_CONFLICT: { status: 409, title: "This Idempotency-Key was used with a different request" },
  REQUEST_IN_PROGRESS: { status: 409, title: "The original request is still being processed" },
  AGREEMENT_INACTIVE: { status: 422, title: "No effective signed agreement covers this action" },
  MODULE_DISABLED: { status: 422, title: "This module is not enabled in the agreement" },
  MODULE_UNAVAILABLE: { status: 422, title: "This module is not available in this release" },
  TRANSACTION_TYPE_DISABLED: { status: 422, title: "This transaction type is not enabled" },
  ACCOUNT_NOT_ALLOWED: { status: 422, title: "This account cannot be used for this action" },
  RAIL_CONFIGURATION_REQUIRED: { status: 422, title: "The payment rail is not configured" },
  RAIL_LIMIT_EXCEEDED: { status: 422, title: "Rail ceiling exceeded" },
  MODULE_LIMIT_EXCEEDED: { status: 422, title: "Module limit exceeded" },
  CORPORATE_DAILY_LIMIT_EXCEEDED: { status: 422, title: "Daily corporate limit exceeded" },
  CORPORATE_MONTHLY_LIMIT_EXCEEDED: { status: 422, title: "Monthly corporate limit exceeded" },
  USER_LIMIT_EXCEEDED: { status: 422, title: "User limit exceeded" },
  BATCH_ROW_CAP_EXCEEDED: { status: 422, title: "The batch has more rows than the agreement allows" },
  SELF_APPROVAL_FORBIDDEN: { status: 403, title: "You cannot approve your own proposal" },
  APPROVAL_POLICY_UNAVAILABLE: { status: 422, title: "No approval rule covers this amount" },
  REAPPROVAL_REQUIRED: { status: 409, title: "The proposal must be approved again" },
  INSUFFICIENT_FUNDS: { status: 422, title: "Insufficient available funds" },
  NAME_MISMATCH: { status: 422, title: "The beneficiary name does not match the account" },
  NAME_CHECK_UNAVAILABLE: { status: 503, title: "The name check is temporarily unavailable" },
  EXECUTION_WINDOW_CLOSED: { status: 422, title: "The execution window is closed" },
  STATUS_UNRESOLVED: { status: 409, title: "The result is still being checked" },
  RETRY_NOT_ELIGIBLE: { status: 409, title: "This item is not eligible for retry" },
  IMPORT_TOO_LARGE: { status: 413, title: "The file is too large" },
  UNSUPPORTED_FILE: { status: 415, title: "This file type or template is not supported" },
  QUOTA_EXCEEDED: { status: 429, title: "Too many requests" },
  ADAPTER_UNAVAILABLE: { status: 503, title: "The banking system is temporarily unavailable" },
  INTERNAL_ERROR: { status: 500, title: "Something went wrong" },
} as const;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export type Violation = {
  field?: string;
  rule?: string;
  code?: string;
  message?: string;
  /** Extra machine-readable values, e.g. remainingMinor. Strings only. */
  [key: string]: string | undefined;
};

export type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail?: string;
  correlationId: string;
  violations?: Violation[];
  retryAfterSeconds?: number;
};

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly violations: Violation[] | undefined;
  readonly retryAfterSeconds: number | undefined;
  /** Safe, user-presentable detail. Never put identifiers of inaccessible objects here. */
  readonly detail: string | undefined;

  constructor(
    code: ErrorCode,
    options: {
      detail?: string;
      violations?: Violation[];
      retryAfterSeconds?: number;
      status?: number;
      cause?: unknown;
    } = {},
  ) {
    super(options.detail ?? ERROR_CATALOG[code].title, options.cause ? { cause: options.cause } : undefined);
    this.name = "DomainError";
    this.code = code;
    this.status = options.status ?? ERROR_CATALOG[code].status;
    this.violations = options.violations;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.detail = options.detail;
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

export function problemType(code: ErrorCode): string {
  return `urn:alqarib:problem:${code.toLowerCase().replaceAll("_", "-")}`;
}

export function toProblem(error: DomainError, correlationId: string): ProblemDetails {
  return {
    type: problemType(error.code),
    title: ERROR_CATALOG[error.code].title,
    status: error.status,
    code: error.code,
    ...(error.detail ? { detail: error.detail } : {}),
    correlationId,
    ...(error.violations?.length ? { violations: error.violations } : {}),
    ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
  };
}

/** 404 for anything the caller may not know exists (SEC-01). */
export function notFound(): DomainError {
  return new DomainError("RESOURCE_NOT_FOUND");
}

export function denied(detail?: string): DomainError {
  return new DomainError("PERMISSION_DENIED", detail ? { detail } : {});
}

export function conflict(detail?: string): DomainError {
  return new DomainError("STATE_CONFLICT", detail ? { detail } : {});
}

export function invalid(violations: Violation[], detail?: string): DomainError {
  return new DomainError("VALIDATION_FAILED", { violations, ...(detail ? { detail } : {}) });
}
