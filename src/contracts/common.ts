/** Shared wire-level field rules (Appendix A of document 02). */
import { z } from "zod";

/** C0/C1 control characters, NUL, and invisible bidirectional/zero-width controls. */
const CONTROL_OR_HIDDEN = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/;

export function hasUnsafeCharacters(value: string): boolean {
  return CONTROL_OR_HIDDEN.test(value);
}

/** Free text shown to people: trimmed, bounded, no control or hidden direction characters. */
export function safeText(min: number, max: number) {
  return z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !hasUnsafeCharacters(value), "contains control or hidden characters");
}

/** Codes and references: printable ASCII without spaces at the edges, max 64 by default. */
export function safeCode(max = 64) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 ._\-\/#]*$/, "use letters, digits, space and . _ - / # only");
}

export const uuidSchema = z.uuid();
export const localDateSchema = z.iso.date();
export const instantSchema = z.iso.datetime({ offset: true });

export const pageQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const idParamSchema = z.strictObject({ id: z.uuid() });

export const reasonSchema = safeText(3, 500);

/** Sandbox account reference format. NOT an IBAN and not a CBL standard (PAY-01). */
export const DEMO_ACCOUNT_SCHEME = "DEMO_DOMESTIC";
export const DEMO_ACCOUNT_PATTERN = /^DEMO-LY-[0-9]{6}$/;

export function normalizeAccountReference(value: string): string {
  return value.trim().toUpperCase();
}

export const accountSchemeSchema = z.literal(DEMO_ACCOUNT_SCHEME);
export const accountReferenceSchema = z
  .string()
  .trim()
  .transform(normalizeAccountReference)
  .refine((value) => DEMO_ACCOUNT_PATTERN.test(value), "use the sandbox format DEMO-LY-000000");

/** Mask an account reference for display: DEMO-LY-900001 → DEMO-LY-••0001. */
export function maskAccountReference(reference: string): string {
  if (reference.length <= 4) return "••••";
  const head = reference.slice(0, Math.max(0, reference.length - 6));
  return `${head}••${reference.slice(-4)}`;
}
