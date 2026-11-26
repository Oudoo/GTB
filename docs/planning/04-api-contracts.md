# 04 — API and integration contract

## General protocol

Prefix all routes `/api/v1`. Publish complete OpenAPI 3.1 including auth, parameters, DTOs, errors and examples for implemented operations. Use the shared Zod schemas or generate/check spec parity in CI. Unsupported product families must not have successful stub endpoints. Only v1 is shipped in R1; two live API versions and retirement policy are production targets from catalogue p.16, deferred until a real v2 exists.

JSON money: `{ "currency": "LYD", "minor": "125000" }` means LYD 125.000, never 125,000 dinars. ISO date `YYYY-MM-DD`, UTC instant RFC3339; business timezone reported explicitly. Opaque IDs, decimal-free string minor units, safe integer counts only. Errors use `application/problem+json`, no stack trace/SQL or existence leaks. List response: `{ data: [...], page: { nextCursor: string|null, hasMore: boolean }, correlationId }`. Single resource includes `version` and available actions. Actions derive from current authorization/state but are rechecked on mutation.

Accept/return `X-Correlation-ID` after validating length/characters; generate if absent. Never trust it as authorization. Return `Cache-Control: private, no-store` for confidential responses and tenant-specific data. Reject unknown write fields to prevent mass assignment. Cookie writes require CSRF/origin protection; scoped bearer API writes require credential permissions. `If-Match` with resource revision required for edits and decisions (428 if absent, 412 stale). Idempotency replay is checked first for an already-completed identical request so stale retry headers do not manufacture a second action.

All create and command POSTs require `Idempotency-Key` (UUID recommended). Scope by bank/corporate, authenticated principal, method and canonical route/action. Canonical request includes semantic payload plus target version, excluding volatile correlation header. Concurrent identical request either returns committed original or `409 REQUEST_IN_PROGRESS` with retry guidance; cannot execute twice. Different payload/key conflict returns `409 IDEMPOTENCY_CONFLICT`. Keep response/result references at least 30 days in R1; core/business execution uniqueness is permanent and independent of API retention. Never persist sensitive payroll plaintext in idempotency response cache: store authorized resource pointer and reproject for current permissions.

## Endpoint inventory

`C` = corporate session/explicit credential scope, `B` = bank session/permission, `P` = payroll-restricted projection, `R` = assigned-account read. “Command” means POST with idempotency and audit; user context is never a request-body field.

