# 05 — Experience and screen specification

## Design direction

Create a restrained, credible banking workspace branded **Al Qarib | Corporate Banking**. Use a light canvas, deep navy navigation, muted teal action/accent color and clear typography. Financial data needs alignment, hierarchy and whitespace, not gradients or decorative dashboards. Use red only for destructive/error states, amber for pending/action required, green for confirmed posted/settled outcomes, blue for informational states. Pair color with text/icon; pending is never green success.

Suggested tokens (measure contrast before finalizing): canvas `#F5F7FA`, surface `#FFFFFF`, text `#15253B`, muted `#53647A`, nav `#10233F`, accent `#006D77`, border `#D7DFE8`. Use 4px spacing base with 8/12/16/24/32 rhythm, 8–12px radius, subtle borders and minimal shadows. Body 14–16px, headings 20–32px. Use bundled licensed Inter (English) and Noto Sans Arabic or equivalent; ensure font license retained. Render monetary values in tabular numerals, aligned by decimal/currency. Avoid excessive compactness and illegible low-contrast grey.

Desktop: persistent sidebar 232–256px; top context bar with corporate/bank, locale, user menu and persistent “Sandbox — simulated funds” indicator. Main width fluid with comfortable max-width for forms (~900px), full-width tables. Mobile: drawer navigation, compact context bar, stacked summaries; tables have accessible overflow/column priority rather than clipped action buttons. Verify 1440px, 1024px, 768px and 390px widths.

## Navigation and route inventory

Route prefix `/{locale}` where locale is `en` or `ar`. Bank workspace is visually distinct, never hidden inside corporate actions. Sidebar only shows permitted operational pages; unavailable products live in a separate **Product catalogue** page with release status and honest scope descriptions. Disabled agreement module shows explanation and bank contact instruction rather than a fake enable button.

