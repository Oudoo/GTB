import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { MESSAGES } from "./messages";
import { routing } from "./routing";

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  return {
    locale,
    messages: MESSAGES[locale],
    // Dates and schedules are shown in the bank's time zone, never the device's (document 05).
    timeZone: process.env["BANK_TIMEZONE"] ?? "Africa/Tripoli",
  };
});
