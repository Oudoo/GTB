import { redirect } from "@/i18n/navigation";
import { isLocale } from "@/i18n/routing";

// The locale root has no content of its own: the workspace router decides where to go.
export default async function LocaleIndex({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect({ href: "/dashboard", locale: isLocale(locale) ? locale : "en" });
}
