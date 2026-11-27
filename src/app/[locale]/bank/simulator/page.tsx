import { getTranslations } from "next-intl/server";
import { Badge, Callout, Card, CardHeader, Code, EmptyState, Money, PageHeader } from "@/components/ui/primitives";
import { ChequeEventButtons } from "@/features/collections/client/collection-forms";
import { Forbidden, LoadError } from "@/features/common/states";
import { AvailabilityToggle, ClockForm, FaultForm, OverlayForm, RemoveButton } from "@/features/operations/client/simulator-forms";
import { businessDateOf } from "@/lib/calendar";
import { formatDate, formatDateTime } from "@/lib/format";
import { listPendingCheques } from "@/server/domain/collections/deposits";
import { getSimulatorState } from "@/server/domain/operations/simulator";
import { can, load, requireBankPage } from "@/server/page";

export default async function SimulatorPage({ params }: { params: Promise<{ locale: string }> }) {
  const { deps, ctx, locale } = await requireBankPage((await params).locale);
  const t = await getTranslations({ locale });
  if (!can(ctx, "bank.simulator.control")) return <Forbidden />;
  const result = await load(() => getSimulatorState(deps, ctx));
  if (!result.ok) return <LoadError code={result.code} />;
  const state = result.data;
  const cheques = await load(() => listPendingCheques(deps, ctx));

  return (
    <>
      <PageHeader title={t("ops.sim.title")} description={t("ops.sim.description")} />
      <div className="flex flex-col gap-5">
        <Callout tone="sandbox" role="note">{t("common.sandbox.explain")}</Callout>

        <Card data-testid="sim-clock">
          <CardHeader title={t("ops.sim.clock")} description={t("ops.sim.clockNote")} />
          <div className="flex flex-col gap-4 p-4 sm:p-5">
            <p>
              {t("ops.sim.clockNow")}: <span className="font-semibold" data-testid="sim-now" data-iso={state.clock.now}>{formatDateTime(state.clock.now, locale, deps.timeZone)}</span>{" "}
              <span className="text-muted">({t("common.labels.bankTime", { zone: state.clock.timeZone })})</span>
            </p>
            <p className="text-sm text-muted" data-testid="sim-offset" data-minutes={state.clock.offsetMinutes}>{t("ops.sim.clockOffset", { minutes: Math.max(0, state.clock.offsetMinutes) })}</p>
            <ClockForm />
          </div>
        </Card>

        <Card data-testid="sim-cheques">
          <CardHeader title={t("teller.cheques.title")} description={t("teller.cheques.help")} />
          {cheques.ok && cheques.data.length > 0 ? (
            <ul className="divide-y divide-border">
              {cheques.data.map((cheque) => (
                <li key={cheque.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5" data-cheque={cheque.intakeReference}>
                  <span>
                    <Code>{cheque.intakeReference}</Code> <Money value={cheque.amount} /> <bdi className="text-muted">{locale === "ar" ? cheque.corporate.nameAr : cheque.corporate.name}</bdi>
                  </span>
                  <ChequeEventButtons depositId={cheque.id} />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title={t("teller.cheques.empty")} />
          )}
        </Card>

        <Card data-testid="sim-availability">
          <CardHeader title={t("ops.sim.availability")} description={t("ops.sim.availabilityNote")} />
          <ul className="divide-y divide-border">
            {state.availability.map((entry) => (
              <li key={entry.target} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5" data-target={entry.target} data-offline={entry.offline}>
                <span className="flex flex-wrap items-center gap-3">
                  {t(`ops.sim.target.${entry.target}`)}
                  <Badge tone={entry.offline ? "danger" : "success"}>{entry.offline ? t("ops.sim.offline") : t("ops.sim.online")}</Badge>
                </span>
                <AvailabilityToggle target={entry.target} offline={entry.offline} />
              </li>
            ))}
          </ul>
        </Card>

        <Card data-testid="sim-faults">
          <CardHeader title={t("ops.sim.faults")} description={t("ops.sim.faultsNote")} />
          <div className="flex flex-col gap-4 p-4 sm:p-5">
            <FaultForm />
            {state.faults.length === 0 ? (
              <EmptyState title={t("ops.sim.noFaults")} />
            ) : (
              <ul className="divide-y divide-border">
                {state.faults.map((fault) => (
                  <li key={fault.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                    <span>
                      <Code className="text-xs">{fault.executionReference}</Code> · {t(`ops.sim.faultKind.${fault.fault}` as Parameters<typeof t>[0])}
                      <span className="block text-sm text-muted">
                        {t("ops.sim.uses")}: {fault.remainingUses ?? "∞"} · {formatDateTime(fault.createdAt, locale, deps.timeZone)}
                      </span>
                    </span>
                    <RemoveButton path={`/bank/simulator/faults/${fault.id}/remove`} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card data-testid="sim-overlays">
          <CardHeader title={t("ops.sim.overlays")} description={t("ops.sim.overlaysNote")} />
          <div className="flex flex-col gap-4 p-4 sm:p-5">
            <OverlayForm defaultDate={businessDateOf(deps.clock.now(), deps.timeZone)} />
            {state.overlays.length === 0 ? (
              <EmptyState title={t("ops.sim.noOverlays")} />
            ) : (
              <ul className="divide-y divide-border">
                {state.overlays.map((overlay) => (
                  <li key={overlay.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                    <span>
                      <Code className="text-xs">{overlay.executionReference}</Code> · {t(`ops.sim.overlayKind.${overlay.kind}` as Parameters<typeof t>[0])}
                      {overlay.amountMinor ? <> · <Money value={{ currency: "LYD", minor: overlay.amountMinor }} /></> : null}
                      <span className="block text-sm text-muted">{formatDate(overlay.businessDate, locale, deps.timeZone)}</span>
                    </span>
                    <RemoveButton path={`/bank/simulator/recon-overlays/${overlay.id}/remove`} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
