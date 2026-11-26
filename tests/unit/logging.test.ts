import { afterEach, describe, expect, it } from "vitest";
import { DomainError } from "@/contracts/errors";
import { logError, logInfo, redact, resolveCorrelationId, safeError, setLogSinkForTests } from "@/server/logging";

afterEach(() => setLogSinkForTests(undefined));

describe("structured redacted logging (SEC-05)", () => {
  it("redacts sensitive keys at any depth and stringifies bigint", () => {
    const out = redact({
      reference: "PAY-1",
      amountMinor: 125000n,
      password: "hunter2",
      nested: { token: "abc", employeeName: "Synthetic Person", netMinor: 900000n, list: [{ secret: "s" }] },
    }) as Record<string, unknown>;
    expect(out).toEqual({
      reference: "PAY-1",
      amountMinor: "125000",
      password: "[REDACTED]",
      nested: { token: "[REDACTED]", employeeName: "[REDACTED]", netMinor: "[REDACTED]", list: [{ secret: "[REDACTED]" }] },
    });
  });

  it("never writes a raw error message, only its class and stable code", () => {
    const lines: string[] = [];
    setLogSinkForTests((line) => lines.push(line));
    const leaky = new Error("row 7: employee Synthetic Person salary 4321.000 invalid");
    logError("payroll", "validation failed", leaky, { batchId: "b1", basicMinor: 4321000n });
    logError("payments", "denied", new DomainError("PERMISSION_DENIED"), {});
    logInfo("jobs", "claimed", { jobId: "j1", cookie: "session=abc" });

    const text = lines.join("\n");
    expect(lines).toHaveLength(3);
    expect(text).not.toContain("Synthetic Person");
    expect(text).not.toContain("4321");
    expect(text).not.toContain("session=abc");
    const first = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(first).toMatchObject({
      severity: "error",
      service: "payroll",
      errorClass: "Error",
      batchId: "b1",
      basicMinor: "[REDACTED]",
      msg: "validation failed",
    });
    expect(typeof first["time"]).toBe("string");
    expect(JSON.parse(lines[1] as string)).toMatchObject({ errorClass: "DomainError", code: "PERMISSION_DENIED" });
  });

  it("classifies unknown throwables safely", () => {
    expect(safeError("a string with secrets")).toEqual({ errorClass: "string" });
    expect(safeError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toEqual({
      errorClass: "Error",
      code: "ECONNRESET",
    });
    expect(safeError(Object.assign(new Error("x"), { code: "not a code; drop table" }))).toEqual({ errorClass: "Error" });
  });

  it("accepts only plain bounded correlation IDs", () => {
    expect(resolveCorrelationId("corr_demo_001")).toBe("corr_demo_001");
    expect(resolveCorrelationId("short")).toMatch(/^corr_[0-9a-f]{32}$/);
    expect(resolveCorrelationId("has spaces and\nnewline")).toMatch(/^corr_[0-9a-f]{32}$/);
    expect(resolveCorrelationId("x".repeat(65))).toMatch(/^corr_[0-9a-f]{32}$/);
    expect(resolveCorrelationId(null)).toMatch(/^corr_[0-9a-f]{32}$/);
  });
});
