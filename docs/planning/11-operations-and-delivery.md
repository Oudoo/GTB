# 11 — Setup, operation and delivery contract

This document specifies what Claude must deliver and verify. The commands below are a **target interface, not currently implemented commands**. Replace/add actual tested instructions during implementation, retaining equivalent capabilities. Do not claim the environment was provisioned merely because this plan exists.

## Repository hygiene and environment

Commit dependency lockfile, schema/migrations, deterministic synthetic seed, source fixtures/templates, OpenAPI, `.env.example`, scripts, CI and actual runbook. Ignore `.env*` except sample, `node_modules`, `.next`, local databases/uploads/artifacts, Playwright reports/videos, coverage, logs, secret keys and generated report PDFs. Keep source catalogue PDF/text tracked as reference. Never rewrite/remove it to conceal a requirement.

Expected variable **names** (implementation may adopt auth-library conventions and must document them):

| Name | Purpose | Handling |
|---|---|---|
| `DATABASE_URL` | Runtime app/worker connection with least privilege | Secret, no value committed |
| `MIGRATION_DATABASE_URL` | Schema owner connection for migrations/grants | Separate local/CI secret; no runtime app use |
| `APP_BASE_URL` | Same-origin auth/callback/canonical URL | Nonsecret, explicit deployment value |
| `AUTH_SECRET` | Session signing/encryption | Generated securely, never sample real secret |
| `APP_MODE` | `sandbox` / future `bank-pilot` / `production` | Reject unsupported live modes in R1, no silent fallback |
| `CORE_ADAPTER` | `simulated` in R1 | Real adapters unavailable, fail if selected |
| `BANK_TIMEZONE` | Default Africa/Tripoli | Persist bank calendar source; host timezone irrelevant |
| `STORAGE_PATH` | Private local upload/report storage | Outside public web root, restrictive file permissions |
| `DATA_ENCRYPTION_KEY` | Encrypt sensitive stored webhook secret/fields where used | Secret, separate from auth secret; documented rotation limit |
| `SEED_DEMO_ENABLED` | Explicit opt-in to synthetic seed | Disabled outside sandbox; do not seed on every server startup |
| `DEMO_PASSWORD` | Local synthetic user initialization only | User-provided/generated securely, not shipped production default |
| `LOG_LEVEL` | Structured log verbosity | Never enables raw PII/token dumps |

Required variables are validated at startup with names-only helpful errors. Generate local secrets via supported random generator and store privately; no logging values. A sandbox can have a documented synthetic password in an ignored local file, not a real credential. Prefer secure per-environment generation and a documented local display procedure that does not enter tracked evidence.

## Target local workflow

```sh
# From repository root; after exact Node/pnpm version activation:
pnpm install --frozen-lockfile
docker compose up -d db
pnpm db:migrate
pnpm db:seed
pnpm dev
# Separate terminal from the same repository root:
pnpm worker:dev
# Separate terminal once readiness passes:
pnpm smoke
```

Document a PostgreSQL connection alternative if Docker unavailable; never replace transactional integration tests with SQLite. Separate runtime and migration users/grants in migration/setup script. Seed twice to demonstrate idempotence: first creates demo data, second does not duplicate identities/opening balances/jobs or reset non-demo data. Destructive reset command must explicitly require sandbox database confirmation. Do not run automatic `db push` instead of reviewed migrations or destructive reset at server boot.

Provide `pnpm build`, `pnpm start` and `pnpm worker:start` for compiled deployment-like validation. The worker must not depend on Next development server internals. Explain which ports, private storage directory and DB connections are required. Health readiness confirms DB access, migration compatibility and supported adapter mode; separate worker heartbeat/status is required to diagnose pending work. Never expose DB credentials or detailed exception traces from health endpoints.

## Repeatability and fresh restoration

Retained dependencies/files are different from live processes. Startup instructions must explicitly start app and worker and verify a business flow; don't assume background processes survive a snapshot/restart. Cloud tasks are isolated already; reuse checkout and do not create worktrees. A fresh environment can install from lockfile, migrate clean DB, seed intentionally and run checks without code edits. Dependency lifecycle scripts remain subject to normal trust/checksum verification.

The implementer should verify a second clean test DB initialization, an idempotent second seed and app/worker restart preserving pending state. Keep user test state separate from deterministic CI databases. Record actual commands and working directory, expected readiness, and how to stop only processes started for validation. No unsolicited production deployment is part of implementation.

## Diagnostics and operational behavior

- Log structured timestamp, severity, service, correlation, aggregate/reference, sanitized error class, attempt and duration; omit token/raw upload/salary/employee details.
- Track job queue age, failed/dead-letter counts, unknown executions, reservation age, webhook delivery failure, reconciliation break count and last successful run. Provide modest bank operations UI/query commands, not a full observability platform requirement.
- Core outage shows stale inquiry timestamp and blocks unsafe dispatch; it does not render fake zero balances or green settlements.
- Worker stop/restart handles stale leases safely. Inquiry resolves financial ambiguity; manual repair proposes a known safe action with reason/approval, never arbitrary SQL state mutation.
- Backup/restore instructions for synthetic DB/private storage must be documented; no claim of tested real-bank DR. Before pilot define RPO/RTO and perform approved restore drill.
- No raw source PDF customer content is sent to third parties. No external email/SMS messages are authorized; use local inbox/log metadata fixtures without sensitive content.

## Delivery documentation checklist

1. README with actual architecture, supported R1 scope and honest simulation boundaries; preserve the planning index.
2. Tested prerequisites, exact version pins, install/migrate/seed/dev/worker/build/start/test commands and variable names.
3. Demo personas, how to securely initialize/login them, scope restrictions and expected end-to-end outcomes.
4. OpenAPI spec and sanitized curl examples; no token secrets copied into tracked examples.
5. Schema diagram/transaction explanations, simulator scenario controls limited to sandbox and reconciliation demo.
6. `IMPLEMENTATION-STATUS.md` task completion/evidence map and `IMPLEMENTATION-DECISIONS.md` justified deviations.
7. Review template filled with evidence, failures/skips/unrun limitations and artifacts. Independent verdict remains pending.
8. Known production gaps, security findings/dependency advisories and owner of external blockers; no FAPI/CBL certification claim.

## Ready for independent audit

All S0–S10 exits verified or explicit blockers reported; clean install and business smoke succeed; automated checks actually execute; race/failure/privacy evidence exists; screens/locales reviewed; no secret or generated junk staged. The subsequent reviewer applies document 08 against the final revision. R1 acceptance does not authorize publishing a live bank service.

## PWA operation and delivery

Include manifest/icons, worker/cache allowlist, HTTPS prerequisite, production-build install testing, generic offline fallback, safe worker update procedure and precise mobile device/browser support in the actual runbook (document 12). Separate static worker cache version from server financial state. Explain unregister/reset for owned app caches in development; do not clear arbitrary browser storage. Record P-01..P-12 with build/worker/device versions. Push/background sync and app-store deployment are not R1 requirements.
