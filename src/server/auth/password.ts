import { hash, verify } from "@node-rs/argon2";

/**
 * Argon2id password hashing (SEC-03). Parameters follow the OWASP baseline
 * (19 MiB memory, 2 iterations, 1 lane). The encoded hash carries its own parameters, so they
 * can be raised later without invalidating stored hashes.
 */
const ARGON2ID = 2; // `Algorithm.Argon2id` (an ambient const enum, so its value is spelled out)

const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(encoded: string, password: string): Promise<boolean> {
  try {
    return await verify(encoded, password);
  } catch {
    return false;
  }
}
