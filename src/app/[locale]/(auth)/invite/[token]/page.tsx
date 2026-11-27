import { getTranslations } from "next-intl/server";
import { Callout, SandboxPill } from "@/components/ui/primitives";
import { InvitationAcceptForm } from "@/features/admin/client/admin-forms";
import { getDeps } from "@/server/deps";
import { lookupInvitation } from "@/server/domain/admin/service";
import { load, localeOf } from "@/server/page";

/** Public page reached from a single-use invitation link. Shows nothing for a bad link. */
export default async function InvitePage({ params }: { params: Promise<{ locale: string; token: string }> }) {
  const { locale: localeParam, token } = await params;
  const locale = localeOf(localeParam);
  const t = await getTranslations({ locale });
  const deps = await getDeps();
  const invitation = /^[A-Za-z0-9_-]{20,200}$/.test(token) ? await load(() => lookupInvitation(deps, token)) : null;
  return (
    <div className="pt-safe pb-safe mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-5 px-4 py-8">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t("admin.invite.title")}</h1>
        <SandboxPill label={t("common.sandbox.short")} />
      </div>
      {invitation?.ok ? (
        <>
          <p data-testid="invite-intro">
            {t("admin.invite.intro", { company: locale === "ar" ? invitation.data.corporate.nameAr : invitation.data.corporate.name, email: invitation.data.email })}
          </p>
          <InvitationAcceptForm token={token} existingIdentity={invitation.data.existingIdentity} />
        </>
      ) : (
        <Callout tone="danger" role="alert" title={t("admin.invite.invalidTitle")} testId="invite-invalid">
          {t("admin.invite.invalidBody")}
        </Callout>
      )}
    </div>
  );
}
