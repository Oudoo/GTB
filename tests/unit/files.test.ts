/**
 * File primitives: bounded CSV/XLSX import, template binding, safe export, private storage
 * keys and PDF text ordering. Covers the parser-level part of U-IMP-01..04 and I-41; the
 * row-level rules (duplicate reference, mixed currency, empty accepted set) are tested with
 * the features that own them.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { neutralizeFormula, parseCsv, toCsv } from "@/server/files/csv";
import { PdfBuilder, visualRuns } from "@/server/files/pdf";
import { downloadResponse, putPrivateFile, readPrivateFile, safeFileName } from "@/server/files/storage";
import { DEFAULT_TABLE_LIMITS, ImportFileError, TEMPLATES, bindTemplate, detectFormat, parseTable, templateFile, type TableLimits } from "@/server/files/tabular";
import { parseXlsx, writeXlsx } from "@/server/files/xlsx";

const text = (value: string) => new TextEncoder().encode(value);
const BULK_HEADER = "row_reference,beneficiary_name,account_scheme,account_reference,amount,currency,purpose";

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ImportFileError) return error.code;
    throw error;
  }
  return "NO_ERROR";
}

/** A workbook assembled by hand so hostile parts can be injected. */
function workbook(options: { sheetXml?: string; extra?: Record<string, string>; contentTypes?: string; workbookXml?: string; rels?: string } = {}): Uint8Array {
  const sheet =
    options.sheetXml ??
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>row_reference</t></is></c></row></sheetData></worksheet>`;
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(options.contentTypes ?? `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`),
    "_rels/.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`),
    "xl/workbook.xml": strToU8(
      options.workbookXml ??
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      options.rels ??
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
  };
  for (const [name, content] of Object.entries(options.extra ?? {})) files[name] = strToU8(content);
  return zipSync(files);
}

describe("CSV import (U-IMP-01, U-IMP-02)", () => {
  it("reads headers and rows with their original line numbers, accepting a BOM", () => {
    const table = parseCsv(text(`﻿${BULK_HEADER}\r\nR-1,"Supplier, Demo",DEMO_DOMESTIC,DEMO-LY-900001,125.000,LYD,Invoice 1\r\n\r\nR-2,Other Demo,DEMO_DOMESTIC,DEMO-LY-900002,0010.500,LYD,Invoice 2\r\n`), DEFAULT_TABLE_LIMITS);
    expect(table.headers).toEqual(BULK_HEADER.split(","));
    expect(table.rows.map((row) => row.line)).toEqual([2, 4]);
    expect(table.rows[0]?.cells[1]).toBe("Supplier, Demo");
    // Leading zeros and decimal text are preserved exactly; nothing is parsed as a number.
    expect(table.rows[1]?.cells[4]).toBe("0010.500");
  });

  it("rejects malformed quoting with a line number instead of guessing", () => {
    let caught: ImportFileError | null = null;
    try {
      parseCsv(text(`${BULK_HEADER}\nR-1,"unterminated,DEMO_DOMESTIC,DEMO-LY-900001,1.000,LYD,x\n`), DEFAULT_TABLE_LIMITS);
    } catch (error) {
      caught = error as ImportFileError;
    }
    expect(caught).toBeInstanceOf(ImportFileError);
    expect(caught?.code).toBe("MALFORMED");
    expect(codeOf(() => parseCsv(text(`a,b\n1,2"3"\n`), DEFAULT_TABLE_LIMITS))).toBe("MALFORMED");
  });

  it("rejects non UTF-8 bytes, NUL bytes and files over the byte or row limit", () => {
    expect(codeOf(() => parseCsv(new Uint8Array([0x61, 0x2c, 0xff, 0xfe]), DEFAULT_TABLE_LIMITS))).toBe("UNSUPPORTED_FILE");
    expect(codeOf(() => parseCsv(new Uint8Array([0x61, 0x00, 0x62]), DEFAULT_TABLE_LIMITS))).toBe("UNSUPPORTED_FILE");
    const limits: TableLimits = { ...DEFAULT_TABLE_LIMITS, maxRows: 3, maxBytes: 200 };
    expect(codeOf(() => parseCsv(text(`a\n1\n2\n3\n4\n`), limits))).toBe("IMPORT_TOO_LARGE");
    expect(parseCsv(text(`a\n1\n2\n3\n`), limits).rows).toHaveLength(3);
    expect(codeOf(() => parseCsv(text("a\n" + "x".repeat(300)), limits))).toBe("IMPORT_TOO_LARGE");
    expect(codeOf(() => parseCsv(text(""), DEFAULT_TABLE_LIMITS))).toBe("EMPTY");
  });
});

