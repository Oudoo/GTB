# Implementation status — Al Qarib GTB sandbox MVP (R1)

Statuses: `not-started`, `in-progress`, `verified`, `blocked`. A task is `verified` only when its exit
evidence was actually executed; the commands and counts are recorded in
[IMPLEMENTATION-REVIEW.md](IMPLEMENTATION-REVIEW.md). This file is maintained by the implementer and is
**not** an independent audit verdict.

Started: 2026-11-26 from planning handoff commit `972d6af` (documents 01–12, no application code).

## S0 — Repository and executable foundations

| Task | Status | Paths | Executed checks | Remaining gaps |
|---|---|---|---|---|
| FND-001 inspect repo, inventory, version pins | in-progress | `package.json`, `.node-version`, `docs/planning/IMPLEMENTATION-DECISIONS.md` | Environment inventory recorded in decisions DEC-001/002 | — |
| FND-002 Next.js strict TS scaffold, scripts | in-progress | `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `src/app` | `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `next build` ran green on the scaffold | Frozen-lockfile install to be re-run on the final revision |
| FND-003 PostgreSQL, Prisma migrations, worker | in-progress | `prisma/schema/*`, `prisma/migrations/*`, `scripts/db-migrate.ts`, `worker/` | Migrations applied to PostgreSQL 16.15 with separate owner/runtime roles | Worker entry and heartbeat pending |
| FND-004 contracts, money, clock, logging | in-progress | `src/contracts/*`, `src/server/{clock,calendar,logging,hash}.ts` | Unit tests U-MON-01..06, U-CAL-01..05, log redaction | — |
| FND-005 CI workflow | not-started | `.github/workflows/ci.yml` | — | — |
| MOB-101 manifest, icons, safe worker baseline | in-progress | `src/app/manifest.ts`, `src/pwa/*`, `public/offline.html`, `public/icons/*` | Service worker builds from allowlist | Production-mode cache tests pending (S10) |

## S1 — Identity, tenant boundary and bilingual shell

| Task | Status | Paths | Executed checks | Remaining gaps |
|---|---|---|---|---|
| IAM-001 auth/session, hashing, throttle, CSRF | not-started | | | |
| IAM-002 membership context, scoped repositories, grants | not-started | | | |
| IAM-003 layouts/navigation, EN/AR, sandbox indicator | not-started | | | |
| IAM-004 seed roles, corporates, banks, accounts | not-started | | | |

## S2 — Agreements, policy and governance

| Task | Status | Paths | Executed checks | Remaining gaps |
|---|---|---|---|---|
| GOV-001 module registry, templates, agreement schema | in-progress | `src/contracts/modules.ts`, migration `20261126000200_module_registry` | Registry/table equality asserted by `pnpm db:migrate` | |
| GOV-002 bank proposal/diff/activation/history | not-started | | | |
| GOV-003 fee/rail/limit/approval evaluators | not-started | | | |
| GOV-004 usage counters/reservations under contention | not-started | | | |
| GOV-005 corporate user/rule proposals, suspension | not-started | | | |
| GOV-006 read-only agreement/limits UI and admin APIs | not-started | | | |

## S3 — Simulated core, accounts and recovery primitive

| Task | Status | Paths | Executed checks | Remaining gaps |
|---|---|---|---|---|
| COR-001 core/rail ports, simulated ledger | not-started | | | |
| COR-002 accounts/balances/statements | not-started | | | |
| COR-003 durable jobs/outbox, stable references, inquiry | not-started | | | |
| COR-004 simulator scenarios, test clock, calendars | not-started | | | |

## S4 — Single payments and approvals

| Task | Status | Paths | Executed checks | Remaining gaps |
|---|---|---|---|---|
| PAY-101 beneficiaries and name enquiry | not-started | | | |
| PAY-102 own/LYPay/ACH wizard, preview, draft, submit | not-started | | | |
| PAY-103 approval queue/detail, distinct votes | not-started | | | |
| PAY-104 release, execution, timeline, events | not-started | | | |
| PAY-105 scheduling, cut-off, cancel, reapproval | not-started | | | |

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
| OPS-102 unknown/failed queue, inquiry, repair | not-started | | | |
| OPS-103 reconciliation and breaks | not-started | | | |
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
| MOB-102 | S1–S7 | not-started | |
| MOB-103 | S3/S4 | not-started | |
| MOB-104 | S8/S9 | not-started | |
| MOB-105 | S10 | not-started | |

## Known blockers

- **Docker is not available in the implementation environment.** PostgreSQL 16.15 runs as a local
  cluster instead; `compose.yaml` is provided for reviewers but was not executed here.
- **No physical Android/iOS device is available.** P-02, P-03 and the device parts of P-09/P-10 stay
  pending; browser emulation is recorded separately and is not offered as device evidence.
