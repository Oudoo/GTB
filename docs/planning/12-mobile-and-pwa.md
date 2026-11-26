# 12 — Desktop web and mobile PWA contract

## Decision and boundaries

The user clarified that the MVP must work on **mobile and web**. Deliver one responsive Next.js/TypeScript Progressive Web App supporting desktop browsers, mobile browsers and installation where supported. This requirement supplements documents 01–11 and supersedes the original exclusion of mobile apps. A separate React Native/Flutter/native application and Apple/Google store distribution are not R1 requirements.

A PWA is the recommended MVP approach because the primary workflows are forms, approvals, file imports, reports and account visibility, which benefit from shared UI, contracts and security controls. It reduces duplicated client implementation and release work. It is not automatically equivalent to a native app: install prompts, background behavior, file handling, push and OS integration vary by platform. R1 does not depend on push, persistent background execution or biometrics. Reconsider native only after concrete needs emerge, such as bank-mandated device attestation, specialized hardware integration or native SDK requirements.

**Core rule: online banking, installable application.** Installation does not imply offline banking. No cached financial dashboard, offline account browsing, offline salary file or queued payment/approval. Static assets and a generic offline page may work offline; customer/financial data must come from an authenticated live connection. This is a sandbox banking MVP even when installed.

## Mobile product scope

**MOB-01 Feature access.** All mandatory R1 actions remain reachable and usable on mobile, subject to the same permissions. Maker can select beneficiary, preview and submit payment; Checker can inspect exact proposal and approve/reject; Treasurer can inspect balances/usage/funding; Payroll officer can select a supported local file and review validation; Finance can manage customers, deposits and reports; bank users can review agreement diffs, capture deposits and handle operations. Heavy workflows may be easier on desktop, but no R1 task may be silently desktop-only. Document platform-specific limits and provide a usable web fallback for installation/file opening, not a dead-end button.

**MOB-02 Touch layout.** Support 360 CSS-pixel width and above, portrait/landscape and 200% text zoom without page-level horizontal overflow. Use drawers/stacked cards/full-screen dialogs for narrow layouts, logical CSS properties for RTL, safe-area insets for installed iOS, dynamic viewport units with fallbacks and touch targets at least 44×44 CSS pixels. Keyboard must not cover current field or submit/review controls. Never place confirmation beneath system home indicator. Preserve visible financial values and labels; truncation must not hide amount, currency or beneficiary identity.

**MOB-03 Navigation.** Corporate mobile uses a compact context header and four persistent destinations: Home, Payments, Approvals, More. Only show authorized destinations and show approval count without salary/PII. More contains payroll, collections, accounts, reports, agreement/limits, administration and developer functions as permitted. Bank workspace has its own menu; context switch is explicit and clears protected UI state. Desktop keeps sidebar. Back navigation must not replay a command; returning to a review page must re-fetch state/version rather than resubmit.

**MOB-04 Data presentation.** Narrow tables use responsive cards with status/reference/amount and a labelled detail action; dense row grids can scroll horizontally inside a clearly labelled region. Error row count and accepted total remain visible. Approval review prioritizes maker, exact amount/fee, account, beneficiary, purpose, schedule, policy and quorum. Totals cannot disappear behind an accordion. Payroll detail restrictions hold on cards, previews, notifications and HTML, not merely in desktop columns.

**MOB-05 Inputs/files/receipts.** Use `inputMode="decimal"` for money with locale-aware parsing but canonical exact minor-unit output; telephone/email keyboards where appropriate. Do not trust mobile client file acceptance filters—server parser checks remain mandatory. File picker must accept supported CSV/XLSX from device storage; display name/size and actionable errors. Interrupted upload permits explicit reselection/revalidation, never an offline upload queue or duplicate batch creation. Receipt download is authenticated and usable through browser/OS PDF handling; document Safari/Android behavior. Native share-sheet support is optional and must require explicit user action, never expose secrets or bypass download scope.

## Installable application

**PWA-01 Manifest.** Implement Next.js App Router manifest support (`app/manifest.ts` or equivalent) with stable application `id`, name, short_name, description, `start_url`, `scope`, `display: standalone`, theme/background colors, supported orientation policy, 192/512px icons and a maskable icon with safe padding. Include Apple touch icon and useful favicon. Use stable product identity across locale changes; localized install copy must not create duplicate app identities. Start URL contains no tenant ID, token, credential or sensitive query; resolve session+locale safely at launch. Scope must include `/en` and `/ar` without swallowing unrelated origins. Icons are actual designed assets, not broken links. Manifest shortcuts, if added, lead to authenticated ordinary routes and reveal no financial detail.