describe("template binding (U-IMP-01)", () => {
  const table = (header: string, ...lines: string[]) => parseCsv(text([header, ...lines].join("\n")), DEFAULT_TABLE_LIMITS);

  it("binds rows by column name, trims edges only and fills absent optional columns", () => {
    const rows = bindTemplate(table(`${BULK_HEADER}`, `R-1,  Supplier Demo ,DEMO_DOMESTIC,DEMO-LY-900001,125.000,LYD,Invoice  1`), TEMPLATES.bulk, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.line).toBe(2);
    expect(rows[0]?.values["beneficiary_name"]).toBe("Supplier Demo");
    expect(rows[0]?.values["purpose"]).toBe("Invoice  1");
    expect(rows[0]?.values["beneficiary_reference"]).toBe("");
  });

  it("rejects a wrong template version, missing, duplicate and unexpected headers", () => {
    const good = table(BULK_HEADER, "R-1,A,DEMO_DOMESTIC,DEMO-LY-900001,1.000,LYD,x");
    expect(codeOf(() => bindTemplate(good, TEMPLATES.bulk, 2))).toBe("TEMPLATE_VERSION");
    expect(codeOf(() => bindTemplate(table(BULK_HEADER.replace(",currency", "")), TEMPLATES.bulk, 1))).toBe("MISSING_HEADER");
    expect(codeOf(() => bindTemplate(table(`${BULK_HEADER},amount`), TEMPLATES.bulk, 1))).toBe("DUPLICATE_HEADER");
    expect(codeOf(() => bindTemplate(table(`${BULK_HEADER},salary`), TEMPLATES.bulk, 1))).toBe("UNEXPECTED_HEADER");
    // A payroll file can never carry a free-form account column (Appendix A).
    const payrollHeader = [...TEMPLATES.payroll.required, "account_reference"].join(",");
    expect(codeOf(() => bindTemplate(table(payrollHeader), TEMPLATES.payroll, 1))).toBe("UNEXPECTED_HEADER");
  });

  it("produces templates that read back as their own headers in both formats", () => {
    for (const format of ["CSV", "XLSX"] as const) {
      const file = templateFile(TEMPLATES.customers, format, [{ customer_code: "CUST-001", display_name: "Demo", mobile: "+218912345678", company: "Demo Co" }], ["Synthetic example"]);
      const parsed = parseTable(file, `customers.${format.toLowerCase()}`);
      expect(parsed.headers).toEqual([...TEMPLATES.customers.required, ...TEMPLATES.customers.optional]);
      expect(bindTemplate(parsed, TEMPLATES.customers, 1)[0]?.values["customer_code"]).toBe("CUST-001");
    }
  });
});

describe("format detection (BAT-01)", () => {
  it("trusts content, not the extension", () => {
    const csv = text("a,b\n1,2\n");
    const xlsx = writeXlsx([{ name: "Data", rows: [["a"], ["1"]] }]);
    expect(detectFormat(csv, "batch.csv")).toBe("CSV");
    expect(detectFormat(xlsx, "batch.XLSX")).toBe("XLSX");
    expect(codeOf(() => detectFormat(csv, "batch.xlsx"))).toBe("UNSUPPORTED_FILE");
    expect(codeOf(() => detectFormat(xlsx, "batch.csv"))).toBe("UNSUPPORTED_FILE");
    expect(codeOf(() => detectFormat(csv, "batch.xls"))).toBe("UNSUPPORTED_FILE");
    expect(codeOf(() => detectFormat(csv, "batch.xlsm"))).toBe("UNSUPPORTED_FILE");
    expect(codeOf(() => detectFormat(csv, "batch"))).toBe("UNSUPPORTED_FILE");
    // A legacy binary workbook renamed to .csv is still refused.
    expect(codeOf(() => detectFormat(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1]), "batch.csv"))).toBe("UNSUPPORTED_FILE");
    expect(codeOf(() => parseTable(new Uint8Array(), "batch.csv"))).toBe("EMPTY");
  });
});

