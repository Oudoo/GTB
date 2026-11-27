/**
 * Bounded `.xlsx` reader and minimal writer (BAT-01, Appendix A of document 02, DEC-003).
 *
 * The reader is purpose-built on `fflate` (zip) and `saxes` (XML) because the import rules
 * need hard bounds that general spreadsheet libraries do not expose:
 *   - the compressed upload size is capped before anything is inflated;
 *   - every zip entry is inflated through a counter, so the total DECOMPRESSED size is capped
 *     on real output bytes — a lying size header (zip bomb) cannot get past it;
 *   - only an allow-list of workbook parts is accepted: macros (`vbaProject`), external links,
 *     embedded objects, drawings, connections and anything unknown reject the whole file;
 *   - a formula cell rejects the file even when a cached value is present (never evaluated);
 *   - no DTD is accepted and no entity is expanded;
 *   - sheets, rows, columns and cell length are bounded while parsing.
 * Only cell text is returned. Numbers are returned exactly as written in the file and are
 * validated as decimal text by the feature — they are never converted through a float.
 *
 * The writer emits text-only cells (inline strings), so nothing it produces can be a formula.
 */
import { Unzip, UnzipInflate, zipSync, type Zippable } from "fflate";
import { SaxesParser } from "saxes";
import { ImportFileError, type ParsedTable, type TableLimits } from "./tabular-types";

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const MAX_ENTRIES = 100;
const ENTRY_NAME = /^[A-Za-z0-9_[\]/.\- ]{1,200}$/;

/** Workbook parts a plain data workbook may contain. Everything else is refused. */
const ALLOWED_PARTS: RegExp[] = [
  /^\[Content_Types\]\.xml$/,
  /^_rels\/\.rels$/,
  /^docProps\/(app|core|custom)\.xml$/,
  /^xl\/workbook\.xml$/,
  /^xl\/_rels\/workbook\.xml\.rels$/,
  /^xl\/worksheets\/sheet\d{1,3}\.xml$/,
  /^xl\/worksheets\/_rels\/sheet\d{1,3}\.xml\.rels$/,
  /^xl\/sharedStrings\.xml$/,
  /^xl\/styles\.xml$/,
  /^xl\/theme\/theme\d{1,2}\.xml$/,
  /^xl\/metadata\.xml$/,
  /^xl\/printerSettings\/printerSettings\d{1,3}\.bin$/,
];

export function looksLikeZip(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((value, index) => bytes[index] === value);
}

function classifyForbidden(name: string): ImportFileError {
  const lower = name.toLowerCase();
  if (lower.includes("vbaproject") || lower.includes("macrosheets") || lower.endsWith(".xlsm")) {
    return new ImportFileError("MACRO", "The workbook contains macros. Save it as a plain .xlsx file without macros.");
  }
  if (lower.includes("externallink") || lower.includes("connections") || lower.includes("querytable")) {
    return new ImportFileError("EXTERNAL_LINK", "The workbook links to external data. Remove external links and try again.");
  }
  if (lower === "xl/calcchain.xml") {
    return new ImportFileError("FORMULA", "The workbook contains formulas. Replace formulas with their values as text.");
  }
  return new ImportFileError("EMBEDDED_OBJECT", "The workbook contains content that is not allowed (objects, drawings, comments or unknown parts).");
}

