/**
 * PDF documents with correct Arabic rendering (RPT-01, COL-03, document 12 P-09).
 *
 * pdfkit shapes Arabic letters (joining forms) through its font engine but does NOT apply the
 * Unicode bidirectional algorithm: a mixed line such as "المرجع DEP-1 بمبلغ LYD 5.000" would
 * be laid out left-to-right in logical order. This module therefore
 *   1. breaks text into lines in LOGICAL order,
 *   2. resolves embedding levels with `bidi-js` (UAX #9) for the paragraph direction,
 *   3. places each word-sized run in VISUAL order, with paired punctuation inside
 *      right-to-left text mirrored explicitly (not left to a font feature),
 * and uses an Arabic font for right-to-left runs and a Latin font for everything else. Fonts
 * are bundled OFL files; nothing is fetched at run time. Amounts, references and dates are
 * ordinary left-to-right runs, so digits are never reversed.
 *
 * Every generated document carries a visible "simulated" stamp: this sandbox must never
 * produce something that could pass for an official bank document.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import bidiFactory from "bidi-js";
import PDFDocument from "pdfkit";

export type PdfLocale = "en" | "ar";
type FontKey = "latin" | "latinBold" | "arabic" | "arabicBold";

const FONT_FILES: Record<FontKey, string> = {
  latin: "Inter-Regular.otf",
  latinBold: "Inter-SemiBold.otf",
  arabic: "NotoSansArabic-Regular.ttf",
  arabicBold: "NotoSansArabic-Bold.ttf",
};

const fontCache = new Map<FontKey, Buffer>();
function fontData(key: FontKey): Buffer {
  let data = fontCache.get(key);
  if (!data) {
    data = readFileSync(join(process.cwd(), "src/assets/fonts", FONT_FILES[key]));
    fontCache.set(key, data);
  }
  return data;
}

const bidi = bidiFactory();

export type VisualRun = { text: string; rtl: boolean };

const SPACE = /^\s+$/u;

/**
 * Visual-order runs of one line (UAX #9). Each run is a word or a stretch of whitespace with
 * one direction; right-to-left runs keep their characters in logical order (the font engine
 * reverses and joins glyphs inside a word) with paired punctuation already mirrored.
 */
export function visualRuns(line: string, direction: "ltr" | "rtl"): VisualRun[] {
  if (line.length === 0) return [];
  const levels = bidi.getEmbeddingLevels(line, direction).levels;
  // Paired punctuation inside a right-to-left stretch is drawn as its own single-character run
  // with the mirrored character chosen here, so the result does not depend on whether a font
  // happens to carry a mirroring feature.
  const mirrorOf = (index: number): string | null => ((levels[index] as number) % 2 === 1 ? bidi.getMirroredCharacter(line[index] as string) : null);

  // Logical runs: maximal stretches with the same level, split again at whitespace edges.
  type Logical = { start: number; end: number; level: number; mirrored: string | null };
  const logical: Logical[] = [];
  let start = 0;
  for (let i = 1; i <= line.length; i += 1) {
    const boundary =
      i === line.length ||
      levels[i] !== levels[start] ||
      SPACE.test(line[i] as string) !== SPACE.test(line[start] as string) ||
      mirrorOf(i) !== null ||
      mirrorOf(start) !== null;
    if (boundary) {
      logical.push({ start, end: i, level: levels[start] as number, mirrored: i - start === 1 ? mirrorOf(start) : null });
      start = i;
    }
  }

  // Rule L2: from the highest level down to the lowest odd level, reverse every contiguous
  // sequence of runs at that level or higher.
  const order = logical.map((_run, index) => index);
  const highest = Math.max(...logical.map((run) => run.level));
  const lowestOdd = Math.min(...logical.filter((run) => run.level % 2 === 1).map((run) => run.level), highest + 1);
  for (let level = highest; level >= lowestOdd; level -= 1) {
    let i = 0;
    while (i < order.length) {
      if ((logical[order[i] as number] as Logical).level >= level) {
        let j = i;
        while (j + 1 < order.length && (logical[order[j + 1] as number] as Logical).level >= level) j += 1;
        for (let a = i, b = j; a < b; a += 1, b -= 1) {
          const swap = order[a] as number;
          order[a] = order[b] as number;
          order[b] = swap;
        }
        i = j + 1;
      } else {
        i += 1;
      }
    }
  }

  return order.map((index) => {
    const run = logical[index] as Logical;
    // A mirrored bracket is a plain left-to-right glyph once its character has been chosen.
    if (run.mirrored !== null) return { text: run.mirrored, rtl: false };
    return { text: line.slice(run.start, run.end), rtl: run.level % 2 === 1 };
  });
}

