/**
 * Structured, redacted logging (SEC-05, document 11).
 *
 * Log lines carry timestamp, severity, service, correlation, aggregate reference and a
 * sanitized error class. They never carry tokens, passwords, upload contents, salary values
 * or employee details: sensitive keys are redacted by name at any depth and values that look
 * like payroll detail must be passed through `safeError` rather than logged raw.
 */
import pino, { type Logger } from "pino";
import { isDomainError } from "@/contracts/errors";

const REDACTED = "[REDACTED]";

/** Keys whose values are never written to a log, whatever the object shape. */
export const SENSITIVE_KEYS: ReadonlySet<string> = new Set(
  [
    "password",
    "newPassword",
    "token",
    "tokenHash",
    "secret",
    "signingSecret",
    "authorization",
    "cookie",
    "setCookie",
    "set-cookie",
    "apiKey",
    "authSecret",
    "dataEncryptionKey",
    "databaseUrl",
    // payroll / employee detail (SEC-04, PYR-02)
    "employeeName",
    "employeeCode",
    "accountReference",
    "basic",
    "basicMinor",
    "allowances",
    "allowancesMinor",
    "deductions",
    "deductionsMinor",
    "correction",
    "correctionMinor",
    "net",
    "netMinor",
    "previousNetMinor",
    "salary",
    "payslipReference",
    "rows",
    "fileContent",
    "rawRow",
    "body",
  ].map((key) => key.toLowerCase()),
);

/** Deep-copy a value for logging/audit with sensitive keys removed and bigints stringified. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : redact(inner, depth + 1);
  }
  return out;
}

/**
 * Reduce any thrown value to a safe description. Raw error messages can contain user data
 * (for example a parser echoing a salary cell), so only the class and a stable code are kept.
 */
export function safeError(error: unknown): { errorClass: string; code?: string } {
  if (isDomainError(error)) return { errorClass: "DomainError", code: error.code };
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      errorClass: error.name || "Error",
      ...(typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? { code } : {}),
    };
  }
  return { errorClass: typeof error };
}

let root: Logger | undefined;

export type LogSink = (line: string) => void;
let testSink: LogSink | undefined;

/** Test hook (I-51): capture every emitted log line. */
export function setLogSinkForTests(sink: LogSink | undefined): void {
  testSink = sink;
  root = undefined;
}

function build(): Logger {
  const level = process.env["LOG_LEVEL"] ?? "info";
  const options = {
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label: string) => ({ severity: label }),
    },
  };
  if (testSink) {
    const sink = testSink;
    return pino(options, { write: (line: string) => sink(line) });
  }
  return pino(options);
}

export function logger(service: string): Logger {
  root ??= build();
  return root.child({ service });
}

export type LogFields = Record<string, unknown>;

/** Log with automatic redaction of the supplied fields. */
export function logInfo(service: string, message: string, fields: LogFields = {}): void {
  logger(service).info(redact(fields) as object, message);
}

export function logWarn(service: string, message: string, fields: LogFields = {}): void {
  logger(service).warn(redact(fields) as object, message);
}

export function logError(service: string, message: string, error: unknown, fields: LogFields = {}): void {
  logger(service).error({ ...(redact(fields) as object), ...safeError(error) }, message);
}

const CORRELATION_PATTERN = /^[A-Za-z0-9._:-]{8,64}$/;

/** Accept a caller correlation ID only if it is short and plain; otherwise generate one. */
export function resolveCorrelationId(candidate: string | null | undefined): string {
  if (candidate && CORRELATION_PATTERN.test(candidate)) return candidate;
  return `corr_${crypto.randomUUID().replaceAll("-", "")}`;
}
