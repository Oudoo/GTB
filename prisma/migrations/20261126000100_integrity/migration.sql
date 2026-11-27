-- Hand-written integrity rules that the Prisma schema language cannot express.
-- Locks and application checks guard normal operation; these constraints are the last defence
-- (document 03: "unique constraints as the last defense").

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- Money: integer minor units inside a documented business range (MON-01).
-- 10^15 minor units is the business bound; it is far inside BIGINT.
-- ---------------------------------------------------------------------------
ALTER TABLE "Payment"
  ADD CONSTRAINT payment_amount_positive CHECK ("amountMinor" > 0 AND "amountMinor" <= 1000000000000000),
  ADD CONSTRAINT payment_fee_nonnegative CHECK ("feeMinor" >= 0 AND "feeMinor" <= 1000000000000000),
  ADD CONSTRAINT payment_destination_shape CHECK (
    ("destinationKind" = 'BENEFICIARY' AND "beneficiaryId" IS NOT NULL AND "destinationAccountId" IS NULL)
    OR ("destinationKind" = 'OWN_ACCOUNT' AND "destinationAccountId" IS NOT NULL AND "beneficiaryId" IS NULL
        AND "destinationAccountId" <> "sourceAccountId")
  ),
  ADD CONSTRAINT payment_schedule_shape CHECK (
    ("executionMode" = 'IMMEDIATE' AND "executeAt" IS NULL) OR ("executionMode" = 'SCHEDULED' AND "executeAt" IS NOT NULL)
  );

ALTER TABLE "BusinessInstruction"
  ADD CONSTRAINT instruction_amount_positive CHECK ("amountMinor" > 0 AND "amountMinor" <= 1000000000000000),
  ADD CONSTRAINT instruction_fee_nonnegative CHECK ("feeMinor" >= 0 AND "feeMinor" <= 1000000000000000);

ALTER TABLE "UsageCounter"
  ADD CONSTRAINT usage_counter_nonnegative CHECK (
    "consumedMinor" >= 0 AND "reservedMinor" >= 0 AND "consumedItems" >= 0 AND "reservedItems" >= 0
  ),
  ADD CONSTRAINT usage_counter_period CHECK ("period" IN ('DAY', 'MONTH'));

ALTER TABLE "LimitReservation"
  ADD CONSTRAINT limit_reservation_positive CHECK ("amountMinor" > 0 AND "items" > 0);

ALTER TABLE "LimitRule"
  ADD CONSTRAINT limit_rule_single_unit CHECK (
    ("metric" = 'AMOUNT' AND "valueMinor" IS NOT NULL AND "valueMinor" >= 0 AND "currency" IS NOT NULL AND "itemCount" IS NULL)
    OR ("metric" = 'ITEMS' AND "itemCount" IS NOT NULL AND "itemCount" >= 0 AND "valueMinor" IS NULL)
  ),
  ADD CONSTRAINT limit_rule_scope_shape CHECK (
    ("scope" = 'TYPE' AND "moduleId" IS NOT NULL AND "transactionType" IS NOT NULL)
    OR ("scope" = 'MODULE' AND "moduleId" IS NOT NULL AND "transactionType" IS NULL)
    OR ("scope" = 'CORPORATE' AND "moduleId" IS NULL AND "transactionType" IS NULL)
  );

ALTER TABLE "FeeRule"
  ADD CONSTRAINT fee_rule_nonnegative CHECK ("fixedMinor" >= 0 AND "fixedMinor" <= 1000000000000000);

ALTER TABLE "ApprovalRule"
  ADD CONSTRAINT approval_rule_band CHECK (
    "minMinor" >= 0 AND ("maxExclusiveMinor" IS NULL OR "maxExclusiveMinor" > "minMinor") AND "checkerCount" >= 1
  ),
  -- Bands for one type/currency may never overlap (ADM-02).
  ADD CONSTRAINT approval_rule_no_overlap EXCLUDE USING gist (
    "agreementVersionId" WITH =,
    "transactionType" WITH =,
    "currency" WITH =,
    int8range("minMinor", "maxExclusiveMinor", '[)') WITH &&
  );

