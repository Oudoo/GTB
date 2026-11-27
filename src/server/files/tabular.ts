/**
 * One entry point for tabular uploads (BAT-01, COL-01, Appendix A of document 02).
 *
 * The format is decided from the file's own bytes, and the extension must agree with it: a
 * renamed file is refused, not interpreted. Templates are versioned manifests declared in code
 * (never a hidden macro); a file must carry exactly the required headers, may carry the listed
 * optional ones, and nothing else.
 */
import { hasUnsafeCharacters } from "@/contracts/common";
import { parseCsv, toCsv } from "./csv";
import { DEFAULT_TABLE_LIMITS, ImportFileError, type ParsedTable, type TableLimits } from "./tabular-types";
import { looksLikeZip, parseXlsx, writeXlsx } from "./xlsx";

export * from "./tabular-types";

export type TableFormat = "CSV" | "XLSX";

/** Decide the format from content and insist that the file name agrees with it. */
export function detectFormat(bytes: Uint8Array, fileName: string): TableFormat {
  const lower = fileName.toLowerCase().trim();
  const extension = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  if (extension !== "csv" && extension !== "xlsx") {
    throw new ImportFileError("UNSUPPORTED_FILE", "Only .csv and .xlsx files are accepted.");
  }
  // Legacy binary workbooks (.xls, OLE2) and anything else that is not what its name says.
  const ole2 = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  if (ole2) throw new ImportFileError("UNSUPPORTED_FILE", "Legacy .xls workbooks are not accepted. Save the file as .xlsx or .csv.");
  const zip = looksLikeZip(bytes);
  if (extension === "xlsx" && !zip) throw new ImportFileError("UNSUPPORTED_FILE", "The file is named .xlsx but is not a workbook.");
  if (extension === "csv" && zip) throw new ImportFileError("UNSUPPORTED_FILE", "The file is named .csv but is not text.");
  return zip ? "XLSX" : "CSV";
}

export function parseTable(bytes: Uint8Array, fileName: string, limits: TableLimits = DEFAULT_TABLE_LIMITS): ParsedTable {
  if (bytes.byteLength === 0) throw new ImportFileError("EMPTY", "The file is empty.");
  if (bytes.byteLength > limits.maxBytes) throw new ImportFileError("IMPORT_TOO_LARGE", "The file is larger than the upload limit.");
  return detectFormat(bytes, fileName) === "XLSX" ? parseXlsx(bytes, limits) : parseCsv(bytes, limits);
}

export type TemplateSpec = Readonly<{
  /** Template family, e.g. `bulk`, `payroll`, `employees`, `customers`. */
  name: string;
  version: number;
  required: readonly string[];
  optional: readonly string[];
}>;

export type BoundRow = { line: number; values: Record<string, string> };

/**
 * Check the header row against a template and return rows keyed by column name.
 * Values are trimmed at the edges only; nothing inside a value is altered. A missing optional
 * column yields an empty string for that field.
 */
export function bindTemplate(table: ParsedTable, spec: TemplateSpec, templateVersion: number): BoundRow[] {
  if (templateVersion !== spec.version) {
    throw new ImportFileError("TEMPLATE_VERSION", `This file must use ${spec.name} template version ${spec.version}.`);
  }
  const headers = table.headers.map((header) => header.replace(/^﻿/, "").trim());
  const seen = new Set<string>();
  for (const header of headers) {
    if (header === "") throw new ImportFileError("MISSING_HEADER", "A header cell is empty.");
    if (seen.has(header)) throw new ImportFileError("DUPLICATE_HEADER", `The column "${header}" appears more than once.`, 1, header);
    seen.add(header);
  }
  const known = new Set([...spec.required, ...spec.optional]);
  for (const column of spec.required) {
    if (!seen.has(column)) throw new ImportFileError("MISSING_HEADER", `The required column "${column}" is missing.`, 1, column);
  }
  for (const header of headers) {
    if (!known.has(header)) throw new ImportFileError("UNEXPECTED_HEADER", `The column "${header}" is not part of this template.`, 1, header);
  }
  return table.rows.map((row) => {
    if (row.cells.length > headers.length && row.cells.slice(headers.length).some((cell) => cell.trim() !== "")) {
      throw new ImportFileError("MALFORMED", "A row has more values than there are columns.", row.line);
    }
    const values: Record<string, string> = {};
    for (const column of known) values[column] = "";
    headers.forEach((header, index) => {
      values[header] = (row.cells[index] ?? "").trim();
    });
    return { line: row.line, values };
  });
}

/** True when a cell carries control or invisible direction characters (Appendix A). */
export function hasUnsafeCell(value: string): boolean {
  return hasUnsafeCharacters(value);
}

/** A downloadable template with the exact headers and optional synthetic example rows. */
export function templateFile(
  spec: TemplateSpec,
  format: TableFormat,
  examples: ReadonlyArray<Record<string, string>> = [],
  instructions: readonly string[] = [],
): Uint8Array {
  const headers = [...spec.required, ...spec.optional];
  const rows = examples.map((example) => headers.map((header) => example[header] ?? ""));
  if (format === "CSV") return toCsv(headers, rows);
  return writeXlsx([
    { name: "Data", rows: [headers, ...rows] },
    ...(instructions.length > 0 ? [{ name: "Instructions" as const, rows: instructions.map((line) => [line]) }] : []),
  ]);
}

/** The documented templates of Appendix A (document 02). */
export const TEMPLATES = {
  bulk: { name: "bulk", version: 1, required: ["row_reference", "beneficiary_name", "account_scheme", "account_reference", "amount", "currency", "purpose"], optional: ["beneficiary_reference"] },
  employees: { name: "employees", version: 1, required: ["employee_code", "employee_name", "account_scheme", "account_reference"], optional: ["active"] },
  payroll: {
    name: "payroll",
    version: 1,
    required: ["row_reference", "employee_code", "pay_period", "component", "basic", "allowances", "deductions", "correction", "payslip_reference", "currency"],
    optional: ["correction_reference"],
  },
  customers: { name: "customers", version: 1, required: ["customer_code", "display_name", "mobile", "company"], optional: ["industry", "tags", "billing_address", "collection_method"] },
} as const satisfies Record<string, TemplateSpec>;
