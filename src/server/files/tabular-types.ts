/** Shared types and limits for bounded tabular imports (BAT-01, Appendix A of document 02). */

export type TableLimits = Readonly<{
  /** Upload size as received (compressed size for XLSX). */
  maxBytes: number;
  /** Data rows, not counting the header. The system-tested hard cap is 1,000. */
  maxRows: number;
  maxColumns: number;
  /** Raw characters per cell before any field-specific limit. */
  maxCellChars: number;
  /** XLSX only: total bytes after inflating every part. */
  maxDecompressedBytes: number;
  /** XLSX only: worksheets including the optional `Instructions` sheet. */
  maxSheets: number;
}>;

export const HARD_ROW_CAP = 1_000;

export const DEFAULT_TABLE_LIMITS: TableLimits = Object.freeze({
  maxBytes: 5 * 1024 * 1024,
  maxRows: HARD_ROW_CAP,
  maxColumns: 32,
  maxCellChars: 10_000,
  maxDecompressedBytes: 25 * 1024 * 1024,
  maxSheets: 2,
});

export type ParsedTable = {
  format: "CSV" | "XLSX";
  headers: string[];
  /** `line` is the 1-based line (CSV) or worksheet row (XLSX) the person sees in their file. */
  rows: Array<{ line: number; cells: string[] }>;
};

export type ImportFileCode =
  | "UNSUPPORTED_FILE"
  | "IMPORT_TOO_LARGE"
  | "MALFORMED"
  | "EMPTY"
  | "FORMULA"
  | "MACRO"
  | "EXTERNAL_LINK"
  | "EMBEDDED_OBJECT"
  | "DUPLICATE_HEADER"
  | "MISSING_HEADER"
  | "UNEXPECTED_HEADER"
  | "TEMPLATE_VERSION";

/** A whole-file rejection. Row-level problems are reported per row by the feature instead. */
export class ImportFileError extends Error {
  constructor(
    readonly code: ImportFileCode,
    message: string,
    /** Line or worksheet row, when one can be named. */
    readonly line?: number,
    /** Cell reference (XLSX) or column name, when one can be named. */
    readonly cell?: string,
  ) {
    super(message);
    this.name = "ImportFileError";
  }
}
