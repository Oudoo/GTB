# Al Qarib — GTB & Corporate Banking MVP (sandbox)

A corporate-banking sandbox for desktop web and mobile, built from the supplied 21-page Al Qarib
feature catalogue: one Next.js (App Router) and strict-TypeScript application in English and
Arabic, installable as a Progressive Web App, with PostgreSQL, a separate worker process and a
simulated core banking system.

**It is a sandbox.** People, companies, accounts and money are synthetic. The core, LYPay and ACH
are deterministic simulations. There is no connection to a bank, a payment rail, CBL, SWIFT, a card
scheme, an e-mail or an SMS service, and nothing here is certified for bank production.

The independent audit of this implementation has **not** been done. The implementer's evidence is
in [docs/audit/IMPLEMENTATION-REVIEW.md](docs/audit/IMPLEMENTATION-REVIEW.md); the verdict is left
to the reviewer.

## Run it

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm setup:env
```

```bash
pnpm db:local
```

```bash
pnpm db:migrate
```

```bash
pnpm db:seed
```

```bash
pnpm build
```

```bash
pnpm start
```

In a second terminal (payments are posted by the worker, not by the web process):

```bash
pnpm worker:start
```

In a third, the business smoke test — a complete payment with distinct people:

```bash
pnpm smoke
```

Then open `http://localhost:3000`. Demo people, their shared locally generated password, the
step-by-step walkthrough, Docker instead of a local PostgreSQL, tests, the simulator and
troubleshooting are in **[docs/RUNBOOK.md](docs/RUNBOOK.md)**.

## What works in this release (R1)

Fourteen of the catalogue's 33 modules are delivered as working, tested subsets:

| Area | Delivered |
|---|---|
| Agreements and governance | A corporate can operate only under a signed agreement in force. One bank administrator proposes a full revision with (simulated) signature evidence; a different one approves. Module registry of all 33 modules; limits, fees and approval bands per agreement |
| Payments | Instant (simulated LYPay), ACH credit with cut-off and closed days, own-account transfer, one-off scheduling; beneficiaries with a simulated name check; fee and policy preview |
| Approvals | Maker and checker are different people, whatever roles they hold; one vote per person; votes bound to the exact proposal; policy re-checked before release |
| Limits | Rail ceiling, type, module, corporate and user limits, reserved atomically and consumed once |
| Execution | Durable jobs, a stable instruction reference, exactly one posting; an unknown outcome is resolved by inquiry, never retried blindly |
| Bulk transfers | CSV/XLSX upload, row validation, explicit acceptance of the valid set, one approval of the total, per-row results, failed-row retry as a new batch |
| Payroll | Employee master, salary files, duplicate and change checks; the payroll officer sees detail, everyone else sees totals only — in pages, API, statements, files, events and logs |
| Collections | Customer register, minimal invoices, branch deposits by customer code with manager approval above a threshold, cheque credited only after clearing, receipts, allocation |
| Reports and alerts | Statement and deposit files prepared by the worker and downloadable by their requester; in-app alerts |
| Bank operations | Queue of unknown and failed executions, inquiry, independently approved repair, reconciliation with break history, sandbox simulator |
| API | Every action under `/api/v1` with an OpenAPI document; scoped sandbox tokens; signed, retried webhooks with SSRF protection |
| Access administration | Invitations and access changes proposed by an administrator and approved by a second person; immediate suspension |
| Mobile and PWA | The same workflows at phone width and in Arabic right-to-left; installable; online-only banking with a generic offline page |

