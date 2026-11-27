import { getTranslations } from "next-intl/server";
import { Callout, SandboxPill } from "@/components/ui/primitives";
import { WorkspaceChooser } from "@/features/auth/client/workspace-chooser";
import { SignOutButton } from "@/features/shell/client/shell-client";
import { requireSession } from "@/server/page";

export default async function SelectWorkspacePage({ params }: { params: Promise<{ locale: string }> }) {
  const { session, locale } = await requireSession((await params).locale);
  const t = await getTranslations({ locale });
  const arabic = locale === "ar";
  const options = session.memberships.map((membership) => ({
    id: membership.id,
    kind: membership.kind,
    title:
      membership.kind === "BANK"
        ? (arabic ? membership.bankNameAr : membership.bankName)
        : ((arabic ? membership.corporateNameAr : membership.corporateName) ?? ""),
    subtitle: membership.kind === "BANK" ? t("nav.context.bankWorkspace") : t("nav.context.corporateWorkspace"),
    roles: membership.roles.map((role) => t(`auth.roles.${role}` as Parameters<typeof t>[0])),
    current: session.context?.membershipId === membership.id,
  }));

  return (
    <div className="pt-safe pb-safe mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-5 px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl">{t("nav.context.choose")}</h1>
        <SandboxPill label={t("common.sandbox.short")} />
      </div>
      <p className="text-muted">{t("nav.context.chooseBody")}</p>
      {options.length === 0 ? <Callout tone="warning">{t("nav.context.none")}</Callout> : <WorkspaceChooser options={options} />}
      <div>
        <SignOutButton className="border border-border" />
      </div>
    </div>
  );
}