export type PdfOptions = {
  locale: PdfLocale;
  title: string;
  subtitle?: string;
  /** Always printed on every page. */
  simulatedStamp: string;
  /** Small print under the title, e.g. generation time and requesting scope. */
  meta?: string[];
  footer?: string;
};

export type PdfColumn = { header: string; width: number; align?: "start" | "end"; mono?: boolean };

const PAGE = { width: 595.28, height: 841.89, margin: 40 };
const INK = "#10233f";
const MUTED = "#5b6b82";
const LINE = "#d5dbe5";
const STAMP = "#6b3fa0";

/**
 * Small direction-aware document builder: title block, label/value pairs and tables. In
 * Arabic the whole layout is mirrored (start = right) and every string goes through
 * `visualRuns`.
 */
export class PdfBuilder {
  private readonly doc: PDFKit.PDFDocument;
  private readonly chunks: Buffer[] = [];
  private readonly done: Promise<Uint8Array>;
  private readonly rtl: boolean;
  private y = PAGE.margin;
  private readonly contentWidth = PAGE.width - PAGE.margin * 2;

  constructor(private readonly options: PdfOptions) {
    this.rtl = options.locale === "ar";
    this.doc = new PDFDocument({
      size: "A4",
      margin: PAGE.margin,
      autoFirstPage: false,
      info: { Title: options.title, Producer: "Al Qarib sandbox", Creator: "Al Qarib sandbox" },
      lang: options.locale,
    });
    for (const key of Object.keys(FONT_FILES) as FontKey[]) this.doc.registerFont(key, fontData(key));
    this.doc.on("data", (chunk: Buffer) => this.chunks.push(chunk));
    this.done = new Promise((resolve, reject) => {
      this.doc.on("end", () => resolve(new Uint8Array(Buffer.concat(this.chunks))));
      this.doc.on("error", reject);
    });
    this.newPage();
    this.text(options.title, { size: 18, bold: true });
    if (options.subtitle) this.text(options.subtitle, { size: 11, color: MUTED });
    for (const line of options.meta ?? []) this.text(line, { size: 9, color: MUTED });
    this.gap(8);
    this.rule();
  }

  private newPage(): void {
    this.doc.addPage();
    this.y = PAGE.margin;
    // The stamp is drawn first so content can never hide it.
    this.drawLine(this.options.simulatedStamp, PAGE.margin, PAGE.margin - 22, this.contentWidth, { size: 8, bold: true, color: STAMP, align: "end" });
    if (this.options.footer) {
      this.drawLine(this.options.footer, PAGE.margin, PAGE.height - PAGE.margin + 8, this.contentWidth, { size: 8, color: MUTED, align: "start" });
    }
  }

  private ensure(height: number): void {
    if (this.y + height > PAGE.height - PAGE.margin) this.newPage();
  }

  private font(rtl: boolean, bold: boolean): FontKey {
    return rtl ? (bold ? "arabicBold" : "arabic") : bold ? "latinBold" : "latin";
  }

  private widthOf(run: VisualRun, size: number, bold: boolean): number {
    this.doc.font(this.font(run.rtl, bold)).fontSize(size);
    return this.doc.widthOfString(run.text);
  }

  /** Break into lines in logical order, measuring each word with the font it will use. */
  private wrap(text: string, width: number, size: number, bold: boolean): string[] {
    const lines: string[] = [];
    for (const paragraph of text.split(/\r?\n/)) {
      const words = paragraph.split(/(\s+)/u).filter((part) => part.length > 0);
      let current = "";
      let currentWidth = 0;
      for (const word of words) {
        const rtlWord = bidi.getEmbeddingLevels(word, this.rtl ? "rtl" : "ltr").levels.some((level) => level % 2 === 1);
        const wordWidth = this.widthOf({ text: word, rtl: rtlWord }, size, bold);
        if (current.length > 0 && currentWidth + wordWidth > width && !SPACE.test(word)) {
          lines.push(current.trimEnd());
          current = "";
          currentWidth = 0;
        }
        if (current.length === 0 && SPACE.test(word)) continue;
        current += word;
        currentWidth += wordWidth;
      }
      lines.push(current.trimEnd());
    }
    return lines;
  }

  /** Draw one already-wrapped line inside a box, in visual order. */
  private drawLine(
    line: string,
    x: number,
    y: number,
    width: number,
    style: { size: number; bold?: boolean; color?: string; align?: "start" | "end" },
  ): void {
    const bold = style.bold ?? false;
    const runs = visualRuns(line, this.rtl ? "rtl" : "ltr");
    const total = runs.reduce((sum, run) => sum + this.widthOf(run, style.size, bold), 0);
    const startSide = this.rtl ? "right" : "left";
    const side = (style.align ?? "start") === "start" ? startSide : startSide === "left" ? "right" : "left";
    let cursor = side === "left" ? x : x + width - total;
    this.doc.fillColor(style.color ?? INK);
    // Latin and Arabic fonts have different ascenders: every run of a line is placed on one
    // shared alphabetic baseline, otherwise references and amounts float above Arabic words.
    const baseline = y + style.size * 0.95;
    for (const run of runs) {
      const runWidth = this.widthOf(run, style.size, bold);
      if (!SPACE.test(run.text)) {
        this.doc.font(this.font(run.rtl, bold)).fontSize(style.size).text(run.text, cursor, baseline, { lineBreak: false, baseline: "alphabetic" });
      }
      cursor += runWidth;
    }
  }