/** Inflate the archive through a byte counter and keep only the XML parts needed for reading. */
function inflateParts(bytes: Uint8Array, limits: TableLimits): Map<string, Uint8Array> {
  const parts = new Map<string, Uint8Array>();
  let entries = 0;
  let total = 0;
  let failure: ImportFileError | null = null;
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    entries += 1;
    if (entries > MAX_ENTRIES) throw new ImportFileError("MALFORMED", "The workbook has too many parts.");
    const name = file.name;
    if (name.endsWith("/")) return; // directory entry
    if (!ENTRY_NAME.test(name) || name.includes("..") || name.startsWith("/")) throw new ImportFileError("MALFORMED", "The workbook has an invalid part name.");
    if (!ALLOWED_PARTS.some((pattern) => pattern.test(name))) throw classifyForbidden(name);
    if (parts.has(name)) throw new ImportFileError("MALFORMED", "The workbook contains a duplicate part.");
    const keep = name.endsWith(".xml") || name.endsWith(".rels");
    const chunks: Uint8Array[] = [];
    file.ondata = (error, chunk, final) => {
      // The inflater reports an exception thrown by this handler back to it as `error`, so the
      // first refusal is remembered and re-raised unchanged instead of becoming "damaged".
      if (failure) throw failure;
      if (error) {
        failure = error instanceof ImportFileError ? error : new ImportFileError("MALFORMED", "The workbook is damaged and could not be read.");
        throw failure;
      }
      total += chunk.byteLength;
      // Counted on real inflated output, so a forged size header cannot bypass the cap.
      if (total > limits.maxDecompressedBytes) {
        failure = new ImportFileError("IMPORT_TOO_LARGE", "The workbook is too large when decompressed.");
        throw failure;
      }
      if (keep) chunks.push(chunk.slice());
      if (final && keep) {
        const merged = new Uint8Array(chunks.reduce((sum, part) => sum + part.byteLength, 0));
        let offset = 0;
        for (const part of chunks) {
          merged.set(part, offset);
          offset += part.byteLength;
        }
        parts.set(name, merged);
      }
    };
    file.start();
  };
  try {
    unzip.push(bytes, true);
  } catch (error) {
    if (failure) throw failure;
    if (error instanceof ImportFileError) throw error;
    throw new ImportFileError("MALFORMED", "The workbook is damaged and could not be read.");
  }
  if (failure) throw failure;
  return parts;
}

type XmlHandlers = {
  open?: (name: string, attributes: Record<string, string>) => void;
  close?: (name: string) => void;
  text?: (value: string) => void;
};

/** Strict XML walk: no DTD, no processing beyond elements, attributes and text. */
function walkXml(data: Uint8Array, handlers: XmlHandlers): void {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new ImportFileError("MALFORMED", "A workbook part is not valid UTF-8.");
  }
  const parser = new SaxesParser({ xmlns: false, position: false });
  parser.on("doctype", () => {
    throw new ImportFileError("MALFORMED", "The workbook contains a document type declaration, which is not allowed.");
  });
  parser.on("error", () => {
    throw new ImportFileError("MALFORMED", "A workbook part is not well-formed XML.");
  });
  parser.on("opentag", (tag) => handlers.open?.(tag.name, tag.attributes as Record<string, string>));
  parser.on("closetag", (tag) => handlers.close?.(tag.name));
  parser.on("text", (value) => handlers.text?.(value));
  parser.on("cdata", (value) => handlers.text?.(value));
  try {
    parser.write(text).close();
  } catch (error) {
    if (error instanceof ImportFileError) throw error;
    throw new ImportFileError("MALFORMED", "A workbook part is not well-formed XML.");
  }
}

function assertNoExternalTargets(rels: Uint8Array | undefined): Map<string, string> {
  const targets = new Map<string, string>();
  if (!rels) return targets;
  walkXml(rels, {
    open: (name, attributes) => {
      if (name !== "Relationship") return;
      if ((attributes["TargetMode"] ?? "").toLowerCase() === "external") {
        throw new ImportFileError("EXTERNAL_LINK", "The workbook links to an external address. Remove external links and try again.");
      }
      if (attributes["Id"] && attributes["Target"]) targets.set(attributes["Id"], attributes["Target"]);
    },
  });
  return targets;
}

function readSharedStrings(data: Uint8Array | undefined, limits: TableLimits): string[] {
  const strings: string[] = [];
  if (!data) return strings;
  const maxStrings = (limits.maxRows + 1) * limits.maxColumns + 1_000;
  let current: string | null = null;
  let inText = false;
  let phonetic = 0;
  walkXml(data, {
    open: (name) => {
      if (name === "si") current = "";
      else if (name === "rPh") phonetic += 1;
      else if (name === "t" && phonetic === 0) inText = true;
    },
    text: (value) => {
      if (inText && current !== null) {
        current += value;
        if (current.length > limits.maxCellChars) throw new ImportFileError("IMPORT_TOO_LARGE", "A cell is longer than the allowed length.");
      }
    },
    close: (name) => {
      if (name === "t") inText = false;
      else if (name === "rPh") phonetic -= 1;
      else if (name === "si") {
        strings.push(current ?? "");
        current = null;
        if (strings.length > maxStrings) throw new ImportFileError("IMPORT_TOO_LARGE", "The workbook has too many text cells.");
      }
    },
  });
  return strings;
}