| Method/path | Purpose | Authorization and important behavior |
|---|---|---|
| GET `/session` | Current actor, contexts, permissions, locale | Verified session, no token/secret returned |
| POST `/session/context` | Select existing membership | Validate membership, invalidate client caches |
| GET `/dashboard` | Cash, approvals, recent activity, alerts | C/R; payroll aggregates only |
| GET `/accounts` | Assigned active accounts | C/R, scoped credential account intersection |
| GET `/accounts/{id}/balance` | Booked/available/holds/as-of | C/R, adapter inquiry and stale marker |
| GET `/accounts/{id}/statements` | Paginated activity | C/R, validated dates; masked aggregate payroll |
| GET/POST `/beneficiaries` | List/create beneficiary | C, create permission, unique normalized account policy |
| GET/PATCH `/beneficiaries/{id}` | Detail/update draft master data | C; versioned, historical snapshot unaffected |
| POST `/beneficiaries/{id}/archive` | Soft archive | C, reference-safe |
| POST `/beneficiaries/name-enquiry` | Canonical account match | C; rate limit, no arbitrary bank-wide search |
| POST `/payments/preview` | Policy/fee/approval/date evaluation | C, no reservation/posting; label advisory |
| GET/POST `/payments` | List/create draft proposal | C; immutable source owner, validated module/type |
| GET/PATCH `/payments/{id}` | Detail/edit draft | C; expected version, no editing submitted payload |
| POST `/payments/{id}/submit` | Freeze revision/request approval | C maker, idempotent; returns 202 with pending state |
| POST `/payments/{id}/revise` | New proposal revision | C maker; invalidates approvals, explains cancellation constraints |
| POST `/payments/{id}/cancel` | Cancel undispatched item | C permission; conflict for in-flight/unknown |
| GET `/approvals` | Permitted payment/batch/admin queue | C, class/account scoped; salary redaction |
| POST `/approvals/{proposalId}/approve` | Vote on exact revision | C/B appropriate class; distinct human, version required |
| POST `/approvals/{proposalId}/reject` | Reject with reason | C/B appropriate class; terminal revision |
| GET `/templates/{bulk-or-payroll}` | Versioned CSV/XLSX template | C, payroll template rights for payroll |
| POST `/batches/uploads` | Bounded multipart upload | C, P for payroll, 202 validation job; body checksum |
| GET `/batches/{id}` | Summary/progress/fees/state | C, P details only with permission |
| GET `/batches/{id}/rows` | Paginated validated/result rows | C with payroll-aware projection |
| GET `/batches/{id}/errors` | Safe error-report download | C/P, secure export audit |
| POST `/batches/{id}/accept-rows` | Confirm accepted row IDs/hash | C/P; server recalculates all totals |
| POST `/batches/{id}/submit` | Freeze batch/request approval | C/P, rejects invalid/unacknowledged rows |
| POST `/batches/{id}/cancel` | Cancel eligible whole batch | C, cannot cancel booked/in-flight rows blindly |
| POST `/batches/{id}/retry` | New batch from eligible failed rows | C/P, source linkage, reapproval required |
| GET/POST `/payroll/employees` | List/add employee | P only |
| PATCH `/payroll/employees/{id}` | Update active/account details | P, scoped/versioned |
| POST `/payroll/employees/import` | Preview employee import | P, same bounded ingestion pipeline |
| POST `/payroll/employees/imports/{id}/commit` | Persist accepted rows | P, transactional/import hash |
| GET/POST `/customers` | Register/list customer | C Finance/Admin; unique scoped code |
| GET/PATCH `/customers/{id}` | Details/activity/update | C, permitted customer fields only |
| POST `/customers/import` | Preview import | C, no silent partial commit |
| POST `/customers/imports/{id}/commit` | Commit accepted customers | C, unique-code concurrency safety |
| POST `/customers/archive` | Archive selected rows | C, reject open invoices with per-item reasons |
| GET/POST `/invoices` | Minimal collection invoice reference | C Finance, no tax/full invoice claims |
| PATCH `/invoices/{id}` | Correct unpaid draft/reference state | C Finance, versioned and audit; no arbitrary paid flag |
| POST `/invoices/{id}/allocate` | Match posted deposit to invoice | C Finance, exact allocation rules below |
| GET `/deposits` | Corporate customer-code deposit history | C/R, 90-day default |
| GET `/deposits/{id}` | Permitted deposit details/status | C/R or B branch scope |
| GET `/deposits/{id}/receipt` | Generated PDF receipt | C/R or B branch scope, authenticated |
| GET `/agreement` | Current modules, terms, limits | C read only; never writable by corporate API token |
| GET `/limits/usage` | Policy windows and usage explanation | C, own permitted user/module/account projections |
| GET/POST `/admin/user-proposals` | List/request membership changes | C Admin, bank bounds |
| GET/POST `/admin/approval-rule-proposals` | List/request stronger corporate rules | C Admin, cannot lower bank minimum |
| GET `/admin/users` | Scoped memberships/status | C Admin, no password/hash disclosure |
| POST `/admin/users/{id}/suspend` | Immediate access revocation | C Admin within delegation and last-admin rule |
| GET/POST `/reports` | List/request statement/deposit report | C/R, date/account/projection checked |
| GET `/reports/{id}/download` | Authenticated completed artifact | Recheck C/R and current permissions |
| GET `/audit-events` | Permitted sanitized audit history | C limited own corporate / B explicit audit permission |
| GET `/notifications` | Own in-app alerts | Verified session; own recipient only |
| POST `/notifications/{id}/read` | Mark own alert read | Session; cannot change recipient |
| GET/POST `/alert-rules` | Read/create low-balance/usage alerts | C Treasurer; scoped accounts |
| PATCH `/alert-rules/{id}` | Update threshold/active state | C Treasurer; versioned |
| GET/POST `/developer/credentials` | Metadata/create sandbox token | C Admin + API permission; show secret only once |
| POST `/developer/credentials/{id}/revoke` | Revoke token immediately | C Admin, audit; token cannot mutate own scopes |
| GET/POST `/developer/webhooks` | Configure allowed event subscription | C Admin + API permission; SSRF policy |
| POST `/developer/webhooks/{id}/rotate-secret` | Rotate signing material | C Admin; encrypted storage, audit |
| GET `/developer/webhooks/{id}/deliveries` | Sanitized delivery log | C API permission |
| POST `/developer/deliveries/{id}/replay` | Replay original event | C API permission; same event ID, audit |
| GET `/bank/corporates` | Bank corporate list | B explicit scope |
| GET/POST `/bank/corporates/{id}/agreement-proposals` | Revision history/propose bank terms | B bank admin maker |
| POST `/bank/corporates/{id}/suspend` | Emergency corporate agreement stop | B explicit emergency permission + reason |
| GET/POST `/bank/rail-parameter-proposals` | Configure simulated rail caps/calendar | B maker; approved through bank governance |
| GET `/bank/teller/customer-lookup` | Resolve corporate+customer code | B teller, bank and branch scope, query minimized |
| POST `/bank/deposits` | Teller captures synthetic cash/cheque | B teller; manager approval when required |
| GET `/bank/branch-approvals` | Manager queue | B manager; same actor cannot approve own deposit |
| POST `/bank/deposits/{id}/approve` | Approve exact intake revision | B branch manager, idempotent/versioned |
| POST `/bank/deposits/{id}/reject` | Reject intake with reason | B branch manager |
| GET `/bank/operations/executions` | Failure/unknown/overdue queue | B Payments operations, scoped masking |
| POST `/bank/operations/executions/{id}/inquire` | Safe authoritative inquiry | B operations, records attempt and evidence |
| POST `/bank/operations/executions/{id}/repair-proposals` | Propose safe recovery | B operations, independent vote if financial |
| GET/POST `/bank/reconciliation-runs` | List/start simulated EOD comparison | B operations, bank/date scope |
| POST `/bank/reconciliation-breaks/{id}/resolution` | Record evidenced disposition | B operations; cannot rewrite ledger |
| GET `/health/live`, GET `/health/ready` | Process / DB+migrations+core mode readiness | Minimal public response, no secrets/topology |