**PWA-02 Install UX.** Show an unobtrusive Install action only where applicable. Use browser-supported install event when available, manually explained Add to Home Screen flow for iOS Safari, and normal browser use everywhere. Detect standalone mode to avoid repeated install prompts. Dismissal is respected. Never require installation to access the service. HTTPS is required outside localhost development. Do not promise automatic iOS install, universal install APIs or app-store availability.

## Service worker and storage safety

**PWA-03 Explicit public allowlist only.** Use a small reviewed service worker, with a maintained compatible integration if helpful, configured deliberately. Generic cache-everything/generated defaults are unacceptable. Precache only a versioned allowlist of public icons, bundled fonts, approved static JS/CSS and a self-contained generic offline document. Cache only known successful same-origin public assets, not arbitrary request responses. Never precache protected URLs by discovering links at build/runtime. Worker source is reviewable and testable. Build ID is nonsecret and identifies cache version.

Network-only and excluded from **all** worker caches: `/api/**`, authentication/session/callback/logout routes, authenticated navigations and HTML, Next.js RSC/Flight/prefetch payloads, server action responses, account/statement/transaction/customer/payroll data, reports/receipts/export/download files and requests with Authorization headers. Do not use navigation caching, stale-while-revalidate or network-first-with-sensitive-fallback for these. Public static JS bundles may be cached only if they embed no fixture secrets or protected data; that is not permission to cache route HTML. Returning authenticated content must have server `private, no-store` headers; those headers supplement explicit worker exclusion, not replace it. Middleware/route caching must also avoid cross-user leakage.

**PWA-04 No offline financial queue/storage.** No Background Sync, replay queue or IndexedDB/localStorage persistence of payment drafts, votes, salary/employee rows, account data, tokens, receipt files or API responses. Auth uses secure cookies as specified; persistent nonsecret locale/theme/install dismissal preferences are allowed. TanStack/other client caches must not persist protected data to disk and must clear on logout/session/context change. Sensitive drafts may exist in component memory while authenticated, but no recovery autosave to browser storage; if server draft save fails, explain that it is not saved. Do not convert loss of network into an apparent successful submission.

**PWA-05 Offline/unknown behavior.** Generic offline document contains no account, tenant, person, balance, recent action or other sensitive data; it offers reconnect/retry and a simple explanation. Already-open page detects failed network and removes/masks financial content and disables writes; `navigator.onLine` alone is not an authority for connectivity. When a command may have reached the server, show result being checked, retain its nonsecret in-memory command key/resource reference and query server before enabling another attempt. No resubmission under a new key after ambiguous outcome. After app closure, recover through authenticated server history, not a local outbox. Background server jobs continue according to approvals/policy; device connectivity must not cancel or duplicate them.

**PWA-06 Lifecycle/security.** On logout revoke server session, clear client state, broadcast logout to other tabs where available and return to login/offline-safe content. Revalidate session and resource state on foreground, `pageshow` including browser back/forward restoration and context switch; mask protected content until revalidation completes. Session expiry never leaves an interactive cached approval screen. Keep existing authentication expiry; installation does not grant indefinite session lifetime. Device lock/app-switcher screenshots and user-created downloads cannot be reliably controlled by a web app: document these limits honestly, do not claim screenshot prevention or remote deletion of saved PDFs. Reduce unintended exposure by not persisting sensitive application content and using correct auth/headers/projections.

**PWA-07 Updates.** Detect a new waiting worker and offer “Update available” without forced reload during an unsaved form, review or in-flight command. Do not automatically `skipWaiting`+reload all tabs mid-action. After safe confirmation, clear obsolete public cache versions, activate and reload; revalidate server session/state. Compatible backend/API version handling must allow old open tabs or provide an explicit safe reload gate. Prevent a reload from re-POSTing the previous operation. Failed upgrade/asset fetch has a recoverable refresh path. Document worker unregister/cache reset for developers without purging arbitrary user/browser storage.

**PWA-08 Notifications.** In-app alerts remain required. OS web push, push-subscription servers and background sync are deferred. Do not request notification permissions at first launch. If push is proposed later, require separate approval, platform/device capability testing and generic non-PII payloads; push must never be treated as approval or authoritative proof of settlement.

## Architecture and deliverables

Add manifest/icon generation, a public static offline document, explicit worker registration/update UX, connectivity/session revalidation guard and cache-policy tests. Do not duplicate domain rules in a mobile-specific client. App Router RSC requests need explicit bypass handling with the tested Next.js version; don't assume every route request is HTML. Prefer the smallest service-worker strategy that satisfies safe public offline fallback and installability. Document the selected implementation and verify HTTPS staging locally/through an approved test origin; do not deploy merely to satisfy a screenshot.