  private lineHeight(size: number): number {
    return Math.round(size * 1.55);
  }

  text(value: string, style: { size?: number; bold?: boolean; color?: string; align?: "start" | "end" } = {}): this {
    const size = style.size ?? 10;
    for (const line of this.wrap(value, this.contentWidth, size, style.bold ?? false)) {
      this.ensure(this.lineHeight(size));
      this.drawLine(line, PAGE.margin, this.y, this.contentWidth, { ...style, size });
      this.y += this.lineHeight(size);
    }
    return this;
  }

  gap(points = 6): this {
    this.y += points;
    return this;
  }

  rule(): this {
    this.ensure(8);
    this.doc.moveTo(PAGE.margin, this.y).lineTo(PAGE.width - PAGE.margin, this.y).lineWidth(0.7).strokeColor(LINE).stroke();
    this.y += 8;
    return this;
  }

  heading(value: string): this {
    this.gap(6);
    return this.text(value, { size: 12, bold: true });
  }

  /** Label/value pairs: label at the start edge, value at the end edge of the same row. */
  keyValues(rows: Array<{ label: string; value: string; strong?: boolean }>): this {
    const labelWidth = this.contentWidth * 0.38;
    const valueWidth = this.contentWidth - labelWidth - 10;
    for (const row of rows) {
      const size = row.strong ? 12 : 10;
      const valueLines = this.wrap(row.value, valueWidth, size, row.strong ?? false);
      const labelLines = this.wrap(row.label, labelWidth, 10, false);
      const height = Math.max(valueLines.length, labelLines.length) * this.lineHeight(size) + 4;
      this.ensure(height);
      const labelX = this.rtl ? PAGE.margin + valueWidth + 10 : PAGE.margin;
      const valueX = this.rtl ? PAGE.margin : PAGE.margin + labelWidth + 10;
      labelLines.forEach((line, index) => this.drawLine(line, labelX, this.y + index * this.lineHeight(size), labelWidth, { size: 10, color: MUTED }));
      valueLines.forEach((line, index) =>
        this.drawLine(line, valueX, this.y + index * this.lineHeight(size), valueWidth, { size, bold: row.strong ?? false, align: "end" }),
      );
      this.y += height;
    }
    return this;
  }

  /** A simple grid. Column widths are fractions of the content width. */
  table(columns: PdfColumn[], rows: string[][]): this {
    const totalWeight = columns.reduce((sum, column) => sum + column.width, 0);
    const widths = columns.map((column) => (column.width / totalWeight) * this.contentWidth);
    const xs: number[] = [];
    let offset = 0;
    for (const width of widths) {
      // In Arabic the first column sits at the right edge.
      xs.push(this.rtl ? PAGE.margin + this.contentWidth - offset - width : PAGE.margin + offset);
      offset += width;
    }
    const pad = 4;
    const drawRow = (cells: string[], header: boolean) => {
      const size = header ? 8.5 : 9;
      const wrapped = cells.map((cell, index) => this.wrap(cell, (widths[index] as number) - pad * 2, size, header));
      const height = Math.max(...wrapped.map((lines) => lines.length)) * this.lineHeight(size) + pad;
      if (this.y + height > PAGE.height - PAGE.margin) {
        this.newPage();
        if (!header) drawRow(columns.map((column) => column.header), true);
      }
      wrapped.forEach((lines, index) => {
        const column = columns[index] as PdfColumn;
        lines.forEach((line, lineIndex) =>
          this.drawLine(line, (xs[index] as number) + pad, this.y + lineIndex * this.lineHeight(size), (widths[index] as number) - pad * 2, {
            size,
            bold: header,
            color: header ? MUTED : INK,
            align: column.align ?? "start",
          }),
        );
      });
      this.y += height;
      this.doc.moveTo(PAGE.margin, this.y).lineTo(PAGE.width - PAGE.margin, this.y).lineWidth(0.5).strokeColor(LINE).stroke();
      this.y += pad;
    };
    drawRow(columns.map((column) => column.header), true);
    for (const row of rows) drawRow(row, false);
    return this;
  }

  async finish(): Promise<Uint8Array> {
    this.doc.end();
    return this.done;
  }
}
