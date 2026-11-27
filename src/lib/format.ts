/**
 * Display formatting shared by server and client components.
 * Money always shows the currency code, Western digits and "." decimals in both locales
 * (DEC-009). Dates use the selected language but the BANK's time zone, never the device's.
 */
import { formatMinorGrouped, isCurrency, type Currency } from "@/contracts/money";

export type MoneyLike = { currency: string; minor: string };

export function moneyText(value: MoneyLike): string {
  const currency: Currency = isCurrency(value.currency) ? value.currency : "LYD";
  return `${currency} ${formatMinorGrouped(BigInt(value.minor), currency)}`;
}

export function amountText(value: MoneyLike): string {
  const currency: Currency = isCurrency(value.currency) ? value.currency : "LYD";
  return formatMinorGrouped(BigInt(value.minor), currency);
}

const localeTag = (locale: string) => (locale === "ar" ? "ar-LY-u-nu-latn" : "en-GB");

export function formatDateTime(iso: string, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(localeTag(locale), {
    timeZone,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

export function formatDate(isoOrDate: string, locale: string, timeZone: string): string {
  // A plain business date (YYYY-MM-DD) is already a bank-calendar date: format it as UTC noon.
  const plain = /^\d{4}-\d{2}-\d{2}$/.test(isoOrDate);
  return new Intl.DateTimeFormat(localeTag(locale), {
    timeZone: plain ? "UTC" : timeZone,
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).format(new Date(plain ? `${isoOrDate}T12:00:00.000Z` : isoOrDate));
}

export function formatTime(iso: string, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(localeTag(locale), { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

/** "2 h", "3 d" style age for work queues. */
export function ageText(iso: string, now: Date, locale: string): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  const formatter = new Intl.RelativeTimeFormat(localeTag(locale), { numeric: "always", style: "short" });
  if (seconds < 3600) return formatter.format(-Math.max(1, Math.round(seconds / 60)), "minute");
  if (seconds < 86_400) return formatter.format(-Math.round(seconds / 3600), "hour");
  return formatter.format(-Math.round(seconds / 86_400), "day");
}
