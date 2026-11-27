# Implementation status — Al Qarib GTB sandbox MVP (R1)

Statuses: `not-started`, `in-progress`, `verified`, `blocked`. A task is `verified` only when its exit
evidence was actually executed; the commands and counts are recorded in
[IMPLEMENTATION-REVIEW.md](IMPLEMENTATION-REVIEW.md). This file is maintained by the implementer and is
**not** an independent audit verdict.

Started: 2026-11-26 from planning handoff commit `972d6af` (documents 01–12, no application code).

## Checkpoint summary (implementer's own record, not an audit verdict)

Last executed on the working tree that became the commit recorded in `IMPLEMENTATION-REVIEW.md`:

| Check | Command | Result |
|---|---|---|
| Lint | `pnpm lint` | clean (0 errors, 0 warnings) |
| Types | `pnpm typecheck` | clean |
| Unit | `pnpm test:unit` | 94 passed / 94 |
| Integration (real PostgreSQL 16) | `pnpm test:integration` | 16 passed / 16 |
| Production build + worker bundle | `pnpm build` | succeeded |
| End-to-end (production build, separate worker, own database) | `pnpm test:e2e` | 4 passed / 4 (E-01, E-02 × English desktop, Arabic 390 px emulation) — last run at commit `9dee03d`; not re-run since |

`verified` below means the listed checks were executed and passed. `in-progress` means code exists
but required tests from document 07 are still missing — those are listed, not implied.

## S0 — Repository and executable foundations

