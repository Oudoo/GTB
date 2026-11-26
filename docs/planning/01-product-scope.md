# 01 — Product definition and catalogue traceability

## Release thesis

Give a Libyan corporate treasury team one coherent workspace to understand cash, pay suppliers, run payroll, collect customer deposits and prove who approved each action. Give the bank an equally strong workspace to authorize services and investigate execution. The differentiator is controlled execution and visibility, not a large menu of unfinished products.

**Release R1 supports desktop web and mobile as one responsive, installable Next.js PWA** (see document 12). Mobile is a first-class supported product surface, including maker/checker, payroll, collections and bank operations; it is not just a dashboard resized to fit.

**Release R1 is a runnable sandbox MVP**, suitable for product evaluation and bank discovery with synthetic data. It must have durable database state, distinct authenticated people, genuine server-enforced policy, asynchronous payment simulation, failure recovery and reproducible tests. It must be designed for eventual bank integration without pretending that integration exists.

**A live-money pilot is a separate release gate.** It requires bank contracts, confirmed rail parameters, approved identity and strong-authentication infrastructure, bank-specific adapters, regulatory/legal review, penetration testing, operational controls and reconciliation against a real core sandbox. A sandbox banner is mandatory throughout R1. Live-money pilot prerequisites are in document 09.

## Users and jobs

| Persona | Primary job | Successful R1 outcome |
|---|---|---|
| Corporate Maker | Pay suppliers accurately | Submit a validated single or batch payment, understand limits and track execution |
| Corporate Checker | Control money movement | Inspect the immutable proposal, approve or reject without approving own work |
| Treasurer | Control cash and funding | View available balance, approval queue, scheduled obligations and execution failures |
| Payroll officer | Pay employees privately | Validate upload, review salary changes, obtain approval, track and retry eligible failures |
| Finance/Accountant | Reconcile collections | Find customer-code deposits, download receipts, inspect statements and export permitted data |
| Corporate Admin | Manage access within bank bounds | Request role/account/limit changes and obtain second-person approval |
| Viewer | Observe permitted information | Read assigned accounts and aggregate payroll results without salary details |
| Bank admin maker/checker | Govern agreement and policy | Independently propose/approve activation, limits and effective-dated revisions |
| Branch teller/manager | Capture controlled deposits | Resolve corporate + customer code, record cash/cheque and apply threshold approval |
| Payments operations | Resolve ambiguity and breaks | Inspect rail status, reconcile simulated core, retry safely with recorded reasons |
| Relationship manager | Support corporate relationship | Read agreement and permitted corporate summary, no blanket transaction authority |
| Compliance | Review audit exceptions | Read scoped audit and approved exports, no universal payroll bypass |

Bank permissions are bank-scoped and purpose-specific. A bank role does not implicitly grant access to every salary or mutation. CBL admin, Notary, Trade officer, Credit officer, Cardholder and Corporate IT belong to later full product capabilities; Corporate IT has scoped sandbox API access in R1, not a broad administrator role.

## Scope levels

- **R1 core:** mandatory, complete workflow and tests, within the restrictions listed below.
- **R1 subset:** mandatory named subset only; rest explicitly deferred, with no misleading enabled buttons.
- **R1 foundation:** shared infrastructure exposed as working product controls; not a full commercial module.
- **R2/R3:** roadmap card with accurate description and unavailable status. No fabricated success actions or full unfinished screen families.

## All 33 modules mapped

