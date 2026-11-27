# Executed checks at revision `dc2fa68`

Concise record of what was run, where and with which result. Full logs, Playwright reports and
screenshots are generated artifacts (ignored by Git); re-create them with the commands below.

| Field | Value |
|---|---|
| Revision | `dc2fa68b2a6321dfc63ca192d146aad6e978d5e3`, clean working tree for code and tests (only documentation was uncommitted) |
| Date | 2026-11-27 (UTC) |
| Machine A (implementation environment) | Linux 6.18 container, 4 CPUs, 15 GiB RAM; Node 24.22.3, pnpm 10.28.0, PostgreSQL 16.15 local cluster, Chromium for Playwright 1.63.0 |
| Machine B (GitHub Actions, `ubuntu-24.04` runner) | Fresh checkout, `pnpm install --frozen-lockfile`, PostgreSQL 16.16 service container |
| Service-worker build identifier | `dc2fa68b2a63` |

## Machine A, in this order

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `pnpm install --frozen-lockfile` | 0 | Lockfile matches `package.json` |
| 2 | `pnpm lint` | 0 | 0 errors, 0 warnings (`--max-warnings=0`) |
| 3 | `pnpm typecheck` | 0 | `src`, `worker`, `prisma`, `scripts`, `tests` |
| 4 | `pnpm test:unit` | 0 | 11 files, **225 passed**, 0 failed, 0 skipped |
| 5 | `pnpm test:integration` | 0 | 10 files, **59 passed**, 0 failed, 0 skipped — real PostgreSQL, one database per test world |
| 6 | `pnpm test:contract` | 0 | 1 file, **5 passed** |
| 7 | `pnpm openapi:check` | 0 | "OpenAPI is up to date (116 operations)" |
| 8 | `pnpm audit` | 0 | "No known vulnerabilities found" (also `--prod`, run at `c8581d9`) |
| 9 | `pnpm build` | 0 | Next.js production build and worker bundle |
| 10 | `pnpm test:e2e --trace off` | 0 | **36 passed** (18 journeys × 2 layouts), 0 skipped, 0 flaky, 2.6 min |
| 11 | `pnpm db:reset-demo --yes` | 0 | Database recreated, 3 migrations, "29 identities, 6 opening balances" |
| 12 | `pnpm db:seed` (second run) | 0 | "0 identities created, 0 opening balances booked" |
| 13 | `pnpm start` and `pnpm worker:start` (two processes) | — | `/api/v1/health/ready` 200 `{"status":"ready","mode":"sandbox","coreAdapter":"simulated"}` |
| 14 | `pnpm worker:status` | 0 | "Worker ALIVE … Queue 0 pending, 0 running, 0 dead-lettered" |
| 15 | `pnpm smoke` | 0 | 13 checks, transcript below |
| 16 | Worker killed with `SIGKILL`; 33 s later `pnpm smoke --restart-check`; application stopped; both started again | 0 | 12 checks, transcript below |
| 17 | Application and worker logs of steps 13–16 searched for `error`/`unhandled` | — | 0 lines |

Per file — unit: batches 20, calendar 17, files 23, i18n 4, logging 4, migrations 2, money 44,
permissions 20, policy 53, webhooks 33, wiring 5. Integration: s2-admin 4, s4-money-movement 18,
s4-payment-gate 7, s5-bulk 4, s6-payroll 5, s7-collections 4, s8-operations 5,
s8-reconciliation 4, s8-reports-alerts 4, s9-developer 4.

Browser journeys, each on `desktop-en` (1366×900, English) and `phone-ar` (390×844 touch
emulation, Arabic): E-01, E-02, E-06, E-07, E-08, E-09a, E-09b, E-09c, E-11a, E-11b, E-11c, P-01,
P-04+P-11, P-05, P-06, P-07, P-08, P-10. E-11a annotation in both layouts: "34 screens scanned;
moderate or minor findings: none".

### `pnpm smoke` (step 15, fresh database)

