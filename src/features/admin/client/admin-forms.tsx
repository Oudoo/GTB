"use client";

/**
 * Corporate administration forms (ADM-01). A proposal states the COMPLETE access a member
 * should have; the server checks it against the signed agreement, refuses a change to the
 * caller's own access and applies nothing until a different person approves.
 */
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ProblemAlert, useCommand } from "@/components/command";
import { AmountInput, Checkbox, Field, FormActions, Input, Textarea, describe } from "@/components/ui/form";
import { Button, Callout } from "@/components/ui/primitives";
import { lydMinor } from "@/features/collections/client/collection-forms";
import { Link } from "@/i18n/navigation";

const ROLES = ["CORPORATE_ADMIN", "MAKER", "CHECKER", "TREASURER", "FINANCE", "PAYROLL_OFFICER", "VIEWER", "API_INTEGRATOR"] as const;
const RIGHTS = ["read", "debit", "approve", "report"] as const;
type Right = (typeof RIGHTS)[number];
type Rights = Record<Right, boolean>;
type AccountOption = { id: string; label: string };
export type MemberAccess = { membershipId: string; roles: string[]; grants: Array<{ accountId: string } & Rights>; perItem: string; daily: string };

const none: Rights = { read: false, debit: false, approve: false, report: false };

export function UserChangeForm({ mode, accounts, member }: { mode: "invite" | "change"; accounts: AccountOption[]; member?: MemberAccess }) {
  const t = useTranslations("admin");
  const common = useTranslations("common");
  const fields = useTranslations("errors.fields");
  const command = useCommand();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [roles, setRoles] = useState<ReadonlySet<string>>(new Set(member?.roles ?? ["VIEWER"]));
  const [rights, setRights] = useState<Record<string, Rights>>(Object.fromEntries(accounts.map((account) => [account.id, { ...none, ...(member?.grants.find((grant) => grant.accountId === account.id) ?? {}) }])));
  const [perItem, setPerItem] = useState(member?.perItem ?? "");
  const [daily, setDaily] = useState(member?.daily ?? "");
  const [reason, setReason] = useState("");
  const [sent, setSent] = useState(false);
  const prefix = member ? `change-${member.membershipId}` : "invite";
  const perItemMinor = lydMinor(perItem);
  const dailyMinor = lydMinor(daily);
  const limitsEmpty = perItem.trim() === "" && daily.trim() === "";
  const limitsValid = limitsEmpty || (perItemMinor !== null && dailyMinor !== null);
  const reasonValid = reason.trim().length >= 3 && reason.trim().length <= 500;
  const valid = roles.size > 0 && limitsValid && reasonValid && (mode === "change" || (email.trim().length > 3 && displayName.trim().length >= 2));
  const setRight = (accountId: string, right: Right, on: boolean) => {
    const current = rights[accountId] ?? none;
    // Any right on an account needs view access to it; removing view removes the rest.
    const next = right === "read" ? (on ? { ...current, read: true } : { ...none }) : { ...current, [right]: on, read: on ? true : current.read };
    setRights({ ...rights, [accountId]: next });
  };
  return (
    <form
      className="flex flex-col gap-4"
      data-testid={`${prefix}-form`}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid) return;
        setSent(false);
        const grants = accounts.filter((account) => rights[account.id]?.read).map((account) => ({ accountId: account.id, ...(rights[account.id] as Rights) }));
        const access = { roles: [...roles], grants, limits: limitsEmpty ? null : { perItem: { currency: "LYD", minor: perItemMinor }, daily: { currency: "LYD", minor: dailyMinor } }, reason: reason.trim() };
        const result = await command.run("/admin/user-proposals", { body: mode === "invite" ? { kind: "INVITE", email: email.trim(), displayName: displayName.trim(), ...access } : { kind: "CHANGE_ACCESS", membershipId: member?.membershipId, ...access } });
        if (result.ok) {
          setSent(true);
          setReason("");
          if (mode === "invite") {
            setEmail("");
            setDisplayName("");
          }
        }
      }}
    >
      <p className="text-sm text-muted">{t("change.help")}</p>
      {mode === "invite" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id={`${prefix}-email`} label={t("change.email")} required>
            <Input {...describe(`${prefix}-email`, {})} type="email" inputMode="email" autoComplete="off" value={email} maxLength={200} required dir="ltr" onChange={(event) => setEmail(event.target.value)} />
          </Field>
          <Field id={`${prefix}-name`} label={t("change.displayName")} required>
            <Input {...describe(`${prefix}-name`, {})} value={displayName} minLength={2} maxLength={120} required onChange={(event) => setDisplayName(event.target.value)} />
          </Field>
        </div>
      ) : null}
      <fieldset className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
        <legend className="text-sm font-semibold">{t("change.roles")}</legend>
        {ROLES.map((role) => (
          <Checkbox
            key={role}
            id={`${prefix}-role-${role}`}
            label={t(`roles.${role}`)}
            checked={roles.has(role)}
            onChange={(event) => {
              const next = new Set(roles);
              if (event.target.checked) next.add(role);
              else next.delete(role);
              setRoles(next);
            }}
          />
        ))}
        {roles.size === 0 ? <p role="alert" className="text-sm font-medium text-danger sm:col-span-2">{t("change.chooseRole")}</p> : null}
      </fieldset>
      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-semibold">{t("change.accountRights")}</legend>
        {accounts.map((account) => (
          <div key={account.id} className="rounded-lg border border-border p-3">
            <p className="font-medium"><bdi>{account.label}</bdi></p>
            <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-4">
              {RIGHTS.map((right) => (
                <Checkbox key={right} id={`${prefix}-${account.id}-${right}`} label={t(`users.rights.${right}`)} checked={rights[account.id]?.[right] ?? false} onChange={(event) => setRight(account.id, right, event.target.checked)} />
              ))}
            </div>
          </div>
        ))}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-semibold">{t("change.limitsTitle")}</legend>
        <p className="text-sm text-muted">{t("change.limitsHelp")}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id={`${prefix}-per-item`} label={t("change.perItem")} error={!limitsValid ? t("change.limitsInvalid") : undefined}>
            <AmountInput {...describe(`${prefix}-per-item`, { error: !limitsValid })} value={perItem} onChange={(event) => setPerItem(event.target.value)} />
          </Field>
          <Field id={`${prefix}-daily`} label={t("change.daily")}>
            <AmountInput {...describe(`${prefix}-daily`, {})} value={daily} onChange={(event) => setDaily(event.target.value)} />
          </Field>
        </div>
      </fieldset>
      <Field id={`${prefix}-reason`} label={t("change.reason")} required error={reason.length > 0 && !reasonValid ? fields("reasonLength") : undefined}>
        <Textarea {...describe(`${prefix}-reason`, { error: reason.length > 0 && !reasonValid })} value={reason} maxLength={500} required onChange={(event) => setReason(event.target.value)} />
      </Field>
      {sent ? (
        <Callout tone="success" role="status" testId={`${prefix}-sent`}>
          {t("change.sent")}
        </Callout>
      ) : null}
      <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
      <FormActions>
        <Button type="submit" disabled={!valid || command.pending || command.unknownOutcome} aria-busy={command.pending} data-testid={`${prefix}-submit`}>
          {command.pending ? common("actions.working") : mode === "invite" ? t("change.invite") : t("change.propose")}
        </Button>
      </FormActions>
    </form>
  );
}

