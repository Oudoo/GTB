import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Deterministic JSON for hashing immutable proposals: object keys sorted, bigint as decimal
 * string, Date as ISO string, `undefined` members dropped.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner !== undefined) out[key] = normalize(inner);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Hash of the canonical form — the proposal digest votes are bound to. */
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function hmacSha256Hex(secret: string | Uint8Array, message: string | Uint8Array): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || !/^[0-9a-f]*$/i.test(a) || !/^[0-9a-f]*$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Deterministic UUID for a named synthetic fixture (RFC 9562 version 8, custom).
 * Lets the seed be idempotent and lets tests refer to fixtures by name.
 */
export function fixtureUuid(name: string): string {
  const bytes = createHash("sha256").update(`alqarib-fixture:${name}`).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