| Catalogue ID | Module | R1 boundary and later work | Source pages |
|---|---|---|---|
| 1.1 | Instant payments | R1 subset: LYD account-to-account and beneficiary-name confirmation through simulated LYPay; wallets and payer QR later | 1,5 |
| 1.2 | ACH | R1 subset: domestic credit transfer and batch clearing simulation; direct debit mandates and ACH cheque-clearing integration later | 1,5 |
| 1.3 | RTGS | R2: high value, two checkers, treasury initiation and operations release; no R1 initiation | 1,5 |
| 1.4 | SWIFT payments | R3: structured addresses, purpose, FX reference, screening, gpi and message interfaces; no R1 cross-border | 1,6 |
| 1.5 | Own-account/scheduled | R1 subset: immediate own-account and one-off future-dated transfers; standing orders and editable recurrence later | 1,6 |
| 2.1 | Bulk transfers | R1 subset: CSV/XLSX upload, row validation, valid-row choice, preview, approval, execution, row results, failed-row retry; groups and recurring runs later | 2,6 |
| 2.2 | Payroll | R1 subset: employee list, salary/allowance/deduction upload, account match simulation, scheduled run, privacy, alerts, approval, counts and failed-row retry; instant-salary product and CBL interface deferred | 2,7 |
| 3.1 | Customer ID/list | R1 core: unique corporate-scoped customer code, +218 validation, CRUD, import, filters, export; invoice references are minimal records, not a full AR ledger | 2,8–9 |
| 3.2 | Branch deposits | R1 subset: synthetic teller/manager journey, cash posting, pending cheque then controlled simulated clearing; only configured own-bank branches | 2,9 |
| 3.3 | Summary/receipts | R1 core: default 90-day history, scoped filters, CSV export, PDF receipts and audit; synthetic bank stamp clearly marked | 2,9 |
| 3.4 | Payment links | R2: expiry, single/reusable/invoice links; no unauthenticated payment capture or sharing integrations in R1 | 2,9 |
| 3.5 | QR collections | R2: static/dynamic reference, payment notification and auto-match; no decorative QR presented as payable | 2,9 |
| 4.1 | Virtual accounts | R2: hierarchy, count/depth policy, closure and master-account ledger; R1 may store future references, no operational VA balance | 2,10 |
| 4.2 | Reconciliation/sweeping | R2: VA reference matching, suspense and sweeping. R1 core/platform reconciliation below is foundational, not delivery of this module | 2,10 |
| 5.1 | Certified cheque | R3: core hold, certification, presentation, expiry/return; distinct from ordinary cheque deposits | 2,11 |
| 5.2 | LG/LC escrow | R3: choose bank-approved A/B, notary/dispute controls, core hold, ACH/RTGS settlement only; never instant | 2,11 |
| 6.1 | Documentary collections | R3: bank trade-team workflow/document requirements and ICC controls must be obtained | 2,12 |
| 6.2 | Letters of credit | R3: trade integration, discrepancies, exposure, FX allocation, document security | 2,12 |
| 6.3 | Guarantees | R3: issue/amend/claim/release, exposure, margins and dates | 2,12 |
| 7.1 | Cash concentration | R2: approved sweep/target-balance rules and internal postings | 2,13 |
| 7.2 | Liquidity alerts | R1 subset: in-app low-balance/usage thresholds with deduplication; SMS, email delivery and predictive shortfall later | 2,13 |
| 8.1 | Cheque issuance | R3: books/inventory, issue/stop/cancel and cut-offs | 2,13 |
| 8.2 | Cheque management | R3: positive pay, presented-cheque returns and clearing integration; R1 deposit status is not this product | 3,13 |
| 9.1 | Debit/prepaid cards | R3: issuer/processor integration and card/MCC policy; never store PAN/CVV | 3,13 |
| 9.2 | Credit cards | R3: bank credit approval and outstanding exposure accounting | 3,14 |
| 10.1 | API connectivity | R1 foundation: complete implemented-domain REST/OpenAPI, sandbox scoped credentials, quotas, signed outbound events; OIDC/FAPI/mTLS production channel integration later | 3,14–16 |
| 10.2 | Host-to-host/files | R2: signed file automation, duplicate detection and ISO/MT formats; R1 manual upload is not H2H | 3,14 |
| 10.3 | ERP connectors | R3: vendor-specific adapters and invoice reconciliation | 3,14 |
| 11.1 | Statements/reports | R1 subset: assigned-account history, filters, CSV/PDF, on-demand reporting; scheduled delivery and regulatory formats later | 3,14 |
| 11.2 | Cash forecasting | R2: explainable projection from obligations/history; no AI-generated financial actions | 3,14 |
| 12.1 | Users/roles | R1 core: scoped membership, account grants, suspension and approved permission changes | 3–5,14 |
| 12.2 | Approval matrix | R1 core: immutable rule snapshot, bands and distinct checkers, bank floors, change review | 3–5,15 |
| 12.3 | Agreement/limits console | R1 core: bank two-person activation/revision, signature evidence, modules/types/accounts, fees, limits, validity and history | 3–5,15 |

Cross-cutting catalogue requirements: five control levels (pp.3–5), API parity and idempotency (pp.15–16), canonical core adapter and recovery (pp.16–19), all unresolved CBL values (pp.20–21). R1 restrictions are product decisions, not source omissions.

## R1 transaction catalogue

Only enable these explicit types: `INSTANT_ACCOUNT_CREDIT` (1.1/LYPay), `ACH_CREDIT` (1.2/ACH), `OWN_ACCOUNT_TRANSFER` (1.5/Internal), `BULK_CREDIT` (2.1 with LYPay or ACH child instructions), `PAYROLL_SALARY` and `PAYROLL_ALLOWANCE` (2.2/ACH), `BRANCH_CASH_DEPOSIT` and `BRANCH_CHEQUE_DEPOSIT` (3.2/Branch). Scheduled transfers use the underlying type plus execution date, not a new rail. Payroll routing uses ACH in R1; never label this as the national instant-salary connection.

## Product success and demonstration

These are targets for evaluation, not existing measured results:

1. A new reviewer can run seeded infrastructure and sign in as the different actors within 15 minutes after dependencies are present.
2. Maker completes a saved-beneficiary payment in under three minutes, including policy/fee review; checker understands amount, account, beneficiary and purpose without leaving the approval page.
3. A 100-row batch returns row errors with references and exact totals; errors cannot silently become payments.
4. Two concurrent approvals/releases cannot pay twice or exceed a shared limit.
5. Payroll confidential fields never appear in unprivileged HTML, JSON, exports, logs or notifications.
6. Bank can trace an agreement revision → payment proposal → approvals → execution attempt → simulated core entry → reconciliation result.
7. English and Arabic work across the core demo, with correct RTL layout and LYD precision.

Mandatory demo: bank activates agreement → maker creates payment → checker approves → worker settles → statement shows posting → repeat with an ambiguous response and reconciliation → payroll upload with invalid/duplicate rows and masked approval → teller records deposit and finance downloads receipt. Document every actor and expected balance before/after.

## Deliberate exclusions

No separate native iOS/Android app or app-store distribution in R1; mobile is delivered by the mandatory PWA. No real payment acceptance, live identity provider, external SMS/WhatsApp/email sending, AI decisioning, financial advice, production KYC/AML, sanctions certification, FX execution, trade document ingestion, cash forecasting, real cards, wallet payments, recurring schedules or production API gateway. Architectural boundaries must allow these later; do not implement speculative adapters or menus at the expense of R1.
