# 07 — Verification specification

## Evidence standard

These tests are instructions for implementation, **not tests already run**. Implement them as executable automated checks using the project's tools. Keep unit, database integration, adapter contract, browser, accessibility and performance outcomes separate. Include nonzero discovered/executed test counts; failed/skipped/expected-failure counts; command, tested revision, date, environment/version, fixture and output paths. A zero-test exit code, build-only run, screenshot-only review or renamed failing assertion is not proof.

Run critical concurrency and persistence checks against real PostgreSQL, not an in-memory repository mock. Browser tests use distinct authenticated actors/storage states. Test helpers can set fixture scenario/clock directly only under isolated test configuration; never add a production “skip auth” flag. Avoid time-based sleeps; await observable state with bounded timeout and a controlled worker/test clock.

## Deterministic seed contract

Use Bank A (Al Qarib Sandbox) and Bank B (Boundary Test Bank); Corporate A (Qarib Trading Demo, Medium) and Corporate B (Sahara Logistics Demo, Small) in Bank A, plus Corporate C in Bank B. Names are synthetic. Customer code `CUST-001` exists in both A and B to test code collision. Set bank business timezone Africa/Tripoli, test date 2026-11-23 and an explicit calendar fixture. Never infer live holiday dates from this synthetic calendar.

People must be different identities: A admin, A maker, A checker1, A checker2, A payroll officer, A treasurer, A finance, A viewer; corresponding limited B maker/viewer; bank admin maker/checker; teller1/manager1 (branch1); teller2 (branch2); operations; compliance; Bank B admin. Include a multi-role maker+checker identity to test that role combinations do not bypass human separation. Demo account/password procedure must be local/sandbox only, no real credentials.

Amounts below are **invented test policy**, not CBL/bank-approved limits. All machine values minor units; display value listed for clarity:

| Fixture | Display value | Minor value / behavior |
|---|---|---|
| A operating booked | LYD 100,000.000 | `100000000` |
| A payroll booked | LYD 50,000.000 | `50000000` |
| A savings booked | LYD 25,000.000 | `25000000` |
| Instant rail item cap | LYD 5,000.000 | `5000000`, DEMO_UNCONFIRMED |
| ACH item cap | LYD 8,000.000 | `8000000`, DEMO_UNCONFIRMED; not source's tentative 10,000 |
| Instant module daily/monthly | LYD 20,000 / 100,000 | `20000000` / `100000000` |
| Corporate overall daily/monthly | LYD 30,000 / 150,000 | `30000000` / `150000000` |
| A Maker per item/day | LYD 3,000 / 10,000 | `3000000` / `10000000` |
| Single transfer fee | LYD 0.500 | `500` |
| Own-account fee | LYD 0.000 | explicit `0` |
| Approval band 1 | [0, 2,000) LYD | one independent checker |
| Approval band 2 | [2,000, supported max) LYD | two independent checkers |
| Teller manager threshold | Above LYD 2,000 | `>2000000` requires independent manager |
| Batch row/file cap | 100 / 5 MiB | demo agreement can vary inside tested hard cap |

Give bulk/payroll explicit module limits and user allowances large enough for their fixtures; never silently disable limits in tests. Separate scenarios reset database state or use isolated tenants. For “LYD 125.000 instant success” expect operating booked falls by 125.500, settlement control credited 125.000 and fee income 0.500; used limit increases by 125.000, not 125.500. For own transfer 125.000, source drops and destination rises 125.000, journal net zero, corporate used outgoing counts 125.000 once. Document any revised fixtures while retaining semantic assertions.

## Unit/property tests

| Test IDs | Obligations |
|---|---|
| U-MON-01..06 | LYD 0.001 exact, 125.000 round trip, reject 0/negative/exponent/4 decimals/overflow, differing currency comparison rejected; no Number arithmetic |
| U-LIM-01..08 | Each limit layer independently rejects, exact boundary allowed, item vs amount not compared, principal vs fee semantics, unknown rail blocks, current reserved included, month/day boundaries use bank clock |
| U-APR-01..05 | Band min inclusive/max exclusive, no gaps/overlap, checker counts respect floor, maker identity never votes, changed proposal invalidates votes |
| U-STA-01..05 | Legal transitions only, accepted ≠ settled, unknown not retryable, returned has compensation link, batch state derived from accepted rows |
| U-IMP-01..07 | Required header/template, malformed quoting, unexpected formulas/macros, decompressed size, duplicate reference, mixed currency, empty accepted set |
| U-PYR-01..05 | Exact net with signed correction, invalid negative components, duplicate period/component, salary-change threshold, redaction projections |
| U-CAL-01..05 | Cut-off before/at/after, closed day roll, core offline, future scheduling horizon, month boundary and UTC/business-date difference |
| U-EVT-01..04 | Signature raw bytes, timestamp/header validation, delivery retry schedule, sanitized payload and stable event ID |

