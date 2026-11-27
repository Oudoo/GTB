/**
 * Idempotent synthetic demo seed (IAM-004, document 07/11).
 *
 * - Runs only in sandbox mode with an explicit opt-in (checked by the CLI wrapper).
 * - Every row has a deterministic id, so a second run creates nothing new and never resets
 *   non-demo data, balances or passwords.
 * - Corporate A's agreement is left as a DRAFT on purpose: the mandatory demonstration starts
 *   with a real two-person bank activation. Corporate B is activated here THROUGH the same
 *   governance service by two distinct seeded bank administrators (DEC-013).
 */
import "@/server/bootstrap";
import type { AgreementProposal } from "@/contracts/agreement";
import {
  branchCashRef,
  ensureBankLedger,
  ensureDirectoryAccounts,
  ensureOpeningBalance,
  ensureSimAccount,
} from "@/server/adapters/core/simulator-admin";
import { compareNames } from "@/server/adapters/core/simulated-core";
import { hashPassword } from "@/server/auth/password";
import { fixtureContext } from "@/server/auth/session";
import { localDateToDbDate } from "@/server/calendar";
import type { Deps } from "@/server/deps";
import { castVote } from "@/server/domain/approvals/service";
import { proposeAgreementVersion } from "@/server/domain/agreements/service";
import { segmentTemplate } from "@/server/domain/agreements/templates";
import { fixtureUuid, sha256Hex } from "@/server/hash";
import {
  ACCOUNTS,
  BANKS,
  BENEFICIARIES_A,
  BRANCHES,
  BULK_RECIPIENT_COUNT,
  BULK_SCENARIOS,
  CALENDARS,
  CLOSED_DAYS,
  CORPORATES,
  CUSTOMERS,
  DIRECTORY,
  EMPLOYEES_A,
  NEW_STAFF_A,
  PEOPLE,
  RAIL_EFFECTIVE_FROM,
  bulkRecipientName,
  bulkRecipientRef,
  customerId,
  directory,
  membershipId,
  personId,
  type AccountKey,
  type CorporateKey,
} from "./fixtures";

export type SeedSummary = { peopleCreated: number; openingBalancesBooked: number; corporateBActivated: boolean };

const maskNumber = (ref: string) => `${ref.slice(0, ref.length - 6)}••${ref.slice(-4)}`;

function scopeOf(membership: (typeof PEOPLE)[number]["memberships"][number]) {
  if ("corporate" in membership.scope) {
    const corporate = CORPORATES[membership.scope.corporate];
    return { kind: "CORPORATE" as const, bankId: BANKS[corporate.bank].id, corporateId: corporate.id, scopeKey: `C:${corporate.id}`, label: `C-${membership.scope.corporate}` };
  }
  const bank = BANKS[membership.scope.bank];
  return { kind: "BANK" as const, bankId: bank.id, corporateId: null, scopeKey: `B:${bank.id}`, label: `B-${membership.scope.bank}` };
}

