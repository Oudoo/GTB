"use client";

/**
 * Teller intake (COL-02). The teller names the company AND the customer code, confirms what
 * the bank found, then captures. Bank and branch are taken from the signed-in session on the
 * server; the branch sent here is only the requested context and cannot widen it.
 */
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ProblemAlert, useCommand } from "@/components/command";
import { AmountInput, Field, FormActions, Input, Select, describe } from "@/components/ui/form";
import { Button, Callout, DetailList, Money } from "@/components/ui/primitives";
import { lydMinor } from "@/features/collections/client/collection-forms";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api-client";

type Lookup = {
  corporate: { id: string; name: string; nameAr: string };
  customer: { code: string; displayName: string; company: string };
  creditAccounts: Array<{ id: string; name: string; nameAr: string; maskedNumber: string }>;
  perDepositCap: { currency: string; minor: string };
  managerThreshold: { currency: string; minor: string };
};

export function TellerCaptureForm({ corporates, branchId, locale }: { corporates: Array<{ id: string; name: string; nameAr: string }>; branchId: string; locale: string }) {
  const t = useTranslations("teller");
  const methods = useTranslations("collections.deposits.methods");
  const common = useTranslations("common");
  const router = useRouter();
  const command = useCommand();
  const [corporateId, setCorporateId] = useState("");
  const [customerCode, setCustomerCode] = useState("");
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [looking, setLooking] = useState(false);
  const [lookupFailed, setLookupFailed] = useState(false);
  const [creditAccountId, setCreditAccountId] = useState("");
  const [method, setMethod] = useState<"CASH" | "CHEQUE">("CASH");
  const [amount, setAmount] = useState("");
  const [depositorReference, setDepositorReference] = useState("");
  const [chequeReference, setChequeReference] = useState("");
  const minor = lydMinor(amount);
  const name = (value: { name: string; nameAr: string }) => (locale === "ar" ? value.nameAr : value.name);
  const reset = () => {
    setLookup(null);
    setLookupFailed(false);
    setAmount("");
    setDepositorReference("");
    setChequeReference("");
    command.reset();
  };

  if (!lookup) {
    return (
      <form
        className="flex flex-col gap-4"
        data-testid="teller-lookup-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setLooking(true);
          setLookupFailed(false);
          const result = await api<Lookup>(`/bank/teller/customer-lookup?corporateId=${encodeURIComponent(corporateId)}&customerCode=${encodeURIComponent(customerCode.trim())}`);
          setLooking(false);
          if (result.ok) {
            setLookup(result.data);
            setCreditAccountId(result.data.creditAccounts[0]?.id ?? "");
          } else {
            setLookupFailed(true);
          }
        }}
      >
        <h2 className="font-semibold">{t("step1")}</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="teller-corporate" label={t("corporate")} required>
            <Select {...describe("teller-corporate", {})} value={corporateId} required onChange={(event) => setCorporateId(event.target.value)}>
              <option value="">{t("chooseCorporate")}</option>
              {corporates.map((corporate) => (
                <option key={corporate.id} value={corporate.id}>
                  {name(corporate)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="teller-code" label={t("customerCode")} required>
            <Input {...describe("teller-code", {})} value={customerCode} maxLength={32} required dir="ltr" autoCapitalize="characters" onChange={(event) => setCustomerCode(event.target.value)} />
          </Field>
        </div>
        {lookupFailed ? (
          <Callout tone="danger" role="alert" testId="lookup-failed">
            {t("notFound")}
          </Callout>
        ) : null}
        <FormActions>
          <Button type="submit" disabled={looking || corporateId === "" || customerCode.trim() === ""} aria-busy={looking} data-testid="teller-lookup">
            {looking ? common("actions.working") : t("lookup")}
          </Button>
        </FormActions>
      </form>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      data-testid="teller-capture-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!minor) return;
        const result = await command.run<{ id: string }>(
          "/bank/deposits",
          { body: { corporateId: lookup.corporate.id, customerCode: lookup.customer.code, creditAccountId, branchId, method, amount: { currency: "LYD", minor }, depositorReference: depositorReference.trim(), ...(method === "CHEQUE" ? { chequeReference: chequeReference.trim() } : {}) } },
          { refresh: false },
        );
        if (result.ok) router.push(`/bank/deposits/${result.data.id}`);
      }}
    >
      <Callout tone="info" title={t("confirmTitle")} testId="teller-confirm">
        <DetailList
          items={[
            { label: t("confirmCorporate"), value: <bdi>{name(lookup.corporate)}</bdi>, testId: "confirm-corporate" },
            { label: t("confirmCustomer"), value: <span><bdi dir="ltr">{lookup.customer.code}</bdi> — <bdi>{lookup.customer.displayName}</bdi></span>, testId: "confirm-customer" },
          ]}
        />
      </Callout>
      <h2 className="font-semibold">{t("step2")}</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id="teller-account" label={t("account")} required>
          <Select {...describe("teller-account", {})} value={creditAccountId} required onChange={(event) => setCreditAccountId(event.target.value)}>
            {lookup.creditAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {name(account)} · {account.maskedNumber}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="teller-method" label={t("method")} required>
          <Select {...describe("teller-method", {})} value={method} onChange={(event) => setMethod(event.target.value as "CASH" | "CHEQUE")}>
            <option value="CASH">{methods("CASH")}</option>
            <option value="CHEQUE">{methods("CHEQUE")}</option>
          </Select>
        </Field>
        <Field
          id="teller-amount"
          label={t("amount")}
          required
          hint={
            <span>
              {t.rich("amountHint", { threshold: () => <Money value={lookup.managerThreshold} />, cap: () => <Money value={lookup.perDepositCap} /> })}
            </span>
          }
          error={amount !== "" && !minor ? t("amountInvalid") : undefined}
        >
          <AmountInput {...describe("teller-amount", { hint: true, error: amount !== "" && !minor })} value={amount} required onChange={(event) => setAmount(event.target.value)} />
        </Field>
        <Field id="teller-depositor" label={t("depositorReference")} required hint={t("depositorHint")}>
          <Input {...describe("teller-depositor", { hint: true })} value={depositorReference} maxLength={40} required dir="ltr" onChange={(event) => setDepositorReference(event.target.value)} />
        </Field>
        {method === "CHEQUE" ? (
          <Field id="teller-cheque" label={t("chequeReference")} required>
            <Input {...describe("teller-cheque", {})} value={chequeReference} maxLength={40} required dir="ltr" onChange={(event) => setChequeReference(event.target.value)} />
          </Field>
        ) : null}
      </div>
      <p className="text-sm text-muted">{t("captureNote")}</p>
      <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
      <FormActions>
        <Button type="submit" disabled={!minor || creditAccountId === "" || command.pending || command.unknownOutcome} aria-busy={command.pending} data-testid="teller-capture">
          {command.pending ? common("actions.working") : t("capture")}
        </Button>
        <Button variant="secondary" disabled={command.pending} onClick={reset}>
          {t("startOver")}
        </Button>
      </FormActions>
    </form>
  );
}