Property tests useful for money conservation, monotonic consumed quotas and arbitrary permission combinations; do not substitute snapshot assertions for exact arithmetic/state checks.

## Database integration and adversarial cases

| ID | Setup / action | Required observation |
|---|---|---|
| I-01 | A user requests B account/payment/batch/report by guessed ID | 404, no content or existence leak; no mutation |
| I-02 | Bank A admin requests Bank B corporate | Denied; no cross-bank read/aggregate |
| I-03 | Forge tenant/actor/role headers/body; alter account grant | Ignored/rejected; real session authority prevails |
| I-04 | Draft/expired/suspended/not-yet-valid/no-signature agreement | Operational submit/release rejected, governance history readable |
| I-05 | Same bank admin proposes and activates own revision | Denied even with both roles; different admin succeeds |
| I-06 | Concurrent effective agreement versions / bank rule vote | One valid outcome, no overlapping active revisions |
| I-07 | Enable deferred module/type via crafted request | Rejected, not fake success |
| I-08 | Same human maker+checker approves own payment | Denied; vote count unchanged |
| I-09 | Two simultaneous approvals by checker1 for one item | One vote only, one release job |
| I-10 | Two distinct final-checker requests race | Single transition/reservation/execution |
| I-11 | Reuse create idempotency key/body then different body | Same resource first; 409 conflicting payload, no second payment |
| I-12 | Parallel identical create requests | One resource/intent, replay or documented in-progress outcome |
| I-13 | Two payments each 600 with only 1,000 remaining quota | At most one reserves/releases; no overrun, counters never negative |
| I-14 | Parallel different accounts share corporate daily quota | Corporate-wide lock/constraint still limits total |
| I-15 | Final approval followed by maker/checker suspension | Dispatch blocked or approval reset, no unauthorized posting |
| I-16 | Agreement module disabled/fee changed between approval/dispatch | Re-evaluation blocks/reapproval; no silent higher fee |
| I-17 | Fail after usage reservation before adapter call | Intent recoverable; no lost reservation or double consume |
| I-18 | Core posts then request times out/app dies before ack | STATUS_UNKNOWN/inquiry, exactly one debit, original reference resolved |
| I-19 | Unknown execution lease expires and worker restarts | Inquiry, not a new blind debit; reservation held until authoritative result |
| I-20 | Duplicate/out-of-order adapter events | No duplicate journal/fee or backward final status |
| I-21 | Definitive pre-post failure/cancel | Funds/limit reservations released once, no booked debit |
| I-22 | Return after settled | Linked compensation, original retained, historic usage not freed |
| I-23 | Internal transfer destination outside corporate/different currency | Rejected before posting; valid transfer balanced atomically |
| I-24 | Scheduled item spans business month / cut-off | Correct new window checked, no old reservation loophole |
| I-25 | Accept 95 of 100 imported rows | Only accepted set frozen/executed; hash/total consistent |
| I-26 | Modify row amount after batch approvals | New revision/votes invalidated; old approval cannot release changed rows |
| I-27 | Partially settle batch; one row unknown | Partial status/counts accurate, unknown excluded from retry |
| I-28 | Concurrent failed-row retries | One active retry chain; no duplicate business instruction |
| I-29 | Same salary employee+period+component in another file | Duplicate blocked despite new filename/idempotency key |
| I-30 | Checker/Finance/Viewer query payroll rows/errors/raw report/statement/audit | No employee salary/name/account leak; aggregate approval still possible |
| I-31 | Admin grants themselves payroll/payment rights beyond bank bounds | Rejected; no implicit superuser bypass |
| I-32 | Suspend account/user then use existing session/token/report URL | Current permission/session revocation enforced |
| I-33 | Duplicate customer code A vs B, import duplicates inside A | Different corporates allowed; same corporate rejected atomically |
| I-34 | Delete/archive customer with open invoice/history | Open invoice blocks; historical references never cascade deleted |
| I-35 | Teller uses code without corporate or another bank/branch | Cannot miscredit; scope enforced |
| I-36 | Cash amount above threshold; teller approves own | No credit until different eligible manager approves |
| I-37 | Cheque accepted then returned before clear | No booked/available credit ever; pending receipt correct |
| I-38 | Duplicate cheque-clear event | One credit/receipt/event only |
| I-39 | Allocate deposit over remaining amount / to another customer | Rejected; parallel allocations cannot overpay invoice |
| I-40 | Return allocated deposit | Reversing allocation and invoice due restored, history retained |
| I-41 | CSV customer cell begins =,+,-,@ or control characters | Safe export not an executable spreadsheet formula |
| I-42 | Unprivileged report download after privilege revocation | Denied; artifact generation authorization not reused forever |
| I-43 | Missing/duplicate/amount-mismatch core reconciliation fixture | Correct break types detected, no direct ledger edit repair |
| I-44 | Runtime app attempts audit UPDATE/DELETE | Database denies; successful business mutation has atomic audit event |
| I-45 | API bearer token attempts checker/admin bank endpoint | Denied regardless of supplied scope text/header |
| I-46 | Quota exceeded and credential revoked | 429 Retry-After; revoked token 401; no money side effects |
| I-47 | Webhook destination private IP, IPv6, redirect, DNS rebinding | No prohibited connection attempted; reason logged safely |
| I-48 | Subscriber timeout after settlement and worker restart | Payment remains settled, event delivery retried/dedupable |
| I-49 | Wrong raw-body signature/stale timestamp at fixture receiver | Receiver rejects; replay example uses fresh signed delivery |
| I-50 | Two jobs trigger same alert threshold | One notification per intended recipient/window crossing |
| I-51 | Inject raw salary into error path then inspect captured logs | Redaction prevents disclosure; structured error remains useful |
| I-52 | Omit CSRF/origin protection on cookie mutation / login brute force | Forged write denied; throttle activated without user enumeration |