describe("XLSX import (U-IMP-03, U-IMP-04)", () => {
  it("round-trips text exactly, including leading zeros and text that looks like a formula", () => {
    const file = writeXlsx([
      { name: "Data", rows: [["row_reference", "account_reference", "amount", "note"], ["R-1", "0012345", "125.000", "=1+1"], ["R-2", "DEMO-LY-900001", "0.500", "شركة تجريبية <&>"]] },
      { name: "Instructions", rows: [["Synthetic template"]] },
    ]);
    const table = parseXlsx(file, DEFAULT_TABLE_LIMITS);
    expect(table.format).toBe("XLSX");
    expect(table.headers).toEqual(["row_reference", "account_reference", "amount", "note"]);
    expect(table.rows).toEqual([
      { line: 2, cells: ["R-1", "0012345", "125.000", "=1+1"] },
      { line: 3, cells: ["R-2", "DEMO-LY-900001", "0.500", "شركة تجريبية <&>"] },
    ]);
  });

  it("returns numeric cells exactly as written and never through a float", () => {
    const sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>amount</t></is></c></row><row r="2"><c r="A2"><v>0.30000000000000004</v></c></row><row r="3"><c r="A3" t="n"><v>1.25E+2</v></c></row></sheetData></worksheet>`;
    const table = parseXlsx(workbook({ sheetXml: sheet }), DEFAULT_TABLE_LIMITS);
    // The feature's decimal validation then rejects both values; nothing is rounded here.
    expect(table.rows.map((row) => row.cells[0])).toEqual(["0.30000000000000004", "1.25E+2"]);
  });

  it("reads shared strings and ignores phonetic text", () => {
    const sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="b"><v>1</v></c></row></sheetData></worksheet>`;
    const shared = `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>code</t></si><si><t>active</t></si><si><r><t>EMP-</t></r><r><t>001</t></r><rPh><t>ignored</t></rPh></si></sst>`;
    const table = parseXlsx(workbook({ sheetXml: sheet, extra: { "xl/sharedStrings.xml": shared } }), DEFAULT_TABLE_LIMITS);
    expect(table.headers).toEqual(["code", "active"]);
    expect(table.rows[0]?.cells).toEqual(["EMP-001", "true"]);
  });

  it("rejects a formula cell even when a cached value is present", () => {
    const sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>amount</t></is></c></row><row r="2"><c r="A2"><f>100+25</f><v>125</v></c></row></sheetData></worksheet>`;
    let caught: ImportFileError | null = null;
    try {
      parseXlsx(workbook({ sheetXml: sheet }), DEFAULT_TABLE_LIMITS);
    } catch (error) {
      caught = error as ImportFileError;
    }
    expect(caught?.code).toBe("FORMULA");
    expect(caught?.line).toBe(2);
    expect(caught?.cell).toBe("A2");
    expect(codeOf(() => parseXlsx(workbook({ extra: { "xl/calcChain.xml": "<calcChain/>" } }), DEFAULT_TABLE_LIMITS))).toBe("FORMULA");
  });

  it("rejects macros, external links, embedded objects and unknown parts", () => {
    expect(codeOf(() => parseXlsx(workbook({ extra: { "xl/vbaProject.bin": "macro" } }), DEFAULT_TABLE_LIMITS))).toBe("MACRO");
    expect(codeOf(() => parseXlsx(workbook({ contentTypes: `<Types><Override ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>` }), DEFAULT_TABLE_LIMITS))).toBe("MACRO");
    expect(codeOf(() => parseXlsx(workbook({ extra: { "xl/externalLinks/externalLink1.xml": "<x/>" } }), DEFAULT_TABLE_LIMITS))).toBe("EXTERNAL_LINK");
    expect(
      codeOf(() =>
        parseXlsx(
          workbook({
            rels: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="hyperlink" Target="https://example.invalid/" TargetMode="External"/></Relationships>`,
          }),
          DEFAULT_TABLE_LIMITS,
        ),
      ),
    ).toBe("EXTERNAL_LINK");
    expect(codeOf(() => parseXlsx(workbook({ workbookXml: `<workbook><externalReferences><externalReference/></externalReferences><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>` }), DEFAULT_TABLE_LIMITS))).toBe("EXTERNAL_LINK");
    expect(codeOf(() => parseXlsx(workbook({ extra: { "xl/embeddings/oleObject1.bin": "x" } }), DEFAULT_TABLE_LIMITS))).toBe("EMBEDDED_OBJECT");
    expect(codeOf(() => parseXlsx(workbook({ extra: { "xl/drawings/drawing1.xml": "<x/>" } }), DEFAULT_TABLE_LIMITS))).toBe("EMBEDDED_OBJECT");
    expect(codeOf(() => parseXlsx(workbook({ extra: { "payload.exe": "x" } }), DEFAULT_TABLE_LIMITS))).toBe("EMBEDDED_OBJECT");
  });

  it("refuses a document type declaration and never expands entities", () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE worksheet [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&b;</t></is></c></row></sheetData></worksheet>`;
    expect(codeOf(() => parseXlsx(workbook({ sheetXml: bomb }), DEFAULT_TABLE_LIMITS))).toBe("MALFORMED");
    expect(codeOf(() => parseXlsx(workbook({ sheetXml: "<worksheet><sheetData><row></sheetData>" }), DEFAULT_TABLE_LIMITS))).toBe("MALFORMED");
  });

  it("caps the DECOMPRESSED size on real inflated bytes", () => {
    // ~2 MiB of one repeated character compresses to a few kilobytes.
    const padding = "A".repeat(2 * 1024 * 1024);
    const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>h</t></is></c></row></sheetData><!--${padding}--></worksheet>`;
    const file = workbook({ sheetXml: sheet });
    expect(file.byteLength).toBeLessThan(64 * 1024);
    const small: TableLimits = { ...DEFAULT_TABLE_LIMITS, maxDecompressedBytes: 1024 * 1024 };
    expect(codeOf(() => parseXlsx(file, small))).toBe("IMPORT_TOO_LARGE");
    expect(parseXlsx(file, DEFAULT_TABLE_LIMITS).headers).toEqual(["h"]);
    // The compressed upload size is checked before anything is inflated.
    expect(codeOf(() => parseXlsx(file, { ...DEFAULT_TABLE_LIMITS, maxBytes: 1_000 }))).toBe("IMPORT_TOO_LARGE");
  });

  it("enforces sheet, row, column and cell bounds and the Data sheet rule", () => {
    const rows = (count: number) => [["h"], ...Array.from({ length: count }, (_value, index) => [`v${index}`])];
    const limits: TableLimits = { ...DEFAULT_TABLE_LIMITS, maxRows: 5 };
    expect(parseXlsx(writeXlsx([{ name: "Data", rows: rows(5) }]), limits).rows).toHaveLength(5);
    expect(codeOf(() => parseXlsx(writeXlsx([{ name: "Data", rows: rows(6) }]), limits))).toBe("IMPORT_TOO_LARGE");
    expect(codeOf(() => parseXlsx(writeXlsx([{ name: "Data", rows: [["h"], ["x".repeat(50)]] }]), { ...DEFAULT_TABLE_LIMITS, maxCellChars: 20 }))).toBe("IMPORT_TOO_LARGE");
    expect(codeOf(() => parseXlsx(writeXlsx([{ name: "Data", rows: [["a", "b", "c"], ["1", "2", "3"]] }]), { ...DEFAULT_TABLE_LIMITS, maxColumns: 2 }))).toBe("MALFORMED");
    expect(codeOf(() => parseXlsx(writeXlsx([{ name: "Data", rows: [["a"], ["1", "stray"]] }]), DEFAULT_TABLE_LIMITS))).toBe("MALFORMED");
    const noData = workbook({ workbookXml: `<workbook xmlns:r="r"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>` });
    expect(codeOf(() => parseXlsx(noData, DEFAULT_TABLE_LIMITS))).toBe("MISSING_HEADER");
    const three = workbook({ workbookXml: `<workbook xmlns:r="r"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Instructions" sheetId="2" r:id="rId1"/><sheet name="More" sheetId="3" r:id="rId1"/></sheets></workbook>` });
    expect(codeOf(() => parseXlsx(three, DEFAULT_TABLE_LIMITS))).toBe("MALFORMED");
    expect(codeOf(() => parseXlsx(text("not a zip"), DEFAULT_TABLE_LIMITS))).toBe("UNSUPPORTED_FILE");
    expect(codeOf(() => parseXlsx(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]), DEFAULT_TABLE_LIMITS))).not.toBe("NO_ERROR");
  });
});

