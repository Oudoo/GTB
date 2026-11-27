/**
 * Reads back the text drawn in a PDF produced by the application, so a test can assert what a
 * downloaded document does and does not show. Test-only and deliberately small: it understands
 * what pdfkit writes (Flate streams, Type0 fonts with a ToUnicode map, `Tj`/`TJ` operators).
 *
 * The result is the list of text runs in drawing order. Callers that look for one value should
 * search `runs`; callers that look for a phrase should search `joined` (runs concatenated).
 * A right-to-left page draws its runs in visual order, so a multi-word Latin phrase is NOT
 * contiguous there — search for its words.
 */
import { inflateSync } from "node:zlib";

export type PdfText = { runs: string[]; joined: string };

type PdfObject = { dict: string; stream: string | null };

function objectsOf(pdf: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  const pattern = /(\d+) 0 obj\b/g;
  for (let match = pattern.exec(pdf); match; match = pattern.exec(pdf)) {
    const start = match.index + match[0].length;
    const end = pdf.indexOf("endobj", start);
    if (end < 0) break;
    const body = pdf.slice(start, end);
    const streamAt = body.search(/stream\r?\n/);
    if (streamAt < 0) {
      objects.set(Number(match[1]), { dict: body, stream: null });
      continue;
    }
    const dict = body.slice(0, streamAt);
    const dataStart = streamAt + (body.slice(streamAt).match(/^stream\r?\n/) as RegExpMatchArray)[0].length;
    const length = /\/Length (\d+)(?! \d+ R)/.exec(dict);
    const raw = length ? body.slice(dataStart, dataStart + Number(length[1])) : body.slice(dataStart, body.lastIndexOf("endstream"));
    let stream = raw;
    if (dict.includes("/FlateDecode")) {
      try {
        stream = inflateSync(Buffer.from(raw, "latin1")).toString("latin1");
      } catch {
        stream = "";
      }
    }
    objects.set(Number(match[1]), { dict, stream });
    pattern.lastIndex = end;
  }
  return objects;
}

const utf16 = (hex: string): string => {
  let out = "";
  for (let index = 0; index + 4 <= hex.length; index += 4) out += String.fromCharCode(Number.parseInt(hex.slice(index, index + 4), 16));
  return out;
};

/** Glyph code → text, from a ToUnicode CMap. */
function parseCMap(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const entry of (block[1] as string).matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(Number.parseInt(entry[1] as string, 16), utf16(entry[2] as string));
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const entry of (block[1] as string).matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]*>)/g)) {
      const low = Number.parseInt(entry[1] as string, 16);
      const high = Number.parseInt(entry[2] as string, 16);
      const target = entry[3] as string;
      if (target.startsWith("[")) {
        const values = [...target.matchAll(/<([0-9a-fA-F]*)>/g)].map((value) => utf16(value[1] as string));
        for (let code = low; code <= high && code - low < values.length; code += 1) map.set(code, values[code - low] as string);
      } else {
        const first = Number.parseInt(target.slice(1, -1), 16);
        for (let code = low; code <= high; code += 1) map.set(code, String.fromCodePoint(first + (code - low)));
      }
    }
  }
  return map;
}

export function pdfText(bytes: Uint8Array): PdfText {
  const pdf = Buffer.from(bytes).toString("latin1");
  if (!pdf.startsWith("%PDF")) throw new Error("not a PDF");
  const objects = objectsOf(pdf);

  // Font resource name (/F1) → ToUnicode map of that font.
  const fonts = new Map<string, Map<number, string>>();
  for (const object of objects.values()) {
    for (const reference of `${object.dict}${object.stream ?? ""}`.matchAll(/\/(F\d+) (\d+) 0 R/g)) {
      const font = objects.get(Number(reference[2]));
      const toUnicode = font ? /\/ToUnicode (\d+) 0 R/.exec(font.dict) : null;
      const cmap = toUnicode ? objects.get(Number(toUnicode[1])) : null;
      if (cmap?.stream) fonts.set(reference[1] as string, parseCMap(cmap.stream));
    }
  }
  if (fonts.size === 0) throw new Error("no embedded font with a ToUnicode map was found");

  const runs: string[] = [];
  for (const object of objects.values()) {
    const content = object.stream;
    if (!content || !/\bBT\b/.test(content) || content.includes("begincmap")) continue;
    let font: Map<number, string> | undefined;
    // Font selection, array show and simple show, in the order they occur.
    for (const token of content.matchAll(/\/(F\d+) [\d.]+ Tf|\[((?:<[0-9a-fA-F]*>|[^\]])*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g)) {
      if (token[1]) {
        font = fonts.get(token[1]);
        continue;
      }
      const hex = token[2] !== undefined ? [...token[2].matchAll(/<([0-9a-fA-F]*)>/g)].map((part) => part[1] as string).join("") : (token[3] as string);
      if (!font) throw new Error("text drawn before a font was selected");
      let run = "";
      for (let index = 0; index + 4 <= hex.length; index += 4) run += font.get(Number.parseInt(hex.slice(index, index + 4), 16)) ?? "�";
      if (run) runs.push(run);
    }
  }
  return { runs, joined: runs.join("") };
}
