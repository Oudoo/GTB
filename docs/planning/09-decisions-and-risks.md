# 09 — Decisions, assumptions and unresolved dependencies

## Authority and scope assumptions

The only supplied product source is the 21-page catalogue dated 23 November 2026. It mentions a CBL draft Digital Documentary Credit v1.1, Cash Monitoring deck and Bulk Transfer Journey, but those underlying documents are **not attached here**. Do not claim to have read them. Source claims about market research, CBL strategy, rails and limits are unverified product input. Do not cite them as legal advice or final bank requirements. The PDF is preserved with SHA-256 `014280e63526c3ddcda87d95b81101c2135a75486ea1a2e3da2439b162e34736`.

The release design and stack below are recommendations for this implementation, not verbatim source requirements. All values used to run the sandbox are labelled synthetic. Real-bank launch is outside R1.

## Architectural/product decisions already made

| ID | Decision | Why / effect |
|---|---|---|
| D01 | Next.js App Router + strict TypeScript | Explicit user choice, single typed product codebase |
| D02 | Modular monolith and separate durable worker | One deployable domain, correct asynchronous lifecycle without distributed-system overhead |
| D03 | PostgreSQL, integer minor-unit money, LYD only for execution | Concurrency and precision; LYD uses 3 fractional digits |
| D04 | Simulated core behind canonical ports | No confirmed bank sandbox/API/credentials; core remains eventual system of record |
| D05 | R1 focuses governance, domestic payments, bulk/payroll, collections, reports | Demonstrates connected customer value while all 33 modules remain mapped |
| D06 | English+Arabic and accessible RTL in R1 | Libya context and credible bank review; not a late translation layer |
| D07 | At least one independent checker for all R1 money movements | Conservative floor; source allows some bank-configured batch flexibility, intentionally narrowed |
| D08 | Corporate limits count outgoing principal; fees affect funds only | Clear testable accounting/quota policy; confirm before live pilot |
| D09 | No cross-currency corporate aggregation in R1 | Avoid invented FX valuation/exposure policy; future decision needed |
| D10 | Scheduled obligations reserve at due-date release | Prevent stale/month-crossing quota semantics; approval doesn't guarantee future funds |
| D11 | Returns do not restore historical outgoing quota | Prevent limit recycling; confirm bank preference before pilot |
| D12 | Payroll aggregate approval and grouped statement projection | Preserve source payroll confidentiality while enabling maker-checker |
| D13 | Scoped opaque sandbox API tokens, no automated checker voting | Working API foundation without falsely claiming OAuth/FAPI/mTLS compliance |
| D14 | Two bank-admin approvals for activation/changes; bank emergency stop immediate | Source maker/checker requirement; safety stop not delayed by unavailable checker |
| D15 | Branch deposits scoped to own-bank synthetic branches | Meaning and acceptance network of “other banks” unresolved |
| D16 | Minimal invoice-reference/allocation records only | Support customer paid/due pages and archive rules without full AR product |
| D17 | Signed evidence recorded as simulated attestation | No e-signature integration or legal execution service supplied |
| D18 | Trade/exposure/escrow/cards remain deferred | Different financial controls/integrations; do not apply amount-flow limit model to exposure |
| D19 | Version 1 only until a real version 2 is required | Avoid meaningless duplicate APIs; preserve path versioning for later dual-version operation |
| D20 | Sandbox `.xlsx`/CSV import, default 100/hard-tested 1,000 rows | Catalogue has conflicting 100/200 defaults; our values are explicit test policy, not source resolution |

## Mobile decision added after initial planning

**D21 — Web and mobile through one PWA (user clarification).** Desktop browser and mobile browser/installed modes are mandatory in R1. Document 12 is authoritative for this addition. Separate native apps and app-store packaging are deferred. This supersedes the original mobile-app exclusion. Installation, offline safety and real-device/browser evidence are acceptance obligations. No native background execution, biometric security or reliable push promise is implied.

## Source open points (must stay visible)