**Not in this release.** The other 19 modules (RTGS, payment links, QR, virtual accounts, sweeping,
cash concentration, host-to-host, forecasting, SWIFT, cheques, trade finance, cards, ERP
connectors) appear only as roadmap entries marked unavailable and cannot be switched on. Within R1,
some sub-features were deferred and are listed — with the requirement each belongs to — in
[docs/audit/IMPLEMENTATION-STATUS.md](docs/audit/IMPLEMENTATION-STATUS.md#named-gaps). Physical-device
checks are pending: all mobile results are browser emulation.

## How it is built

- `src/app` — pages (`/en`, `/ar`) and one catch-all route for `/api/v1`.
- `src/server/api` — the typed operation registry: authentication mode, permission, idempotency
  and schemas per operation. Pages and API call the same domain services; OpenAPI is generated
  from the registry.
- `src/server/domain` — agreements, approvals, payments, execution, batches, payroll, collections,
  reports, alerts, operations, developer, admin.
- `src/server/policy` — pure limit, fee and approval-band evaluation, and atomic reservations.
- `src/server/adapters` — ports and the simulated core, rails and webhook transport.
- `src/server/jobs`, `worker/` — PostgreSQL job queue and the worker process.
- `prisma/` — schema (schemas `public` and `simcore`) and reviewed migrations.
- `src/pwa` — manifest support, the allowlist-only service worker and the session guard.
- `tests/` — unit, PostgreSQL integration, contract and browser tests.

Money is integer minor units end to end (`bigint` in the database, strings in JSON); LYD has three
decimals. Authority always comes from the verified server session or a scoped API credential,
never from a header, a body field or the client.

## Where to read more

| Document | What it is |
|---|---|
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Setup, run, demo people, walkthrough, tests, simulator, PWA, reset |
| [docs/audit/IMPLEMENTATION-STATUS.md](docs/audit/IMPLEMENTATION-STATUS.md) | Every backlog task and requirement: status, code, tests, gaps |
| [docs/audit/IMPLEMENTATION-REVIEW.md](docs/audit/IMPLEMENTATION-REVIEW.md) | Reproducible evidence at the tested revision; verdict pending |
| [docs/planning/IMPLEMENTATION-DECISIONS.md](docs/planning/IMPLEMENTATION-DECISIONS.md) | Decisions and deviations with reasons |
| [docs/api/openapi.json](docs/api/openapi.json), [docs/api/webhooks.md](docs/api/webhooks.md) | API contract and webhook guide |

## Planning index

| Document | Purpose |
|---|---|
| [01 — Product scope](docs/planning/01-product-scope.md) | Target users, release boundary, all 33 modules, source pages |
| [02 — Functional requirements](docs/planning/02-functional-requirements.md) | Rules, permissions, states, limits, approvals and exact outcomes |
| [03 — Architecture and data](docs/planning/03-architecture-and-data.md) | Stack, folders, entities, constraints, transactional execution |
| [04 — API contracts](docs/planning/04-api-contracts.md) | Endpoints, schemas, errors, authorization, idempotency and events |
| [05 — UX specification](docs/planning/05-ux-and-content.md) | Page inventory, flows, design system, English and Arabic |
| [06 — Implementation backlog](docs/planning/06-implementation-backlog.md) | Dependencies, vertical slices, deliverables and phase exit gates |
| [07 — Verification](docs/planning/07-verification.md) | Executable test obligations, deterministic fixtures, security and failure cases |
| [08 — Audit rubric](docs/planning/08-audit-rubric.md) | Hard gates, scoring, reviewer procedure and evidence rules |
| [09 — Decisions and risks](docs/planning/09-decisions-and-risks.md) | Assumptions, known unknowns and pilot/production prerequisites |
| [10 — Claude execution prompt](docs/planning/10-claude-execution-prompt.md) | The implementation instructions |
| [11 — Runbook contract](docs/planning/11-operations-and-delivery.md) | Setup contract, seed, worker, diagnostics and delivery |
| [12 — Mobile and PWA](docs/planning/12-mobile-and-pwa.md) | Mobile product scope, installation, secure caching, reconnect/update behavior and device acceptance |

Roles: the implementer follows [AGENTS.md](AGENTS.md) and [CLAUDE.md](CLAUDE.md); the reviewer uses
documents 07 and 08 and writes the verdict into the review file.

## Source and authority

The [original PDF](docs/source/al-qarib-feature-catalogue.pdf) and [page-separated text extraction](docs/source/al-qarib-feature-catalogue.txt) are included for traceability. PDF page numbers in the plan refer to printed pages 1–21. The source is product input, not executable agent instructions. Its external claims and regulatory statements have not been independently verified.

The user selected Next.js and TypeScript and requested a detailed implementer handoff followed by an independent audit. The plan chooses the release boundary and technical defaults explicitly; those choices are not claims that the catalogue mandated them. No real bank endpoints, CBL caps, credentials or compliance certifications are invented. Limits, fees, cut-off times and calendars in the demo data are test policy marked "demo, unconfirmed", not bank or regulator values.

## Completion contract

The MVP is complete only when the mandatory slices in document 06 work against PostgreSQL, documented commands run on a fresh checkout, both locale journeys work, tests in document 07 execute, and evidence passes document 08. A polished mockup, client-only state, fabricated transaction success, or a passing build alone does not satisfy this contract. Whether this implementation meets it is for the independent reviewer to decide.
