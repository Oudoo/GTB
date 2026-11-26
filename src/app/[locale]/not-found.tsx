import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

export default async function NotFound() {
  const t = await getTranslations("common");
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-start justify-center gap-3 p-6">
      <h1 className="text-2xl">{t("states.notFoundTitle")}</h1>
      <p className="text-muted">{t("states.notFoundBody")}</p>
      <Link
        href="/"
        className="min-touch inline-flex items-center rounded-lg bg-accent px-4 font-semibold text-white hover:bg-accent-strong"
      >
        {t("actions.back")}
      </Link>
    </main>
  );
}