| Unknown | Source | Needed for | R1 behavior / resolution owner |
|---|---|---|---|
| ACH item ceiling and return window | p.20 #1 | Real ACH execution/returns | Configurable synthetic value, no asserted 10,000 LYD law; bank payments/CBL confirmation |
| Corporate LYPay and bulk ceilings | p.20 #2, p.5 | Live instant/corporate bulk | Fail closed when unset; demo profile clearly unconfirmed; bank/CBL |
| Escrow option A vs B and legal event/dispute model | p.11, p.20 #3 | Conditional payments | R3 blocked; bank legal/product/CBL, not implementer choice |
| “Other banks” collection network/meaning | pp.9–10, p.20 #4 | Interbank collection | Own-bank sandbox only; bank product/branch network |
| Teller flow operational approval | p.20 #5 | Branch pilot | Proposed synthetic workflow, obtain branch manager/compliance signoff |
| Row-cap default per segment | pp.6–7, p.20 #6 | Live bulk/payroll | Demo 100 configurable, no automatic 200; bank product |
| Documentary collections checklist/process | p.20 #7 | Trade release | R3 blocked pending bank trade team documents |
| All final limits | p.21 #8 | Every real-money product | Synthetic configurable seed only; bank agreements/rail owners |
| CBL instant-salary interface/file/API/settlement | p.7, p.19 | National salary mode | Deferred, never claim standard ACH payroll is this service; bank/CBL |
| Core product/release/licensed API coverage | pp.17–19 | Real adapter | Port + simulator only; bank core team |
| Native vs platform virtual accounts | pp.10,19 | Virtual account implementation | R2 decision after core capability analysis |

## Additional discovery needed before live-money pilot

- Identity provider and federation, bank onboarding/KYC authority, MFA/step-up method, corporate signatory delegation and legal signature acceptance. Obtain actual identity/account schemes; do not invent Libyan regulatory validation.
- Bank calendar, timezone, end-of-day windows, real rail cut-offs, debit vs settlement timing, overdraft/hold policy, posting and fee reversals, return accounting and status mapping.
- Approved bank/corporate segment tariffs and per-account/user/type limits, whether fees consume quota, whether internal transfers count overall, exposure basis and FX aggregation for future modules.
- Data residency and retention periods, payroll access policy, privacy review, encryption/key custody, archival/WORM requirements, audit export recipients and incident response ownership.
- Real bank-to-core routing (private/mTLS), service accounts, outbound network rules, secrets management and certificate renewal. HTTPS alone is not an integration assurance.
- OIDC/OAuth2/FAPI profile and conformance requirements, mTLS client lifecycle, consent and bank SCA policy, API gateway quotas, API version retirement notice periods.
- Real bank sandbox accounts and contract tests, payroll peak-volume assumptions, DR targets/RPO/RTO, backups and restore drill, reconciliation/fallback procedures, support staffing and repair authorization.
- External sanctions/AML/fraud screening ownership and stop rules. R1 flagging is not a sanctions/AML engine.
- Security assessment/penetration test, threat model, accessibility localization review and bank UAT with formal acceptance.

## Risk register

| Risk | Likelihood/impact | Mitigation and proof |
|---|---|---|
| Broad catalogue produces superficial screens | High/High | Mandatory slices and explicit module boundaries; don't build deferred workflows |
| Happy-path-only fake banking demo | High/High | Postgres persistence, real identities, negative/race/crash tests and independent audit |
| Quota checks race or ignore reservations | Medium/Critical | Atomic counters/reservations, real concurrent DB tests |
| Adapter timeout causes double debit | Medium/Critical | Stable execution ref, unknown state, inquiry then reconciliation |
| Salary leaks through generic surfaces | High/Critical | Central projection policy plus HTML/API/export/log negative tests |
| Agreement changes bypass two-person review | Medium/High | Immutable revisions, independent bank votes and effective-date constraints |
| Demo credentials/test-mode endpoint deployed publicly | Medium/Critical | Explicit sandbox mode, production startup guard, no user-controlled auth bypass |
| XLSX parser/zip/macro or CSV injection | Medium/High | Bounded parser, reject formulas/macros, safe exports, dependency review |
| Webhook SSRF or leaked signing secrets | Medium/High | Egress validation per delivery, no redirects, encryption/rotation, adversarial tests |
| Worker crashes lose events/leave false status | Medium/High | Transactional outbox, leased jobs, recovery/inquiry and restart tests |
| Arabic PDF text not shaped correctly | Medium/Medium | Bundle fonts/shaping-aware renderer and inspect actual Arabic PDF |
| Multi-currency values added as same units | Medium/Critical | LYD-only posting, explicit future currency/exposure policy |
| R1 mistaken for legally production-ready | Medium/High | Persistent sandbox label, honest adapters and separate pilot checklist |

## Decision-change procedure

Implementer may choose supported libraries, filenames or low-level structures without asking permission for every detail. Before changing a business/control rule, record: decision ID, original requirement, proposed change, reason/evidence, security/financial effect, affected API/data/UX/tests and whether owner input is required. Defaults above allow implementation without blocking on unavailable external bank details. Missing real credentials are not a reason to fake integration success or weaken controls.
