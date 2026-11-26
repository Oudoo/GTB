# 06 — Ordered implementation backlog

## Delivery method

Build in vertical slices, with working UI + API + DB + permissions + tests per slice. Do not scaffold all future products. Keep `docs/audit/IMPLEMENTATION-STATUS.md` with each task ID, status (`not-started`, `in-progress`, `verified`, `blocked`), paths, executed checks and remaining gaps. A task is verified only after its exit evidence exists. Record plan deviations separately; no redefining acceptance to match incomplete work.

Indicative effort for one experienced engineer with AI assistance is 12–18 engineering weeks, not a promise or a reason to cut controls. Dependency availability, integration discoveries and review findings may change it. R1 is a substantial banking sandbox. If a smaller first milestone is needed, stop after S4 as a **payments alpha**, never claim the full MVP is complete. The mobile/PWA tasks and gates in document 12 attach to these same slices; they are mandatory, not an optional later release. All slices S0–S10 are mandatory for the requested R1.

Dependency chain: S0 → S1 → S2 → S3 → S4 → S5 → S6; S7 can follow S4 independently of S5/S6; S8 follows payments+deposits; S9 follows stable events/APIs; S10 integrates every slice. Shared UI/i18n/accessibility starts in S1 and continues throughout, not as a final cosmetic phase.

## S0 — Repository and executable foundations (estimate 2–4 days)

| Task | Deliverable | Exit evidence |
|---|---|---|
| FND-001 | Inspect current repo/AGENTS/docs, inventory and decision log, clarify version compatibility | Actual version pins/rationale, no existing work removed |
| FND-002 | Next.js App Router strict TS, pnpm lock, lint/typecheck/test/build scripts, formatter | Frozen install, nonzero unit test discovery, production build |
| FND-003 | PostgreSQL Compose service/alternative local connection, Prisma schema/migration, separate worker entry | Fresh DB migration and worker heartbeat/job |
| FND-004 | Shared contracts, currency helpers, Clock port, structured redacted logging/correlation | Unit tests for LYD exponent, invalid inputs, timezone windows |
| FND-005 | CI workflow running lint/typecheck/unit/integration/build with PostgreSQL | CI configuration matches local commands; DB tests actually execute |

Do not wait for a bank credential. Use synthetic core design. Do not commit `.env`, dependency directories or generated reports.

## S1 — Identity, tenant boundary and bilingual shell (3–5 days)

| Task | Deliverable | Exit evidence |
|---|---|---|
| IAM-001 | Maintained auth/session integration, synthetic seeded identities, password hashing, login throttle, CSRF | Login/logout/session revocation, invalid login and CSRF tests |
| IAM-002 | Bank/corporate membership context, scoped repositories/account grants and permissions | Cross-corporate/cross-bank reads/writes/download denial integration tests |
| IAM-003 | Corporate and bank layouts/navigation, English/Arabic routing/messages, sandbox indicator | Keyboard navigation and RTL screenshots, no protected-page cache leak |
| IAM-004 | Seed all roles, two corporates and two banks, scoped account fixtures | Idempotent seed; README credential procedure with no real credentials |

Gate: unauthorized direct URLs and API requests fail even when sidebar guard is bypassed. Role selector cannot create authority.

## S2 — Agreements, policy and governance (5–8 days)

| Task | Deliverable | Exit evidence |
|---|---|---|
| GOV-001 | 33-module registry, segment demo templates, agreement version/signature evidence schema | All catalogue IDs represented once; deferred modules cannot activate |
| GOV-002 | Bank maker proposal/editor, checker diff review, activation/effective-date processing/history | Same-person denial; independent activation; overlapping revision prevention |
| GOV-003 | Fee/rail/limits/approval evaluators with structured explanation | Boundary table, unknown cap fail-closed, no mixed units |
| GOV-004 | Usage counters/reservations, lock order/transaction retry design | Real Postgres concurrent limit contention test |
| GOV-005 | Corporate user/approval-rule proposals and suspension | No privilege escalation, last-admin protection, session revocation |
| GOV-006 | Read-only corporate agreement/limits UI and internal admin APIs | Corporate token cannot change bank agreement; policy provenance visible |

