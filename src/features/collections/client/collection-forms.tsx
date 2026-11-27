"use client";

/**
 * Customer register and invoice forms (COL-01). The server enforces the unique code, the
 * permissions, versions and every allocation rule; these controls only collect the input.
 */
import { useTranslations } from "next-intl";
import { useState } from "react";
import { CommandButton, ProblemAlert, useCommand } from "@/components/command";
import { AmountInput, Field, FormActions, Input, Select, describe } from "@/components/ui/form";
import { Button } from "@/components/ui/primitives";
import { MoneyError, parseUserAmount } from "@/contracts/money";

/** Exact minor units of a typed LYD amount, or null when it is not a valid positive amount. */
export function lydMinor(input: string): string | null {
  try {
    const minor = parseUserAmount(input, "LYD");
    return minor > 0n ? minor.toString() : null;
  } catch (error) {
    if (error instanceof MoneyError) return null;
    throw error;
  }
}

export function CustomerAddForm() {
  const t = useTranslations("collections.customers");
  const common = useTranslations("common");
  const command = useCommand();
  const empty = { code: "", displayName: "", company: "", mobile: "+218", industry: "", billingAddress: "" };
  const [values, setValues] = useState(empty);
  const set = (key: keyof typeof empty) => (event: { target: { value: string } }) => setValues({ ...values, [key]: event.target.value });
  return (
    <form
      className="flex flex-col gap-4"
      data-testid="customer-add-form"
      onSubmit={async (event) => {
        event.preventDefault();
        const result = await command.run("/customers", {
          body: { code: values.code.trim(), displayName: values.displayName.trim(), company: values.company.trim(), mobile: values.mobile.trim(), ...(values.industry.trim() ? { industry: values.industry.trim() } : {}), ...(values.billingAddress.trim() ? { billingAddress: values.billingAddress.trim() } : {}) },
        });
        if (result.ok) setValues(empty);
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id="customer-code" label={t("code")} required hint={t("codeHint")}>
          <Input {...describe("customer-code", { hint: true })} value={values.code} maxLength={32} required dir="ltr" onChange={set("code")} />
        </Field>
        <Field id="customer-name" label={t("name")} required>
          <Input {...describe("customer-name", {})} value={values.displayName} minLength={2} maxLength={160} required onChange={set("displayName")} />
        </Field>
        <Field id="customer-company" label={t("company")} required>
          <Input {...describe("customer-company", {})} value={values.company} minLength={2} maxLength={160} required onChange={set("company")} />
        </Field>
        <Field id="customer-mobile" label={t("mobile")} required hint={t("mobileHint")}>
          <Input {...describe("customer-mobile", { hint: true })} type="tel" inputMode="tel" value={values.mobile} maxLength={13} required dir="ltr" pattern="\+218[0-9]{9}" onChange={set("mobile")} />
        </Field>
        <Field id="customer-industry" label={t("industry")}>
          <Input {...describe("customer-industry", {})} value={values.industry} maxLength={80} onChange={set("industry")} />
        </Field>
        <Field id="customer-address" label={t("billingAddress")}>
          <Input {...describe("customer-address", {})} value={values.billingAddress} maxLength={300} onChange={set("billingAddress")} />
        </Field>
      </div>
      <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
      <FormActions>
        <Button type="submit" disabled={command.pending || command.unknownOutcome} aria-busy={command.pending} data-testid="customer-add">
          {command.pending ? common("actions.working") : t("add")}
        </Button>
      </FormActions>
    </form>
  );
}

export function CustomerArchiveButton({ customerId, version, archived }: { customerId: string; version: number; archived: boolean }) {
  const t = useTranslations("collections.customer");
  const command = useCommand();
  const common = useTranslations("common");
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          variant="secondary"
          disabled={command.pending || command.unknownOutcome}
          aria-busy={command.pending}
          data-testid="customer-archive"
          onClick={async () => {
            await command.run(`/customers/${customerId}`, { method: "PATCH", body: { archived: !archived }, ifMatch: version });
          }}
        >
          {command.pending ? common("actions.working") : archived ? t("restore") : t("archive")}
        </Button>
      </div>
      <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
    </div>
  );
}

export function InvoiceAddForm({ customerId }: { customerId: string }) {
  const t = useTranslations("collections.invoices");
  const common = useTranslations("common");
  const teller = useTranslations("teller");
  const command = useCommand();
  const [reference, setReference] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const minor = lydMinor(amount);
  return (
    <form
      className="flex flex-col gap-4"
      data-testid="invoice-add-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!minor) return;
        const result = await command.run("/invoices", { body: { customerId, reference: reference.trim(), amount: { currency: "LYD", minor }, dueDate } });
        if (result.ok) {
          setReference("");
          setAmount("");
          setDueDate("");
        }
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field id="invoice-reference" label={t("reference")} required>
          <Input {...describe("invoice-reference", {})} value={reference} maxLength={64} required dir="ltr" onChange={(event) => setReference(event.target.value)} />
        </Field>
        <Field id="invoice-amount" label={t("amount")} required hint={t("amountHint")} error={amount !== "" && !minor ? teller("amountInvalid") : undefined}>
          <AmountInput {...describe("invoice-amount", { hint: true, error: amount !== "" && !minor })} value={amount} required onChange={(event) => setAmount(event.target.value)} />
        </Field>
        <Field id="invoice-due" label={t("dueDate")} required>
          <Input {...describe("invoice-due", {})} type="date" value={dueDate} required dir="ltr" onChange={(event) => setDueDate(event.target.value)} />
        </Field>
      </div>
      <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
      <FormActions>
        <Button type="submit" disabled={!minor || command.pending || command.unknownOutcome} aria-busy={command.pending} data-testid="invoice-add">
          {command.pending ? common("actions.working") : t("add")}
        </Button>
      </FormActions>
    </form>
  );
}

export function AllocateForm({ invoices, deposits }: { invoices: Array<{ id: string; label: string }>; deposits: Array<{ id: string; label: string }> }) {
  const t = useTranslations("collections.invoices");
  const common = useTranslations("common");
  const teller = useTranslations("teller");
  const command = useCommand();
  const [invoiceId, setInvoiceId] = useState(invoices[0]?.id ?? "");
  const [depositId, setDepositId] = useState(deposits[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const minor = lydMinor(amount);
  return (
    <form
      className="flex flex-col gap-4"
      data-testid="allocate-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!minor) return;
        const result = await command.run(`/invoices/${invoiceId}/allocate`, { body: { depositId, amount: { currency: "LYD", minor } } });
        if (result.ok) setAmount("");
      }}
    >
      <p className="text-sm text-muted">{t("allocateHelp")}</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field id="allocate-invoice" label={t("invoice")} required>
          <Select {...describe("allocate-invoice", {})} value={invoiceId} onChange={(event) => setInvoiceId(event.target.value)}>
            {invoices.map((invoice) => (
              <option key={invoice.id} value={invoice.id}>
                {invoice.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="allocate-deposit" label={t("deposit")} required>
          <Select {...describe("allocate-deposit", {})} value={depositId} onChange={(event) => setDepositId(event.target.value)}>
            {deposits.map((deposit) => (
              <option key={deposit.id} value={deposit.id}>
                {deposit.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="allocate-amount" label={t("amount")} required error={amount !== "" && !minor ? teller("amountInvalid") : undefined}>
          <AmountInput {...describe("allocate-amount", { error: amount !== "" && !minor })} value={amount} required onChange={(event) => setAmount(event.target.value)} />
        </Field>
      </div>
      <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
      <FormActions>
        <Button type="submit" disabled={!minor || command.pending || command.unknownOutcome} aria-busy={command.pending} data-testid="allocate">
          {command.pending ? common("actions.working") : t("allocate")}
        </Button>
      </FormActions>
    </form>
  );
}

/** Sandbox operator: send a simulated clearing-house result for one waiting cheque. */
export function ChequeEventButtons({ depositId }: { depositId: string }) {
  const t = useTranslations("teller.cheques");
  return (
    <span className="flex flex-wrap justify-end gap-2">
      <CommandButton path={`/bank/simulator/cheques/${depositId}/events`} body={{ outcome: "CLEARED", reason: t("reasonClear") }} testId={`cheque-clear-${depositId}`}>
        {t("clear")}
      </CommandButton>
      <CommandButton path={`/bank/simulator/cheques/${depositId}/events`} body={{ outcome: "RETURNED", reason: t("reasonReturn") }} variant="secondary" testId={`cheque-return-${depositId}`}>
        {t("return")}
      </CommandButton>
    </span>
  );
}
