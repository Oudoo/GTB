/**
 * CSV in and out (BAT-01, COL-01, RPT-01, I-41).
 *
 * Writing: RFC 4180 quoting, CRLF line ends, UTF-8 with BOM (so spreadsheet tools read Arabic),
 * and every cell that a spreadsheet could evaluate as a formula is neutralised.
 * Reading: strict UTF-8, hard byte/row/column/cell bounds, malformed quoting is an error with a
 * line number — nothing is guessed or silently repaired.
 */
import { parse } from "csv-parse/sync";
import { ImportFileError, type TableLimits, type ParsedTable } from "./tabular-types";

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Stop a text cell from being executed as a formula when the file is opened in a spreadsheet:
 * a leading `=`, `+`, `-`, `@`, tab or carriage return gets an apostrophe prefix. Plain signed
 * numbers such as `-125.000` stay numbers.
 */
export function neutralizeFormula(value: string): string {
  if (value.length === 0 || PLAIN_NUMBER.test(value)) return value;
  return FORMULA_START.test(value) ? `'${value}` : value;
}

function quote(value: string): string {
  return /[",\r\n]/.test(value) || value !== value.trim() ? `"${value.replaceAll('"', '""')}"` : value;
}

export type CsvCell = string | number | bigint | boolean | null | undefined;

/** Serialise rows as a UTF-8 CSV file. Control characters other than line breaks are removed. */
export function toCsv(headers: readonly string[], rows: ReadonlyArray<readonly CsvCell[]>): Uint8Array {
  const clean = (cell: CsvCell): string => {
    if (cell === null || cell === undefined) return "";
    const text = String(cell).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
    return quote(neutralizeFormula(text));
  };
  const lines = [headers.map(clean).join(","), ...rows.map((row) => row.map(clean).join(","))];
  return new TextEncoder().encode(`﻿${lines.join("\r\n")}\r\n`);
}

/** Parse a CSV upload into a header row and data rows with their original line numbers. */
export function parseCsv(bytes: Uint8Array, limits: TableLimits): ParsedTable {
  if (bytes.byteLength > limits.maxBytes) throw new ImportFileError("IMPORT_TOO_LARGE", "The file is larger than the upload limit.");
  if (bytes.includes(0)) throw new ImportFileError("UNSUPPORTED_FILE", "The file is not UTF-8 text.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new ImportFileError("UNSUPPORTED_FILE", "The file is not valid UTF-8 text.");
  }

  let records: Array<{ record: string[]; info: { lines: number } }>;
  try {
    records = parse(text, {
      bom: true,
      delimiter: ",",
      relax_column_count: true,
      skip_empty_lines: true,
      info: true,
      max_record_size: limits.maxCellChars * 8,
      // One more than allowed so "too many rows" is detected without reading the whole file.
      to: limits.maxRows + 2,
    }) as unknown as Array<{ record: string[]; info: { lines: number } }>;
  } catch (error) {
    const detail = error as { code?: string; lines?: number };
    throw new ImportFileError("MALFORMED", "The CSV file could not be read.", detail.lines);
  }
  if (records.length === 0) throw new ImportFileError("EMPTY", "The file has no header row.");
  if (records.length > limits.maxRows + 1) throw new ImportFileError("IMPORT_TOO_LARGE", `The file has more than ${limits.maxRows} data rows.`);

  const [header, ...data] = records;
  const headers = (header as { record: string[] }).record.map((cell) => cell.trim());
  if (headers.length > limits.maxColumns) throw new ImportFileError("MALFORMED", "The file has too many columns.");
  const rows = data.map(({ record, info }) => {
    if (record.length > limits.maxColumns) throw new ImportFileError("MALFORMED", "A row has too many columns.", info.lines);
    for (const cell of record) {
      if (cell.length > limits.maxCellChars) throw new ImportFileError("IMPORT_TOO_LARGE", "A cell is longer than the allowed length.", info.lines);
    }
    return { line: info.lines, cells: record };
  });
  return { format: "CSV", headers, rows };
}
