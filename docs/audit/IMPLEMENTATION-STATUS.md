# Implementation status — Al Qarib GTB sandbox MVP (R1)

Maintained by the implementer. It is **not** an independent audit verdict; the reviewer applies
document 08 and writes the verdict into [IMPLEMENTATION-REVIEW.md](IMPLEMENTATION-REVIEW.md).

- Started 2026-11-26 from planning handoff commit `972d6af` (documents 01–12, no application code).
- Status at tested revision **`dc2fa68`** (2026-11-27). Executed checks, exit codes and counts:
  [evidence/gate-dc2fa68.md](evidence/gate-dc2fa68.md).
- Statuses: `verified` — the task's exit evidence was executed and passed at the tested revision;
  `in-progress` — working code exists but part of the documented exit evidence is missing (the
  missing part is named); `not-started`; `blocked`.
- "Emulation" always means Chromium desktop or Chromium phone emulation. Nothing in this file is a
  physical-device result.

## Executed at the tested revision

| Check | Command | Result |
|---|---|---|
| Frozen install | `pnpm install --frozen-lockfile` | exit 0 (also on a fresh GitHub Actions checkout) |
| Lint | `pnpm lint` | clean, 0 warnings |
| Types | `pnpm typecheck` | clean (application, worker, scripts, tests) |
| Unit | `pnpm test:unit` | 225 passed / 225 |
| Integration, real PostgreSQL 16 | `pnpm test:integration` | 59 passed / 59 |
| Contract | `pnpm test:contract` | 5 passed / 5 |
| OpenAPI drift | `pnpm openapi:check` | up to date, 116 operations |
| Dependency audit | `pnpm audit` | no known vulnerabilities |
| Production build and worker bundle | `pnpm build` | succeeded |
| Browser journeys, production build, separate worker, own database | `pnpm test:e2e --trace off` | 36 passed / 36 (18 journeys × English desktop and Arabic 390 px emulation) |
| Fresh database, seed twice | `pnpm db:reset-demo --yes`, `pnpm db:seed` | second seed created nothing |
| Business smoke against the running app and worker | `pnpm smoke` | passed, 13 checks |
| Worker killed, app stopped, both restarted | `pnpm smoke --restart-check` | passed, one debit |
| CI on GitHub Actions (fresh checkout, PostgreSQL 16.16 service) | `.github/workflows/ci.yml` | success on `dc2fa68` (run #6) and on `c8581d9` (run #5), both jobs |

No test is skipped, marked expected-to-fail or excluded. Nothing was run against a real bank system.

## S0 — Repository and executable foundations

| Task | Status | Paths | Executed evidence | Remaining gaps |
|---|---|---|---|---|
| FND-001 inventory, version pins | verified | `package.json`, `.node-version`, DEC-001/002 | Pinned toolchain installs and builds | — |
| FND-002 Next.js strict TS, scripts | verified | `next.config.ts`, `tsconfig.json`, `eslint.config.mjs` | Frozen install, lint, typecheck, 225 unit tests, build | — |
| FND-003 PostgreSQL, migrations, worker | verified | `prisma/schema/*`, `prisma/migrations/*`, `scripts/db-*.ts`, `scripts/dev-postgres.sh`, `worker/index.ts`, `compose.yaml` | Fresh migration with separate owner/runtime roles; worker heartbeat (`pnpm worker:status`); `tests/unit/migrations.test.ts` | `compose.yaml` **not executed** (no Docker). The admin-URL path it needs was broken until `848e538` and is now executed locally over TCP and in CI |
| FND-004 contracts, money, clock, logging | verified | `src/contracts/*`, `src/server/{clock,logging,hash}.ts`, `src/lib/calendar.ts` | U-MON, U-CAL, log redaction tests | — |
| FND-005 CI | verified | `.github/workflows/ci.yml` | Run #6 green on `dc2fa68`: both jobs, PostgreSQL 16 service; lint, types, unit, integration, contract, OpenAPI check, build and the 36 journeys executed there | Runs #1–#2 failed on the provisioning defect above; #3–#4 were cancelled by newer pushes |

## S1 — Identity, tenant boundary and bilingual shell

| Task | Status | Paths | Executed evidence | Remaining gaps |
|---|---|---|---|---|
| IAM-001 sessions, hashing, throttle, CSRF | verified | `src/server/auth/*`, `src/server/api/framework.ts` | I-52 (cross-site write refused, throttle without user enumeration), I-32 (suspension ends sessions), P-07 (sign-out ends every tab), E-11c | — |
| IAM-002 membership context, grants | verified | `src/server/auth/{context,session,permissions}.ts` | I-01, I-02, I-03, I-07; `tests/unit/permissions.test.ts`; cross-corporate and cross-bank refusals in every slice test | — |
| IAM-003 layouts, EN/AR, sandbox indicator | verified | `src/features/shell/*`, `src/i18n/*`, `src/app/[locale]` | i18n key parity and Arabic-text test; all journeys in both languages; E-11a/b/c | No tracked screenshot set (assertions instead) |
| IAM-004 seed | verified | `src/server/seed/*`, `prisma/seed.ts` | Seed twice; 29 synthetic identities; 2 banks, 3 corporates | — |

## S2 — Agreements, policy and governance

| Task | Status | Paths | Executed evidence | Remaining gaps |
|---|---|---|---|---|
| GOV-001 module registry, templates, agreement schema | verified | `src/contracts/{modules,agreement}.ts`, migration `…_module_registry` | Registry/table equality at migrate; I-07; E-01 | — |
| GOV-002 proposal, review, activation, history | verified | `src/server/domain/agreements/service.ts`, `src/app/[locale]/bank/**` | I-04 (draft, unsigned, not-yet-effective, expired, suspended, restore by a second administrator), I-05, I-06 (20 racing votes, one revision in force), E-01 | Rail-parameter proposals have code and a screen but no dedicated test |
| GOV-003 fee, rail, limit, approval evaluators | verified | `src/server/policy/evaluate.ts` | U-LIM-01..08, U-APR-01..03 (53 tests) | — |
| GOV-004 usage counters and reservations | verified | `src/server/policy/reservations.ts` | I-13, I-14, I-17 on PostgreSQL | — |
| GOV-005 corporate user and rule proposals, suspension | **in-progress** | `src/server/domain/admin/*`, `(corporate)/admin/users` | I-31, I-32, invitation test, E-09a | **Corporate approval-rule proposals are not built**; the page says so |
| GOV-006 read-only agreement and limits, admin APIs | verified | `(corporate)/{agreement,limits,products}` | E-01; I-45 (a token cannot reach bank operations) | — |

## S3 — Simulated core, accounts and recovery primitive

| Task | Status | Paths | Executed evidence | Remaining gaps |
|---|---|---|---|---|
| COR-001 core and rail ports, simulated ledger | **in-progress** | `src/server/adapters/**`, schema `simcore` | Balanced journals (deferred trigger); exact balances, holds, settlement control and fee income asserted in integration tests | **No separate adapter contract test suite**: the port is exercised through the engine only |
| COR-002 accounts, balances, statements | verified | `src/server/domain/accounts/service.ts`, `(corporate)/accounts/**` | Booked/available/holds and statement lines in integration, E-02 and smoke | 10,000-entry performance sample not run |
| COR-003 durable jobs, outbox, stable references, inquiry | verified | `src/server/jobs/*`, `src/server/domain/execution/*`, `worker/index.ts` | I-17, I-18, I-19, I-21, I-48; restart check with real processes | — |
| COR-004 simulator scenarios, clock, calendars | verified | `src/server/adapters/core/simulator-*.ts`, `src/server/domain/operations/simulator.ts`, `bank/simulator` | I-20, I-22, I-24, I-43; U-CAL | — |

## S4 — Single payments and approvals

| Task | Status | Paths | Executed evidence | Remaining gaps |
|---|---|---|---|---|
| PAY-101 beneficiaries and name check | **in-progress** | `src/server/domain/payments/beneficiaries.ts`, `(corporate)/beneficiaries` | Matched beneficiary in E-02 and smoke; name mismatch on bulk and payroll rows | **No test of the close-match acknowledgment, archive, or history snapshot of a single beneficiary** |
| PAY-102 wizard, preview, draft, submit | verified | `src/server/domain/payments/service.ts`, `payment-wizard.tsx` | Gate test, E-02 in both languages, I-23 | — |
| PAY-103 approval queue, distinct votes | verified | `src/server/domain/approvals/service.ts`, `src/features/approvals/**` | I-08, I-09, I-10 (20 simultaneous votes), two-checker payments in I-14 | Two-checker flow not driven through the browser (E-03) |
| PAY-104 release, execution, timeline, events | verified | `src/server/domain/execution/*` | I-15, I-16, I-17, I-18, I-20, I-21, I-22; E-02; smoke | — |
| PAY-105 scheduling, cut-off, cancel, reapproval | verified | same | I-15, I-16, I-24; U-CAL-01..05 | Not driven through the browser (E-05) |

## S5 — Bulk engine

| Task | Status | Paths | Executed evidence | Remaining gaps |
|---|---|---|---|---|
| BAT-101 templates, bounded ingestion, validation | verified | `src/server/files/*`, `src/server/domain/batches/{service,validation}.ts` | U-IMP (parser, formulas, size caps, duplicates, mixed currency), I-25 | — |
| BAT-102 accepted set, preview, approval | verified | `src/server/domain/batches/{service,state}.ts` | I-25, I-26; E-06 | — |
| BAT-103 child dispatch, reservations, derived state | verified | same, `src/server/domain/execution/*` | 100-row file, exact balance and usage, I-27; U-STA-05 | — |
| BAT-104 failed-row retry, result export | verified | same | I-27, I-28 (concurrent retries); E-06 | Writes are session-only: a token cannot upload (DEC-023) |

## S6 — Payroll

| Task | Status | Paths | Executed evidence | Remaining gaps |
|---|---|---|---|---|
| PYR-101 employee master and import, components | **in-progress** | `src/server/domain/payroll/employees.ts`, `(corporate)/payroll/employees` | U-PYR-01..04; employee import **API** tested | **No screen for the employee file import** (single add/edit screen exists; a note on the page says so) |
| PYR-102 upload, duplicates, changes, scheduling | verified | `src/server/domain/batches/*`, `src/server/domain/payroll/detail.ts` | I-29; salary-change acknowledgment and correction test; E-07 | — |
| PYR-103 aggregate projection, restricted detail | verified | `src/server/domain/payroll/detail.ts`, `src/features/batches/*` | I-30, I-51; tokens, report files, PDFs, webhooks (third payroll test); E-07 page scans | — |
| PYR-104 aggregate statement, safe retry | verified | `src/server/domain/accounts/service.ts` | One `PAYROLL_RUN` line per run in JSON, CSV, PDF and through a token | — |

## S7 — Collections and teller deposits

| Task | Status | Paths | Executed evidence | Remaining gaps |
|---|---|---|---|---|
| COL-101 customers, import, export, invoices | **in-progress** | `src/server/domain/collections/service.ts`, `(corporate)/customers/**` | I-33, I-34 | **Not built: customer file import, CSV export, bulk archive, invoice edit/void.** Single create/edit/archive and invoice creation work |
| COL-102 teller capture, manager approval | verified | `src/server/domain/collections/deposits.ts`, `bank/{teller,branch-approvals}` | I-35, I-36; E-08 | — |
| COL-103 cash post, cheque clear/return | verified | same | I-37, I-38 | — |
| COL-104 timeline, receipts, allocation | **in-progress** | same, `(corporate)/deposits/**` | I-39; receipt PDF in E-08 | **I-40 not implemented**: a deposit that was posted and allocated cannot be returned (DEC-033) |

## S8 — Reports, operations, insight

| Task | Status | Paths | Executed evidence | Remaining gaps |
|---|---|---|---|---|
| OPS-101 report jobs and downloads | verified | `src/server/domain/reports/service.ts`, `(corporate)/reports` | I-41, I-42; statement CSV and PDF (EN/AR) content checks | Deposit summary is CSV only (no PDF) |
| OPS-102 unknown/failed queue, inquiry, repair | verified | `src/server/domain/operations/service.ts`, `bank/operations/**` | I-18, I-19, repair approval and isolation tests | Not driven through the browser (E-04) |
| OPS-103 reconciliation and breaks | verified | `src/server/domain/operations/reconciliation.ts`, `bank/reconciliation/**` | I-43, append-only dispositions, core-offline failure | — |
| OPS-104 alerts and audit search | **in-progress** | `src/server/domain/alerts/service.ts`, `src/server/domain/audit/service.ts` | I-50; audit search in smoke and E-02; I-44 | **Alert rules cannot be created or edited** (two seeded rules are evaluated) |

## S9 — API product foundation

| Task | Status | Paths | Executed evidence | Remaining gaps |
|---|---|---|---|---|
| API-101 OpenAPI parity, errors, idempotency | verified | `src/server/api/{framework,registry,openapi}.ts`, `docs/api/openapi.json` | Contract tests; `openapi:check`; I-11, I-12 | curl examples in the runbook were written from the contract, not replayed one by one |
| API-102 tokens, quotas, developer screen | verified | `src/server/domain/developer/service.ts`, `(corporate)/developer` | I-45, I-46; E-09b | — |
| API-103 signed durable webhooks | **in-progress** | same, `src/server/adapters/webhooks/transport.ts` | U-EVT, I-48, I-49 | **No secret rotation and no manual replay** |
| API-104 SSRF-hardened destinations | verified | `src/server/net/ssrf.ts` | I-47 (private IPv4/IPv6, redirect, DNS rebinding); 33 unit tests | — |

## S10 — Hardening and handoff

| Task | Status | Paths | Executed evidence | Remaining gaps |
|---|---|---|---|---|
| REL-001 bilingual, accessibility, responsive, PWA, device pass | **in-progress** | `src/pwa/*`, `tests/e2e/{e11-accessibility,pwa}.spec.ts` | E-11a/b/c; P-01, P-04..P-08, P-10, P-11 in emulation | **No physical device** (P-02, P-03, device parts of P-09/P-10); **P-12 other engines not run** |
| REL-002 full verification suite | **in-progress** | `tests/**` | 225 unit, 59 integration, 5 contract, 36 journeys | I-40 missing; E-03, E-04, E-05, E-10, E-12 not as browser journeys; no adapter contract suite |
| REL-003 fresh setup and restart | verified | `scripts/*`, `docs/RUNBOOK.md` | Two fresh provisions (local, CI); seed twice; smoke; restart check | Docker path not executed |
| REL-004 security and dependency review, load samples | **in-progress** | — | `pnpm audit` clean; secret and shortcut searches (review file) | **No performance measurement** |
| REL-005 runbook, environment sample, requirement map | verified | `README.md`, `docs/RUNBOOK.md`, `.env.example`, review file | Commands in the runbook are the ones executed | — |

## Mobile and PWA tasks (document 12)

| Task | Status | Evidence | Gaps |
|---|---|---|---|
| MOB-101 manifest, icons, worker baseline | verified (emulation) | P-01, P-04/P-11 | Installation on a device not checked |
| MOB-102 mobile navigation, forms, approvals, imports | verified (emulation) | All 18 journeys at 390 px in Arabic, including file selection and approval review | 360 px checked for overflow only (P-10) |
| MOB-103 offline masking, lost response, session lifecycle | verified (emulation) | P-05, P-06, P-07 | — |
| MOB-104 mobile PDF/file flows, alerts, reports | in-progress | File upload via the page's file input in emulation; receipt and report downloads | A real phone file picker and PDF viewer were never used |
| MOB-105 production-mode PWA tests, device evidence, runbook | in-progress | P-01, P-04..P-08, P-10, P-11 on the production build | P-02, P-03, P-12 pending |

### P-01..P-12

| ID | How checked | Result |
|---|---|---|
| P-01 manifest and icons | Automated, production build | Passed (both layouts). HTTPS origin not inspected: `localhost` only |
| P-02 Android Chrome install | — | **Pending: no device** |
| P-03 iPhone Safari Add to Home Screen | — | **Pending: no device** |
| P-04 offline start, storage inspection | Automated emulation | Passed: one cache holding exactly the allowlisted public files; no IndexedDB database; local storage, session storage and readable cookies contain no banking data, identity or token (the code's only local-storage use is the install-prompt dismissal flag) |
| P-05 lose the network on an open page | Automated emulation | Passed: content masked, actions disabled |
| P-06 lost response during approval | Automated emulation | Passed: result checked with the server, one approval, one debit |
| P-07 sign-out, other tab, Back | Automated emulation | Passed |
| P-08 update while a form is open | Automated emulation, production build | Passed: waits, refuses under the open form, clean switch, no replay |
| P-09 mobile CSV/XLSX upload, PDF receipt EN/AR | Partly: upload through the file input in emulation (E-06, E-07); Arabic PDF shaping by unit test and by reading PDF text back | **Device part pending** (real file picker, PDF viewer) |
| P-10 360/390 px, landscape, text zoom, keyboard | Automated emulation: no page-level horizontal overflow; 200% approximated by root font size (DEC-039) | Passed in emulation. **On-screen keyboard not checked** |
| P-11 API/RSC/auth/downloads through the worker | Automated emulation | Passed: network-only, nothing cached |
| P-12 other desktop browsers, installed mode | — | **Not run**: only Chromium is installed here |

## Document 07 coverage

**Browser journeys.** E-01, E-02, E-06, E-07, E-08, E-09, E-11: automated in both layouts. E-03
(two checkers, fee change), E-04 (unknown recovery), E-05 (scheduling), E-10 (developer: token
payment, signed event) and E-12 (clean restart) are **not browser journeys**; their behaviour is
tested on PostgreSQL through the HTTP API (I-14, I-16, I-18, I-19, I-24, I-45..I-49) and E-12 by
`pnpm smoke --restart-check` with real processes. E-06 uses a 5-row file in the browser; the
100-row file is the integration test. E-07 does not import employees through a screen. E-08 does
not import a customer file.

**Integration cases.** Covered by executed tests: I-01..I-39 and I-41..I-52, **except** the parts
listed here. I-40 — not implemented. I-04 — draft, unsigned, future, expired and suspended are
covered; "closed" is not. I-27 — unknown rows are excluded from retry and resolved by operations;
covered. I-33 — the "import duplicates inside A" half is not applicable (no customer import).
I-41 — covered for statement and deposit CSV; customer CSV export does not exist.

**Unit groups.** U-MON, U-LIM-01..08, U-APR-01..03, U-STA-05, U-IMP-01..07, U-PYR-01..04, U-CAL-01..05,
U-EVT-01..04: executed. U-APR-04/05 (maker never votes, changed proposal voids votes) and
U-STA-01..04 (legal transitions, accepted ≠ settled, unknown not retryable, return linked) have
**no pure unit test**: there is no separate transition table — the engine moves states by
compare-and-set in PostgreSQL — and they are proven by I-05, I-08, I-18..I-22, I-26 instead.
U-PYR-05 (redaction projections) is proven by the payroll integration tests, not a unit test.

**Performance, load.** Not measured.

## Named gaps

Deferred inside R1 under DEC-041. None of these is presented as working.

| Gap | Requirement | What exists instead |
|---|---|---|
| Employee file import screen | PYR-01, PYR-101 | API (preview, commit) with tests; single add/edit screen |
| Customer file import, CSV export, bulk archive | COL-01, COL-101, I-33, I-41 | Single create/edit/archive |
| Invoice edit and void | COL-01 | Invoice creation and allocation |
| Return of a posted, allocated deposit | COL-03, COL-104, I-40 | Cheque return before clearing only |
| Deposit summary as PDF | RPT-01, OPS-101 | CSV |
| Create or edit alert rules | ALT-01, OPS-104 | Two seeded rules, evaluated and deduplicated |
| Webhook secret rotation, manual replay | EVT-01, API-103 | Automatic retries with a stable event id |
| Corporate approval-rule proposals | ADM-02, GOV-005 | Bank bands enforced; the evaluator accepts stricter corporate bands; page marked "not available" |
| Batch upload through an API token | API-01, BAT-01 | Session-only writes; tokens read bulk batches |
| Beneficiary close-match, archive and snapshot tests | PAY-01, PAY-101 | Code and screen; matched path tested |
| Rail-parameter proposal test | AGR-02 | Code and screen; same approval mechanism as agreements |
| Adapter contract test suite | COR-001 | Ports exercised through the engine in integration tests |
| Browser journeys E-03, E-04, E-05, E-10, E-12 | Document 07 | Integration tests and the smoke command |
| Performance and load samples | Document 03, REL-004 | — |
| Other browser engines (P-12) | Document 12 | Chromium only |
| Physical devices (P-02, P-03, device parts of P-09, P-10) | Document 12 | Emulation, reported as emulation |
| Docker Compose run | Document 11 | Local cluster path; admin-URL path executed locally and in CI |
| Backup/restore drill | Document 11 | Commands documented |

Catalogue modules outside R1 (19 of 33: RTGS, payment links, QR collections, virtual accounts,
auto-reconciliation and sweeping, cash concentration, host-to-host, cash forecasting, SWIFT,
certified cheque, escrow, documentary collections, letters of credit, guarantees, cheque issuance
and management, cards, ERP connectors) are roadmap entries only. They are listed on the Products
page as unavailable and an agreement cannot enable them (I-07).

## Simulation boundaries

- **Core banking**: an isolated simulated ledger in the `simcore` schema. No Temenos, FLEXCUBE or
  any real core.
- **Rails**: LYPay and ACH are deterministic simulations with scenario accounts. No LYPay, ACH,
  CBL, SWIFT or card connection exists. Cut-off times, calendars, ceilings, fees and limits are
  test policy labelled "demo, unconfirmed".
- **Name check**: a comparison against a synthetic directory.
- **Signatures**: agreement signature evidence is a labelled simulated attestation.
- **Strong authentication**: none beyond password sign-in; nothing is presented as bank SCA.
- **E-mail and SMS**: none. Invitations appear in a sandbox inbox on the administration page.
- **Webhooks**: real HTTPS delivery code with SSRF protection; tests use an in-memory receiver.
- **Stamps on receipts and reports**: visibly marked simulated.

## Known limitations

- Content-Security-Policy allows inline scripts (DEC-014).
- The sandbox clock and availability switches apply to the whole sandbox, not per bank.
- A payroll run with one settled line shows that line's amount as the run total (DEC-037).
- A revision superseded at the instant it started keeps its proposed dates (DEC-036).
- The fixed fee is not refunded when a payment is returned (DEC-015).
- A web app cannot prevent screenshots or remove a saved PDF from a device.
- One deprecation warning from the PostgreSQL driver appears in test output; it does not affect results.

## Corrections of the record

- Commit `158ea60` said 119 unit tests passed while one failed (an Arabic report label had no
  Arabic text; the check piped through `grep` and did not gate on the exit code). Fixed in
  `f95a6d5`; every later result in this repository is gated on exit codes.
- Earlier versions of this file and DEC-002 said `compose.yaml` was provided. It did not exist
  until `33dbba9`.
- `pnpm smoke` and `pnpm worker:status` were named in `package.json` without their script files
  until `33dbba9`.
- `pnpm db:local` with `POSTGRES_ADMIN_URL` did not work until `848e538`.
- Integration test teardown was observed failing at random — 3 of 6 consecutive runs, every test
  passing and the database drop refused — before commit `74bd384`, which fixed it (DEC-038).
