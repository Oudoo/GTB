import { getTranslations } from "next-intl/server";
import { Card, PageHeader } from "@/components/ui/primitives";
import { LocaleSwitch, SignOutButton } from "@/features/shell/client/shell-client";
import { CORPORATE_NAV, visibleNav } from "@/features/shell/nav";
import { Link } from "@/i18n/navigation";
import { InstallAction } from "@/pwa/install-action";
import { requireCorporatePage } from "@/server/page";

/** The phone "More" destination (MOB-03): every permitted area that is not a primary tab. */
export default async function MorePage({ params }: { params: Promise<{ locale: string }> }) {
  const { ctx, session, locale } = await requireCorporatePage((await params).locale);
  const t = await getTranslations({ locale });
  const items = visibleNav(CORPORATE_NAV, ctx.permissions).filter((item) => !item.mobile);
  const groups = ["cash", "pay", "collect", "control", "administer"];
  return (
    <>
      <PageHeader title={t("corp.more.title")} />
      <div className="flex flex-col gap-4">
        {groups.map((group) => {
          const members = items.filter((item) => item.group === group);
          if (members.length === 0) return null;
          return (
            <Card key={group} as="div">
              <h2 className="px-4 pt-3 text-xs font-semibold tracking-wide text-muted uppercase">{t(`nav.groups.${group}` as Parameters<typeof t>[0])}</h2>
              <ul className="divide-y divide-border">
                {members.map((item) => (
                  <li key={item.key}>
                    <Link href={item.href} className="flex min-h-12 items-center justify-between px-4 py-2 font-medium hover:bg-canvas">
                      {t(`nav.${item.label}` as Parameters<typeof t>[0])}
                      <span aria-hidden="true" className="text-muted rtl:rotate-180">›</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          );
        })}
        <Card as="div" className="flex flex-col gap-2 p-4">
          <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">{t("corp.more.account")}</h2>
          <p className="text-sm">{t("auth.signedInAs", { name: locale === "ar" ? (session.person.nameAr ?? session.person.name) : session.person.name })}</p>
          <div className="flex flex-wrap gap-2">
            <LocaleSwitch label={t("common.labels.language")} />
            <InstallAction variant="full" />
            {session.memberships.length > 1 ? (
              <Link href="/select-workspace" className="min-touch inline-flex items-center rounded-lg border border-border px-3 text-sm font-semibold">
                {t("nav.context.switch")}
              </Link>
            ) : null}
            <SignOutButton className="border border-border" />
          </div>
        </Card>
      </div>
    </>
  );
}
