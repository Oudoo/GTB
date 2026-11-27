/**
 * Authenticated encryption for secrets the platform must be able to use again (webhook signing
 * secrets). AES-256-GCM under DATA_ENCRYPTION_KEY; a fresh random nonce per value.
 * API tokens are NOT stored this way: only their hash is kept.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

export function sealSecret(key: Uint8Array, plaintext: string): string {
  if (key.byteLength !== 32) throw new Error("Encryption key must be 32 bytes");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, nonce.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}

export function openSecret(key: Uint8Array, sealed: string): string {
  const [version, nonce, tag, body] = sealed.split(":");
  if (version !== VERSION || !nonce || !tag || !body) throw new Error("Unsupported secret format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}