| Task | Status | Paths | Executed checks | Remaining gaps |
|---|---|---|---|---|
| FND-001 inspect repo, inventory, version pins | verified | `package.json`, `.node-version`, `docs/planning/IMPLEMENTATION-DECISIONS.md` | Inventory in DEC-001/002; lint/typecheck/build on the pinned versions | Frozen-lockfile install to be re-run on the final revision |
| FND-002 Next.js strict TS scaffold, scripts | verified | `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `src/app` | `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm build` | — |
| FND-003 PostgreSQL, Prisma migrations, worker | in-progress | `prisma/schema/*`, `prisma/migrations/*`, `scripts/db-migrate.ts`, `scripts/db-reset-demo.ts`, `worker/index.ts`, `scripts/build-worker.mjs` | Migrations applied with separate owner/runtime roles; worker runs as its own process (`pnpm worker:start`), heartbeat visible on `/bank`; E-02 settles through it | `tests/unit/migrations.test.ts`; `compose.yaml` not executed (no Docker daemon) |
| FND-004 contracts, money, clock, logging | verified | `src/contracts/*`, `src/server/{clock,logging,hash}.ts`, `src/lib/calendar.ts` | U-MON, U-CAL, log-redaction unit tests | — |
| FND-005 CI workflow | not-started | `.github/workflows/ci.yml` | — | — |
| MOB-101 manifest, icons, safe worker baseline | in-progress | `src/app/manifest.ts`, `src/pwa/*`, `public/offline.html`, `public/icons/*` | Service worker builds from the allowlist in `pnpm build` | Production-mode cache inspection P-04/P-11 (S10) |

## S1 — Identity, tenant boundary and bilingual shell

| Task | Status | Paths | Executed checks | Remaining gaps |
|---|---|---|---|---|
| IAM-001 auth/session, hashing, throttle, CSRF | in-progress | `src/server/auth/*`, `src/server/api/framework.ts` | Real sign-in through the form in every E2E actor; integration world signs in through the dispatcher | I-32, I-52 (throttle, CSRF, revocation) not yet written |
| IAM-002 membership context, scoped repositories, grants | in-progress | `src/server/auth/context.ts`, `src/server/auth/session.ts` | E-01: bank routes are 404 for a corporate session; another bank's corporate is not listed | I-01..I-03 isolation matrix not yet written |
| IAM-003 layouts/navigation, EN/AR, sandbox indicator | in-progress | `src/features/shell/*`, `src/i18n/*`, `src/app/[locale]` | i18n key-parity unit test; E-01/E-02 in Arabic at 390 px; sandbox indicator asserted | axe and keyboard pass (E-11) |
| IAM-004 seed roles, corporates, banks, accounts | verified | `src/server/seed/*`, `prisma/seed.ts` | Seed runs twice without creating anything the second time; 29 synthetic identities | — |

## S2 — Agreements, policy and governance

| Task | Status | Paths | Executed checks | Remaining gaps |
|---|---|---|---|---|
| GOV-001 module registry, templates, agreement schema | verified | `src/contracts/{modules,agreement}.ts`, migration `20261126000200_module_registry` | Registry/table equality asserted by `pnpm db:migrate`; E-01 asserts deferred modules have no enable control | I-07 crafted-request test |
| GOV-002 bank proposal/diff/activation/history | in-progress | `src/server/domain/agreements/service.ts`, `src/app/[locale]/bank/**`, `src/features/agreement/**` | Integration: two-person activation, self-approval denied and audited; E-01 through the UI in both layouts | I-06 (overlap/future revision), suspension/restore journey |
| GOV-003 fee/rail/limit/approval evaluators | in-progress | `src/server/policy/evaluate.ts`, `src/server/domain/agreements/rails.ts` | Exercised by the S4 gate test and E-02 | U-LIM-01..08, U-APR-01..05 not yet written |
| GOV-004 usage counters/reservations under contention | in-progress | `src/server/policy/reservations.ts` | Exact usage deltas asserted in integration and E-02 | I-13, I-14 concurrency races not yet written |
| GOV-005 corporate user/rule proposals, suspension | not-started | | | |
| GOV-006 read-only agreement/limits UI and admin APIs | in-progress | `src/app/[locale]/(corporate)/{agreement,limits,products}` | E-01 corporate reads effective policy; E-02 reads usage from the limits page | — |

## S3 — Simulated core, accounts and recovery primitive

| Task | Status | Paths | Executed checks | Remaining gaps |
|---|---|---|---|---|
| COR-001 core/rail ports, simulated ledger | in-progress | `src/server/adapters/**`, schema `simcore` | Journals balanced by a deferred trigger; integration asserts settlement control and fee income | Adapter contract tests |
| COR-002 accounts/balances/statements | in-progress | `src/server/domain/accounts/service.ts`, `src/app/[locale]/(corporate)/accounts/**` | Exact balances and statement lines in integration and E-02 | U-STA, 10,000-entry performance sample |
| COR-003 durable jobs/outbox, stable references, inquiry | in-progress | `src/server/jobs/*`, `src/server/domain/execution/*`, `worker/index.ts` | Integration: timeout-after-booking → unknown → inquiry → one journal; definitive rejection releases hold and quota once | I-17, I-19 crash windows; outbox publisher (S9) |
| COR-004 simulator scenarios, test clock, calendars | in-progress | `src/server/adapters/core/simulator-*.ts`, `src/lib/calendar.ts` | Scenario accounts drive the integration tests; E2E starts the sandbox clock at the fixture instant | Simulator console page (S8) |

## S4 — Single payments and approvals

| Task | Status | Paths | Executed checks | Remaining gaps |
|---|---|---|---|---|
| PAY-101 beneficiaries and name enquiry | in-progress | `src/server/domain/payments/beneficiaries.ts`, `src/features/payments/client/beneficiary-form.tsx` | Name-matched fixture beneficiary used in E-02 | Close-match/mismatch journeys |
| PAY-102 own/LYPay/ACH wizard, preview, draft, submit | in-progress | `src/server/domain/payments/service.ts`, `src/features/payments/client/payment-wizard.tsx` | Integration: preview, idempotent create, submit; E-02 wizard in EN and AR | I-23 own transfer, ACH window cases |
| PAY-103 approval queue/detail, distinct votes | in-progress | `src/server/domain/approvals/service.ts`, `src/features/approvals/**` | Self-approval denied in UI and API; approval replay has no second effect (E-02) | I-09, I-10 concurrent votes; E-03 two checkers |
| PAY-104 release, execution, timeline, events | in-progress | `src/server/domain/execution/*`, `src/server/domain/payments/service.ts` | E-02: worker settles; balance −125.500, usage +125.000, statement/timeline/audit share one execution reference | I-20 duplicate/out-of-order events, I-22 return |
| PAY-105 scheduling, cut-off, cancel, reapproval | in-progress | same | Code paths exist | I-16, I-24, E-03, E-05 not yet written |

## S5 — Bulk engine

| Task | Status | Paths | Executed checks | Remaining gaps |
|---|---|---|---|---|
| BAT-101 templates, bounded ingestion, validation | not-started | | | |
| BAT-102 accepted set, preview, batch approval | not-started | | | |
| BAT-103 child dispatch, reservations, derived state | not-started | | | |
| BAT-104 failed-row retry, result export | not-started | | | |

## S6 — Payroll

| Task | Status | Paths | Executed checks | Remaining gaps |
|---|---|---|---|---|
| PYR-101 employee master/import, components | not-started | | | |
| PYR-102 payroll upload, duplicates, scheduling | not-started | | | |
| PYR-103 aggregate checker projection, restricted detail | not-started | | | |
| PYR-104 aggregate statement projection, safe retry | not-started | | | |

## S7 — Collections and teller deposits

| Task | Status | Paths | Executed checks | Remaining gaps |
|---|---|---|---|---|
| COL-101 customers, import, export, invoices | not-started | | | |
| COL-102 teller capture, manager approval | not-started | | | |
| COL-103 cash post, cheque clear/return | not-started | | | |
| COL-104 timeline, receipts, allocation | not-started | | | |

## S8 — Reports, operations, insight

| Task | Status | Paths | Executed checks | Remaining gaps |
|---|---|---|---|---|
| OPS-101 report jobs and downloads | not-started | | | |
| OPS-102 unknown/failed queue, inquiry, repair | in-progress | `src/server/domain/operations/{service,register}.ts`, `src/app/[locale]/bank/operations/**` | `tests/integration/s8-operations.test.ts` (5): inquiry acknowledges a booked posting once; "not found" stays unknown; repair needs inquiry first and an independent approver; same-reference resubmission books once; a resolved execution cannot be repaired; bank isolation | E-04 journey through the UI not yet run |
| OPS-103 reconciliation and breaks | in-progress | `src/server/domain/operations/{reconciliation,simulator}.ts`, `src/app/[locale]/bank/{reconciliation,simulator}/**` | `tests/integration/s8-reconciliation.test.ts` (4): I-43 five break kinds with unchanged ledger, append-only dispositions, visible failure when the core is offline, audited simulator switches | Deposit postings join the expected set with S7; UI journey not yet run |
| OPS-104 alerts and audit search | not-started | | | |

## S9 — API product foundation

| Task | Status | Paths | Executed checks | Remaining gaps |
|---|---|---|---|---|
| API-101 OpenAPI parity, errors, idempotency | not-started | | | |
| API-102 sandbox tokens, quotas, developer UI | not-started | | | |
| API-103 signed durable webhooks | not-started | | | |
| API-104 SSRF-hardened destinations | not-started | | | |

## S10 — Hardening and handoff

| Task | Status | Paths | Executed checks | Remaining gaps |
|---|---|---|---|---|
| REL-001 bilingual UX/a11y/responsive/PWA pass | not-started | | | Physical-device checks P-02/P-03 require real devices |
| REL-002 full verification suite | not-started | | | |
| REL-003 fresh-checkout provisioning and restart | not-started | | | |
| REL-004 security/dependency review, load samples | not-started | | | |
| REL-005 runbook, env sample, requirement map | not-started | | | |

## Mobile/PWA tasks (document 12)

| Task | Slice | Status | Notes |
|---|---|---|---|
| MOB-101 | S0/S1 | in-progress | See S0 |
| MOB-102 | S1–S7 | in-progress | Shell, payment wizard, approval review, agreement and audit screens usable at 390 px in Arabic (Chromium emulation only) |
| MOB-103 | S3/S4 | in-progress | `SessionGuard` masks content offline and on foreground revalidation; lost-response handling in `useCommand`. P-05/P-06/P-07 tests pending |
| MOB-104 | S8/S9 | not-started | |
| MOB-105 | S10 | not-started | |

## Known blockers

- **Docker is not available in the implementation environment.** PostgreSQL 16.15 runs as a local
  cluster instead; `compose.yaml` is provided for reviewers but was not executed here.
- **No physical Android/iOS device is available.** P-02, P-03 and the device parts of P-09/P-10 stay
  pending; browser emulation is recorded separately and is not offered as device evidence.
