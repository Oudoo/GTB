import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_MINOR,
  MoneyError,
  addMoney,
  compareMoney,
  formatMinor,
  formatMinorGrouped,
  formatMoney,
  money,
  moneyFromJson,
  moneyJsonSchema,
  moneyToJson,
  parseDecimalAmount,
  parseMinorString,
  parseUserAmount,
  positiveMoneyJsonSchema,
  subtractMoney,
  sumMoney,
} from "@/contracts/money";

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof MoneyError ? error.code : `unexpected:${String(error)}`;
  }
  return undefined;
};

describe("U-MON-01 LYD has exactly three decimals", () => {
  it("represents LYD 0.001 as one minor unit", () => {
    expect(parseDecimalAmount("0.001", "LYD")).toBe(1n);
    expect(formatMinor(1n, "LYD")).toBe("0.001");
  });

  it("uses two decimals for USD/EUR (dictionary only; R1 posts LYD)", () => {
    expect(parseDecimalAmount("0.01", "USD")).toBe(1n);
    expect(formatMinor(1n, "EUR")).toBe("0.01");
  });
});

describe("U-MON-02 LYD 125.000 round trip", () => {
  it("parses, serializes and formats without loss", () => {
    const minor = parseDecimalAmount("125.000", "LYD");
    expect(minor).toBe(125000n);
    const value = money("LYD", minor);
    expect(moneyToJson(value)).toEqual({ currency: "LYD", minor: "125000" });
    expect(moneyFromJson(moneyJsonSchema.parse({ currency: "LYD", minor: "125000" }))).toEqual(value);
    expect(formatMoney(value)).toBe("LYD 125.000");
  });

  it("JSON minor 125000 is LYD 125.000, never 125,000 dinars", () => {
    expect(formatMoney(money("LYD", parseMinorString("125000")))).toBe("LYD 125.000");
    expect(formatMinorGrouped(100000000n, "LYD")).toBe("100,000.000");
  });

  it("accepts short decimal forms as exact values", () => {
    expect(parseDecimalAmount("125", "LYD")).toBe(125000n);
    expect(parseDecimalAmount("125.5", "LYD")).toBe(125500n);
    expect(parseDecimalAmount("0.5", "LYD")).toBe(500n);
  });

  it("property: format → parse is the identity for every representable amount", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MAX_MINOR }), (minor) => {
        expect(parseDecimalAmount(formatMinor(minor, "LYD"), "LYD")).toBe(minor);
        expect(parseMinorString(minor.toString())).toBe(minor);
      }),
    );
  });
});

describe("U-MON-03 rejects zero, negative and malformed machine amounts", () => {
  it("rejects a non-positive payment amount at the wire schema", () => {
    expect(positiveMoneyJsonSchema.safeParse({ currency: "LYD", minor: "0" }).success).toBe(false);
    expect(positiveMoneyJsonSchema.safeParse({ currency: "LYD", minor: "-5" }).success).toBe(false);
    expect(positiveMoneyJsonSchema.safeParse({ currency: "LYD", minor: "1" }).success).toBe(true);
  });

  it.each(["-1", "+1", "1e3", "1E3", "1,000", "1 000", " 1", "1.0", "01", "", "abc", "0x10", "١٢٣"])(
    "rejects minor string %j",
    (input) => {
      expect(code(() => parseMinorString(input))).toBe("INVALID_AMOUNT_FORMAT");
    },
  );

  it.each(["1e3", "1,000.000", "1 000", "-1", "+1", ".5", "5.", "1.2.3", "", "LYD 5", "0x10", "Infinity", "NaN"])(
    "rejects decimal text %j",
    (input) => {
      expect(code(() => parseDecimalAmount(input, "LYD"))).toBe("INVALID_AMOUNT_FORMAT");
    },
  );

  it("rejects non-string machine input instead of coercing numbers", () => {
    expect(code(() => parseMinorString(125000 as unknown))).toBe("INVALID_AMOUNT_FORMAT");
    expect(code(() => parseDecimalAmount(125.5 as unknown, "LYD"))).toBe("INVALID_AMOUNT_FORMAT");
    expect(moneyJsonSchema.safeParse({ currency: "LYD", minor: 125000 }).success).toBe(false);
  });

  it("rejects unknown wire fields (mass assignment)", () => {
    expect(moneyJsonSchema.safeParse({ currency: "LYD", minor: "1", actorId: "x" }).success).toBe(false);
  });

  it("allows a signed value only where explicitly requested (payroll correction)", () => {
    expect(parseDecimalAmount("-12.500", "LYD", { allowNegative: true })).toBe(-12500n);
    expect(parseMinorString("-12500", { allowNegative: true })).toBe(-12500n);
  });
});