ALTER TABLE "ApprovalRequest"
  ADD CONSTRAINT approval_request_counts CHECK (
    "requiredApprovals" >= 1 AND "approvalsCount" >= 0 AND "approvalsCount" <= "requiredApprovals"
  ),
  ADD CONSTRAINT approval_request_active_key CHECK (("state" = 'PENDING') = ("activeKey" IS NOT NULL));

ALTER TABLE "Membership"
  ADD CONSTRAINT membership_scope_shape CHECK (
    ("kind" = 'CORPORATE' AND "corporateId" IS NOT NULL AND "scopeKey" = 'C:' || "corporateId"::text)
    OR ("kind" = 'BANK' AND "corporateId" IS NULL AND "scopeKey" = 'B:' || "bankId"::text)
  ),
  ADD CONSTRAINT membership_user_limits CHECK (
    ("userPerItemLimitMinor" IS NULL OR "userPerItemLimitMinor" >= 0)
    AND ("userDailyLimitMinor" IS NULL OR "userDailyLimitMinor" >= 0)
  );

ALTER TABLE "Batch"
  ADD CONSTRAINT batch_totals_nonnegative CHECK (
    "acceptedCount" >= 0 AND "acceptedTotalMinor" >= 0 AND "feeTotalMinor" >= 0 AND "totalRows" >= 0
  );

ALTER TABLE "BatchRow"
  ADD CONSTRAINT batch_row_amount CHECK ("amountMinor" IS NULL OR ("amountMinor" > 0 AND "amountMinor" <= 1000000000000000)),
  ADD CONSTRAINT batch_row_accept_valid CHECK (NOT "accepted" OR "validationState" = 'VALID');

ALTER TABLE "PayrollRowDetail"
  ADD CONSTRAINT payroll_components CHECK (
    ("basicMinor" IS NULL OR "basicMinor" >= 0)
    AND ("allowancesMinor" IS NULL OR "allowancesMinor" >= 0)
    AND ("deductionsMinor" IS NULL OR "deductionsMinor" >= 0)
  );

ALTER TABLE "InvoiceReference"
  ADD CONSTRAINT invoice_amounts CHECK (
    "amountMinor" > 0 AND "amountMinor" <= 1000000000000000 AND "allocatedMinor" >= 0 AND "allocatedMinor" <= "amountMinor"
  );

ALTER TABLE "Deposit"
  ADD CONSTRAINT deposit_amounts CHECK (
    "amountMinor" > 0 AND "amountMinor" <= 1000000000000000 AND "allocatedMinor" >= 0 AND "allocatedMinor" <= "amountMinor"
  ),
  ADD CONSTRAINT deposit_cheque_reference CHECK (("method" = 'CHEQUE') = ("chequeReference" IS NOT NULL));

ALTER TABLE "DepositAllocation"
  ADD CONSTRAINT deposit_allocation_nonzero CHECK ("amountMinor" <> 0);

ALTER TABLE "RailParameter"
  ADD CONSTRAINT rail_parameter_ceiling CHECK ("perItemMinor" IS NULL OR "perItemMinor" >= 0),
  ADD CONSTRAINT rail_parameter_offline_pair CHECK (
    ("offlineStartLocalTime" IS NULL) = ("offlineEndLocalTime" IS NULL)
  );

