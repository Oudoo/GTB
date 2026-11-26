-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "simcore";

-- CreateEnum
CREATE TYPE "ApprovalClass" AS ENUM ('PAYMENT', 'BULK', 'PAYROLL', 'CORPORATE_ADMIN', 'BANK_GOVERNANCE', 'BANK_REPAIR', 'BRANCH_DEPOSIT');

-- CreateEnum
CREATE TYPE "ApprovalState" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'SUPERSEDED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "VoteDecision" AS ENUM ('APPROVE', 'REJECT');

-- CreateEnum
CREATE TYPE "Segment" AS ENUM ('LARGE', 'MEDIUM', 'SMALL');

-- CreateEnum
CREATE TYPE "Rail" AS ENUM ('LYPAY', 'ACH', 'INTERNAL', 'BRANCH');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('INSTANT_ACCOUNT_CREDIT', 'ACH_CREDIT', 'OWN_ACCOUNT_TRANSFER', 'BULK_CREDIT', 'PAYROLL_SALARY', 'PAYROLL_ALLOWANCE', 'BRANCH_CASH_DEPOSIT', 'BRANCH_CHEQUE_DEPOSIT');

-- CreateEnum
CREATE TYPE "Provenance" AS ENUM ('DEMO_UNCONFIRMED', 'BANK_CONFIRMED');