function columnIndex(reference: string): number {
  const letters = /^([A-Z]{1,3})\d+$/.exec(reference)?.[1];
  if (!letters) throw new ImportFileError("MALFORMED", "The worksheet has an invalid cell reference.");
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function readSheet(data: Uint8Array, strings: string[], limits: TableLimits): Array<{ line: number; cells: string[] }> {
  const rows: Array<{ line: number; cells: string[] }> = [];
  let rowNumber = 0;
  let cells: string[] = [];
  let cellRef = "";
  let cellType = "";
  let value: string | null = null;
  let capture: "v" | "t" | null = null;
  let nextColumn = 0;

  walkXml(data, {
    open: (name, attributes) => {
      if (name === "row") {
        const declared = Number.parseInt(attributes["r"] ?? "", 10);
        rowNumber = Number.isInteger(declared) && declared > rowNumber ? declared : rowNumber + 1;
        cells = [];
        nextColumn = 0;
      } else if (name === "c") {
        cellRef = attributes["r"] ?? "";
        cellType = attributes["t"] ?? "n";
        value = null;
      } else if (name === "f") {
        // A formula is refused even when Excel stored a cached result next to it.
        throw new ImportFileError("FORMULA", "The worksheet contains a formula. Replace formulas with their values as text.", rowNumber, cellRef || undefined);
      } else if (name === "v") {
        capture = "v";
        value = "";
      } else if (name === "t" && cellType === "inlineStr") {
        capture = "t";
        value ??= "";
      }
    },
    text: (chunk) => {
      if (capture === null || value === null) return;
      value += chunk;
      if (value.length > limits.maxCellChars) throw new ImportFileError("IMPORT_TOO_LARGE", "A cell is longer than the allowed length.", rowNumber, cellRef || undefined);
    },
    close: (name) => {
      if (name === "v" || name === "t") {
        capture = null;
      } else if (name === "c") {
        const index = cellRef ? columnIndex(cellRef) : nextColumn;
        nextColumn = index + 1;
        if (index >= limits.maxColumns) {
          if ((value ?? "").trim() !== "") throw new ImportFileError("MALFORMED", "The worksheet has too many columns.", rowNumber, cellRef || undefined);
          return;
        }
        let text = value ?? "";
        if (cellType === "s") {
          const shared = strings[Number.parseInt(text, 10)];
          if (shared === undefined) throw new ImportFileError("MALFORMED", "The worksheet refers to missing text.", rowNumber, cellRef || undefined);
          text = shared;
        } else if (cellType === "b") {
          text = text === "1" ? "true" : "false";
        } else if (cellType === "e") {
          throw new ImportFileError("MALFORMED", "The worksheet contains an error value.", rowNumber, cellRef || undefined);
        }
        while (cells.length < index) cells.push("");
        cells[index] = text;
      } else if (name === "row") {
        if (cells.some((cell) => cell.trim() !== "")) {
          rows.push({ line: rowNumber, cells });
          if (rows.length > limits.maxRows + 1) throw new ImportFileError("IMPORT_TOO_LARGE", `The worksheet has more than ${limits.maxRows} data rows.`);
        }
      }
    },
  });
  return rows;
}

/** Read the `Data` worksheet of an uploaded workbook into header and rows. */
export function parseXlsx(bytes: Uint8Array, limits: TableLimits): ParsedTable {
  if (bytes.byteLength > limits.maxBytes) throw new ImportFileError("IMPORT_TOO_LARGE", "The file is larger than the upload limit.");
  if (!looksLikeZip(bytes)) throw new ImportFileError("UNSUPPORTED_FILE", "The file is not an .xlsx workbook.");
  const parts = inflateParts(bytes, limits);

  const contentTypes = parts.get("[Content_Types].xml");
  const workbook = parts.get("xl/workbook.xml");
  if (!contentTypes || !workbook) throw new ImportFileError("UNSUPPORTED_FILE", "The file is not an .xlsx workbook.");
  const declared = new TextDecoder().decode(contentTypes).toLowerCase();
  if (declared.includes("macroenabled") || declared.includes("vbaproject")) {
    throw new ImportFileError("MACRO", "The workbook contains macros. Save it as a plain .xlsx file without macros.");
  }
  if (declared.includes("ms-excel.sheet.binary")) throw new ImportFileError("UNSUPPORTED_FILE", "Only .xlsx workbooks are accepted.");

  const sheets: Array<{ name: string; relId: string }> = [];
  walkXml(workbook, {
    open: (name, attributes) => {
      if (name === "sheet") sheets.push({ name: (attributes["name"] ?? "").trim(), relId: attributes["r:id"] ?? "" });
      else if (name === "externalReference" || name === "externalReferences") {
        throw new ImportFileError("EXTERNAL_LINK", "The workbook links to external data. Remove external links and try again.");
      }
    },
  });
  if (sheets.length === 0) throw new ImportFileError("EMPTY", "The workbook has no worksheet.");
  if (sheets.length > limits.maxSheets) throw new ImportFileError("MALFORMED", `The workbook may contain at most ${limits.maxSheets} worksheets (Data and optional Instructions).`);
  const dataSheet = sheets.find((sheet) => sheet.name === "Data");
  if (!dataSheet) throw new ImportFileError("MISSING_HEADER", "The workbook needs a worksheet named Data with the headers in row 1.");
  if (sheets.some((sheet) => sheet !== dataSheet && sheet.name !== "Instructions")) {
    throw new ImportFileError("MALFORMED", "The only worksheets allowed are Data and Instructions.");
  }

  const targets = assertNoExternalTargets(parts.get("xl/_rels/workbook.xml.rels"));
  for (const [name, data] of parts) {
    if (/^xl\/worksheets\/_rels\//.test(name) || name === "_rels/.rels") assertNoExternalTargets(data);
  }
  const target = targets.get(dataSheet.relId);
  if (!target) throw new ImportFileError("MALFORMED", "The workbook structure is incomplete.");
  const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  const sheet = parts.get(path);
  if (!sheet) throw new ImportFileError("MALFORMED", "The Data worksheet is missing from the workbook.");

  const strings = readSharedStrings(parts.get("xl/sharedStrings.xml"), limits);
  const rows = readSheet(sheet, strings, limits);
  const header = rows[0];
  if (!header || header.line !== 1) throw new ImportFileError("MISSING_HEADER", "Row 1 of the Data worksheet must contain the column headers.");
  const headers = header.cells.map((cell) => cell.trim());
  while (headers.length > 0 && headers[headers.length - 1] === "") headers.pop();
  const data = rows.slice(1).map((row) => {
    if (row.cells.slice(headers.length).some((cell) => cell.trim() !== "")) {
      throw new ImportFileError("MALFORMED", "A row has a value outside the header columns.", row.line);
    }
    const cells = row.cells.slice(0, headers.length);
    while (cells.length < headers.length) cells.push("");
    return { line: row.line, cells };
  });
  return { format: "XLSX", headers, rows: data };
}

// ---------------------------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------------------------

const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

function xmlEscape(value: string): string {
  return value.replace(XML_INVALID, "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function columnLetters(index: number): string {
  let letters = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

function sheetXml(rows: ReadonlyArray<readonly string[]>): string {
  const body = rows
    .map((cells, rowIndex) => {
      const row = cells
        .map((cell, columnIndex) =>
          cell === "" ? "" : `<c r="${columnLetters(columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell)}</t></is></c>`,
        )
        .join("");
      return `<row r="${rowIndex + 1}">${row}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

export type XlsxSheet = { name: "Data" | "Instructions"; rows: ReadonlyArray<readonly string[]> };

/**
 * Write a text-only workbook (templates, result files, test fixtures). Every cell is an inline
 * string, so a value starting with `=` is stored and displayed as text, never as a formula.
 */
export function writeXlsx(sheets: readonly XlsxSheet[]): Uint8Array {
  const encoder = new TextEncoder();
  const files: Zippable = {};
  const put = (name: string, xml: string) => {
    // A fixed timestamp keeps the output byte-identical for identical input.
    files[name] = [encoder.encode(xml), { mtime: new Date("2026-01-01T00:00:00Z"), level: 6 }];
  };
  put(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
      .map((_sheet, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join("")}</Types>`,
  );
  put(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  put(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
      .join("")}</sheets></workbook>`,
  );
  put(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map((_sheet, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`)
      .join("")}</Relationships>`,
  );
  sheets.forEach((sheet, index) => put(`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet.rows)));
  return zipSync(files);
}