export async function seedDemo(deps: Deps, options: { password: string }): Promise<SeedSummary> {
  const { db } = deps;
  const summary: SeedSummary = { peopleCreated: 0, openingBalancesBooked: 0, corporateBActivated: false };

  // --- banks, branches, calendars -------------------------------------------------------------
  for (const bank of Object.values(BANKS)) {
    await db.bank.upsert({
      where: { id: bank.id },
      update: {},
      create: { id: bank.id, code: bank.code, name: bank.name, nameAr: bank.nameAr, businessTimezone: deps.timeZone, baseCurrency: "LYD", sandbox: true },
    });
  }
  for (const branch of Object.values(BRANCHES)) {
    await db.branch.upsert({
      where: { id: branch.id },
      update: {},
      create: { id: branch.id, bankId: BANKS[branch.bank].id, code: branch.code, name: branch.name, nameAr: branch.nameAr, cashAccountRef: `${BANKS[branch.bank].code}:${branchCashRef(branch.code)}` },
    });
  }
  for (const calendar of Object.values(CALENDARS)) {
    await db.bankCalendar.upsert({
      where: { id: calendar.id },
      update: {},
      // Friday and Saturday closed for clearing: synthetic fixture policy.
      create: { id: calendar.id, bankId: BANKS[calendar.bank].id, code: calendar.code, name: calendar.name, timezone: deps.timeZone, weekendDays: [5, 6] },
    });
    await db.calendarClosedDay.createMany({
      data: CLOSED_DAYS.map((day) => ({ calendarId: calendar.id, date: localDateToDbDate(day.date), label: day.label })),
      skipDuplicates: true,
    });
  }

  // --- simulated core ledgers -----------------------------------------------------------------
  await ensureBankLedger(db, BANKS.A.code, ["BR1", "BR2"]);
  await ensureBankLedger(db, BANKS.B.code, ["BB1"]);

  // --- corporates and accounts ----------------------------------------------------------------
  for (const corporate of Object.values(CORPORATES)) {
    await db.corporate.upsert({
      where: { id: corporate.id },
      update: {},
      create: {
        id: corporate.id,
        bankId: BANKS[corporate.bank].id,
        legalName: corporate.legalName,
        legalNameAr: corporate.legalNameAr,
        shortCode: corporate.shortCode,
        segment: corporate.segment,
        coreCustomerRef: corporate.coreCustomerRef,
      },
    });
    await db.agreement.upsert({
      where: { corporateId: corporate.id },
      update: {},
      create: { id: fixtureUuid(`agreement:${corporate.id}`), bankId: BANKS[corporate.bank].id, corporateId: corporate.id, status: "DRAFT" },
    });
  }
  for (const account of Object.values(ACCOUNTS)) {
    const corporate = CORPORATES[account.corporate];
    const bank = BANKS[corporate.bank];
    await ensureSimAccount(db, { ref: account.ref, bankCode: bank.code, ownerRef: corporate.coreCustomerRef, holderName: corporate.legalName, currency: "LYD", kind: "CUSTOMER" });
    await db.account.upsert({
      where: { id: account.id },
      update: {},
      create: {
        id: account.id,
        bankId: bank.id,
        corporateId: corporate.id,
        coreAccountRef: account.ref,
        name: account.name,
        nameAr: account.nameAr,
        maskedNumber: maskNumber(account.ref),
        currency: "LYD",
        kind: account.kind,
      },
    });
    if (await ensureOpeningBalance(db, deps.clock, deps.timeZone, { bankCode: bank.code, accountRef: account.ref, amountMinor: account.opening, currency: "LYD" })) {
      summary.openingBalancesBooked += 1;
    }
  }

  // --- synthetic directory --------------------------------------------------------------------
  await ensureDirectoryAccounts(db, DIRECTORY.map((entry) => ({ reference: entry.reference, holderName: entry.holderName, bankName: entry.bankName, scenario: entry.scenario })));
  await ensureDirectoryAccounts(db, [...EMPLOYEES_A, ...NEW_STAFF_A].map((employee) => ({ reference: employee.reference, holderName: employee.name, bankName: "Sahel Demo Bank" })));
  await ensureDirectoryAccounts(
    db,
    Array.from({ length: BULK_RECIPIENT_COUNT }, (_unused, index) => {
      const n = index + 1;
      const scenario = BULK_SCENARIOS[n];
      return { reference: bulkRecipientRef(n), holderName: bulkRecipientName(n), bankName: "Jabal Demo Bank", ...(scenario ? { scenario } : {}) };
    }),
  );

  // --- people, memberships, grants ------------------------------------------------------------
  for (const person of PEOPLE) {
    const id = personId(person.key);
    const existing = await db.person.findUnique({ where: { id } });
    if (!existing) {
      await db.person.create({
        data: { id, email: person.email, name: person.name, nameAr: person.nameAr, emailVerified: true, preferredLocale: person.locale, isDemo: true },
      });
      summary.peopleCreated += 1;
    }
    const credential = await db.authAccount.findFirst({ where: { userId: id, providerId: "credential" } });
    if (!credential) {
      // A password is set only when the identity is first created; re-seeding never resets it.
      await db.authAccount.create({
        data: { id: fixtureUuid(`auth-account:${person.key}`), userId: id, providerId: "credential", accountId: id, password: await hashPassword(options.password) },
      });
    }
    for (const membership of person.memberships) {
      const scope = scopeOf(membership);
      const mId = membershipId(person.key, scope.label);
      await db.membership.upsert({
        where: { id: mId },
        update: {},
        create: {
          id: mId,
          personId: id,
          bankId: scope.bankId,
          corporateId: scope.corporateId,
          kind: scope.kind,
          scopeKey: scope.scopeKey,
          roles: membership.roles as never,
          branchId: membership.branch ? BRANCHES[membership.branch].id : null,
          userPerItemLimitMinor: membership.perItem ?? null,
          userDailyLimitMinor: membership.daily ?? null,
          limitCurrency: membership.perItem !== undefined ? "LYD" : null,
        },
      });
      for (const grant of membership.grants ?? []) {
        const account = ACCOUNTS[grant.account as AccountKey];
        await db.accountGrant.createMany({
          data: [
            {
              id: fixtureUuid(`grant:${person.key}:${grant.account}`),
              membershipId: mId,
              corporateId: scope.corporateId as string,
              accountId: account.id,
              canRead: grant.read ?? false,
              canDebit: grant.debit ?? false,
              canApprove: grant.approve ?? false,
              canReport: grant.report ?? false,
            },
          ],
          skipDuplicates: true,
        });
      }
    }
  }

  // --- rail parameters: synthetic, DEMO_UNCONFIRMED, recorded as approved fixtures -------------
  const railRows = [
    { bank: "A", rail: "LYPAY", perItem: 5_000_000n, open: null, cutoff: null, closed: false, offline: null, delay: 0 },
    { bank: "A", rail: "ACH", perItem: 8_000_000n, open: "08:00", cutoff: "14:00", closed: true, offline: null, delay: 5 },
    { bank: "A", rail: "INTERNAL", perItem: 50_000_000n, open: null, cutoff: null, closed: false, offline: ["23:30", "00:30"] as const, delay: 0 },
    { bank: "A", rail: "BRANCH", perItem: 50_000_000n, open: null, cutoff: null, closed: false, offline: null, delay: 0 },
    // Boundary bank: the instant-rail ceiling is deliberately NOT configured → fails closed.
    { bank: "B", rail: "LYPAY", perItem: null, open: null, cutoff: null, closed: false, offline: null, delay: 0 },
    { bank: "B", rail: "INTERNAL", perItem: 50_000_000n, open: null, cutoff: null, closed: false, offline: null, delay: 0 },
  ] as const;
  for (const row of railRows) {
    const id = fixtureUuid(`rail:${row.bank}:${row.rail}:1`);
    const proposer = row.bank === "A" ? personId("bankMaker") : personId("bankBAdmin");
    await db.railParameter.createMany({
      data: [
        {
          id,
          bankId: BANKS[row.bank].id,
          rail: row.rail,
          currency: "LYD",
          versionNo: 1,
          status: "APPROVED",
          perItemMinor: row.perItem,
          provenance: "DEMO_UNCONFIRMED",
          calendarId: CALENDARS[row.bank].id,
          openLocalTime: row.open,
          cutoffLocalTime: row.cutoff,
          observesClosedDays: row.closed,
          offlineStartLocalTime: row.offline?.[0] ?? null,
          offlineEndLocalTime: row.offline?.[1] ?? null,
          settlementDelaySeconds: row.delay,
          effectiveFrom: new Date(RAIL_EFFECTIVE_FROM),
          changeReason: "Synthetic sandbox fixture — not a confirmed rail parameter",
          payloadHash: sha256Hex(`fixture-rail:${row.bank}:${row.rail}:1`),
          proposedByPersonId: proposer,
          approvedByPersonId: row.bank === "A" ? personId("bankChecker") : null,
        },
      ],
      skipDuplicates: true,
    });
  }

  // --- beneficiaries of Corporate A (name-checked against the synthetic directory) -------------
  for (const beneficiary of BENEFICIARIES_A) {
    const entry = directory(beneficiary.key);
    const status = compareNames(beneficiary.displayName, entry.holderName);
    await db.beneficiary.createMany({
      data: [
        {
          id: beneficiary.id,
          bankId: BANKS.A.id,
          corporateId: CORPORATES.A.id,
          displayName: beneficiary.displayName,
          scheme: "DEMO_DOMESTIC",
          accountReference: entry.reference,
          bankName: entry.bankName,
          matchStatus: status === "MATCH" ? "MATCHED" : status,
          matchedName: entry.holderName,
          matchCheckedAt: deps.clock.now(),
          activeKey: `${CORPORATES.A.id}:DEMO_DOMESTIC:${entry.reference}`,
          createdByPersonId: personId("aMaker"),
        },
      ],
      skipDuplicates: true,
    });
  }

  // --- collections and payroll master data ----------------------------------------------------
  for (const customer of CUSTOMERS) {
    const corporate = CORPORATES[customer.corporate as CorporateKey];
    await db.customer.createMany({
      data: [
        {
          id: customerId(customer.corporate as CorporateKey, customer.code),
          bankId: BANKS[corporate.bank].id,
          corporateId: corporate.id,
          code: customer.code,
          displayName: customer.displayName,
          company: customer.company,
          mobileE164: customer.mobile,
          industry: customer.industry,
          tags: [...customer.tags],
          createdByPersonId: personId(customer.corporate === "A" ? "aFinance" : "bFinance"),
        },
      ],
      skipDuplicates: true,
    });
  }
  // Demo alert thresholds (ALT-01): low available balance on the operating account and 80% of
  // the corporate daily limit. Synthetic values, not CBL parameters.
  await db.alertRule.createMany({
    data: [
      { id: fixtureUuid("alert:A:lowBalance"), bankId: BANKS.A.id, corporateId: CORPORATES.A.id, kind: "LOW_BALANCE", accountId: ACCOUNTS.A_OPERATING.id, thresholdMinor: 20_000_000n, currency: "LYD", createdByPersonId: personId("aTreasurer") },
      { id: fixtureUuid("alert:A:limitUsage"), bankId: BANKS.A.id, corporateId: CORPORATES.A.id, kind: "LIMIT_USAGE", thresholdBps: 8_000, usageScopeKey: "CORPORATE", usagePeriod: "DAY", createdByPersonId: personId("aTreasurer") },
    ],
    skipDuplicates: true,
  });
  for (const employee of EMPLOYEES_A) {
    await db.payrollEmployee.createMany({
      data: [
        {
          id: fixtureUuid(`employee:A:${employee.code}`),
          bankId: BANKS.A.id,
          corporateId: CORPORATES.A.id,
          employeeCode: employee.code,
          name: employee.name,
          accountScheme: "DEMO_DOMESTIC",
          accountReference: employee.reference,
          accountMatchStatus: "MATCHED",
          matchCheckedAt: deps.clock.now(),
        },
      ],
      skipDuplicates: true,
    });
  }

  // --- Corporate B: activated through real two-person governance ------------------------------
  const bVersions = await db.agreementVersion.count({ where: { corporateId: CORPORATES.B.id } });
  if (bVersions === 0) {
    const maker = await fixtureContext(deps, membershipId("bankMaker", "B-A"), "seed-corporate-b");
    const checker = await fixtureContext(deps, membershipId("bankChecker", "B-A"), "seed-corporate-b");
    const versionId = fixtureUuid("agreementVersion:B:1");
    await proposeAgreementVersion(deps, maker, CORPORATES.B.id, demoAgreementProposal(deps, "B"), versionId);
    const request = await db.approvalRequest.findFirstOrThrow({ where: { targetType: "agreementVersion", targetId: versionId } });
    await castVote(deps, checker, request.id, {
      decision: "APPROVE",
      proposalVersion: request.targetRevision,
      proposalHash: request.payloadHash,
      reason: "Seeded sandbox agreement for boundary fixtures",
      expectedVersion: request.version,
    });
    summary.corporateBActivated = true;
  }

  return summary;
}