The table defines business routes; auth library login/logout/reset routes may use its conventions. Add GET detail routes where links require them and document them, not unexplained 404s. Customer/report exports can be requested via `/reports` rather than duplicate endpoints. Every enabled UI mutation must map to an operation and evidence. Write an endpoint-to-permission map test; browser-only internal governance APIs must reject corporate bearer tokens even if names resemble admin scopes.

## Example payment

```http
POST /api/v1/payments
Idempotency-Key: 4453cf48-b78c-4719-b520-1817d54cbbf1
Content-Type: application/json

{
  "moduleId": "1.1",
  "transactionType": "INSTANT_ACCOUNT_CREDIT",
  "sourceAccountId": "acct_demo_operating",
  "beneficiaryId": "ben_demo_supplier",
  "amount": { "currency": "LYD", "minor": "125000" },
  "purpose": "Supplier invoice DEMO-2026-001",
  "clientReference": "DEMO-2026-001",
  "execution": { "mode": "IMMEDIATE" }
}
```

201 returns `{ data: { id, state: "DRAFT", version: 1, ...redactedDetails }, correlationId }`. Submit freezes the revision and returns pending approval. Preview response contains evaluation timestamp, `advisory: true`, agreement/policy versions, core as-of, fee, totalDebit, projectedAvailable, constraints `{code, scope, metric, limit, used, reserved, requested, passes}`, required checkers and execution window. No guarantee of funds/limit capacity until dispatch.