-- CreateEnum
CREATE TYPE "ExecutionMode" AS ENUM ('IMMEDIATE', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "BatchKind" AS ENUM ('BULK', 'PAYROLL');

-- CreateEnum
CREATE TYPE "BatchState" AS ENUM ('DRAFT', 'VALIDATING', 'READY', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'PROCESSING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FileFormat" AS ENUM ('CSV', 'XLSX');

-- CreateEnum
CREATE TYPE "RowValidationState" AS ENUM ('VALID', 'INVALID', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "RowExecutionState" AS ENUM ('NONE', 'PENDING', 'PROCESSING', 'SUBMITTED', 'SETTLED', 'FAILED', 'STATUS_UNKNOWN', 'RETURNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PayrollComponent" AS ENUM ('SALARY', 'ALLOWANCE');

-- CreateEnum
CREATE TYPE "CollectionMethod" AS ENUM ('OWN_BANK');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('OPEN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DepositMethod" AS ENUM ('CASH', 'CHEQUE');

-- CreateEnum
CREATE TYPE "DepositState" AS ENUM ('DRAFT', 'PENDING_MANAGER', 'PENDING_POSTING', 'ACCEPTED_PENDING_CLEARING', 'POSTED', 'RETURNED', 'REJECTED', 'STATUS_UNKNOWN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReceiptKind" AS ENUM ('PENDING_ACKNOWLEDGMENT', 'POSTED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('R1_CORE', 'R1_SUBSET', 'R1_FOUNDATION', 'R2', 'R3');

-- CreateEnum
CREATE TYPE "AgreementStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "AgreementVersionStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'EFFECTIVE', 'SUPERSEDED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "LimitScope" AS ENUM ('TYPE', 'MODULE', 'CORPORATE');

-- CreateEnum
CREATE TYPE "LimitMetric" AS ENUM ('AMOUNT', 'ITEMS');

-- CreateEnum
CREATE TYPE "LimitPeriod" AS ENUM ('ITEM', 'DAY', 'MONTH', 'BATCH');

-- CreateEnum
CREATE TYPE "GovernanceStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'EFFECTIVE', 'SUPERSEDED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "UserChangeKind" AS ENUM ('INVITE', 'ROLE_CHANGE', 'GRANT_CHANGE', 'LIMIT_CHANGE', 'REACTIVATE');

-- CreateEnum
CREATE TYPE "CorporateStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "PersonStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "MembershipKind" AS ENUM ('CORPORATE', 'BANK');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'INVITED');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('CORPORATE_ADMIN', 'MAKER', 'CHECKER', 'TREASURER', 'FINANCE', 'PAYROLL_OFFICER', 'VIEWER', 'API_INTEGRATOR', 'BANK_ADMIN_MAKER', 'BANK_ADMIN_CHECKER', 'RELATIONSHIP_MANAGER', 'BRANCH_TELLER', 'BRANCH_MANAGER', 'PAYMENTS_OPERATIONS', 'COMPLIANCE', 'PAYROLL_SUPPORT');

-- CreateEnum
CREATE TYPE "AccountKind" AS ENUM ('OPERATING', 'PAYROLL', 'SAVINGS', 'COLLECTION');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'FROZEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('STATEMENT', 'DEPOSIT_SUMMARY', 'CUSTOMER_EXPORT', 'BATCH_RESULT', 'BATCH_ERRORS', 'PAYROLL_DETAIL', 'PAYROLL_ERRORS', 'AUDIT_EXPORT');

-- CreateEnum
CREATE TYPE "ReportFormat" AS ENUM ('CSV', 'PDF');

-- CreateEnum
CREATE TYPE "ReportState" AS ENUM ('PENDING', 'READY', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RepairAction" AS ENUM ('RESUBMIT_SAME_REFERENCE', 'MARK_FAILED_UNPOSTED');

-- CreateEnum
CREATE TYPE "RepairStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReconBreakKind" AS ENUM ('MISSING_IN_CORE', 'UNEXPECTED_IN_CORE', 'DUPLICATE_IN_CORE', 'AMOUNT_MISMATCH', 'STATUS_MISMATCH');

-- CreateEnum
CREATE TYPE "AlertKind" AS ENUM ('LOW_BALANCE', 'LIMIT_USAGE');

-- CreateEnum
CREATE TYPE "BeneficiaryMatchStatus" AS ENUM ('UNCHECKED', 'MATCHED', 'CLOSE_MATCH', 'MISMATCH', 'NOT_FOUND');

-- CreateEnum
CREATE TYPE "PaymentState" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'QUEUED', 'PROCESSING', 'SUBMITTED', 'SETTLED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED', 'STATUS_UNKNOWN', 'RETURNED');

-- CreateEnum
CREATE TYPE "DestinationKind" AS ENUM ('BENEFICIARY', 'OWN_ACCOUNT');

-- CreateEnum
CREATE TYPE "InstructionKind" AS ENUM ('SINGLE_PAYMENT', 'BULK_ROW', 'PAYROLL_ROW');

-- CreateEnum
CREATE TYPE "InstructionState" AS ENUM ('PENDING', 'PROCESSING', 'SUBMITTED', 'SETTLED', 'FAILED', 'STATUS_UNKNOWN', 'RETURNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AttemptState" AS ENUM ('INTENT', 'HOLD_PLACED', 'RAIL_SUBMITTED', 'BOOKED', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AttemptPhase" AS ENUM ('HOLD', 'RAIL', 'BOOKING');

-- CreateEnum
CREATE TYPE "ReservationState" AS ENUM ('RESERVED', 'CONSUMED', 'RELEASED');

-- CreateEnum
CREATE TYPE "JobState" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'DEAD', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AuditActorKind" AS ENUM ('PERSON', 'CREDENTIAL', 'SERVICE');

-- CreateEnum
CREATE TYPE "AuditResult" AS ENUM ('SUCCESS', 'DENIED', 'FAILED');

-- CreateEnum
CREATE TYPE "IdempotencyState" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "DeliveryState" AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "simcore"."SimAccountKind" AS ENUM ('CUSTOMER', 'SETTLEMENT_CONTROL', 'FEE_INCOME', 'CASH_VAULT', 'CHEQUE_CLEARING', 'OPENING_EQUITY');

-- CreateEnum
CREATE TYPE "simcore"."SimAccountStatus" AS ENUM ('ACTIVE', 'BLOCKED', 'CLOSED');

-- CreateEnum
CREATE TYPE "simcore"."SimHoldState" AS ENUM ('ACTIVE', 'CAPTURED', 'RELEASED');

-- CreateEnum
CREATE TYPE "simcore"."SimScenario" AS ENUM ('SUCCESS', 'NAME_MISMATCH', 'CLOSE_MATCH', 'ACCOUNT_BLOCKED', 'RAIL_REJECT', 'TIMEOUT_BEFORE_PROCESSING', 'TIMEOUT_AFTER_BOOKING', 'ACH_DELAYED', 'LATE_RETURN', 'DUPLICATE_EVENT', 'OUT_OF_ORDER_EVENT');

-- CreateEnum
CREATE TYPE "simcore"."SimRailStatus" AS ENUM ('ACCEPTED', 'SETTLED', 'REJECTED', 'RETURNED');

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID,
    "klass" "ApprovalClass" NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" UUID NOT NULL,
    "targetRevision" INTEGER NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "makerPersonId" UUID NOT NULL,
    "requiredApprovals" INTEGER NOT NULL,
    "approvalsCount" INTEGER NOT NULL DEFAULT 0,
    "state" "ApprovalState" NOT NULL DEFAULT 'PENDING',
    "policyVersion" INTEGER NOT NULL DEFAULT 1,
    "policySnapshot" JSONB,
    "sourceAccountId" UUID,
    "branchId" UUID,
    "amountMinor" BIGINT,
    "currency" TEXT,
    "activeKey" TEXT,
    "expiresAt" TIMESTAMPTZ(6),
    "decidedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalVote" (
    "id" UUID NOT NULL,
    "approvalRequestId" UUID NOT NULL,
    "personId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "decision" "VoteDecision" NOT NULL,
    "reason" TEXT,
    "policyVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Batch" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "kind" "BatchKind" NOT NULL,
    "reference" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "sourceAccountId" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "rail" "Rail" NOT NULL,
    "executionMode" "ExecutionMode" NOT NULL,
    "executeAt" TIMESTAMPTZ(6),
    "state" "BatchState" NOT NULL DEFAULT 'VALIDATING',
    "validationVersion" INTEGER NOT NULL DEFAULT 1,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "fileName" TEXT NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "fileFormat" "FileFormat" NOT NULL,
    "storageKey" TEXT,
    "templateVersion" INTEGER NOT NULL,
    "payPeriod" TEXT,
    "isCorrection" BOOLEAN NOT NULL DEFAULT false,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "duplicateRows" INTEGER NOT NULL DEFAULT 0,
    "warningRows" INTEGER NOT NULL DEFAULT 0,
    "acceptedCount" INTEGER NOT NULL DEFAULT 0,
    "acceptedTotalMinor" BIGINT NOT NULL DEFAULT 0,
    "feePerItemMinor" BIGINT,
    "feeTotalMinor" BIGINT NOT NULL DEFAULT 0,
    "acceptedRowsHash" TEXT,
    "warningsAcknowledged" BOOLEAN NOT NULL DEFAULT false,
    "identicalToBatchId" UUID,
    "parentBatchId" UUID,
    "validationErrorCode" TEXT,
    "releaseBlockCode" TEXT,
    "agreementVersionId" UUID,
    "policySnapshot" JSONB,
    "approvalRequestId" UUID,
    "makerPersonId" UUID NOT NULL,
    "makerMembershipId" UUID NOT NULL,
    "createdVia" TEXT NOT NULL DEFAULT 'WEB',
    "submittedAt" TIMESTAMPTZ(6),
    "finishedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BatchRow" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "rowReference" TEXT,
    "validationState" "RowValidationState" NOT NULL,
    "accepted" BOOLEAN NOT NULL DEFAULT false,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "amountMinor" BIGINT,
    "currency" TEXT,
    "beneficiaryName" TEXT,
    "accountScheme" TEXT,
    "accountReference" TEXT,
    "purpose" TEXT,
    "beneficiaryReference" TEXT,
    "businessKey" TEXT,
    "activeBusinessKey" TEXT,
    "instructionId" UUID,
    "executionState" "RowExecutionState" NOT NULL DEFAULT 'NONE',
    "failureCode" TEXT,
    "retryOfRowId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BatchRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRowDetail" (
    "batchRowId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "employeeId" UUID,
    "employeeCode" TEXT NOT NULL,
    "employeeName" TEXT,
    "accountScheme" TEXT,
    "accountReference" TEXT,
    "payPeriod" TEXT NOT NULL,
    "component" "PayrollComponent",
    "basicMinor" BIGINT,
    "allowancesMinor" BIGINT,
    "deductionsMinor" BIGINT,
    "correctionMinor" BIGINT,
    "netMinor" BIGINT,
    "payslipReference" TEXT,
    "correctionReference" TEXT,
    "previousNetMinor" BIGINT,
    "changeFlag" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PayrollRowDetail_pkey" PRIMARY KEY ("batchRowId")
);

-- CreateTable
CREATE TABLE "PayrollEmployee" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountScheme" TEXT NOT NULL,
    "accountReference" TEXT NOT NULL,
    "accountMatchStatus" "BeneficiaryMatchStatus" NOT NULL DEFAULT 'UNCHECKED',
    "matchCheckedAt" TIMESTAMPTZ(6),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PayrollEmployee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportSession" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "fileFormat" "FileFormat" NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PREVIEWED',
    "totalRows" INTEGER NOT NULL,
    "validRows" INTEGER NOT NULL,
    "invalidRows" INTEGER NOT NULL,
    "rows" JSONB NOT NULL,
    "acceptedHash" TEXT NOT NULL,
    "createdByPersonId" UUID NOT NULL,
    "committedAt" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ImportSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "mobileE164" TEXT NOT NULL,
    "industry" TEXT,
    "tags" TEXT[],
    "billingAddress" TEXT,
    "collectionMethod" "CollectionMethod" NOT NULL DEFAULT 'OWN_BANK',
    "referencedAt" TIMESTAMPTZ(6),
    "archivedAt" TIMESTAMPTZ(6),
    "createdByPersonId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceReference" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "dueDate" DATE NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'OPEN',
    "allocatedMinor" BIGINT NOT NULL DEFAULT 0,
    "createdByPersonId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "InvoiceReference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deposit" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "creditAccountId" UUID NOT NULL,
    "method" "DepositMethod" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "depositorReference" TEXT NOT NULL,
    "chequeReference" TEXT,
    "intakeReference" TEXT NOT NULL,
    "state" "DepositState" NOT NULL,
    "requiresManager" BOOLEAN NOT NULL DEFAULT false,
    "cashReviewFlag" BOOLEAN NOT NULL DEFAULT false,
    "contentHash" TEXT NOT NULL,
    "tellerPersonId" UUID NOT NULL,
    "managerPersonId" UUID,
    "approvalRequestId" UUID,
    "executionReference" TEXT NOT NULL,
    "coreReference" TEXT,
    "postedAt" TIMESTAMPTZ(6),
    "businessDate" DATE,
    "returnReason" TEXT,
    "failureCode" TEXT,
    "allocatedMinor" BIGINT NOT NULL DEFAULT 0,
    "inquiryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Deposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepositAllocation" (
    "id" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "depositId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "reversesAllocationId" UUID,
    "createdByPersonId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepositAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Receipt" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "depositId" UUID NOT NULL,
    "kind" "ReceiptKind" NOT NULL,
    "reference" TEXT NOT NULL,
    "supersedesReceiptId" UUID,
    "issuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModuleDefinition" (
    "catalogueId" TEXT NOT NULL,
    "domainNo" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "deliveryStatus" "DeliveryStatus" NOT NULL,
    "limitBasis" TEXT NOT NULL,
    "rails" TEXT[],
    "r1TransactionTypes" "TransactionType"[],
    "sourcePages" TEXT NOT NULL,

    CONSTRAINT "ModuleDefinition_pkey" PRIMARY KEY ("catalogueId")
);

-- CreateTable
CREATE TABLE "Agreement" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "status" "AgreementStatus" NOT NULL DEFAULT 'DRAFT',
    "suspendedAt" TIMESTAMPTZ(6),
    "suspendedByPersonId" UUID,
    "suspensionReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Agreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgreementVersion" (
    "id" UUID NOT NULL,
    "agreementId" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "status" "AgreementVersionStatus" NOT NULL,
    "segment" "Segment" NOT NULL,
    "effectiveFrom" TIMESTAMPTZ(6) NOT NULL,
    "effectiveUntil" TIMESTAMPTZ(6) NOT NULL,
    "terms" JSONB NOT NULL,
    "termsHash" TEXT NOT NULL,
    "signatureEvidence" JSONB NOT NULL,
    "changeReason" TEXT NOT NULL,
    "proposedByPersonId" UUID NOT NULL,
    "approvedByPersonId" UUID,
    "approvedAt" TIMESTAMPTZ(6),
    "decisionReason" TEXT,
    "approvalRequestId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "AgreementVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModuleEntitlement" (
    "id" UUID NOT NULL,
    "agreementVersionId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "moduleId" TEXT NOT NULL,
    "allowedTypes" "TransactionType"[],
    "currency" TEXT NOT NULL,
    "rowCap" INTEGER,

    CONSTRAINT "ModuleEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModuleEntitlementAccount" (
    "entitlementId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "allowDebit" BOOLEAN NOT NULL DEFAULT false,
    "allowCredit" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ModuleEntitlementAccount_pkey" PRIMARY KEY ("entitlementId","accountId")
);

-- CreateTable
CREATE TABLE "LimitRule" (
    "id" UUID NOT NULL,
    "agreementVersionId" UUID NOT NULL,
    "scope" "LimitScope" NOT NULL,
    "moduleId" TEXT,
    "transactionType" "TransactionType",
    "metric" "LimitMetric" NOT NULL,
    "period" "LimitPeriod" NOT NULL,
    "currency" TEXT,
    "valueMinor" BIGINT,
    "itemCount" INTEGER,
    "provenance" "Provenance" NOT NULL DEFAULT 'DEMO_UNCONFIRMED',

    CONSTRAINT "LimitRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeRule" (
    "id" UUID NOT NULL,
    "agreementVersionId" UUID NOT NULL,
    "transactionType" "TransactionType" NOT NULL,
    "currency" TEXT NOT NULL,
    "fixedMinor" BIGINT NOT NULL,

    CONSTRAINT "FeeRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRule" (
    "id" UUID NOT NULL,
    "agreementVersionId" UUID NOT NULL,
    "moduleId" TEXT NOT NULL,
    "transactionType" "TransactionType" NOT NULL,
    "currency" TEXT NOT NULL,
    "minMinor" BIGINT NOT NULL,
    "maxExclusiveMinor" BIGINT,
    "checkerCount" INTEGER NOT NULL,

    CONSTRAINT "ApprovalRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CorporateRuleSet" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "status" "GovernanceStatus" NOT NULL,
    "bands" JSONB NOT NULL,
    "bandsHash" TEXT NOT NULL,
    "changeReason" TEXT NOT NULL,
    "proposedByPersonId" UUID NOT NULL,
    "approvalRequestId" UUID,
    "effectiveAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CorporateRuleSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankCalendar" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "weekendDays" INTEGER[],
    "provenance" "Provenance" NOT NULL DEFAULT 'DEMO_UNCONFIRMED',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BankCalendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarClosedDay" (
    "calendarId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "CalendarClosedDay_pkey" PRIMARY KEY ("calendarId","date")
);

-- CreateTable
CREATE TABLE "RailParameter" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "rail" "Rail" NOT NULL,
    "currency" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "status" "GovernanceStatus" NOT NULL,
    "perItemMinor" BIGINT,
    "provenance" "Provenance" NOT NULL DEFAULT 'DEMO_UNCONFIRMED',
    "calendarId" UUID NOT NULL,
    "openLocalTime" TEXT,
    "cutoffLocalTime" TEXT,
    "observesClosedDays" BOOLEAN NOT NULL DEFAULT false,
    "offlineStartLocalTime" TEXT,
    "offlineEndLocalTime" TEXT,
    "settlementDelaySeconds" INTEGER NOT NULL DEFAULT 0,
    "effectiveFrom" TIMESTAMPTZ(6) NOT NULL,
    "changeReason" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "proposedByPersonId" UUID NOT NULL,
    "approvedByPersonId" UUID,
    "approvalRequestId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RailParameter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserChangeProposal" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "kind" "UserChangeKind" NOT NULL,
    "targetMembershipId" UUID,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "status" "GovernanceStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "proposedByPersonId" UUID NOT NULL,
    "approvalRequestId" UUID,
    "appliedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "UserChangeProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgreementRestoreProposal" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "agreementId" UUID NOT NULL,
    "status" "GovernanceStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "proposedByPersonId" UUID NOT NULL,
    "approvalRequestId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AgreementRestoreProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bank" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "businessTimezone" TEXT NOT NULL,
    "baseCurrency" TEXT NOT NULL,
    "sandbox" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Bank_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Branch" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "cashAccountRef" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Corporate" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "legalName" TEXT NOT NULL,
    "legalNameAr" TEXT NOT NULL,
    "shortCode" TEXT NOT NULL,
    "segment" "Segment" NOT NULL,
    "status" "CorporateStatus" NOT NULL DEFAULT 'ACTIVE',
    "coreCustomerRef" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Corporate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Person" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "status" "PersonStatus" NOT NULL DEFAULT 'ACTIVE',
    "preferredLocale" TEXT NOT NULL DEFAULT 'en',
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" UUID NOT NULL,
    "activeMembershipId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthAccount" (
    "id" UUID NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "password" TEXT,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ(6),
    "refreshTokenExpiresAt" TIMESTAMPTZ(6),
    "scope" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AuthAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthVerification" (
    "id" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AuthVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthRateLimit" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "lastRequest" BIGINT NOT NULL,

    CONSTRAINT "AuthRateLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginThrottle" (
    "keyHash" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMPTZ(6) NOT NULL,
    "lockedUntil" TIMESTAMPTZ(6),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LoginThrottle_pkey" PRIMARY KEY ("keyHash")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" UUID NOT NULL,
    "personId" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID,
    "kind" "MembershipKind" NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "roles" "Role"[],
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "branchId" UUID,
    "userPerItemLimitMinor" BIGINT,
    "userDailyLimitMinor" BIGINT,
    "limitCurrency" TEXT,
    "grantVersion" INTEGER NOT NULL DEFAULT 1,
    "suspendedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "coreAccountRef" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "maskedNumber" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "kind" "AccountKind" NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountGrant" (
    "id" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "canRead" BOOLEAN NOT NULL DEFAULT true,
    "canDebit" BOOLEAN NOT NULL DEFAULT false,
    "canApprove" BOOLEAN NOT NULL DEFAULT false,
    "canReport" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AccountGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userChangeProposalId" UUID NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "usedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocalInboxMessage" (
    "id" UUID NOT NULL,
    "toEmail" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LocalInboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID,
    "type" "ReportType" NOT NULL,
    "format" "ReportFormat" NOT NULL,
    "params" JSONB NOT NULL,
    "accountIds" UUID[],
    "restricted" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "requestedByPersonId" UUID NOT NULL,
    "requestedByMembershipId" UUID NOT NULL,
    "state" "ReportState" NOT NULL DEFAULT 'PENDING',
    "storageKey" TEXT,
    "checksum" TEXT,
    "sizeBytes" INTEGER,
    "fileName" TEXT,
    "rowCount" INTEGER,
    "projectionVersion" INTEGER NOT NULL DEFAULT 1,
    "failureCode" TEXT,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepairProposal" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "instructionId" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "action" "RepairAction" NOT NULL,
    "reason" TEXT NOT NULL,
    "evidenceReference" TEXT,
    "payloadHash" TEXT NOT NULL,
    "status" "RepairStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "proposedByPersonId" UUID NOT NULL,
    "approvalRequestId" UUID,
    "outcome" JSONB,
    "activeKey" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RepairProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationRun" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "businessDate" DATE NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'RUNNING',
    "startedByPersonId" UUID,
    "expectedCount" INTEGER NOT NULL DEFAULT 0,
    "coreCount" INTEGER NOT NULL DEFAULT 0,
    "matchedCount" INTEGER NOT NULL DEFAULT 0,
    "breakCount" INTEGER NOT NULL DEFAULT 0,
    "failureCode" TEXT,
    "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(6),

    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationBreak" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID,
    "kind" "ReconBreakKind" NOT NULL,
    "executionReference" TEXT NOT NULL,
    "expected" JSONB,
    "actual" JSONB,
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ReconciliationBreak_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationResolution" (
    "id" UUID NOT NULL,
    "breakId" UUID NOT NULL,
    "disposition" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidenceReference" TEXT,
    "actorPersonId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationResolution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertRule" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "kind" "AlertKind" NOT NULL,
    "accountId" UUID,
    "thresholdMinor" BIGINT,
    "currency" TEXT,
    "thresholdBps" INTEGER,
    "usageScopeKey" TEXT,
    "usagePeriod" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdByPersonId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID,
    "recipientPersonId" UUID NOT NULL,
    "eventKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "linkPath" TEXT,
    "readAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Beneficiary" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "displayName" TEXT NOT NULL,
    "scheme" TEXT NOT NULL,
    "accountReference" TEXT NOT NULL,
    "bankName" TEXT,
    "country" TEXT NOT NULL DEFAULT 'LY',
    "matchStatus" "BeneficiaryMatchStatus" NOT NULL DEFAULT 'UNCHECKED',
    "matchedName" TEXT,
    "matchCheckedAt" TIMESTAMPTZ(6),
    "closeMatchAcknowledged" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMPTZ(6),
    "activeKey" TEXT,
    "createdByPersonId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Beneficiary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "transactionType" "TransactionType" NOT NULL,
    "rail" "Rail" NOT NULL,
    "sourceAccountId" UUID NOT NULL,
    "destinationKind" "DestinationKind" NOT NULL,
    "beneficiaryId" UUID,
    "destinationAccountId" UUID,
    "destinationSnapshot" JSONB NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "feeMinor" BIGINT NOT NULL DEFAULT 0,
    "purpose" TEXT NOT NULL,
    "clientReference" TEXT,
    "executionMode" "ExecutionMode" NOT NULL,
    "executeAt" TIMESTAMPTZ(6),
    "executionBusinessDate" DATE,
    "state" "PaymentState" NOT NULL DEFAULT 'DRAFT',
    "releaseBlockCode" TEXT,
    "failureCode" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "proposalHash" TEXT,
    "agreementVersionId" UUID,
    "policySnapshot" JSONB,
    "approvalRequestId" UUID,
    "makerPersonId" UUID NOT NULL,
    "makerMembershipId" UUID NOT NULL,
    "createdVia" TEXT NOT NULL DEFAULT 'WEB',
    "createdByCredentialId" UUID,
    "submittedAt" TIMESTAMPTZ(6),
    "settledAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRevision" (
    "id" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "revisionNo" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "createdByPersonId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessInstruction" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "businessKey" TEXT NOT NULL,
    "kind" "InstructionKind" NOT NULL,
    "paymentId" UUID,
    "batchId" UUID,
    "moduleId" TEXT NOT NULL,
    "transactionType" "TransactionType" NOT NULL,
    "rail" "Rail" NOT NULL,
    "sourceAccountId" UUID NOT NULL,
    "sourceCoreRef" TEXT NOT NULL,
    "destinationScheme" TEXT,
    "destinationReference" TEXT,
    "destinationName" TEXT,
    "destinationCoreRef" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "feeMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "confidential" BOOLEAN NOT NULL DEFAULT false,
    "groupRef" TEXT,
    "narrative" TEXT NOT NULL,
    "makerMembershipId" UUID NOT NULL,
    "state" "InstructionState" NOT NULL DEFAULT 'PENDING',
    "failureCode" TEXT,
    "reservationCycle" INTEGER NOT NULL DEFAULT 0,
    "currentAttemptNo" INTEGER NOT NULL DEFAULT 0,
    "settledAt" TIMESTAMPTZ(6),
    "returnedAt" TIMESTAMPTZ(6),
    "correlationId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "BusinessInstruction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionAttempt" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "instructionId" UUID NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "executionReference" TEXT NOT NULL,
    "holdReference" TEXT NOT NULL,
    "railReference" TEXT,
    "batchRowId" UUID,
    "state" "AttemptState" NOT NULL DEFAULT 'INTENT',
    "unknownPhase" "AttemptPhase",
    "failureCode" TEXT,
    "coreReference" TEXT,
    "bookedAt" TIMESTAMPTZ(6),
    "bookedBusinessDate" DATE,
    "inquiryCount" INTEGER NOT NULL DEFAULT 0,
    "lastInquiryAt" TIMESTAMPTZ(6),
    "lastInquiryResult" TEXT,
    "activeKey" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ExecutionAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageCounter" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "period" "LimitPeriod" NOT NULL,
    "windowStart" DATE NOT NULL,
    "currency" TEXT NOT NULL,
    "consumedMinor" BIGINT NOT NULL DEFAULT 0,
    "reservedMinor" BIGINT NOT NULL DEFAULT 0,
    "consumedItems" INTEGER NOT NULL DEFAULT 0,
    "reservedItems" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LimitReservation" (
    "id" UUID NOT NULL,
    "instructionId" UUID NOT NULL,
    "counterId" UUID NOT NULL,
    "cycle" INTEGER NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "items" INTEGER NOT NULL DEFAULT 1,
    "state" "ReservationState" NOT NULL DEFAULT 'RESERVED',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LimitReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimelineEvent" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "code" TEXT NOT NULL,
    "fromState" TEXT,
    "toState" TEXT,
    "actorPersonId" UUID,
    "actorService" TEXT,
    "reference" TEXT,
    "detail" JSONB,

    CONSTRAINT "TimelineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferenceSequence" (
    "scopeKey" TEXT NOT NULL,
    "nextValue" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "ReferenceSequence_pkey" PRIMARY KEY ("scopeKey")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "dedupKey" TEXT,
    "payload" JSONB NOT NULL,
    "state" "JobState" NOT NULL DEFAULT 'PENDING',
    "availableAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "lockedBy" TEXT,
    "lockedUntil" TIMESTAMPTZ(6),
    "lastErrorCode" TEXT,
    "bankId" UUID,
    "corporateId" UUID,
    "aggregateType" TEXT,
    "aggregateId" UUID,
    "correlationId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "finishedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "workerId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "pid" INTEGER NOT NULL,
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL,
    "jobsProcessed" INTEGER NOT NULL DEFAULT 0,
    "buildId" TEXT,

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("workerId")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID,
    "type" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "correlationId" TEXT,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(6),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "bankId" UUID,
    "corporateId" UUID,
    "actorKind" "AuditActorKind" NOT NULL,
    "actorPersonId" UUID,
    "actorCredentialId" UUID,
    "actorService" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "correlationId" TEXT,
    "proposalRevision" INTEGER,
    "changes" JSONB,
    "result" "AuditResult" NOT NULL DEFAULT 'SUCCESS',
    "sensitiveRead" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "identifierHash" TEXT,
    "personId" UUID,
    "bankId" UUID,
    "corporateId" UUID,
    "correlationId" TEXT,
    "detail" JSONB,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "state" "IdempotencyState" NOT NULL DEFAULT 'IN_PROGRESS',
    "responseStatus" INTEGER,
    "resultType" TEXT,
    "resultId" TEXT,
    "resultMeta" JSONB,
    "lockedUntil" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiCredential" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "accountIds" UUID[],
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "lastUsedAt" TIMESTAMPTZ(6),
    "createdByPersonId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ApiCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiQuotaWindow" (
    "credentialId" UUID NOT NULL,
    "windowKind" TEXT NOT NULL,
    "windowStart" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ApiQuotaWindow_pkey" PRIMARY KEY ("credentialId","windowKind","windowStart")
);

-- CreateTable
CREATE TABLE "WebhookSubscription" (
    "id" UUID NOT NULL,
    "bankId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[],
    "secretCiphertext" TEXT NOT NULL,
    "previousSecretCiphertext" TEXT,
    "previousSecretExpiresAt" TIMESTAMPTZ(6),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdByPersonId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "WebhookSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "corporateId" UUID NOT NULL,
    "state" "DeliveryState" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(6),
    "lastAttemptAt" TIMESTAMPTZ(6),
    "lastStatusCode" INTEGER,
    "lastErrorCode" TEXT,
    "responseSnippet" TEXT,
    "replayOfDeliveryId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "simcore"."SimCoreAccount" (
    "ref" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "ownerRef" TEXT,
    "holderName" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "kind" "simcore"."SimAccountKind" NOT NULL,
    "status" "simcore"."SimAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "bookedMinor" BIGINT NOT NULL DEFAULT 0,
    "allowNegative" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SimCoreAccount_pkey" PRIMARY KEY ("ref")
);

-- CreateTable
CREATE TABLE "simcore"."SimCoreHold" (
    "reference" TEXT NOT NULL,
    "accountRef" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "state" "simcore"."SimHoldState" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SimCoreHold_pkey" PRIMARY KEY ("reference")
);

-- CreateTable
CREATE TABLE "simcore"."SimCoreJournal" (
    "id" UUID NOT NULL,
    "executionReference" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "postedAt" TIMESTAMPTZ(6) NOT NULL,
    "narrative" TEXT NOT NULL,
    "groupRef" TEXT,
    "payloadHash" TEXT NOT NULL,
    "reversesExecutionReference" TEXT,

    CONSTRAINT "SimCoreJournal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "simcore"."SimCoreEntry" (
    "id" UUID NOT NULL,
    "journalId" UUID NOT NULL,
    "accountRef" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "signedMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "component" TEXT NOT NULL DEFAULT 'PRINCIPAL',
    "postedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SimCoreEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "simcore"."SimDirectoryAccount" (
    "scheme" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "holderName" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "scenario" "simcore"."SimScenario" NOT NULL DEFAULT 'SUCCESS',
    "status" "simcore"."SimAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "consumedBy" TEXT[],

    CONSTRAINT "SimDirectoryAccount_pkey" PRIMARY KEY ("scheme","reference")
);

-- CreateTable
CREATE TABLE "simcore"."SimFault" (
    "id" UUID NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetValue" TEXT NOT NULL,
    "fault" TEXT NOT NULL,
    "remainingUses" INTEGER,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimFault_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "simcore"."SimRailMessage" (
    "railReference" TEXT NOT NULL,
    "rail" TEXT NOT NULL,
    "instructionReference" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "destinationScheme" TEXT NOT NULL,
    "destinationReference" TEXT NOT NULL,
    "status" "simcore"."SimRailStatus" NOT NULL DEFAULT 'ACCEPTED',
    "rejectCode" TEXT,
    "acceptedAt" TIMESTAMPTZ(6) NOT NULL,
    "settleAt" TIMESTAMPTZ(6) NOT NULL,
    "returnAt" TIMESTAMPTZ(6),
    "events" JSONB NOT NULL DEFAULT '[]',
    "eventCursor" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SimRailMessage_pkey" PRIMARY KEY ("railReference")
);

-- CreateTable
CREATE TABLE "simcore"."SimCheque" (
    "reference" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedAt" TIMESTAMPTZ(6),
    "events" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "SimCheque_pkey" PRIMARY KEY ("reference")
);

-- CreateTable
CREATE TABLE "simcore"."SimSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SimSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "simcore"."SimReconOverlay" (
    "id" UUID NOT NULL,
    "bankCode" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "executionReference" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountMinor" BIGINT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimReconOverlay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalRequest_activeKey_key" ON "ApprovalRequest"("activeKey");

-- CreateIndex
CREATE INDEX "ApprovalRequest_bankId_corporateId_state_klass_idx" ON "ApprovalRequest"("bankId", "corporateId", "state", "klass");

-- CreateIndex
CREATE INDEX "ApprovalRequest_targetType_targetId_idx" ON "ApprovalRequest"("targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalVote_approvalRequestId_personId_key" ON "ApprovalVote"("approvalRequestId", "personId");

-- CreateIndex
CREATE INDEX "Batch_corporateId_kind_state_createdAt_idx" ON "Batch"("corporateId", "kind", "state", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Batch_corporateId_reference_key" ON "Batch"("corporateId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "Batch_id_corporateId_key" ON "Batch"("id", "corporateId");

-- CreateIndex
CREATE UNIQUE INDEX "BatchRow_activeBusinessKey_key" ON "BatchRow"("activeBusinessKey");

-- CreateIndex
CREATE INDEX "BatchRow_batchId_validationState_idx" ON "BatchRow"("batchId", "validationState");

-- CreateIndex
CREATE INDEX "BatchRow_batchId_executionState_idx" ON "BatchRow"("batchId", "executionState");

-- CreateIndex
CREATE INDEX "BatchRow_instructionId_idx" ON "BatchRow"("instructionId");

-- CreateIndex
CREATE UNIQUE INDEX "BatchRow_batchId_lineNumber_key" ON "BatchRow"("batchId", "lineNumber");

-- CreateIndex
CREATE INDEX "PayrollRowDetail_corporateId_employeeId_payPeriod_idx" ON "PayrollRowDetail"("corporateId", "employeeId", "payPeriod");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollEmployee_corporateId_employeeCode_key" ON "PayrollEmployee"("corporateId", "employeeCode");

-- CreateIndex
CREATE INDEX "ImportSession_corporateId_kind_createdAt_idx" ON "ImportSession"("corporateId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "Customer_corporateId_archivedAt_displayName_idx" ON "Customer"("corporateId", "archivedAt", "displayName");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_corporateId_code_key" ON "Customer"("corporateId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_id_corporateId_key" ON "Customer"("id", "corporateId");

-- CreateIndex
CREATE INDEX "InvoiceReference_customerId_status_idx" ON "InvoiceReference"("customerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceReference_corporateId_reference_key" ON "InvoiceReference"("corporateId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceReference_id_corporateId_key" ON "InvoiceReference"("id", "corporateId");

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_intakeReference_key" ON "Deposit"("intakeReference");

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_executionReference_key" ON "Deposit"("executionReference");

-- CreateIndex
CREATE INDEX "Deposit_corporateId_createdAt_idx" ON "Deposit"("corporateId", "createdAt");

-- CreateIndex
CREATE INDEX "Deposit_customerId_createdAt_idx" ON "Deposit"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "Deposit_branchId_state_createdAt_idx" ON "Deposit"("branchId", "state", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_id_corporateId_key" ON "Deposit"("id", "corporateId");

-- CreateIndex
CREATE UNIQUE INDEX "DepositAllocation_reversesAllocationId_key" ON "DepositAllocation"("reversesAllocationId");

-- CreateIndex
CREATE INDEX "DepositAllocation_depositId_idx" ON "DepositAllocation"("depositId");

-- CreateIndex
CREATE INDEX "DepositAllocation_invoiceId_idx" ON "DepositAllocation"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_reference_key" ON "Receipt"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_depositId_kind_key" ON "Receipt"("depositId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ModuleDefinition_sortOrder_key" ON "ModuleDefinition"("sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Agreement_corporateId_key" ON "Agreement"("corporateId");

-- CreateIndex
CREATE INDEX "Agreement_bankId_idx" ON "Agreement"("bankId");

-- CreateIndex
CREATE UNIQUE INDEX "AgreementVersion_approvalRequestId_key" ON "AgreementVersion"("approvalRequestId");

-- CreateIndex
CREATE INDEX "AgreementVersion_corporateId_status_idx" ON "AgreementVersion"("corporateId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AgreementVersion_agreementId_versionNo_key" ON "AgreementVersion"("agreementId", "versionNo");

-- CreateIndex
CREATE UNIQUE INDEX "ModuleEntitlement_agreementVersionId_moduleId_key" ON "ModuleEntitlement"("agreementVersionId", "moduleId");

-- CreateIndex
CREATE INDEX "LimitRule_agreementVersionId_idx" ON "LimitRule"("agreementVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "FeeRule_agreementVersionId_transactionType_currency_key" ON "FeeRule"("agreementVersionId", "transactionType", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalRule_agreementVersionId_transactionType_currency_mi_key" ON "ApprovalRule"("agreementVersionId", "transactionType", "currency", "minMinor");

-- CreateIndex
CREATE UNIQUE INDEX "CorporateRuleSet_approvalRequestId_key" ON "CorporateRuleSet"("approvalRequestId");

-- CreateIndex
CREATE INDEX "CorporateRuleSet_corporateId_status_idx" ON "CorporateRuleSet"("corporateId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CorporateRuleSet_corporateId_versionNo_key" ON "CorporateRuleSet"("corporateId", "versionNo");

-- CreateIndex
CREATE UNIQUE INDEX "BankCalendar_bankId_code_key" ON "BankCalendar"("bankId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "RailParameter_approvalRequestId_key" ON "RailParameter"("approvalRequestId");

-- CreateIndex
CREATE INDEX "RailParameter_bankId_rail_status_effectiveFrom_idx" ON "RailParameter"("bankId", "rail", "status", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "RailParameter_bankId_rail_currency_versionNo_key" ON "RailParameter"("bankId", "rail", "currency", "versionNo");

-- CreateIndex
CREATE UNIQUE INDEX "UserChangeProposal_approvalRequestId_key" ON "UserChangeProposal"("approvalRequestId");

-- CreateIndex
CREATE INDEX "UserChangeProposal_corporateId_status_idx" ON "UserChangeProposal"("corporateId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AgreementRestoreProposal_approvalRequestId_key" ON "AgreementRestoreProposal"("approvalRequestId");

-- CreateIndex
CREATE INDEX "AgreementRestoreProposal_agreementId_status_idx" ON "AgreementRestoreProposal"("agreementId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Bank_code_key" ON "Bank"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_bankId_code_key" ON "Branch"("bankId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_id_bankId_key" ON "Branch"("id", "bankId");

-- CreateIndex
CREATE UNIQUE INDEX "Corporate_bankId_shortCode_key" ON "Corporate"("bankId", "shortCode");

-- CreateIndex
CREATE UNIQUE INDEX "Corporate_id_bankId_key" ON "Corporate"("id", "bankId");

-- CreateIndex
CREATE UNIQUE INDEX "Person_email_key" ON "Person"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AuthSession_token_key" ON "AuthSession"("token");

-- CreateIndex
CREATE INDEX "AuthSession_userId_idx" ON "AuthSession"("userId");

-- CreateIndex
CREATE INDEX "AuthAccount_userId_idx" ON "AuthAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthAccount_providerId_accountId_key" ON "AuthAccount"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "AuthVerification_identifier_idx" ON "AuthVerification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "AuthRateLimit_key_key" ON "AuthRateLimit"("key");

-- CreateIndex
CREATE INDEX "Membership_corporateId_idx" ON "Membership"("corporateId");

-- CreateIndex
CREATE INDEX "Membership_bankId_kind_idx" ON "Membership"("bankId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_personId_scopeKey_key" ON "Membership"("personId", "scopeKey");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_id_corporateId_key" ON "Membership"("id", "corporateId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_coreAccountRef_key" ON "Account"("coreAccountRef");

-- CreateIndex
CREATE INDEX "Account_corporateId_idx" ON "Account"("corporateId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_id_corporateId_key" ON "Account"("id", "corporateId");

-- CreateIndex
CREATE INDEX "AccountGrant_accountId_idx" ON "AccountGrant"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountGrant_membershipId_accountId_key" ON "AccountGrant"("membershipId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_userChangeProposalId_key" ON "Invitation"("userChangeProposalId");

-- CreateIndex
CREATE INDEX "Invitation_corporateId_idx" ON "Invitation"("corporateId");

-- CreateIndex
CREATE INDEX "LocalInboxMessage_toEmail_createdAt_idx" ON "LocalInboxMessage"("toEmail", "createdAt");

-- CreateIndex
CREATE INDEX "Report_corporateId_createdAt_idx" ON "Report"("corporateId", "createdAt");

-- CreateIndex
CREATE INDEX "Report_requestedByPersonId_createdAt_idx" ON "Report"("requestedByPersonId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RepairProposal_approvalRequestId_key" ON "RepairProposal"("approvalRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "RepairProposal_activeKey_key" ON "RepairProposal"("activeKey");

-- CreateIndex
CREATE INDEX "RepairProposal_bankId_status_idx" ON "RepairProposal"("bankId", "status");

-- CreateIndex
CREATE INDEX "ReconciliationRun_bankId_businessDate_startedAt_idx" ON "ReconciliationRun"("bankId", "businessDate", "startedAt");

-- CreateIndex
CREATE INDEX "ReconciliationBreak_bankId_state_idx" ON "ReconciliationBreak"("bankId", "state");

-- CreateIndex
CREATE INDEX "ReconciliationResolution_breakId_createdAt_idx" ON "ReconciliationResolution"("breakId", "createdAt");

-- CreateIndex
CREATE INDEX "AlertRule_corporateId_active_idx" ON "AlertRule"("corporateId", "active");

-- CreateIndex
CREATE INDEX "Notification_recipientPersonId_readAt_createdAt_idx" ON "Notification"("recipientPersonId", "readAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_recipientPersonId_eventKey_key" ON "Notification"("recipientPersonId", "eventKey");

-- CreateIndex
CREATE UNIQUE INDEX "Beneficiary_activeKey_key" ON "Beneficiary"("activeKey");

-- CreateIndex
CREATE INDEX "Beneficiary_corporateId_archivedAt_idx" ON "Beneficiary"("corporateId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Beneficiary_id_corporateId_key" ON "Beneficiary"("id", "corporateId");

-- CreateIndex
CREATE INDEX "Payment_corporateId_state_createdAt_idx" ON "Payment"("corporateId", "state", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_sourceAccountId_createdAt_idx" ON "Payment"("sourceAccountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_corporateId_reference_key" ON "Payment"("corporateId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRevision_paymentId_revisionNo_key" ON "PaymentRevision"("paymentId", "revisionNo");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessInstruction_paymentId_key" ON "BusinessInstruction"("paymentId");

-- CreateIndex
CREATE INDEX "BusinessInstruction_bankId_state_updatedAt_idx" ON "BusinessInstruction"("bankId", "state", "updatedAt");

-- CreateIndex
CREATE INDEX "BusinessInstruction_batchId_state_idx" ON "BusinessInstruction"("batchId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessInstruction_corporateId_businessKey_key" ON "BusinessInstruction"("corporateId", "businessKey");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionAttempt_executionReference_key" ON "ExecutionAttempt"("executionReference");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionAttempt_holdReference_key" ON "ExecutionAttempt"("holdReference");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionAttempt_railReference_key" ON "ExecutionAttempt"("railReference");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionAttempt_activeKey_key" ON "ExecutionAttempt"("activeKey");

-- CreateIndex
CREATE INDEX "ExecutionAttempt_bankId_state_updatedAt_idx" ON "ExecutionAttempt"("bankId", "state", "updatedAt");

-- CreateIndex
CREATE INDEX "ExecutionAttempt_bookedBusinessDate_idx" ON "ExecutionAttempt"("bookedBusinessDate");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionAttempt_instructionId_attemptNo_key" ON "ExecutionAttempt"("instructionId", "attemptNo");

-- CreateIndex
CREATE UNIQUE INDEX "UsageCounter_corporateId_scopeKey_period_windowStart_curren_key" ON "UsageCounter"("corporateId", "scopeKey", "period", "windowStart", "currency");

-- CreateIndex
CREATE INDEX "LimitReservation_counterId_state_idx" ON "LimitReservation"("counterId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "LimitReservation_instructionId_counterId_cycle_key" ON "LimitReservation"("instructionId", "counterId", "cycle");

-- CreateIndex
CREATE INDEX "TimelineEvent_aggregateType_aggregateId_at_idx" ON "TimelineEvent"("aggregateType", "aggregateId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "Job_dedupKey_key" ON "Job"("dedupKey");

-- CreateIndex
CREATE INDEX "Job_state_availableAt_idx" ON "Job"("state", "availableAt");

-- CreateIndex
CREATE INDEX "Job_aggregateType_aggregateId_idx" ON "Job"("aggregateType", "aggregateId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_dedupKey_key" ON "OutboxEvent"("dedupKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_occurredAt_idx" ON "OutboxEvent"("publishedAt", "occurredAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_corporateId_occurredAt_idx" ON "OutboxEvent"("corporateId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_bankId_corporateId_at_idx" ON "AuditEvent"("bankId", "corporateId", "at");

-- CreateIndex
CREATE INDEX "AuditEvent_targetType_targetId_at_idx" ON "AuditEvent"("targetType", "targetId", "at");

-- CreateIndex
CREATE INDEX "AuditEvent_correlationId_idx" ON "AuditEvent"("correlationId");

-- CreateIndex
CREATE INDEX "SecurityEvent_kind_at_idx" ON "SecurityEvent"("kind", "at");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_scopeKey_key_key" ON "IdempotencyRecord"("scopeKey", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ApiCredential_tokenPrefix_key" ON "ApiCredential"("tokenPrefix");

-- CreateIndex
CREATE UNIQUE INDEX "ApiCredential_tokenHash_key" ON "ApiCredential"("tokenHash");

-- CreateIndex
CREATE INDEX "ApiCredential_corporateId_idx" ON "ApiCredential"("corporateId");

-- CreateIndex
CREATE INDEX "WebhookSubscription_corporateId_active_idx" ON "WebhookSubscription"("corporateId", "active");

-- CreateIndex
CREATE INDEX "WebhookDelivery_subscriptionId_createdAt_idx" ON "WebhookDelivery"("subscriptionId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_state_nextAttemptAt_idx" ON "WebhookDelivery"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "SimCoreAccount_bankCode_ownerRef_idx" ON "simcore"."SimCoreAccount"("bankCode", "ownerRef");

-- CreateIndex
CREATE INDEX "SimCoreHold_accountRef_state_idx" ON "simcore"."SimCoreHold"("accountRef", "state");

-- CreateIndex
CREATE UNIQUE INDEX "SimCoreJournal_executionReference_key" ON "simcore"."SimCoreJournal"("executionReference");

-- CreateIndex
CREATE INDEX "SimCoreJournal_bankCode_businessDate_idx" ON "simcore"."SimCoreJournal"("bankCode", "businessDate");

-- CreateIndex
CREATE INDEX "SimCoreEntry_accountRef_postedAt_id_idx" ON "simcore"."SimCoreEntry"("accountRef", "postedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SimCoreEntry_journalId_lineNo_key" ON "simcore"."SimCoreEntry"("journalId", "lineNo");

-- CreateIndex
CREATE INDEX "SimFault_targetKind_targetValue_idx" ON "simcore"."SimFault"("targetKind", "targetValue");

-- CreateIndex
CREATE UNIQUE INDEX "SimRailMessage_instructionReference_key" ON "simcore"."SimRailMessage"("instructionReference");

-- CreateIndex
CREATE INDEX "SimRailMessage_status_settleAt_idx" ON "simcore"."SimRailMessage"("status", "settleAt");

-- CreateIndex
CREATE INDEX "SimReconOverlay_bankCode_businessDate_idx" ON "simcore"."SimReconOverlay"("bankCode", "businessDate");

-- AddForeignKey
ALTER TABLE "ApprovalVote" ADD CONSTRAINT "ApprovalVote_approvalRequestId_fkey" FOREIGN KEY ("approvalRequestId") REFERENCES "ApprovalRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalVote" ADD CONSTRAINT "ApprovalVote_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_sourceAccountId_corporateId_fkey" FOREIGN KEY ("sourceAccountId", "corporateId") REFERENCES "Account"("id", "corporateId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchRow" ADD CONSTRAINT "BatchRow_batchId_corporateId_fkey" FOREIGN KEY ("batchId", "corporateId") REFERENCES "Batch"("id", "corporateId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRowDetail" ADD CONSTRAINT "PayrollRowDetail_batchRowId_fkey" FOREIGN KEY ("batchRowId") REFERENCES "BatchRow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceReference" ADD CONSTRAINT "InvoiceReference_customerId_corporateId_fkey" FOREIGN KEY ("customerId", "corporateId") REFERENCES "Customer"("id", "corporateId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_customerId_corporateId_fkey" FOREIGN KEY ("customerId", "corporateId") REFERENCES "Customer"("id", "corporateId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_branchId_bankId_fkey" FOREIGN KEY ("branchId", "bankId") REFERENCES "Branch"("id", "bankId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_creditAccountId_corporateId_fkey" FOREIGN KEY ("creditAccountId", "corporateId") REFERENCES "Account"("id", "corporateId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositAllocation" ADD CONSTRAINT "DepositAllocation_depositId_corporateId_fkey" FOREIGN KEY ("depositId", "corporateId") REFERENCES "Deposit"("id", "corporateId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositAllocation" ADD CONSTRAINT "DepositAllocation_invoiceId_corporateId_fkey" FOREIGN KEY ("invoiceId", "corporateId") REFERENCES "InvoiceReference"("id", "corporateId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_depositId_fkey" FOREIGN KEY ("depositId") REFERENCES "Deposit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agreement" ADD CONSTRAINT "Agreement_corporateId_fkey" FOREIGN KEY ("corporateId") REFERENCES "Corporate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgreementVersion" ADD CONSTRAINT "AgreementVersion_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "Agreement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleEntitlement" ADD CONSTRAINT "ModuleEntitlement_agreementVersionId_fkey" FOREIGN KEY ("agreementVersionId") REFERENCES "AgreementVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleEntitlement" ADD CONSTRAINT "ModuleEntitlement_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "ModuleDefinition"("catalogueId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleEntitlementAccount" ADD CONSTRAINT "ModuleEntitlementAccount_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "ModuleEntitlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LimitRule" ADD CONSTRAINT "LimitRule_agreementVersionId_fkey" FOREIGN KEY ("agreementVersionId") REFERENCES "AgreementVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeRule" ADD CONSTRAINT "FeeRule_agreementVersionId_fkey" FOREIGN KEY ("agreementVersionId") REFERENCES "AgreementVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRule" ADD CONSTRAINT "ApprovalRule_agreementVersionId_fkey" FOREIGN KEY ("agreementVersionId") REFERENCES "AgreementVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankCalendar" ADD CONSTRAINT "BankCalendar_bankId_fkey" FOREIGN KEY ("bankId") REFERENCES "Bank"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarClosedDay" ADD CONSTRAINT "CalendarClosedDay_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "BankCalendar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_bankId_fkey" FOREIGN KEY ("bankId") REFERENCES "Bank"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Corporate" ADD CONSTRAINT "Corporate_bankId_fkey" FOREIGN KEY ("bankId") REFERENCES "Bank"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthAccount" ADD CONSTRAINT "AuthAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_bankId_fkey" FOREIGN KEY ("bankId") REFERENCES "Bank"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_corporateId_fkey" FOREIGN KEY ("corporateId") REFERENCES "Corporate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_corporateId_fkey" FOREIGN KEY ("corporateId") REFERENCES "Corporate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountGrant" ADD CONSTRAINT "AccountGrant_membershipId_corporateId_fkey" FOREIGN KEY ("membershipId", "corporateId") REFERENCES "Membership"("id", "corporateId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountGrant" ADD CONSTRAINT "AccountGrant_accountId_corporateId_fkey" FOREIGN KEY ("accountId", "corporateId") REFERENCES "Account"("id", "corporateId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationBreak" ADD CONSTRAINT "ReconciliationBreak_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReconciliationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationResolution" ADD CONSTRAINT "ReconciliationResolution_breakId_fkey" FOREIGN KEY ("breakId") REFERENCES "ReconciliationBreak"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_sourceAccountId_corporateId_fkey" FOREIGN KEY ("sourceAccountId", "corporateId") REFERENCES "Account"("id", "corporateId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRevision" ADD CONSTRAINT "PaymentRevision_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessInstruction" ADD CONSTRAINT "BusinessInstruction_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionAttempt" ADD CONSTRAINT "ExecutionAttempt_instructionId_fkey" FOREIGN KEY ("instructionId") REFERENCES "BusinessInstruction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LimitReservation" ADD CONSTRAINT "LimitReservation_instructionId_fkey" FOREIGN KEY ("instructionId") REFERENCES "BusinessInstruction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LimitReservation" ADD CONSTRAINT "LimitReservation_counterId_fkey" FOREIGN KEY ("counterId") REFERENCES "UsageCounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "WebhookSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "OutboxEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "simcore"."SimCoreHold" ADD CONSTRAINT "SimCoreHold_accountRef_fkey" FOREIGN KEY ("accountRef") REFERENCES "simcore"."SimCoreAccount"("ref") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "simcore"."SimCoreEntry" ADD CONSTRAINT "SimCoreEntry_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "simcore"."SimCoreJournal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "simcore"."SimCoreEntry" ADD CONSTRAINT "SimCoreEntry_accountRef_fkey" FOREIGN KEY ("accountRef") REFERENCES "simcore"."SimCoreAccount"("ref") ON DELETE RESTRICT ON UPDATE CASCADE;