| Route (after locale) | Screen content and primary action | Required states / access |
|---|---|---|
| `/login` | Email/password, error, sandbox notice, locale | Loading, invalid credential, throttled; no role impersonation |
| `/invite/[token]` | Accept invitation, password/set profile | Invalid/expired/used token, success; no token in logs |
| `/dashboard` | Available/booked cash, pending approvals, upcoming payments, recent activity, in-app alerts | Empty, partial adapter outage, as-of/stale indicators, scoped data |
| `/accounts` | Account cards/table with number mask, currency, booked/available/holds | Empty grants, unavailable core, account disabled |
| `/accounts/[id]` | Balance breakdown, activity, date filter, CSV/PDF request | Payroll aggregation, scoped actions, pagination, error/retry |
| `/payments` | Filterable history, state/rail/account/date, create payment | Empty first-use, no module access, state-aware actions |
| `/payments/new` | Five-step payment wizard | Inline errors, name match, limits/fees, dates, confirm |
| `/payments/[id]` | Instruction snapshot, policy explanation, approval/status timeline, safe actions | Unknown, rejected, failed, returned, stale policy, reapproval |
| `/beneficiaries` | Scoped beneficiary list/add/edit/archive | Name check, mismatches, archived indicator, no history rewrite |
| `/approvals` | Work queue with class, amount, creator, age, account | My eligible work vs read-only; distinct-person hints |
| `/approvals/[id]` | Immutable review details/diff, approval count, reason input | Self-approval blocked, stale revision, aggregate payroll view |
| `/batches` | Bulk run list/counts/total/date/state | Validation in progress, partially settled, unknown rows |
| `/batches/new` | Template → upload → validate → accepted set → preview → submit | Invalid/duplicate rows, explicit valid-only confirmation |
| `/batches/[id]` | Outcome counts, row tabs, safe retry selection, timeline | Current counts, masked payroll, retry disabled for unknown |
| `/payroll` | Pay-period runs and aggregate funding need | No confidential access → aggregate only or forbidden page |
| `/payroll/new` | Restricted payroll upload/review/schedule | Employee matching, net breakdown, change alerts, privacy |
| `/payroll/employees` | Restricted employee master/import | Inline/import errors, active/archive, account match |
| `/customers` | Code/name/mobile/tags/method, search/import/export/archive | Duplicate scoped code, open-invoice block, bulk result |
| `/customers/[id]` | Summary paid/due/deposits, invoices and activity tabs | Minimal invoice create/allocation, pending deposits excluded |
| `/deposits` | 90-day deposit summary, corporate customer filter | Cash vs cheque, pending vs posted, receipts |
| `/deposits/[id]` | Reference, method/amount/branch/time, posting timeline, receipt | Pending acknowledgment distinctly labelled, return/unknown |
| `/reports` | Statement/deposit report request and generated artifacts | Pending/failed/expired/revoked download rights |
| `/agreement` | Current signed modules, linked accounts, fees, validity/history | Read only, suspended/expired warning, provenance labels |
| `/limits` | Per-module/user/corporate usage, reserved/consumed/remaining | Units and business windows explicit, unavailable parameter |
| `/admin/users` | Membership/account grants, propose change/invite/suspend | Last-admin warning, pending second approval |
| `/admin/approval-rules` | Current bands/bank floors, propose stronger rule | Boundary errors, diff, own change cannot approve |
| `/notifications` | Own alerts/read status and permitted rules | Dedup, no salary details |
| `/developer` | Sandbox credential metadata, scopes, OpenAPI, webhook delivery | Token visible once, revoke/rotate confirmation, no default payroll |
| `/audit` | Authorized sanitized event search, correlation/target links | Filter/pagination, sensitive contents redacted |
| `/products` | All 33 modules grouped in 12 domains | Separate release availability and agreement enablement |
| `/bank` | Bank operational overview scoped to assigned bank | No accidental cross-bank aggregate |
| `/bank/corporates` | Corporate list, segment/agreement status | Search and scoped detail links |
| `/bank/corporates/[id]/agreement` | Revision editor/diff, signature evidence, proposal | Draft/missing fields, checker review, effective-date conflict |
| `/bank/approvals` | Bank governance and eligible repair proposals | Distinct admin maker/checker, policy diffs |
| `/bank/rail-parameters` | Demo ceilings/provenance, calendar/cut-offs, proposals | Unknown blocks rail; approved changes history |
| `/bank/teller` | Corporate+code lookup, confirm identity, deposit entry | Not found, ambiguous code across corporates, caps and threshold |
| `/bank/branch-approvals` | Threshold deposit queue/details | Teller cannot self-approve, branch scope enforced |
| `/bank/operations` | Unknown/failed/stale execution, safe inquiry/repair | No direct ledger editing, unknown retry disabled |
| `/bank/reconciliation` | Business-date runs, breaks and evidence resolution | Empty/success/fail, no “mark all fixed” |

Do not duplicate payroll logic: bulk/payroll share import and execution infrastructure but use separate permission-aware page projections. Route names may be adapted to Next.js conventions with an explicit map in delivery documentation; semantics and reachable states cannot disappear.

## Critical interaction details

### Payment wizard

1. Source: show assigned active debit accounts, currency and fresh available balance. Explain frozen/stale accounts. No account → useful empty state, not blank selector.
2. Recipient: choose beneficiary or own account. Name check result alongside normalized masked reference. “Check failed” is distinct from “name mismatch”; retry must not create a payment.
3. Details: amount localized input normalized to canonical minor units, purpose/reference, allowed type/rail and execution date. Exactly one currency. Type changes recompute allowed fields.
4. Review: principal, fee, total debit, as-of funds, estimated remaining, checkers required, effective agreement and all failing policy reasons. Show “Estimate — checked again before execution”. Do not display sensitive internal rule names in user copy.
5. Submit: explicit “Submit for approval”, not “Pay now”. Disable duplicate click for convenience but rely on server idempotency. On success navigate to persistent detail showing pending approval, reference and next actor. Refresh reconstructs from DB.

