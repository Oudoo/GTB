import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { notFound } from "next/navigation";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { directionOf, routing } from "@/i18n/routing";
import { PwaRuntime } from "@/pwa/pwa-runtime";
import "../globals.css";

// Bundled, OFL-licensed fonts (licences in src/assets/fonts). No external font CDN.
const inter = localFont({
  src: [
    { path: "../../assets/fonts/inter-latin-wght-normal.woff2", weight: "100 900", style: "normal" },
    { path: "../../assets/fonts/inter-latin-ext-wght-normal.woff2", weight: "100 900", style: "normal" },
  ],
  variable: "--font-inter",
  display: "swap",
});

const notoArabic = localFont({
  src: [{ path: "../../assets/fonts/noto-sans-arabic-arabic-wght-normal.woff2", weight: "100 900", style: "normal" }],
  variable: "--font-arabic",
  display: "swap",
});

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale: hasLocale(routing.locales, locale) ? locale : "en", namespace: "common" });
  return {
    title: { default: t("brand.full"), template: `%s · ${t("brand.name")}` },
    description: t("sandbox.explain"),
    applicationName: "Al Qarib",
    appleWebApp: { capable: true, title: "Al Qarib", statusBarStyle: "default" },
    icons: {
      icon: [
        { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
        { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      ],
      apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    },
    robots: { index: false, follow: false },
    formatDetection: { telephone: false },
  };
}

export const viewport: Viewport = {
  themeColor: "#10233F",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  return (
    <html lang={locale} dir={directionOf(locale)} className={`${inter.variable} ${notoArabic.variable}`}>
      <body className="antialiased">
        <NextIntlClientProvider>
          {children}
          <PwaRuntime />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
