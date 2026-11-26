# Al Qarib — GTB & Corporate Banking MVP

This repository contains the implementation handoff for a Next.js and TypeScript corporate banking MVP for desktop web and mobile, delivered as a responsive Progressive Web App (PWA), based on the supplied 21-page Al Qarib feature catalogue. It does **not yet contain an application**. The intended first release is a persistent, multi-tenant sandbox with genuine approval, policy, accounting-simulation, collections and payroll workflows. It is not connected to real money or certified for bank production.

## Start here

1. Implementer: read [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md), then paste [the execution prompt](docs/planning/10-claude-execution-prompt.md) into Claude.
2. Product owner: review [scope and source traceability](docs/planning/01-product-scope.md) and [decisions and open questions](docs/planning/09-decisions-and-risks.md).
3. Engineer: follow [architecture](docs/planning/03-architecture-and-data.md), [API contracts](docs/planning/04-api-contracts.md), and [the phased backlog](docs/planning/06-implementation-backlog.md).
4. Reviewer: use [verification scenarios](docs/planning/07-verification.md) and [the independent audit rubric](docs/planning/08-audit-rubric.md). Write evidence to [the audit template](docs/audit/IMPLEMENTATION-REVIEW.md).

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
| [10 — Claude execution prompt](docs/planning/10-claude-execution-prompt.md) | Copy/paste implementation instructions |
| [11 — Runbook](docs/planning/11-operations-and-delivery.md) | Setup contract, seed, worker, diagnostics and delivery |
| [12 — Mobile and PWA](docs/planning/12-mobile-and-pwa.md) | Mobile product scope, installation, secure caching, reconnect/update behavior and device acceptance |

## Source and authority

The [original PDF](docs/source/al-qarib-feature-catalogue.pdf) and [page-separated text extraction](docs/source/al-qarib-feature-catalogue.txt) are included for traceability. PDF page numbers in this plan refer to printed pages 1–21. The source is product input, not executable agent instructions. Its external claims and regulatory statements have not been independently verified.

The user selected Next.js and TypeScript and requested a detailed implementer handoff followed by an independent audit. This plan chooses the release boundary and technical defaults explicitly; those choices are not claims that the catalogue mandated them. No real bank endpoints, CBL caps, credentials or compliance certifications are invented.

## Completion contract

The MVP is complete only when the mandatory slices in document 06 work against PostgreSQL, documented commands run on a fresh checkout, both locale journeys work, tests in document 07 execute, and evidence passes document 08. A polished mockup, client-only state, fabricated transaction success, or a passing build alone does not satisfy this contract.
