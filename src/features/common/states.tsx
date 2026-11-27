import { getTranslations } from "next-intl/server";
import type { ErrorCode } from "@/contracts/errors";
import { Callout, Card, EmptyState } from "@/components/ui/primitives";

/**
 * A failed read is always shown as a failure. It is never rendered as an empty list or as a
 * zero balance (document 05).
 */
export async function LoadError({ code }: { code: ErrorCode }) {
  const t = await getTranslations();
  const key = `errors.${code}` as Parameters<typeof t>[0];
  if (code === "RESOURCE_NOT_FOUND") {
    return (
      <Card>
        <EmptyState title={t("common.states.notFoundTitle")} description={t("common.states.notFoundBody")} />
      </Card>
    );
  }
  if (code === "PERMISSION_DENIED") return <Forbidden />;
  return (
    <Callout tone={code === "ADAPTER_UNAVAILABLE" ? "warning" : "danger"} role="alert" title={t("common.states.errorTitle")} testId="load-error">
      <p data-code={code}>{t.has(key) ? t(key) : t("common.states.errorBody")}</p>
    </Callout>
  );
}

export async function Forbidden() {
  const t = await getTranslations("common.states");
  return (
    <Card>
      <div data-testid="forbidden">
        <EmptyState title={t("forbiddenTitle")} description={t("forbiddenBody")} />
      </div>
    </Card>
  );
}
