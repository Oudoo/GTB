/**
 * Private file storage for uploads, generated reports and receipts (document 11, RPT-01).
 *
 * Files live under STORAGE_PATH, outside the public web root. They are addressed by opaque
 * keys this module generates itself — never by a caller-supplied path — and are only ever
 * returned through an authorized download operation. Nothing here is reachable by URL.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { sha256Hex } from "@/server/hash";

export type StorageArea = "uploads" | "reports" | "receipts" | "exports";
export type StoredFile = { key: string; sizeBytes: number; sha256: string };

const KEY_PATTERN = /^(uploads|reports|receipts|exports)\/[0-9a-f]{2}\/[0-9a-f-]{36}\.[a-z0-9]{1,5}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXTENSION = /^[a-z0-9]{1,5}$/;

function pathFor(storagePath: string, key: string): string {
  if (!KEY_PATTERN.test(key)) throw new Error("Invalid storage key");
  const root = resolve(storagePath);
  const target = resolve(root, key);
  // Defence in depth: the pattern already excludes traversal.
  if (!target.startsWith(root + sep)) throw new Error("Invalid storage key");
  return target;
}

/** Store bytes under a key derived from a record id the caller already owns. */
export async function putPrivateFile(storagePath: string, area: StorageArea, id: string, extension: string, data: Uint8Array): Promise<StoredFile> {
  if (!UUID.test(id) || !EXTENSION.test(extension)) throw new Error("Invalid storage identity");
  const key = `${area}/${id.slice(0, 2)}/${id}.${extension}`;
  const target = pathFor(storagePath, key);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, data, { mode: 0o600 });
  return { key, sizeBytes: data.byteLength, sha256: sha256Hex(data) };
}

export async function readPrivateFile(storagePath: string, key: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(pathFor(storagePath, key)));
}

export async function deletePrivateFile(storagePath: string, key: string): Promise<void> {
  await rm(pathFor(storagePath, key), { force: true });
}

const UNSAFE_FILENAME = /[^A-Za-z0-9._-]+/g;

/** A download name that cannot break out of the Content-Disposition header. */
export function safeFileName(name: string, fallback = "download"): string {
  const cleaned = name.normalize("NFKD").replace(UNSAFE_FILENAME, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 100);
  return cleaned.length > 0 ? cleaned : fallback;
}

const CONTENT_TYPES = {
  csv: "text/csv; charset=utf-8",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;

export type DownloadKind = keyof typeof CONTENT_TYPES;

/**
 * An attachment response for an operation's `raw` result. The dispatcher still adds the
 * standard `private, no-store` and security headers, so a download is never cached by the
 * browser, a proxy or the service worker.
 */
export function downloadResponse(data: Uint8Array, kind: DownloadKind, fileName: string): Response {
  const name = safeFileName(fileName.replace(/\.[A-Za-z0-9]+$/, ""), "download");
  return new Response(data as BodyInit, {
    status: 200,
    headers: {
      "content-type": CONTENT_TYPES[kind],
      "content-length": String(data.byteLength),
      "content-disposition": `attachment; filename="${name}.${kind}"`,
      "x-content-type-options": "nosniff",
    },
  });
}