/** A complete, valid agreement proposal for a seeded corporate, built from its segment template. */
export function demoAgreementProposal(deps: Pick<Deps, "clock">, corporate: CorporateKey, overrides: { effectiveFrom?: Date; effectiveUntil?: Date } = {}): AgreementProposal {
  const fixture = CORPORATES[corporate];
  const accounts = Object.values(ACCOUNTS).filter((account) => account.corporate === corporate);
  const ids = (kinds: string[]) => accounts.filter((account) => kinds.includes(account.kind)).map((account) => account.id);
  const payroll = ids(["PAYROLL"]);
  const now = deps.clock.now();
  const effectiveFrom = overrides.effectiveFrom ?? now;
  const effectiveUntil = overrides.effectiveUntil ?? new Date(effectiveFrom.getTime() + 365 * 86_400_000);
  return {
    effectiveFrom: effectiveFrom.toISOString(),
    effectiveUntil: effectiveUntil.toISOString(),
    signatureEvidence: [
      {
        signerReference: `Authorised signatory of ${fixture.legalName} (synthetic)`,
        evidenceReference: `SIM-SIGN-${fixture.shortCode}-0001`,
        evidenceSha256: sha256Hex(`simulated-signature:${fixture.shortCode}:0001`),
        acceptedAt: now.toISOString(),
        simulated: true,
      },
    ],
    terms: segmentTemplate(fixture.segment, {
      all: accounts.map((account) => account.id),
      payments: ids(["OPERATING", "SAVINGS"]),
      payroll: payroll.length > 0 ? payroll : ids(["OPERATING"]),
      collections: ids(["OPERATING"]),
    }),
    changeReason: "Initial sandbox agreement from the segment demo template",
  };
}