Keep private storage out of public paths; reports and uploaded payroll files never enter the manifest/precache list. Build tooling must not copy `.env`, upload directories, source data fixtures with credentials, generated reports or server secrets into public bundles. Use production build for service-worker tests because dev behavior differs.

## Backlog additions (part of existing mandatory slices)

| Task | Slice | Deliverable | Exit evidence |
|---|---|---|---|
| MOB-101 | S0/S1 | Supported browser/device matrix, manifest/icons, standalone shell and safe worker baseline | Valid metadata/assets, registration only where supported, no protected cache |
| MOB-102 | S1–S7 | Mobile English/Arabic navigation, touch forms, approvals, imports, teller and bank diffs | Core role tasks work at 360/390px, keyboard/safe-area/RTL inspected |
| MOB-103 | S3/S4 | Offline masking, unknown-command/reconnect and session/context lifecycle | No offline write queue, no duplicate execution, server state refreshed |
| MOB-104 | S8/S9 | Mobile PDF/file flows and scoped alert/report behavior | Device file selection and receipt opening, no privacy regression |
| MOB-105 | S10 | Production-mode PWA update/cache tests, install/device evidence and runbook | All P-01..P-12 below executed with accurate platform evidence |

## Mandatory PWA/mobile acceptance tests

| ID | Scenario | Required outcome |
|---|---|---|
| P-01 | Production build manifest/icons/HTTPS origin inspection | Valid install metadata, stable scope/ID, no missing icon or sensitive launch params |
| P-02 | Android Chrome installation and standalone launch | Appropriate install UI, usable authenticated launch, app identity/theme correct |
| P-03 | iPhone Safari Add to Home Screen and launch | Honest manual instructions, safe areas/RTL/keyboard correct, no dependence on unsupported install event |
| P-04 | Offline start then inspect Cache Storage/IndexedDB/localStorage | Generic safe offline screen; only allowlisted public assets, no banking/auth/payroll/report content |
| P-05 | Open account/payroll/approval then lose network | Financial content masked, mutations disabled, no stale-data-as-current UI or offline approval |
| P-06 | Lose response during payment/approval; reconnect/reopen | Authoritative server inquiry/history, same request identity if retry appropriate, one financial effect |
| P-07 | Logout/session expiry/context switch with multiple tabs, Back and foreground | No prior-tenant/user protected view reused, revalidation before sensitive display/action |
| P-08 | Version update while form/review/command active | No forced reload/data replay; safe update UX, clean old static cache and server revalidation |
| P-09 | Mobile local CSV/XLSX upload and PDF receipt in EN/AR | Actual file picker and server validation work; receipt readable with correct Arabic shaping |
| P-10 | 360/390px portrait, landscape, text zoom, virtual keyboard | No clipped critical amounts/actions, touch/keyboard/RTL flow usable |
| P-11 | Request APIs/RSC/auth/private downloads through installed worker | Network-only behavior, no cached sensitive response under any cache key or prior user |
| P-12 | Desktop browsers and installed mode where supported | Functional parity and graceful unsupported-install fallback; no mobile-only regression |

Support target: current stable Chrome/Edge and Firefox desktop; Safari macOS; Chrome Android; Safari iOS, including home-screen installed mode on Android/iOS. Record exact OS/browser versions actually tested. Automated Playwright Chromium/Firefox/WebKit at mobile viewports verifies rendering and many flows, **not physical iOS installation or actual Safari OS file/keyboard behavior**. P-02/P-03 and relevant P-09/P-10 need real-device evidence (reviewer/user-supplied is acceptable if reproducible and clearly attributed). If unavailable, report those checks unrun and keep device acceptance pending; do not claim parity based solely on emulation.

## Audit integration

Existing H01/H02/H07/H08/H11 also apply in worker/installed/mobile mode. H12 now includes required mobile/PWA acceptance evidence. No new numeric category is added: assess mobile usability under UX /10, safe caching/lifecycle under Security /15 and installation/update/reconnect/reproducibility under Resilience /10. Sensitive worker caching, offline financial replay or a material unsupported mobile workflow blocks PASS regardless of visuals. Distinguish an implemented feature from an unrun physical-device check; neither automatically proves the other.

Append P-01..P-12 results and cache inspection evidence to the implementation review template. Record app build ID, active worker version, exact device/browser and online/offline state. R1 is accepted as a web/mobile sandbox PWA only after these obligations and the existing banking controls pass. App-store release or native capability claims require a separate future decision.