For race tests, synchronize competing requests with a barrier and assert final DB/core state, not just HTTP statuses. A “retry later” response is acceptable only if state and subsequent replay are correct. Use at least 20 concurrent attempts for vote/idempotency stress; keep tests deterministic and bounded.

## End-to-end journeys

- **E-01 Bank governance:** login maker admin → propose signed agreement/module/limits → logout/login different admin → review diff/approve → corporate reads effective policy. Include self-approval denial.
- **E-02 Domestic payment:** maker selects account and name-matched beneficiary → exact preview → submit → checker reviews → worker settlement → statement/fee/limit/timeline match. Repeat in Arabic.
- **E-03 Two checkers and tightening policy:** amount at exact two-checker boundary; one vote insufficient; second distinct vote releases. Change fee before dispatch and verify reapproval screen.
- **E-04 Unknown recovery:** induce timeout-after-book → visible unknown warning/no retry → operations inquiry → one settlement, no duplicate entry; refresh/restart persists.
- **E-05 Scheduled:** clock-controlled due/cut-off roll → no early execution → due-time policy/funding check → clear failure or settled outcome.
- **E-06 Bulk:** upload 100-row file, fix or explicitly exclude five invalid → inspect accepted total/fees → approve → partial result → failed-only retry creates new proposal. Unknown row cannot retry.
- **E-07 Payroll:** officer imports employees/salary file → duplicate/change checks → aggregate checker approval → officer sees details, viewer/finance sees aggregates and redacted exports → settled totals/statement match.
- **E-08 Collections:** finance imports customer → teller chooses corporate+code → threshold manager approval → posted receipt → finance finds deposit and allocates invoice; pending cheque never credits prematurely.
- **E-09 Access administration:** corporate admin proposes role/account/limit change → different eligible actor approves → suspended user loses session; role cannot exceed bank envelope.
- **E-10 Sandbox developer:** create scoped token → API payment created → human checker required → signed event delivered/replayed; revoke token, next call rejected.
- **E-11 Locale/responsive/accessibility:** keyboard complete payment/import/checker, Arabic RTL labels/errors/number direction, PDF shaping, mobile key actions; axe severe/critical findings zero on core screens.
- **E-12 Clean restart:** stop only test-started app/worker, restart, sign in and inspect saved rows/votes/receipts/unknown job; no seed reset needed to recover.

## Commands and artifacts expected at delivery

Implement actual scripts or document exact equivalents: `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm test:integration`, `pnpm test:contract`, `pnpm test:e2e`, `pnpm build`, `pnpm smoke`. Integration suite must fail if PostgreSQL unavailable; never silently skip. `smoke` checks readiness, authenticates seeded actors, performs a real permission-bound flow and asserts resulting posting, not just an HTTP 200. Do not run tests against a user's real bank database. CI uses separate migration/admin/runtime URLs if needed for privilege tests.

Evidence bundle (generated artifacts ignored by Git, concise summaries tracked): command transcript/exit codes, machine-readable runner reports, Playwright traces/screenshots, redacted sample API requests/responses, test fixture/version IDs, migration/seed/restart results, performance measurement script+raw results, OpenAPI validation report, dependency audit findings and actual limitations. Avoid copying credentials/session cookies into evidence. Link paths and line numbers for code observations. Test evidence must identify the code revision or tree checksum, including uncommitted changes if any.

## Additional mobile/PWA verification

Execute P-01..P-12 in document 12, alongside E-01..E-12. The original 52 database integration scenarios remain required. Add production-mode worker cache inspection and reconnect/update lifecycle checks, and record physical-device installation/file/keyboard evidence independently from Playwright browser emulation. Unavailable real-device testing stays explicitly unrun, keeping device acceptance pending.