Gate: signed effective active agreement is necessary for operational mutations. Governance bootstrap remains usable before activation.

## S3 — Simulated core, accounts and recovery primitive (4–7 days)

| Task | Deliverable | Exit evidence |
|---|---|---|
| COR-001 | Canonical core/rail ports, isolated simulated core ledger/holds/journal | Contract tests: exact balance/hold/posting semantics, sum-zero journal |
| COR-002 | Account/balance/statement query service and pages, grants/redaction | Correct booked vs available, as-of/outage display, no zero on error |
| COR-003 | Durable jobs/outbox, stable execution references, inquiry/retry error map | Worker restart and crash-after-core-post test |
| COR-004 | Deterministic simulator scenarios, test clock, ACH calendar and LYPay profile | Offline, mismatch, delayed, duplicate/out-of-order/unknown outcomes |

Gate: restarting app and worker preserves and resolves an execution intent, rather than fabricating a balance refresh.

## S4 — Single payments and approvals alpha (6–10 days)

| Task | Deliverable | Exit evidence |
|---|---|---|
| PAY-101 | Beneficiary registry and synthetic name-enquiry UI/API | Match/mismatch/archive/history snapshot tests |
| PAY-102 | Own-account, LYPay account transfer and ACH credit wizard/preview/draft/submit | Exact fee/amount/policy preview, module/account/type rejection |
| PAY-103 | Immutable approval queue/detail, distinct votes and optimistic versions | Self-approval and parallel duplicate vote rejected; two-checker case |
| PAY-104 | Release reservation/adapter execution, status timeline/events | Settle once, timeout-after-post inquiry, insufficient funds and fee-change handling |
| PAY-105 | One-off schedule/cut-off preview/cancel/reapproval | Clock-driven due execution, rollover, policy/suspension changes block |

Gate: full bank activation → maker → checker → settled statement with exact before/after balances and trace. Run same request twice, concurrent approvals, and unknown response recovery.

## S5 — Bulk engine (5–8 days)

| Task | Deliverable | Exit evidence |
|---|---|---|
| BAT-101 | CSV/XLSX templates, bounded ingestion, validation job and row results | Formula/oversized/mixed-currency/duplicate/invalid parser cases |
| BAT-102 | Accepted-set confirmation/hash, fee/count preview and immutable batch approval | Excluded rows never execute; editing invalidates votes |
| BAT-103 | Child dispatch with aggregate reservation allocation and derived state | Partial success, unknown rows, exact quota without double count |
| BAT-104 | Failed-row retry linked to original instruction, result export | No settled/unknown retry; concurrent retry prevented; reapproval |

Gate: 100-row fixture with 95 valid and 5 invalid processes only accepted 95 after approval; child amounts/fees and counter totals reconcile exactly.

## S6 — Payroll (5–8 days)

| Task | Deliverable | Exit evidence |
|---|---|---|
| PYR-101 | Restricted employee master/import and salary component calculation | Employee uniqueness, mismatch, negative/net precision and correction tests |
| PYR-102 | Payroll upload, pay period, changes/duplicates and scheduling atop shared batch engine | Duplicate employee-period-component blocked, warning acknowledgment bound to digest |
| PYR-103 | Aggregate checker/funding/status projection and restricted details | Response/HTML/export/log negative tests across all roles |
| PYR-104 | Aggregate statement projection and safe failed-line retry | No employee salary inferred through statements, row totals still reconcile |

Gate: officer can prepare and inspect salary; ordinary checker approves aggregate proposal without salary rows; finance sees totals only. “Instant salary” national integration remains unavailable, not mocked as live.

## S7 — Customer collections and teller deposits (6–9 days)

