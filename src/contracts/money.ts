/**
 * Exact money (MON-01).
 *
 * - Amounts are integer minor units held in `bigint`; there is no floating point anywhere.
 * - LYD has 3 decimal places; USD/EUR (future compatibility only) have 2.
 * - JSON carries `{ currency, minor }` with `minor` as a decimal-free string:
 *   `{ "currency": "LYD", "minor": "125000" }` is LYD 125.000 — never 125,000 dinars.
 * - Values in different currencies are never compared or summed.
 */
import { z } from "zod";

export const CURRENCIES = {
  LYD: { exponent: 3 },
  USD: { exponent: 2 },
  EUR: { exponent: 2 },
} as const;

export type Currency = keyof typeof CURRENCIES;
export type Money = Readonly<{ currency: Currency; minor: bigint }>;

/** R1 posts LYD only; other currencies exist in the dictionary for future compatibility. */
export const POSTING_CURRENCIES: readonly Currency[] = ["LYD"];

/**
 * Business bound for any single stored amount: 10^15 minor units. This is far inside the
 * PostgreSQL BIGINT range, so sums of many rows cannot overflow, and it is enforced again
 * by CHECK constraints in the database.
 */
export const MAX_MINOR = 1_000_000_000_000_000n;

export class MoneyError extends Error {
  constructor(
    public readonly code:
      | "UNKNOWN_CURRENCY"
      | "INVALID_AMOUNT_FORMAT"
      | "TOO_MANY_DECIMALS"
      | "AMOUNT_OUT_OF_RANGE"
      | "AMOUNT_NOT_POSITIVE"
      | "CURRENCY_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "MoneyError";
  }
}

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CURRENCIES, value);
}

export function assertCurrency(value: unknown): Currency {
  if (!isCurrency(value)) throw new MoneyError("UNKNOWN_CURRENCY", "Unknown currency");
  return value;
}

export function exponentOf(currency: Currency): number {
  return CURRENCIES[currency].exponent;
}

function assertRange(minor: bigint): bigint {
  if (minor > MAX_MINOR || minor < -MAX_MINOR) {
    throw new MoneyError("AMOUNT_OUT_OF_RANGE", "Amount is outside the supported range");
  }
  return minor;
}

export function money(currency: Currency, minor: bigint): Money {
  assertCurrency(currency);
  return Object.freeze({ currency, minor: assertRange(minor) });
}

const MINOR_STRING = /^(0|[1-9][0-9]{0,15})$/;
const SIGNED_MINOR_STRING = /^(0|-?[1-9][0-9]{0,15})$/;

/**
 * Parse a machine minor-unit string ("125000"). Rejects signs (unless allowed), decimals,
 * exponent notation, separators, whitespace and leading zeros.
 */
export function parseMinorString(input: unknown, opts: { allowNegative?: boolean } = {}): bigint {
  if (typeof input !== "string") {
    throw new MoneyError("INVALID_AMOUNT_FORMAT", "Minor units must be a string of digits");
  }
  const pattern = opts.allowNegative ? SIGNED_MINOR_STRING : MINOR_STRING;
  if (!pattern.test(input)) {
    throw new MoneyError("INVALID_AMOUNT_FORMAT", "Minor units must be a string of digits");
  }
  return assertRange(BigInt(input));
}

/**
 * Parse a machine decimal amount as used in import templates ("125.000", "0.5", "125").
 * `.` is the only decimal separator; no grouping, exponent, currency symbol or whitespace.
 */
export function parseDecimalAmount(
  input: unknown,
  currency: Currency,
  opts: { allowNegative?: boolean } = {},
): bigint {
  if (typeof input !== "string") {
    throw new MoneyError("INVALID_AMOUNT_FORMAT", "Amount must be decimal text");
  }
  const match = /^(-)?([0-9]{1,16})(?:\.([0-9]+))?$/.exec(input);
  if (!match) throw new MoneyError("INVALID_AMOUNT_FORMAT", "Amount must be plain decimal text");
  const [, sign, whole, fraction = ""] = match;
  if (sign && !opts.allowNegative) {
    throw new MoneyError("INVALID_AMOUNT_FORMAT", "Negative amounts are not allowed here");
  }
  const exponent = exponentOf(currency);
  if (fraction.length > exponent) {
    throw new MoneyError("TOO_MANY_DECIMALS", `${currency} allows at most ${exponent} decimals`);
  }
  const scaled = BigInt(whole as string) * 10n ** BigInt(exponent);
  const frac = fraction.length ? BigInt(fraction.padEnd(exponent, "0")) : 0n;
  const magnitude = scaled + frac;
  return assertRange(sign ? -magnitude : magnitude);
}