describe("U-MON-04 rejects too many decimal digits", () => {
  it("rejects a fourth LYD decimal rather than rounding", () => {
    expect(code(() => parseDecimalAmount("125.0001", "LYD"))).toBe("TOO_MANY_DECIMALS");
    expect(code(() => parseDecimalAmount("0.0005", "LYD"))).toBe("TOO_MANY_DECIMALS");
    expect(code(() => parseDecimalAmount("1.001", "USD"))).toBe("TOO_MANY_DECIMALS");
  });
});

describe("U-MON-05 rejects out-of-range integers", () => {
  it("rejects values beyond the documented bound", () => {
    expect(code(() => money("LYD", MAX_MINOR + 1n))).toBe("AMOUNT_OUT_OF_RANGE");
    expect(code(() => parseMinorString("9999999999999999"))).toBe("AMOUNT_OUT_OF_RANGE");
    expect(code(() => parseDecimalAmount("9999999999999999", "LYD"))).toBe("AMOUNT_OUT_OF_RANGE");
    expect(code(() => parseMinorString("99999999999999999999"))).toBe("INVALID_AMOUNT_FORMAT");
  });

  it("is exact beyond Number.MAX_SAFE_INTEGER (no float arithmetic)", () => {
    const a = money("LYD", 900_000_000_000_000n);
    const b = money("LYD", 99_999_999_999_999n);
    expect(addMoney(a, b).minor).toBe(999_999_999_999_999n);
    expect(999_999_999_999_999n > BigInt(Number.MAX_SAFE_INTEGER) / 10n).toBe(true);
    expect(formatMinor(999_999_999_999_999n, "LYD")).toBe("999999999999.999");
  });
});

describe("U-MON-06 different currencies are never compared or combined", () => {
  const lyd = money("LYD", 1000n);
  const usd = money("USD", 1000n);

  it("refuses comparison, addition, subtraction and summation across currencies", () => {
    expect(code(() => compareMoney(lyd, usd))).toBe("CURRENCY_MISMATCH");
    expect(code(() => addMoney(lyd, usd))).toBe("CURRENCY_MISMATCH");
    expect(code(() => subtractMoney(lyd, usd))).toBe("CURRENCY_MISMATCH");
    expect(code(() => sumMoney([lyd, usd], "LYD"))).toBe("CURRENCY_MISMATCH");
  });

  it("rejects an unknown currency", () => {
    expect(moneyJsonSchema.safeParse({ currency: "XXX", minor: "1" }).success).toBe(false);
    expect(code(() => money("XXX" as never, 1n))).toBe("UNKNOWN_CURRENCY");
  });

  it("property: sums are conserved exactly", () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 0n, max: 10n ** 12n }), { maxLength: 50 }), (parts) => {
        const total = sumMoney(
          parts.map((minor) => money("LYD", minor)),
          "LYD",
        );
        expect(total.minor).toBe(parts.reduce((acc, value) => acc + value, 0n));
      }),
    );
  });
});

describe("user-typed amounts (MOB-05)", () => {
  it("accepts Western and Arabic-Indic digits with one decimal separator", () => {
    expect(parseUserAmount("125.000", "LYD")).toBe(125000n);
    expect(parseUserAmount(" 125.5 ", "LYD")).toBe(125500n);
    expect(parseUserAmount("١٢٥٫٥٠٠", "LYD")).toBe(125500n);
    expect(parseUserAmount("۱۲۵", "LYD")).toBe(125000n);
  });

  it("refuses to guess grouping separators", () => {
    expect(code(() => parseUserAmount("125,000", "LYD"))).toBe("INVALID_AMOUNT_FORMAT");
    expect(code(() => parseUserAmount("1,250.000", "LYD"))).toBe("INVALID_AMOUNT_FORMAT");
    expect(code(() => parseUserAmount("١٬٢٥٠", "LYD"))).toBe("INVALID_AMOUNT_FORMAT");
  });
});