```json
{
  "type": "urn:alqarib:problem:limit-exceeded",
  "title": "Daily corporate limit exceeded",
  "status": 422,
  "code": "CORPORATE_DAILY_LIMIT_EXCEEDED",
  "correlationId": "corr_demo_001",
  "violations": [{ "field": "amount.minor", "rule": "corporate.daily", "remainingMinor": "100000" }]
}
```

Stable error families: `UNAUTHENTICATED`, `PERMISSION_DENIED`, `RESOURCE_NOT_FOUND`, `VALIDATION_FAILED`, `VERSION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `REQUEST_IN_PROGRESS`, `AGREEMENT_INACTIVE`, `MODULE_DISABLED`, `TRANSACTION_TYPE_DISABLED`, `ACCOUNT_NOT_ALLOWED`, `RAIL_CONFIGURATION_REQUIRED`, `RAIL_LIMIT_EXCEEDED`, `MODULE_LIMIT_EXCEEDED`, `CORPORATE_DAILY_LIMIT_EXCEEDED`, `USER_LIMIT_EXCEEDED`, `SELF_APPROVAL_FORBIDDEN`, `APPROVAL_POLICY_UNAVAILABLE`, `REAPPROVAL_REQUIRED`, `INSUFFICIENT_FUNDS`, `NAME_MISMATCH`, `EXECUTION_WINDOW_CLOSED`, `STATUS_UNRESOLVED`, `RETRY_NOT_ELIGIBLE`, `IMPORT_TOO_LARGE`, `UNSUPPORTED_FILE`, `QUOTA_EXCEEDED`. Map codes consistently to 400/401/403/404/409/412/413/415/422/428/429/503. Runtime adapter failures are sanitized and asynchronous execution state distinguishes unknown from rejected.

## Minimal invoice allocation rule

A posted deposit may be partially allocated to one or more same-customer/same-currency invoice references. Lock deposit allocatable balance and invoice unpaid amount; reject over-allocation, cross-customer allocation or pending/returned deposit. Record allocation entries rather than editable paid flags. Due/paid figures are derived. Reversing a deposit creates linked reversing allocations, audit and updated invoice due; no historic record deletion. This deliberately small subfeature supports catalogue customer pages without promising an ERP/AR system.

## Sandbox credentials and quotas

Use high-entropy opaque bearer tokens; store only token hash plus prefix/expiry/last-used. Never expose token after creation or put it in URLs. Scope list: `accounts:read`, `payments:write`, `payments:read`, `batches:write`, `batches:read`, `collections:read`, `agreements:read`, `webhooks:manage`. Payroll credentials disabled by default and require explicitly restricted payroll integration scope/account grants; no broad token silently gets salary access. Human approval requires a human checker session in R1; bearer tokens cannot vote. Demo quota e.g. 60/minute and 10,000/day is configurable agreement fixture metadata, not a production rate. Return 429 with Retry-After; don't increment money usage for inquiry. Credential revocation takes effect on next call. APIs never accept caller-supplied actor/role/corporate as trusted authority.

## Webhooks

Events: `payment.status_changed`, `batch.finished`, `deposit.posted`, `limit.threshold_reached`. Payload contains `{ id, type, schemaVersion, occurredAt, corporateReference, correlationId, data: { resourceId, state, ...safeAggregate } }`. No employee names/accounts/amounts per row. Sign exact raw body with HMAC-SHA256 over `timestamp + "." + rawBody`, headers `X-AlQarib-Event-Id`, `X-AlQarib-Delivery-Id`, `X-AlQarib-Timestamp`, `X-AlQarib-Signature`. Include receiver verification example with timing-safe comparison and ±300s window. Replay uses same event ID, new delivery ID/timestamp/signature. Retry plan demo: 10s, 30s, 2m, 10m, 1h then dead-letter; 2xx success; timeouts/non-2xx recorded with bounded redacted response.

HTTPS destinations only in deployable mode; block localhost/private/link-local/metadata ranges, IPv4/IPv6 encodings, embedded credentials and nonstandard ports by default. Resolve and validate all addresses at registration **and delivery**, prevent DNS rebinding, disable redirects, bound time/response bytes and use controlled egress. Sandbox tests may use an explicitly configured local fixture receiver reachable only through test-only configuration; never allow arbitrary URL bypass through user input. Secret rotation supports overlap with explicit expiry. No automatic calls to an arbitrary URL merely to “verify” a subscription.

## Real integration boundary

Do not fabricate T24/IRIS/OFS, OBAPI/FLEXCUBE, CBL or rail endpoints. Keep canonical DTOs and adapter contract tests. Real integration later requires actual product/version/license, endpoint coverage, credentials/private routing, supported account schemes, error map, postings/fees/holds semantics, settlement calendar, salary-day load profile and approved reconciliation. Target OAuth2/OIDC+mTLS/FAPI requires gateway/IdP work and formal validation; sandbox API tokens are explicitly not an implementation of those standards.

## Concrete DTO appendix

These illustrative JSON fragments are planning contracts to turn into validated schemas, not executable production configuration. UUID IDs in the implementation may differ from readable fixture IDs. Every DTO rejects unexpected privileged fields.

**Batch multipart metadata:** `kind=BULK|PAYROLL`, `sourceAccountId`, `templateVersion=1`, `rail=ACH|LYPAY` (payroll ACH only in R1), `executionMode=IMMEDIATE|SCHEDULED`, optional `executeAt`, `file` bytes. Kind/source/rail/date freeze into batch revision. Validation response 202 includes `{ id, state: "VALIDATING", version, links: { self, rows } }`. Validation row projection includes `rowId`, `lineNumber`, `validationState`, `errors:[{code,field,messageKey}]`, warnings and permission-appropriate detail. `accept-rows` takes `{acceptedRowIds, excludedRowIds, validationVersion, acknowledgeWarnings}`; the server recomputes accepted hash/totals rather than trusting a client total. Checker vote body `{decision:"APPROVE", proposalVersion:3, proposalHash:"...", reason?:"..."}` plus `If-Match`; actor/checker count is never client-provided.

**Bank agreement proposal:** full immutable `effectiveFrom`, `effectiveUntil`, `segment`, `signatureEvidence:[{signerReference,evidenceReference,evidenceSha256,acceptedAt,simulated:true}]`, `linkedAccounts`, `moduleTerms:[{moduleId,transactionTypes,currency,accountIds,limits,feeRules,approvalBands,rowCap?}]`, `corporateLimits`, `changeReason`. Module availability validated against registry. Monetary rule example `{metric:"AMOUNT",period:"DAY",currency:"LYD",minor:"30000000"}`; item rule `{metric:"ITEMS",period:"BATCH",count:100}`. Never put `minor` and `count` in the same rule. Band example `{minMinor:"0",maxExclusiveMinor:"2000000",checkerCount:1}`. Empty/missing max is valid only as explicitly supported upper unbounded band, still bounded by other transaction limits; no accidental numeric Infinity serialization. Rail parameters record `{rail,currency,perItemMinor,provenance,effectiveFrom,cutoffLocalTime?,calendarId}` with nullable unconfirmed ceiling producing fail-closed behavior until demo/bank configuration supplies it.

**Deposit intake:** `{corporateId, customerCode, creditAccountId, branchId, method:"CASH"|"CHEQUE", amount:{currency:"LYD",minor:"2500000"}, depositorReference, chequeReference?}`. Corporate/branch IDs are requested context only; authenticated teller grants determine permissible values. Reference immutable on submitted intake. POST returns pending-manager or pending-posting status, never immediate success assumed from request receipt. Manager approval binds exact deposit version/hash. Simulator cheque clear is an adapter/test fixture event, not a corporate API mutation.

**Report request:** `{type:"STATEMENT"|"DEPOSIT_SUMMARY",format:"CSV"|"PDF",accountIds:[...],fromDate,toDate,customerId?}`. Server calculates scope and projection, stores requesting actor/tenant/context. Download uses report ID plus current session; no embedded permanent bearer in link. Artifact ID alone never authorizes access. Payroll detailed error reports have a separate restricted report type/projection that ordinary report permission cannot select.