/** Immediate suspension of an active member, or a reactivation proposal for a suspended one. */
export function MemberStatusForm({ membershipId, version, suspended, name }: { membershipId: string; version: number; suspended: boolean; name: string }) {
  const t = useTranslations("admin");
  const common = useTranslations("common");
  const fields = useTranslations("errors.fields");
  const command = useCommand();
  const [reason, setReason] = useState("");
  const [sent, setSent] = useState(false);
  const reasonValid = reason.trim().length >= 3 && reason.trim().length <= 500;
  const id = `status-${membershipId}`;
  return (
    <form
      className="flex flex-col gap-3"
      data-testid={`${id}-form`}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!reasonValid) return;
        const result = suspended
          ? await command.run("/admin/user-proposals", { body: { kind: "REACTIVATE", membershipId, reason: reason.trim() } })
          : await command.run(`/admin/users/${membershipId}/suspend`, { body: { reason: reason.trim() }, ifMatch: version });
        if (result.ok) {
          setReason("");
          setSent(suspended);
        }
      }}
    >
      <p className="font-semibold">{suspended ? t("suspend.reactivate") : t("suspend.title", { name })}</p>
      {!suspended ? <p className="text-sm text-muted">{t("suspend.help")}</p> : null}
      <Field id={`${id}-reason`} label={t("change.reason")} required error={reason.length > 0 && !reasonValid ? fields("reasonLength") : undefined}>
        <Textarea {...describe(`${id}-reason`, { error: reason.length > 0 && !reasonValid })} value={reason} maxLength={500} required onChange={(event) => setReason(event.target.value)} />
      </Field>
      {sent ? <Callout tone="success" role="status">{t("change.sent")}</Callout> : null}
      <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
      <FormActions>
        <Button type="submit" variant={suspended ? "primary" : "danger"} disabled={!reasonValid || command.pending || command.unknownOutcome} aria-busy={command.pending} data-testid={`${id}-submit`}>
          {command.pending ? common("actions.working") : suspended ? t("suspend.reactivate") : t("suspend.confirm")}
        </Button>
      </FormActions>
    </form>
  );
}

/** Public: accept a single-use invitation. The token travels in the request body only. */
export function InvitationAcceptForm({ token, existingIdentity }: { token: string; existingIdentity: boolean }) {
  const t = useTranslations("admin.invite");
  const common = useTranslations("common");
  const command = useCommand();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);
  const mismatch = confirm.length > 0 && confirm !== password;
  const valid = password.length >= 12 && password.length <= 128 && confirm === password;
  if (done) {
    return (
      <div className="flex flex-col gap-3" data-testid="invite-done">
        <Callout tone="success" role="status">
          {t("done")}
        </Callout>
        <Link href="/login" className="font-semibold text-accent underline">
          {t("signIn")}
        </Link>
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-4"
      data-testid="invite-accept-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid) return;
        const result = await command.run("/invitations/accept", { body: { token, password } }, { idempotent: false, refresh: false });
        if (result.ok) setDone(true);
      }}
    >
      {existingIdentity ? <Callout tone="info">{t("existing")}</Callout> : null}
      <Field id="invite-password" label={t("password")} required hint={t("passwordHint")}>
        <Input {...describe("invite-password", { hint: true })} type="password" autoComplete="new-password" value={password} minLength={12} maxLength={128} required dir="ltr" onChange={(event) => setPassword(event.target.value)} />
      </Field>
      <Field id="invite-confirm" label={t("confirm")} required error={mismatch ? t("mismatch") : undefined}>
        <Input {...describe("invite-confirm", { error: mismatch })} type="password" autoComplete="new-password" value={confirm} minLength={12} maxLength={128} required dir="ltr" onChange={(event) => setConfirm(event.target.value)} />
      </Field>
      <ProblemAlert failure={command.failure} onCheck={command.checkServer} />
      <FormActions>
        <Button type="submit" disabled={!valid || command.pending || command.unknownOutcome} aria-busy={command.pending} data-testid="invite-accept">
          {command.pending ? common("actions.working") : t("accept")}
        </Button>
      </FormActions>
    </form>
  );
}