| Task | Deliverable | Exit evidence |
|---|---|---|
| COL-101 | Customer registry/import/filters/export/archive and minimal invoice records | Scoped unique code, open-invoice archive protection, safe CSV |
| COL-102 | Teller corporate+code confirmation and capture, branch manager approval | Collision across corporates resolved explicitly; self-approval and branch bypass denied |
| COL-103 | Cash post and cheque pending/clear/return simulator, idempotent clearance | No pre-clear credit, duplicate event no second posting, unknown inquiry |
| COL-104 | Customer timeline/deposit summary, receipt PDF, minimal invoice allocation | Default 90 days, exact allocation/over-allocation/return reversal tests |

Gate: deposit links correct customer, manager threshold works, finance gets accurate status and synthetic stamped receipt. No implication that other licensed banks are connected.

## S8 — Reports, operations and in-app insight (4–7 days)

| Task | Deliverable | Exit evidence |
|---|---|---|
| OPS-101 | Statement/deposit CSV/PDF report jobs and authorized downloads | Permission revoked after generation blocks download, formula escaping, Arabic PDF |
| OPS-102 | Unknown/failed execution queue, inquiry and independently approved safe repair | No direct status/balance override, every intervention has evidence/reason |
| OPS-103 | Business-date reconciliation and break resolution history | Missing/duplicate/mismatched fixture break detected, no silent auto-fix |
| OPS-104 | Scoped low-balance/usage alerts and sanitized audit search | Event dedup, no payroll payload, trace links complete |

Gate: operations can explain and recover uncertainty without a duplicate payment; reconciliation detects intentionally injected mismatch.

## S9 — API product foundation (4–7 days)

| Task | Deliverable | Exit evidence |
|---|---|---|
| API-101 | OpenAPI coverage/parity, stable errors/correlation/idempotency/version headers | Every UI mutation mapped, schema contract tests and curl smoke |
| API-102 | Scoped sandbox token lifecycle, quotas/revocation, developer UI | No human checker/bank privilege through corporate bearer token |
| API-103 | Signed durable webhooks, retries/logs/replay/rotation | Raw-body HMAC, stale timestamp rejection example, duplicate/replay semantics |
| API-104 | SSRF-hardened destinations and local test-only receiver | Private IPv4/IPv6, redirect, DNS-rebind checks; no production bypass |

Gate: API-created payment goes through same approval/limits/ledger as UI. Webhook failure does not lose settlement event or block payment final state.

## S10 — Hardening, integration review and handoff (5–8 days)

| Task | Deliverable | Exit evidence |
|---|---|---|
| REL-001 | Full bilingual UX/accessibility/responsive and PWA/device pass, receipts | Documents 05/12 screenshots, install/update/offline/security/device checks, keyboard and axe checks |
| REL-002 | Full nontrivial verification suite including concurrency/fault paths | Document 07 evidence with counts, actual exit codes and artifacts |
| REL-003 | Fresh-checkout setup/migrate/seed/dev/worker/smoke/build and restart | Two clean DB provisioning runs, no undocumented manual edits |
| REL-004 | Security/dependency/static-secret review and realistic load samples | Findings triaged, hard gates fixed, measured results and limitations |
| REL-005 | Actual runbook, environment sample, architecture/schema updates and requirement map | Evidence paths for every mandatory requirement; no fabricated pass marks |

Independent audit follows implementation. Fixes must be regression-tested and the audit rerun on the final revision. No passing audit inferred from Claude's completion statement.

## Universal task acceptance checklist

- Inputs validated on server; all data scoped; current permissions checked.
- Correct database constraints/transaction boundary; duplicate and concurrent calls considered.
- Audit/outbox events and safe correlation present where relevant.
- UI has empty/loading/error/success/pending states in both languages.
- Exact money formatting, visible simulation boundary and no secrets/PII leaks.
- Direct API happy and negative paths tested, not only browser click behavior.
- Relevant migration, seed, docs/OpenAPI and status report updated.
- Executed evidence recorded; skipped/unrun work explicitly listed.
