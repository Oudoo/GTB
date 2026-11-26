# 08 — Independent implementation audit

## Review principle

Judge executable behavior against the plan and source, not confidence of the implementer, screenshot polish or volume of code. Reproduce results on the final code revision. Read the actual diff/schema/routes/auth/worker/test setup before trusting status reports. The current repository contains a plan, so there is no application verdict yet.

## Verdicts

- **PASS — Sandbox MVP:** all hard gates satisfied, all mandatory release capabilities evidenced, score ≥90/100, no open critical/high issue. This is not live-bank approval.
- **CONDITIONAL — Sandbox only:** no security/financial hard-gate violation, score 80–89 or bounded medium UX/operability defects with precise remedy; not final MVP acceptance.
- **FAIL:** any hard gate violated, mandatory slice absent, score <80, or critical evidence absent/unreproducible.
- **NOT AUDITABLE:** cannot provision/run required parts or evidence is materially unavailable; do not substitute a numeric pass estimate.

## Hard gates (any failure blocks PASS)

| Gate | Minimum proof |
|---|---|
| H01 Real persistence and reproducibility | Fresh migrations/seed/app+worker work; refresh/restart preserves state; no localStorage/in-memory money authority |
| H02 Tenant/account/role isolation | Negative direct API and download tests including cross-bank and forged context |
| H03 Agreement governance | Effective signed agreement enforced and independent bank approval of activation/changes |
| H04 Independent approvals | Same human cannot self-approve, duplicate/racing votes cannot fabricate quorum |
| H05 Exact money and balanced postings | LYD 3 decimals, integer arithmetic, fees/reservations correct, journal balances |
| H06 Limits under contention | Current policy and reserved usage applied atomically; no shared corporate overrun |
| H07 Exactly-once financial effect | Request replay/race/crash-after-post produce one posting; unknown outcomes cannot blind retry |
| H08 Payroll confidentiality | Unprivileged HTML/JSON/export/log/statement/API/audit projections do not disclose row salary or employee data |
| H09 Batch/deposit correctness | Accepted rows only, safe retry, cheque not credited before clear, threshold maker/manager control |
| H10 Durable recovery and audit | Worker restart, outbox delivery, reconciliation and append-only trace; no direct unapproved ledger edits |
| H11 Honest simulation/credential handling | No false live rail/FAPI/CBL claim, no hardcoded real secret, no deployable demo-auth bypass |
| H12 Verified mandatory delivery | S0–S10 complete with meaningful executed checks, bilingual core journeys, document 12 mobile/install/offline/update/security gates, and no unexplained required-check failure |

## Score after hard-gate evaluation

| Category | Weight | What earns points |
|---|---:|---|
| Domain controls | 25 | Agreements 5, approval rules/versions 5, exact money+fees 5, multi-layer limits 6, effective calendar/revalidation 4 |
| Payment/batch/payroll behavior | 20 | Single/scheduled 6, bulk validation/partial/retry 6, payroll calculations/privacy/period controls 8 |
| Security and API | 15 | Auth/tenancy/grants 6, shared API/OpenAPI/idempotency 4, credentials/CSRF/quota/SSRF 5 |
| Collections/reporting | 10 | Customer/invoice scope 3, teller/cheque/receipt 4, reports/redaction/exports 3 |
| Resilience and operability | 10 | Jobs/outbox/unknown handling 4, reconciliation/repair 3, startup/diagnostics/seed 3 |
| User experience | 10 | Clear flows/states 3, English/Arabic/RTL/PDF 3, accessibility/responsive/visual consistency 4 |
| Engineering and evidence | 10 | Typed boundaries/schema/migrations 3, meaningful tests/concurrency/failure coverage 4, accurate docs/status/deviations 3 |
| Total | 100 | No score overrides a hard-gate failure |

For each subscore award full only with direct evidence, partial for bounded gaps, zero for absent/unverified behavior. Do not deduct for declared R2/R3 exclusions. Do deduct for unacknowledged R1 omissions or presenting deferred products as functional.

## Reviewer procedure

1. Record git revision/tree changes, tool versions and environment. Read `AGENTS.md`, current plan and decision log. Inventory actual routes, modules, scripts, schema, migrations and implementation report.
2. Search for suspicious shortcuts (`TODO`, disabled tests, `.skip`, `any`, `@ts-ignore`, role/tenant headers, localStorage payment state, hardcoded status/balance, unconditional success, test-only auth flags, insecure TLS). A search hit is a lead, not proof of a defect.
3. Provision a fresh isolated DB using documented commands; migrate and seed with runtime privileges separated where required. Build, start app and worker. Confirm readiness and actual mode. Repeat setup/seed to test idempotence without erasing non-demo data.
4. Run tests with real exit codes and nonzero counts. Inspect failure and skip conditions. Confirm DB race tests use actual concurrency, not sequential mocked calls. Check generated reports belong to this run.
5. Exercise E-01..E-12 manually or automated with independent identities; verify database/core entries, fees, limits, audit and state after key steps. Test cross-role/tenant requests outside UI.
6. Inspect transaction boundaries and failure windows statically. Trace submit → vote → reservation → outbox/job → core call → acknowledgment → inquiry/reconciliation. Look for network calls inside long locks and for missing unique constraints.
7. Inspect redaction systematically in HTML/network/logs/artifacts and scoped downloads. Request payroll detail with checker/viewer/bank operations identity. Inspect statement aggregation, not only payroll page.
8. Review English and Arabic screens at specified widths, keyboard navigation, status vocabulary, receipts/PDF and all loading/error/empty states. Run automated accessibility scan plus keyboard checks.
9. Test worker/app stop-restart with an in-flight intent and failed webhook. Re-run business-date reconciliation with injected discrepancies. Confirm repair cannot arbitrarily mark a transaction settled.
10. Create findings, score and verdict. Rerun relevant tests after fixes; invalidate old evidence after material code changes. Do not approve based on a previously tested commit.

## Finding format

Each finding: stable ID, severity, affected requirement/gate, file+line, concrete trigger, steps, observed result, expected result, financial/security/product impact, suggested fix and regression test. Severity: critical = unauthorized posting/tenant breach/salary exposure or credential compromise; high = duplicate/lost financial effects, bypassed controls, materially false balances/status or unworkable mandatory workflow; medium = bounded functional/UX/ops defect; low = minor clarity/maintainability issue. Classify by actual exploit/impact, not dramatic language.

Example: `AUD-007 / Critical / PAY-04 H07: worker retries timeout using a new core reference; after simulator posts then times out, second attempt debits again. Prove with count(coreJournal where instructionId)=2. Fix stable reference + inquiry, add I-18 regression.` This is an illustrative finding, not an observed current defect.

## Evidence that does not qualify

- “Implemented” checkboxes without path and test result.
- Green build with tests disabled or zero assertions.
- Mock repository unit tests offered as proof of PostgreSQL locks.
- API tests that inject administrator context instead of authenticating.
- A screenshot of “Settled” without authoritative core entries.
- One-language sidebar translation offered as Arabic flow support.
- Seeded all-active agreements only, never testing bank maker-checker.
- A route returning 200 with no persisted business effect.
- Correct UI hiding fields while API/PDF/logs leak salary.
- FAPI-ready wording without verified security-profile deployment.

Use `docs/audit/IMPLEMENTATION-REVIEW.md` for the final report. Independent reviewer fills verdict; implementer supplies evidence and identifies gaps without declaring their own independent PASS.