const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0;

/**
 * Parse what a person typed into an amount field. Accepts Western or Arabic-Indic digits and
 * one decimal separator ("." or the Arabic decimal separator "٫"). Grouping separators are
 * rejected rather than guessed: with three LYD decimals "125,000" is ambiguous.
 */
export function parseUserAmount(input: string, currency: Currency): bigint {
  let normalized = "";
  for (const ch of input.trim()) {
    const cp = ch.codePointAt(0) as number;
    if (cp >= ARABIC_INDIC_ZERO && cp <= ARABIC_INDIC_ZERO + 9) {
      normalized += String(cp - ARABIC_INDIC_ZERO);
    } else if (cp >= EXTENDED_ARABIC_INDIC_ZERO && cp <= EXTENDED_ARABIC_INDIC_ZERO + 9) {
      normalized += String(cp - EXTENDED_ARABIC_INDIC_ZERO);
    } else if (ch === "٫") {
      normalized += ".";
    } else {
      normalized += ch;
    }
  }
  return parseDecimalAmount(normalized, currency);
}

/** Canonical decimal text without grouping: 125000n LYD → "125.000". */
export function formatMinor(minor: bigint, currency: Currency): string {
  const exponent = exponentOf(currency);
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  return `${negative ? "-" : ""}${whole}${exponent > 0 ? `.${fraction}` : ""}`;
}

/**
 * Display text with thousands grouping: 100000000n LYD → "100,000.000".
 * Western digits and "." decimals are used in both locales so an amount can never be
 * misread; the UI isolates the value with <bdi dir="ltr"> in right-to-left layouts.
 */
export function formatMinorGrouped(minor: bigint, currency: Currency): string {
  const plain = formatMinor(minor, currency);
  const negative = plain.startsWith("-");
  const [whole = "0", fraction] = (negative ? plain.slice(1) : plain).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction !== undefined ? `.${fraction}` : ""}`;
}

/** "LYD 125.000" — the currency label is always explicit. */
export function formatMoney(value: Money): string {
  return `${value.currency} ${formatMinorGrouped(value.minor, value.currency)}`;
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError("CURRENCY_MISMATCH", "Amounts in different currencies cannot be combined");
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.currency, a.minor + b.minor);
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.currency, a.minor - b.minor);
}

/** -1, 0 or 1. Throws for different currencies: there is no cross-currency ordering. */
export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0;
}

export function sumMoney(values: readonly Money[], currency: Currency): Money {
  let total = 0n;
  for (const value of values) {
    if (value.currency !== currency) {
      throw new MoneyError("CURRENCY_MISMATCH", "Mixed currencies cannot be summed");
    }
    total += value.minor;
  }
  return money(currency, total);
}

export function assertPositive(value: Money): Money {
  if (value.minor <= 0n) throw new MoneyError("AMOUNT_NOT_POSITIVE", "Amount must be greater than zero");
  return value;
}

export type MoneyJson = { currency: Currency; minor: string };

export function moneyToJson(value: Money): MoneyJson {
  return { currency: value.currency, minor: value.minor.toString() };
}

export function minorToJson(minor: bigint, currency: string): MoneyJson {
  return { currency: assertCurrency(currency), minor: minor.toString() };
}

/** Wire schema for a non-negative amount. Unknown fields are rejected. */
export const moneyJsonSchema = z.strictObject({
  currency: z.enum(["LYD", "USD", "EUR"]),
  minor: z.string().regex(MINOR_STRING, "minor must be a string of digits without sign or decimals"),
});

export function moneyFromJson(json: z.infer<typeof moneyJsonSchema>): Money {
  return money(json.currency, parseMinorString(json.minor));
}

/** Wire schema for a strictly positive amount (payments, deposits, invoices). */
export const positiveMoneyJsonSchema = moneyJsonSchema.refine((value) => BigInt(value.minor) > 0n, {
  message: "amount must be greater than zero",
  path: ["minor"],
});
