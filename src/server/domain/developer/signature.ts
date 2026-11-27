/**
 * Webhook signature (document 04). The signature covers the exact raw body:
 *   X-AlQarib-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + rawBody)>
 * `verifyWebhookSignature` is the receiver-side check used by the fixture receiver in tests and
 * reproduced in docs/api/webhooks.md: constant-time comparison and a ±300 second window.
 */
import { hmacSha256Hex, timingSafeEqualHex } from "@/server/hash";

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function signWebhook(secret: string, timestampSeconds: number, rawBody: string): string {
  return `v1=${hmacSha256Hex(secret, `${timestampSeconds}.${rawBody}`)}`;
}

export function verifyWebhookSignature(input: { secret: string; timestampHeader: string | undefined; signatureHeader: string | undefined; rawBody: string; nowSeconds: number }): "OK" | "MISSING_HEADERS" | "STALE_TIMESTAMP" | "BAD_SIGNATURE" {
  if (!input.timestampHeader || !input.signatureHeader || !/^\d{1,12}$/.test(input.timestampHeader)) return "MISSING_HEADERS";
  const timestamp = Number(input.timestampHeader);
  if (Math.abs(input.nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return "STALE_TIMESTAMP";
  const expected = signWebhook(input.secret, timestamp, input.rawBody);
  const given = input.signatureHeader.trim();
  if (given.length !== expected.length) return "BAD_SIGNATURE";
  return timingSafeEqualHex(expected.slice(3), given.slice(3)) && given.startsWith("v1=") ? "OK" : "BAD_SIGNATURE";
}