ALTER TABLE "AlertRule"
  ADD CONSTRAINT alert_rule_shape CHECK (
    ("kind" = 'LOW_BALANCE' AND "accountId" IS NOT NULL AND "thresholdMinor" IS NOT NULL AND "thresholdMinor" >= 0)
    OR ("kind" = 'LIMIT_USAGE' AND "thresholdBps" IS NOT NULL AND "thresholdBps" BETWEEN 1 AND 10000 AND "usageScopeKey" IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- Agreements: effective periods of binding versions never overlap (AGR-02).
-- ---------------------------------------------------------------------------
ALTER TABLE "AgreementVersion"
  ADD CONSTRAINT agreement_version_period CHECK ("effectiveUntil" > "effectiveFrom"),
  ADD CONSTRAINT agreement_version_no_overlap EXCLUDE USING gist (
    "agreementId" WITH =,
    tstzrange("effectiveFrom", "effectiveUntil", '[)') WITH &&
  ) WHERE ("status" IN ('APPROVED', 'EFFECTIVE'));

CREATE FUNCTION agreement_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'agreement versions are never hard deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" <> 'DRAFT' AND (
       NEW."terms" IS DISTINCT FROM OLD."terms"
    OR NEW."termsHash" IS DISTINCT FROM OLD."termsHash"
    OR NEW."signatureEvidence" IS DISTINCT FROM OLD."signatureEvidence"
    OR NEW."segment" IS DISTINCT FROM OLD."segment"
    OR NEW."effectiveFrom" IS DISTINCT FROM OLD."effectiveFrom"
    OR NEW."versionNo" IS DISTINCT FROM OLD."versionNo"
    OR NEW."proposedByPersonId" IS DISTINCT FROM OLD."proposedByPersonId"
    OR NEW."effectiveUntil" > OLD."effectiveUntil"
  ) THEN
    RAISE EXCEPTION 'submitted agreement version content is immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER agreement_version_immutable
  BEFORE UPDATE OR DELETE ON "AgreementVersion"
  FOR EACH ROW EXECUTE FUNCTION agreement_version_immutable();

-- ---------------------------------------------------------------------------
-- Append-only tables (SEC-05, OPS-01). Privileges are also revoked from the runtime role by
-- `pnpm db:migrate`; the trigger holds even for a role that still has the privilege.
-- ---------------------------------------------------------------------------
CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not permitted: append-only table', TG_OP, TG_TABLE_NAME USING ERRCODE = '42501';
END $$;

CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON "AuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER security_event_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON "SecurityEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER timeline_event_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON "TimelineEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER approval_vote_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON "ApprovalVote"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER payment_revision_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON "PaymentRevision"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER recon_resolution_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON "ReconciliationResolution"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER deposit_allocation_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON "DepositAllocation"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER module_definition_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "ModuleDefinition"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- ---------------------------------------------------------------------------
-- Simulated core ledger: immutable, balanced journals; no overdraft on customer accounts.
-- ---------------------------------------------------------------------------
ALTER TABLE "simcore"."SimCoreAccount"
  ADD CONSTRAINT sim_account_no_overdraft CHECK ("allowNegative" OR "bookedMinor" >= 0);

ALTER TABLE "simcore"."SimCoreHold"
  ADD CONSTRAINT sim_hold_positive CHECK ("amountMinor" > 0);

ALTER TABLE "simcore"."SimCoreEntry"
  ADD CONSTRAINT sim_entry_nonzero CHECK ("signedMinor" <> 0);

CREATE TRIGGER sim_journal_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "simcore"."SimCoreJournal"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER sim_entry_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "simcore"."SimCoreEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE FUNCTION "simcore".journal_must_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  unbalanced record;
BEGIN
  SELECT e."currency", sum(e."signedMinor") AS total
    INTO unbalanced
    FROM "simcore"."SimCoreEntry" e
   WHERE e."journalId" = NEW."journalId"
   GROUP BY e."currency"
  HAVING sum(e."signedMinor") <> 0
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'journal % does not balance in % (net %)', NEW."journalId", unbalanced."currency", unbalanced.total
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

-- Deferred to commit so a journal's entries can be inserted one by one inside a transaction.
CREATE CONSTRAINT TRIGGER sim_journal_balanced
  AFTER INSERT ON "simcore"."SimCoreEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "simcore".journal_must_balance();
