import { defineRouting } from "next-intl/routing";

export const LOCALES = ["en", "ar"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: "always",
  // The locale preference cookie is a non-sensitive UI preference (PWA-04 allows it).
  localeCookie: { name: "alqarib_locale", sameSite: "lax", maxAge: 60 * 60 * 24 * 365 },
});

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export function directionOf(locale: Locale): "ltr" | "rtl" {
  return locale === "ar" ? "rtl" : "ltr";
}