describe("CSV export is not an executable spreadsheet (I-41)", () => {
  it("neutralises cells a spreadsheet would evaluate, but keeps plain signed numbers", () => {
    expect(neutralizeFormula("=HYPERLINK(\"https://example.invalid\")")).toBe("'=HYPERLINK(\"https://example.invalid\")");
    expect(neutralizeFormula("+218912345678")).toBe("'+218912345678");
    expect(neutralizeFormula("-cmd|' /C calc'!A0")).toBe("'-cmd|' /C calc'!A0");
    expect(neutralizeFormula("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(neutralizeFormula("\tTab start")).toBe("'\tTab start");
    expect(neutralizeFormula("-125.000")).toBe("-125.000");
    expect(neutralizeFormula("125.000")).toBe("125.000");
    expect(neutralizeFormula("Demo Co")).toBe("Demo Co");
  });

  it("writes RFC 4180 output with a BOM that reads back unchanged apart from neutralisation", () => {
    const bytes = toCsv(["code", "name", "amount"], [["=1+1", 'Quote "Demo", Ltd', "-10.500"], ["C-2", "شركة\nتجريبية", 125n], [null, "x\u0000y", undefined]]);
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const table = parseCsv(bytes, DEFAULT_TABLE_LIMITS);
    expect(table.headers).toEqual(["code", "name", "amount"]);
    expect(table.rows.map((row) => row.cells)).toEqual([
      ["'=1+1", 'Quote "Demo", Ltd', "-10.500"],
      ["C-2", "شركة\nتجريبية", "125"],
      ["", "xy", ""],
    ]);
  });
});

describe("private storage", () => {
  const dir = mkdtempSync(join(tmpdir(), "alqarib-storage-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const id = "019a0000-0000-7000-8000-000000000001";

  it("stores and reads back by a generated key only", async () => {
    const stored = await putPrivateFile(dir, "reports", id, "csv", text("a,b\n"));
    expect(stored.key).toBe(`reports/01/${id}.csv`);
    expect(stored.sizeBytes).toBe(4);
    expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new TextDecoder().decode(await readPrivateFile(dir, stored.key))).toBe("a,b\n");
  });

  it("refuses keys that are not its own, including traversal", async () => {
    for (const key of ["../etc/passwd", "reports/../../secret.csv", "/etc/passwd", "reports/01/../../x.csv", "public/01/x.csv", `reports/01/${id}.csv/..`]) {
      await expect(readPrivateFile(dir, key)).rejects.toThrow("Invalid storage key");
    }
    await expect(putPrivateFile(dir, "reports", "../../x", "csv", text("x"))).rejects.toThrow();
    await expect(putPrivateFile(dir, "reports", id, "c/../sv", text("x"))).rejects.toThrow();
  });

  it("builds download names that cannot break the header", () => {
    expect(safeFileName('report"\r\nSet-Cookie: x=1')).toBe("report-Set-Cookie-x-1");
    expect(safeFileName("../../etc/passwd")).toBe("etc-passwd");
    expect(safeFileName("كشف")).toBe("download");
    const response = downloadResponse(text("a"), "csv", 'statement"; filename="evil.exe');
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="statement-filename-evil.csv"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("PDF text order (P-09)", () => {
  const texts = (line: string, direction: "ltr" | "rtl") => visualRuns(line, direction).map((run) => run.text);

  it("orders a mixed Arabic line visually while keeping references and amounts left-to-right", () => {
    expect(texts("المرجع DEP-QTD-2026-000001 بمبلغ LYD 1,250.000", "rtl")).toEqual(["LYD", " ", "1,250.000", " ", "بمبلغ", " ", "DEP-QTD-2026-000001", " ", "المرجع"]);
    expect(texts("Paid to شركة القريب today", "ltr")).toEqual(["Paid", " ", "to", " ", "القريب", " ", "شركة", " ", "today"]);
    expect(texts("LYD 125.000", "rtl")).toEqual(["LYD", " ", "125.000"]);
  });

  it("mirrors brackets inside right-to-left text explicitly", () => {
    expect(visualRuns("شركة (تجريبي)", "rtl")).toEqual([
      { text: "(", rtl: false },
      { text: "تجريبي", rtl: true },
      { text: ")", rtl: false },
      { text: " ", rtl: true },
      { text: "شركة", rtl: true },
    ]);
    // Brackets around left-to-right content keep their shape and order.
    expect(texts("النور (CUST-001)", "rtl")).toEqual(["(", "CUST-001", ")", " ", "النور"]);
    expect(texts("Demo (CUST-001)", "ltr")).toEqual(["Demo", " ", "(CUST-001)"]);
  });

  it("produces a PDF in both languages with the simulated stamp", async () => {
    for (const locale of ["en", "ar"] as const) {
      const pdf = new PdfBuilder({ locale, title: locale === "ar" ? "إيصال إيداع" : "Deposit receipt", simulatedStamp: "SIMULATED", meta: ["Bank time (Africa/Tripoli)"] });
      pdf.keyValues([{ label: locale === "ar" ? "المبلغ" : "Amount", value: "LYD 1,250.000", strong: true }]);
      pdf.table([{ header: "A", width: 1 }, { header: "B", width: 1, align: "end" }], Array.from({ length: 80 }, (_value, index) => [`row ${index}`, "LYD 1.000"]));
      const bytes = await pdf.finish();
      expect(new TextDecoder("latin1").decode(bytes.slice(0, 5))).toBe("%PDF-");
      expect(bytes.byteLength).toBeGreaterThan(5_000);
    }
  });
});
