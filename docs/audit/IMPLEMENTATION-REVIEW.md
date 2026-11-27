# Al Qarib implementation review

**Current status: IMPLEMENTER EVIDENCE SUPPLIED — INDEPENDENT AUDIT NOT YET PERFORMED.**

Everything below was written by the implementer (Claude) from checks actually executed at the
revision named in the first table. It is evidence offered to the reviewer, not a judgement. The
verdict, the hard-gate results and the scores are left empty for the independent reviewer (Codex),
who should reproduce the commands rather than trust this file. Gaps are stated where they exist;
a missing entry is not a pass.

## Review identity

| Field | Value |
|---|---|
| Implementer | Claude (Anthropic), in a cloud session on branch `claude/sweet-knuth-tetgjn`, pull request [Oudoo/GTB#1](https://github.com/Oudoo/GTB/pull/1) |
| Independent reviewer | Pending (Codex) |
| Evidence date | 2026-11-27 (UTC) |
| Tested code revision | `dc2fa68b2a6321dfc63ca192d146aad6e978d5e3`. Later commits on the branch change documentation only (`git diff --stat dc2fa68 HEAD` lists files under `docs/` and `README.md` only) |
| Node / pnpm / Next / PostgreSQL | Node 24.22.3, pnpm 10.28.0, Next.js 16.4.6, React 19.3.1, TypeScript 6.0.3, Prisma 7.10.1, PostgreSQL 16.15 (local) and 16.16 (CI), Playwright 1.63.0 with Chromium |
| Host | Implementation environment: Linux 6.18 container, 4 CPUs, 15 GiB RAM. CI: GitHub Actions `ubuntu-24.04` |
| Scope offered for review | R1 as defined in documents 01–12: 14 delivered modules, slices S0–S10 |
| Excluded | 19 deferred catalogue modules (roadmap entries only); the named gaps in [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md#named-gaps); all physical-device checks; all real bank, rail, e-mail and SMS integrations |
| Verdict / score | **Pending independent audit** |

## Setup and execution evidence

Transcript with exit codes and counts: [evidence/gate-dc2fa68.md](evidence/gate-dc2fa68.md).
Commands are in [docs/RUNBOOK.md](../RUNBOOK.md). Generated logs and Playwright reports are not
tracked; they are re-created by the commands.

| Check | Command / environment | Actual result | Notes |
|---|---|---|---|
| Frozen dependency installation | `pnpm install --frozen-lockfile` — locally and on a fresh CI checkout | exit 0 both | |
| Fresh DB migration + runtime grants | `pnpm db:local`, `pnpm db:migrate`; also `pnpm db:reset-demo --yes` | exit 0; 3 migrations; registry of 33 modules verified | Owner role `alqarib_owner` (not superuser), runtime role `alqarib_app` (no DDL; no UPDATE/DELETE on audit) |
| Seed and second seed | `pnpm db:seed` twice | first: 29 identities, 6 opening balances; second: 0 and 0 | |
| App + worker readiness and smoke | `pnpm start`, `pnpm worker:start`, `/api/v1/health/ready`, `pnpm worker:status`, `pnpm smoke` | ready 200; worker alive; smoke passed (13 checks) | The smoke is the first demonstration: two bank administrators, maker, checker, worker, exact balances, replay |
| Lint and strict typecheck | `pnpm lint`, `pnpm typecheck` | exit 0, 0 warnings | `strict`; no `any`, no `@ts-ignore`, no `eslint-disable` in the repository |
| Unit tests | `pnpm test:unit` | 225 passed, 0 failed, 0 skipped (11 files) | |
| PostgreSQL integration and race tests | `pnpm test:integration` | 59 passed, 0 failed, 0 skipped (10 files) | Real PostgreSQL; requests go through the real dispatcher with real sign-in; races released by a barrier, 20 simultaneous requests for votes and idempotency |
| Adapter / API contract tests | `pnpm test:contract`, `pnpm openapi:check` | 5 passed; 116 operations, no drift | API contract only. **No adapter contract suite** |
| End-to-end distinct-person journeys | `pnpm test:e2e --trace off` | 36 passed, 0 skipped, 0 flaky | 18 journeys × English desktop and Arabic 390 px emulation; each actor signs in through the form in their own browser context |
| Production build/start + worker | `pnpm build`, then the rows above | exit 0 | Journeys and smoke run against the production build with the worker as a separate process |
| Crash/restart recovery | Worker `SIGKILL`, app stopped, `pnpm smoke --restart-check`; I-17, I-18, I-19 | passed; one debit | Real processes for the restart; injected crash windows on PostgreSQL in I-17 |
| PWA install/offline/cache/update/device | `tests/e2e/pwa.spec.ts` on the production build | P-01, P-04..P-08, P-10, P-11 passed in emulation | **P-02, P-03, P-12 and device parts of P-09/P-10 not run** |
| Accessibility / RTL / PDF / mobile | `tests/e2e/e11-accessibility.spec.ts`; PDF text read back in tests | axe: 34 screens per layout, no finding at any level; keyboard-only sign-in and approval; direction checks | Emulation; no screen reader; no device |
| Performance measurements | — | **Not run** | |
| Secret / dependency / security review | `pnpm audit`; searches below | no known vulnerabilities; no secret in tracked files | One advisory patched by override (DEC-040) |
| Independent machine | GitHub Actions runs [#6](https://github.com/Oudoo/GTB/actions/runs/46008475900) (`dc2fa68`) and [#5](https://github.com/Oudoo/GTB/actions/runs/46007068812) (`c8581d9`) | success, both jobs | Runs #1–#2 failed on a provisioning defect, fixed in `848e538` |

Searches run on the tracked tree at the tested revision (a hit is a lead, not a defect):

| Search | Hits |
|---|---|
| `TODO`, `FIXME`, `XXX` in code | 0 (3 hits are test data: a currency code `XXX` and a placeholder-text guard) |
| `.skip(`, `.only(`, `.fixme(`, `test.fail` | 0 |
| `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `as any`, `: any` | 0 |
| `eslint-disable` | 0 |
| `localStorage`, `sessionStorage`, `indexedDB` in `src` | 1 use: the install-prompt dismissal flag (`src/pwa/install-action.tsx`) |
| Tenant/role/actor request headers (`x-tenant`, `x-role`, `x-corporate`, `x-user-id`…) | 0 |
| `rejectUnauthorized`, `NODE_TLS_REJECT_UNAUTHORIZED`, auth-bypass flags | 0 |
| Private keys; `.env`; files under `storage/` tracked by Git | 0 |
| Literal passwords, secrets, tokens | Synthetic test values in `tests/` only |

## Requirement evidence map

One row per requirement of document 02 and document 12. "Evidence" names executed tests; code
references are files and the function or line at the tested revision. Status words: **evidenced**
(executed tests cover the stated behaviour), **partly** (the gap is named), **not evidenced**.

| Requirement | Code | Executed evidence | Status / gap |
|---|---|---|---|
| SEC-01 tenant isolation | `src/server/auth/context.ts`, `src/server/auth/session.ts`; every domain query is scoped by bank/corporate and id | I-01, I-02, I-03, I-35; payroll, reports and collections tests request other tenants' objects and get 404 | evidenced |
| SEC-02 permissions | `src/server/auth/permissions.ts`; each operation declares one permission (`src/server/api/operations/*`) | `tests/unit/permissions.test.ts` (20), contract test "every non-public operation names a known permission or is an explicitly listed own-session operation", I-31 | evidenced |
| SEC-03 sessions | `src/server/auth/session.ts` (Better Auth, database sessions, throttle), CSRF in `src/server/api/framework.ts` | I-52, I-32, P-07, E-11c | evidenced. Step-up authentication is not implemented and not claimed |
| SEC-04 payroll visibility | `src/server/domain/payroll/detail.ts:7` (`requirePayrollDetail`), projections in `src/server/domain/batches/views.ts` | I-30, I-51, third payroll test (tokens, CSV, PDF, webhooks), E-07 page scans | evidenced |
| SEC-05 audit | `src/server/audit/*`; trigger `audit_event_append_only` (`prisma/migrations/20261126000100_integrity/migration.sql:166`); grants in `src/server/db/provision.ts:70-82` | I-44; audit assertions in the gate test and smoke | evidenced |
| AGR-01 effective agreement | `src/server/domain/agreements/policy.ts:45` (`loadAgreementStatus`) | I-04 (draft, unsigned, future, expired, suspended), E-01, smoke | evidenced; "closed" state not tested |
| AGR-02 two-person change | `src/server/domain/agreements/service.ts:286` (`activateVersion`); exclusion constraint `agreement_version_no_overlap` (migration line 125) | I-05, I-06, I-04 (stop and restore), E-01 | evidenced; rail-parameter proposals untested |
| AGR-03 module registry | `src/contracts/modules.ts`, migration `…_module_registry` | Registry check at migrate, I-07, E-01 | evidenced |
| ADM-01 user changes | `src/server/domain/admin/service.ts` | I-31, I-32, invitation test, E-09a | evidenced |
| ADM-02 approval rules | `src/server/policy/evaluate.ts:236` (`requiredCheckers`), `src/contracts/agreement.ts` (`validateBands`), constraint `approval_rule_no_overlap` | U-APR-01..03, I-26 | partly: corporate rule proposals are not built |
| MON-01 exact values | `src/contracts/money.ts` | U-MON (44 tests) | evidenced |
| MON-02 balance authority | `src/server/adapters/core/simulated-core.ts` | Balance, hold and journal assertions in the gate test, I-17, I-23 | evidenced |
| LIM-01 policy evaluation | `src/server/policy/evaluate.ts:110` (`evaluateLimits`) | U-LIM-01..08 | evidenced |
| LIM-02 usage semantics | `src/server/policy/reservations.ts`, `src/lib/calendar.ts` | Gate test (principal only), I-22, I-23, U-CAL-05 | evidenced |
| LIM-03 atomic reservation | `src/server/policy/reservations.ts:53,74` (`lockCounters`, `reserveLimits`) | I-13, I-14, I-17, I-24 | evidenced |
| LIM-04 fees | `quoteFee`; `comparePolicy` in `src/server/domain/payments/service.ts` | Gate test preview, I-16 | evidenced |
| PAY-01 beneficiary | `src/server/domain/payments/beneficiaries.ts` | Matched beneficiary in gate test, E-02, smoke | partly: close match, archive and snapshot untested |
| PAY-02 proposal | `src/server/domain/payments/service.ts` | Gate test, E-02, I-23 | evidenced |
| APR-01 lifecycle | same; `src/server/domain/execution/engine.ts:179` (`casAttempt`) | Timeline order in gate test, I-20, I-21 | evidenced (no pure transition-table unit test) |
| APR-02 distinct authorization | `src/server/domain/approvals/service.ts:195,329` (`castVote`, `SELF_APPROVAL_FORBIDDEN`) | I-05, I-08, I-09, I-10, I-36, E-01, E-02, smoke | evidenced |
| APR-03 revalidation | `src/server/domain/payments/service.ts:916,983` (`releasePayment`, `blockRelease`) | I-04, I-15, I-16 | evidenced |
| PAY-03 scheduling | same; `resolveExecutionWindow` in `src/lib/calendar.ts` | U-CAL-01..04, I-15, I-16, I-24 | evidenced (no browser journey) |
| PAY-04 idempotent outcome | idempotency in `src/server/api/framework.ts`; engine | I-11, I-12, I-17, I-18, I-19, I-22, P-06, smoke | evidenced |
| BAT-01 import | `src/server/files/{csv,xlsx,tabular}.ts` | U-IMP-01..07, I-25 | evidenced |
| BAT-02 review | `src/server/domain/batches/service.ts` | I-25, I-26, E-06 | evidenced |
| BAT-03 execution | same; `deriveBatchState` | I-25, I-27, U-STA-05 | evidenced |
| BAT-04 retry | `retryFailedRows` | I-27, I-28, E-06 | evidenced |
| PYR-01 employee data | `src/server/domain/payroll/employees.ts` | U-PYR-01..04, payroll tests | partly: import has an API and tests, no screen |
| PYR-02 confidential operations | `src/server/domain/payroll/detail.ts`; statement grouping in `src/server/domain/accounts/service.ts:118` | I-30, I-51, third payroll test, E-07 | evidenced; single-line run limitation (DEC-037) |
| COL-01 customer register | `src/server/domain/collections/service.ts` | I-33, I-34 | partly: no import, export, bulk archive, invoice edit |
| COL-02 teller matching | `src/server/domain/collections/deposits.ts:194` (`captureDeposit`) | I-35, I-36, E-08 | evidenced |
| COL-03 deposit states | same, line 467 (`applyChequeEvent`) | I-37, I-38, E-08 | partly: return after posting (I-40) not implemented |
| RPT-01 statements/exports | `src/server/domain/reports/service.ts`, `src/server/files/{csv,pdf}.ts` | I-41, I-42, PDF and CSV content checks | partly: deposit summary has no PDF; no customer export |
| OPS-01 recovery | `src/server/domain/operations/{service,reconciliation}.ts` | I-18, I-19, I-43, repair tests | evidenced |
| ALT-01 alerts | `src/server/domain/alerts/service.ts` | I-50 | partly: rules cannot be created or edited |
| API-01 same controls | `src/server/api/registry.ts`; `API_SCOPES` | I-45, I-46, contract tests, E-09b | partly: batch writes are session-only (DEC-023) |
| EVT-01 durable events | `src/server/outbox.ts`, `src/server/domain/developer/service.ts:238` (`deliverWebhook`), `src/server/net/ssrf.ts:30` | U-EVT, I-47, I-48, I-49 | partly: no rotation, no manual replay |
| MOB-01 feature access | responsive screens under `src/app/[locale]` | Every journey on the phone layout | evidenced in emulation |
| MOB-02 touch layout | `src/components/ui/*`, shell | P-10 | evidenced in emulation; on-screen keyboard unchecked |
| MOB-03 navigation | `src/features/shell/*` | Journeys; P-07 | evidenced in emulation |
| MOB-04 data presentation | responsive tables and cards | E-06, E-07 on the phone layout | evidenced in emulation |
| MOB-05 inputs, files, receipts | forms, upload, downloads | E-06, E-07, E-08 on the phone layout | partly: real device file picker and PDF viewer not used |
| PWA-01 manifest | `src/app/manifest.ts`, `public/icons` | P-01 | evidenced |
| PWA-02 install UX | `src/pwa/install-action.tsx` | Rendered in journeys | **not evidenced**: no install performed |
| PWA-03 allowlist-only worker | `src/pwa/sw.template.js:59`, `scripts/build-service-worker.mjs` | P-04, P-11 | evidenced |
| PWA-04 no offline queue or storage | same; no Background Sync, no IndexedDB | P-04 | evidenced |
| PWA-05 offline and unknown behaviour | `src/features/shell/client/session-guard.tsx:33`, `src/components/command.tsx` | P-05, P-06 | evidenced in emulation |
| PWA-06 lifecycle and security | same | P-07 | evidenced in emulation |
| PWA-07 updates | `src/pwa/pwa-runtime.tsx`, `src/pwa/busy-guard.ts` | P-08 | evidenced in emulation |
| PWA-08 notifications | in-app only; no push, no permission prompt | Search: no push or notification API use | evidenced by absence |

Test identifiers of document 07 and where each is executed are listed in
[IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md#document-07-coverage).

## Hard gates

Reviewer result for every gate: **pending**. The implementer offers the following evidence and
names what is missing; no gate is declared passed here.

| Gate | Evidence offered | Known weakness the reviewer should weigh |
|---|---|---|
| H01 Real persistence and reproducibility | Fresh migrate and seed (twice) locally and in CI; all state in PostgreSQL; restart check with real processes; no client-side money state | Docker path not executed |
| H02 Tenant/account/role isolation | I-01, I-02, I-03, I-07, I-35, I-45; forged headers and body actor ids ignored; cross-bank and cross-corporate 404s; permission matrix test | — |
| H03 Agreement governance | I-04, I-05, I-06; E-01; smoke | Rail-parameter proposals untested; "closed" untested |
| H04 Independent approvals | I-05, I-08, I-09, I-10 (20 simultaneous votes), I-36; a person with both roles is refused | — |
| H05 Exact money and balanced postings | U-MON; deferred constraint trigger `sim_journal_balanced` (integrity migration, line 219) rejects a journal that does not sum to zero per currency; exact minor-unit assertions on balance, fee income and settlement control | — |
| H06 Limits under contention | I-13, I-14 on PostgreSQL with a barrier; U-LIM | — |
| H07 Exactly-once financial effect | I-11, I-12 (20 identical creates), I-17, I-18, I-19, I-20; P-06; smoke replay; restart check | — |
| H08 Payroll confidentiality | I-30, I-51; tokens, CSV, PDF (text read back), webhooks, stored side channels, logs; E-07 page scans before and after settlement | A run with one line reveals that line (DEC-037) |
| H09 Batch/deposit correctness | I-25..I-28; I-36, I-37, I-38, I-39 | I-40 not implemented |
| H10 Durable recovery and audit | I-17, I-19, I-43, I-44, I-48; restart check | — |
| H11 Honest simulation/credential handling | Sandbox indicator asserted in E-01 and shown in every shell; `src/server/env.ts:58-63` refuses any `APP_MODE` but `sandbox` and any `CORE_ADAPTER` but `simulated` at start-up; the seed refuses to run outside sandbox; no secret in the tree; demo password generated locally and never printed | CSP allows inline scripts (DEC-014) |
| H12 Verified mandatory delivery | S0–S10 statuses in the status file; journeys in both languages; P-01, P-04..P-08, P-10, P-11 | **Eight backlog tasks are `in-progress`** with named gaps; P-02, P-03, P-12 not run; no performance sample. The implementer does not consider H12 demonstrably met |

## Findings

Reviewer findings: none recorded yet — the audit has not been performed. Absence of entries is not
evidence of correctness.

Defects the implementer found and fixed during implementation (each has a regression test or check):

| ID | Severity (implementer's view) | What was wrong | Fixed in | Regression evidence |
|---|---|---|---|---|
| IMP-01 | High (unworkable workflow) | The web application never loaded the registrations of approval targets and job handlers: approving a batch returned HTTP 500 in the built app while integration tests passed | `a8f5f57` | `tests/unit/wiring.test.ts`; E-06 |
| IMP-02 | Medium | Batch rows were stored with their pre-check state, losing name-check, duplicate and item-limit marks | `3db3c64` | `tests/integration/s5-bulk.test.ts` |
| IMP-03 | Medium (PWA) | The service worker was never installable: the build substituted a placeholder inside a comment | `c34e6e5` | Build guard in `scripts/build-service-worker.mjs`; P-04 |
| IMP-04 | Medium (PWA) | The page reloaded when the worker first took control, wiping a form | `c34e6e5` | P-08 |
| IMP-05 | Medium (ops) | `pnpm db:local` ignored `POSTGRES_ADMIN_URL`; the Docker/CI path never worked | `848e538` | CI runs #5, #6 |
| IMP-06 | Medium (delivery) | `pnpm smoke` and `pnpm worker:status` pointed at files that did not exist | `33dbba9` | Executed, see evidence file |
| IMP-07 | Low (test harness) | Test database teardown failed at random although tests passed | `74bd384` | 6 of 6 clean runs after the fix |
| IMP-08 | Low (dependency) | One high advisory on a transitive package of the Prisma CLI | `c8581d9` | `pnpm audit` clean |
| IMP-09 | Process | Commit `158ea60` reported passing unit tests while one failed (check not gated on exit code) | `f95a6d5` | All later results gated on exit codes |

Open items the implementer already knows about are the named gaps in the status file.

## Scores

Left for the independent reviewer.

| Domain controls /25 | Payments/batches/payroll /20 | Security/API /15 | Collections/reports /10 | Resilience /10 | UX /10 | Engineering/evidence /10 | Total /100 |
|---|---|---|---|---|---|---|---|
| Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |

## Limitations and disposition

- **Implemented and evidenced** (implementer's statement): the 14 R1 modules as described in the
  README, with the controls in the requirement map marked "evidenced".
- **Partly implemented**: the rows marked "partly" above and the eight `in-progress` backlog tasks
  (GOV-005, COR-001, PAY-101, PYR-101, COL-101, COL-104, OPS-104, API-103) plus REL-001, REL-002,
  REL-004 and the mobile tasks MOB-104, MOB-105.
- **Environment limits, not repository defects**: no Docker daemon, no physical device, only
  Chromium available.
- **Failed, skipped, expected-failure checks**: none at the tested revision. Earlier failures are
  listed under "Corrections of the record" in the status file.
- **Unrun checks**: P-02, P-03, P-12, device parts of P-09/P-10, performance, Docker Compose,
  backup/restore drill, browser journeys E-03, E-04, E-05, E-10, E-12, I-40.
- **Simulation boundaries**: every bank-side system is simulated (status file, "Simulation
  boundaries"). Nothing here is evidence about LYPay, ACH, CBL, Temenos, FLEXCUBE, SWIFT or cards.
- **Reproduce**: follow `docs/RUNBOOK.md` sections 2, 3, 6 and 7 at `dc2fa68`.
- **Independent verdict**: pending; only the reviewer assigns it after reproduction.
