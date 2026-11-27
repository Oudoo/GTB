import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Callout, SandboxPill } from "@/components/ui/primitives";
import { LoginForm } from "@/features/auth/client/login-form";
import { LocaleSwitch } from "@/features/shell/client/shell-client";
import { redirect } from "@/i18n/navigation";
import { resolveSession } from "@/server/auth/session";
import { getDeps } from "@/server/deps";
import { resolveCorrelationId } from "@/server/logging";
import { localeOf } from "@/server/page";
import { headers } from "next/headers";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale: localeOf(locale), namespace: "auth.signIn" });
  return { title: t("title") };
}

export default async function LoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ ended?: string }>;
}) {
  const locale = localeOf((await params).locale);
  const { ended } = await searchParams;
  const deps = await getDeps();
  const requestHeaders = await headers();
  const session = await resolveSession(deps, new Headers({ cookie: requestHeaders.get("cookie") ?? "" }), resolveCorrelationId(null));
  if (session) redirect({ href: "/", locale });
  const t = await getTranslations({ locale });

  return (
    <div className="pt-safe pb-safe mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-5 px-4 py-8">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="grid size-10 place-items-center rounded-[10px] bg-nav">
            <span className="block size-[18px] rounded-full border-[3px] border-[#5fc3cb] border-e-transparent" />
          </span>
          <div className="leading-tight">
            <p className="font-semibold">{t("common.brand.name")}</p>
            <p className="text-sm text-muted">{t("common.brand.product")}</p>
          </div>
        </div>
        <LocaleSwitch label={t("common.labels.language")} />
      </div>

      <main className="rounded-[12px] border border-border bg-surface p-5 shadow-[0_1px_2px_rgb(16_35_63/0.06)] sm:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-xl">{t("auth.signIn.title")}</h1>
            <p className="text-sm text-muted">{t("auth.signIn.subtitle")}</p>
          </div>
          <SandboxPill label={t("common.sandbox.short")} />
        </div>
        {ended ? (
          <div className="mb-4">
            <Callout tone="info" role="status">{t("auth.signIn.sessionEnded")}</Callout>
          </div>
        ) : null}
        <LoginForm />
      </main>

      <Callout tone="sandbox" title={t("common.sandbox.label")}>
        <p>{t("common.sandbox.explain")}</p>
        <p className="mt-1">{t("auth.signIn.sandboxNotice")}</p>
      </Callout>
    </div>
  );
}