### Checker review

Show immutable creator/time/version, source/recipient/purpose, amount/fee/date, policy summary and already counted approvals. Payroll uses count/total/period/anomaly counts only. Approve confirmation says what is authorized and remaining checkers; reject requires meaningful reason (3–500 chars). On stale revision, show new revision and require a fresh review. No bulk approve-all in R1: every decision must review its proposal. Own proposal displays read-only explanation, API also rejects.

### Import wizard

Download versioned template and concise schema instructions. Drag/drop plus accessible file picker. Show file name/size, parse progress and cancellable pre-submission state. Validation grid has stable row numbers and code-specific guidance; no silent normalization of financially meaningful values. Summary: total input, valid, invalid, excluded, accepted count, total principal, fees and resulting debit. Valid-only continuation requires checkbox and explicit summary of exclusions. Back/edit invalidates prior digest and approval. Large datasets paginate; do not render 1,000 editable DOM rows at once. Payroll error download requires payroll permission and never appears to ordinary checker.

### Deposit/receipt

Teller first confirms corporate+customer and destination. Amount and type review second, threshold/manager status third. Pending cheque receipt is not a posted-credit receipt. Posted receipt is generated from immutable server data, with reference, simulated stamp and authentic status. Finance can download after authorization without recreating deposit. Unknown posting explains “We are checking the result. Do not submit again.”

## Content and accessibility rules

- No placeholder lorem ipsum, stock KPI charts, invented exchange rates, decorative AI insights or undocumented “coming soon” interactive transactions.
- Money status copy: Pending approval, Scheduled, Processing, Submitted to rail, Settled, Failed before posting, Result being checked, Returned. Tooltip explains each without claiming settlement for accepted items.
- Error messages identify fix and preserve safe form values; correlation reference is available for support, never full internals. No raw stack traces in UI.
- Loading skeletons preserve layout; submit buttons show progress; empty states have permission-appropriate next action. Failed data fetch is never rendered as zero balance.
- WCAG 2.2 AA target: semantic headings/landmarks, visible keyboard focus, labelled form controls and errors, accessible combobox/dialog, focus restoration, keyboard table actions, `aria-live` status announcements without revealing salary. Minimum 44px touch targets for key actions. Reduced-motion respect. Never require hover alone.
- RTL: document `dir`, logical spacing properties, mirrored navigation chevrons, correct menu alignment and table ordering. Isolate account refs, IDs and numeric amounts with `bdi`/direction where needed. Do not reverse literal account numbers. Arabic translations are complete for core journeys/errors/receipts, not just sidebar. Snapshot audit checks Arabic form/table overflow and PDF joining.
- Date display follows selected language but shows bank timezone on schedules and reporting windows. User's local timezone does not move accounting cut-offs. Currency labels always explicit (e.g. LYD 125.000).
- Financial charts use actual seeded/query data with labelled axes and accessible text alternative; no chart where a compact table is clearer.

## Visual review evidence

Capture screenshots for English+Arabic dashboard, payment review/detail, checker queue/detail, payroll aggregate/detail under different identities, batch error screen, customer/deposit receipt and bank agreement diff. Capture desktop 1440×1000 and mobile 390×844 for dashboard/payment/import navigation. Use same deterministic fixture to compare balance and status across screenshots. Screenshots support inspection; they never replace functional or authorization tests.

## Mandatory mobile/installed experience

Apply document 12 to every page above: mobile corporate Home/Payments/Approvals/More navigation, separate bank workspace navigation, 360px minimum layouts, safe-area/keyboard handling, file picker/PDF behavior, install assistance and safe offline/update/reconnect states. All R1 role tasks remain usable on mobile. Capture installed Android/iOS evidence separately from viewport emulation and never label an unrun device check passed.