```
Al Qarib sandbox smoke test against http://localhost:3000
  ok  application ready: sandbox mode, simulated core, migrations current
  ok  six distinct people signed in with their own credentials (2 bank administrators, operations, maker, checker, corporate administrator)
  ok  worker process alive (heartbeat within 30 seconds)
  ok  bank administrator (maker) proposed the signed sandbox agreement
  ok  the proposer could not activate their own proposal
  ok  a different bank administrator activated it; the corporate now reads an agreement in force
  ok  maker created and submitted PAY-QTD-2026-000001: LYD 125.000 to Tripoli Office Supplies Demo; the repeated request created nothing new
  ok  the maker could not approve their own payment
  ok  a different checker reviewed recipient Tripoli Office Supplies Demo, amount LYD 125.000 and fee LYD 0.500, then approved
  ok  the worker settled it through the simulated core (instruction AQ01A21D3BA65E730E831FFDCF7DE31A98A1)
  ok  source balance fell by LYD 125.500; outgoing limit usage rose by LYD 125.000 (the fee does not count toward limits)
  ok  statement (payment and fee lines), payment timeline and audit trail carry the same instruction reference; maker and checker are two people
  ok  repeating the approval and the create request changed nothing: exactly one debit

SMOKE PASSED — payment PAY-QTD-2026-000001, instruction AQ01A21D3BA65E730E831FFDCF7DE31A98A1, booked balance now LYD 99874.500.
```

### `pnpm smoke --restart-check` (step 16)

```
Al Qarib sandbox smoke test against http://localhost:3000
  ok  application ready: sandbox mode, simulated core, migrations current
  ok  six distinct people signed in with their own credentials (2 bank administrators, operations, maker, checker, corporate administrator)
  ok  worker process is stopped (no heartbeat in the last 30 seconds)
  ok  a signed agreement is already in force for Qarib Trading Demo (activation not repeated)
  ok  maker created and submitted PAY-QTD-2026-000002: LYD 125.000 to Tripoli Office Supplies Demo; the repeated request created nothing new
  ok  the maker could not approve their own payment
  ok  a different checker reviewed recipient Tripoli Office Supplies Demo, amount LYD 125.000 and fee LYD 0.500, then approved
  ok  with the worker stopped the approved payment waits as QUEUED: balance untouched, limit reserved

  >>> Start the worker now (`pnpm worker:start`). You may also stop and start the application. Waiting up to 300 seconds…

  ok  the restarted worker settled it through the simulated core (instruction AQ01A21D3C356170799B9034AC0B9BBB81A1)
  ok  source balance fell by LYD 125.500; outgoing limit usage rose by LYD 125.000 (the fee does not count toward limits)
  ok  statement (payment and fee lines), payment timeline and audit trail carry the same instruction reference; maker and checker are two people
  ok  repeating the approval and the create request changed nothing: exactly one debit

SMOKE PASSED — payment PAY-QTD-2026-000002, instruction AQ01A21D3C356170799B9034AC0B9BBB81A1, booked balance now LYD 99749.000.
```

LYD 100,000.000 − 2 × 125.500 = 99,749.000.

## Machine B (GitHub Actions)

| Run | Revision | Result |
|---|---|---|
| [#6](https://github.com/Oudoo/GTB/actions/runs/46008475900) | `dc2fa68` (the tested revision) | **success** — job "lint, types, unit, integration, contract, build" and job "browser journeys (production build, separate worker)" |
| [#5](https://github.com/Oudoo/GTB/actions/runs/46007068812) | `c8581d9` | **success** — both jobs |
| #1, #2 | `c4ab0c2`, `2da6364` | **failure** — `pnpm db:local` ignored `POSTGRES_ADMIN_URL`; fixed in `848e538` |
| #3, #4 | `848e538`, `b3bb571` | cancelled by a newer push before finishing (not a result) |


## Not executed

- `docker compose up -d db` (no Docker daemon). The admin-URL path it relies on was executed
  against the local server over TCP with a temporary superuser, and by CI against a service container.
- Any physical device; any browser engine other than Chromium.
- Performance measurements (document 03 targets).
- A backup/restore drill.
